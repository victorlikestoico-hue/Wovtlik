import {
	makeWASocket,
	DisconnectReason,
	useMultiFileAuthState as getMultiFileAuthState,
	fetchLatestBaileysVersion,
	Browsers,
	downloadMediaMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { Redis } from "ioredis";
import { createIoredisTurnState } from "../redis-adapter.ts";
import { createInboundHandler } from "./inbound-handler.ts";
import { normalizeProfileStatus } from "./profile.ts";
import { runtimePaths, clearDirectoryContents, getInstanceAuthDir } from "../runtime-paths.ts";
import {
	createConfiguredChatClient,
	describeImage,
	transcribeAudio,
} from "../ai-providers.ts";
import { qualifyLeadAndCreateSuggestions } from "../ai-qualification-service.ts";
import {
	getConnectionState,
	setConnectionState,
	getActiveWhatsAppInstance,
	updateWhatsAppInstanceState,
	getOrCreateConversation,
	getConversationById,
	insertMessageAndTouchConversation,
	updateConversation,
	updateConversationNameIfExists,
	setMode,
	recordConversationEvent,
	getSettings,
	setSetting,
	getRecentHistory,
	getActiveSystemPrompt,
	getMessageContentByWhatsappId,
	notifyTelegramHumanNeeded,
	getPendingOutbox,
	markOutboxSent,
	markOutboxFailed,
	deleteConversation,
	enqueueOutbox,
	listConversations,
	getAgentProfile,
	getAgentProfileByEmail,
	saveAgentProfile,
	saveCrmTask,
	notifyGroupFailureReport,
	logNearMissIntent,
	insertGroupFailureReport,
	markGroupFailureReportConfirmed,
	markLatestGroupFailureReportResolved,
} from "../db.ts";
import { lookupCase, getAgentMetrics, isDashBigConfigured } from "../dashbig-client.ts";
import { getAgentSchedule, clearAgentAbsence, queueAgentOffline } from "../sheets-client.ts";
import { createCalendarEvent } from "../google-calendar-client.ts";
import { runtimeCrmRepository } from "../repositories/runtime-crm.ts";
import { outboxDestinationForConversation } from "../outbox-routing.ts";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });
const authDir = runtimePaths.authDir;
const dataDir = runtimePaths.dataDir;

for (const dir of [authDir, dataDir]) {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

// ── DashBig intent helpers ───────────────────────────────────────────────────

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EMAIL_REGEX = /[\w.+%-]+@[\w-]+\.[\w.]+/;
const METRICS_KEYWORDS = [
	"métrica", "metrica",
	"cómo voy", "como voy",
	"mi csat", "mi aht", "mi rendimiento",
	"mis stats", "mis kpis", "mis kpi",
];
const METRICS_LATEST_KEYWORDS = [
	"ultimo dia", "último dia", "ultimo día", "último día",
	"ayer", "metricas hoy", "métricas hoy",
];
const SCHEDULE_KEYWORDS = [
	"mis turnos", "mi turno", "mi horario", "cuando trabajo",
	"cuándo trabajo", "mi programacion", "mi programación",
	"ver turnos", "ver mi horario",
];
const OFFLINE_KEYWORDS = [
	"inactivame", "inactivarme", "ponme fuera de línea", "ponme fuera de linea",
	"ponme offline", "ponerme fuera de línea", "ponerme fuera de linea",
	"cambiarme a fuera de línea", "cambiarme a offline", "ponme en offline",
	"se me cayó el internet", "se me cayo el internet",
	"se cayó el internet", "se cayo el internet",
	"perdí internet", "perdi internet", "se me fue el internet", "se fue el internet",
	"sin internet y tengo chat", "tengo chats y sin internet",
	"caí del sistema", "cai del sistema",
	"me quedé sin internet", "me quede sin internet",
	"ponme inactivo", "dejarme fuera de línea", "dejarme fuera de linea",
	"pasarme a fuera de línea", "pasarme a offline",
	// Variantes de "desconectar"
	"desconectarme",  // suelto cubre "me ayudas a desconectarme", "ayudame a desconectarme", etc.
	"desconéctame", "desconectame", "me desconecto", "quiero desconectarme",
	"necesito desconectarme", "me voy a desconectar", "voy a desconectarme",
	"podés desconectarme", "podes desconectarme", "me podés desconectar", "me podes desconectar",
	"me puedes desconectar", "desconectarme por favor",
	"me desconectes", "que me desconectes", "me desconecten", "que me desconecten",
	"me vas a desconectar", "me podrias desconectar", "podrías desconectarme",
	// Variantes de "quiero/necesito estar offline"
	"me voy offline", "me pongo offline", "quiero quedar offline", "quiero estar offline",
	"necesito estar offline", "necesito quedar offline", "voy a estar offline",
	"quiero quedar fuera de línea", "quiero estar fuera de línea",
	"quiero quedar fuera de linea", "quiero estar fuera de linea",
	"necesito estar fuera de línea", "necesito quedar fuera de línea",
	// Sácame / salir de línea
	"sácame de línea", "sacame de linea", "sácame de linea", "sacame de línea",
	"quiero salir de línea", "quiero salir de linea", "quiero que me pongas offline",
	"poneme offline", "ponganme offline", "poneme fuera de línea", "poneme fuera de linea",
	// Inactivo / dejar de atender
	"ponerme inactivo", "dejarme inactivo", "quedarme inactivo",
	"no quiero atender", "necesito salir del sistema",
	// Problemas de conexión genéricos
	"me quedé sin señal", "me quede sin señal", "perdí la señal", "perdi la señal",
	"se me cayó la conexión", "se me cayo la conexion", "sin conexión", "sin conexion",
	"problemas de conexión", "problemas de conexion", "se me fue la señal",
	// Falla de energía / corte de luz
	"se fue la luz", "se me fue la luz", "se cortó la luz", "se corto la luz",
	"sin luz", "no tengo luz", "corte de luz", "hubo un corte de luz",
	"se fue la energía", "se fue la energia", "se me fue la energía", "se me fue la energia",
	"falla de energía", "falla de energia", "falla eléctrica", "falla electrica",
	"fallo eléctrico", "fallo electrico", "corte de energía", "corte de energia",
	"sin energía", "sin energia", "se cortó la energía", "se corto la energia",
	"se fue la corriente", "se cortó la corriente", "se corto la corriente",
	"sin corriente", "apagón", "apagon", "hubo un apagón", "hubo un apagon",
	// Falla o daño del equipo / PC
	"se dañó mi pc", "se daño mi pc", "se rompió mi pc", "se rompio mi pc",
	"se quemó mi pc", "se quemo mi pc", "mi pc se dañó", "mi pc se daño",
	"mi pc se rompió", "mi pc se rompio", "falla en mi pc", "falla de pc",
	"problema con mi pc", "problemas con mi pc",
	"se dañó mi computador", "se daño mi computador",
	"se dañó mi computadora", "se daño mi computadora",
	"se rompió mi computador", "se rompio mi computador",
	"se rompió mi computadora", "se rompio mi computadora",
	"mi computador se dañó", "mi computador se daño",
	"mi computadora se dañó", "mi computadora se daño",
	"se me dañó el computador", "se me daño el computador",
	"se me dañó la pc", "se me daño la pc",
	"falla en mi computador", "falla en mi computadora",
	"mi pc está actualizando", "mi pc esta actualizando",
	"mi computador está actualizando", "mi computador esta actualizando",
	"mi computadora está actualizando", "mi computadora esta actualizando",
	"se está actualizando mi pc", "se esta actualizando mi pc",
	"está actualizando mi equipo", "esta actualizando mi equipo",
	"mi equipo está actualizando", "mi equipo esta actualizando",
	// Falla del aplicativo HC (donde están los chats)
	"hc no funciona", "hc no carga", "hc lento", "hc lenta", "lentitud en hc",
	"el hc no funciona", "el hc no carga", "se cae el hc", "se cae hc",
	"no me deja entrar al hc", "hc no abre", "se traba el hc", "se traba hc",
	"hc caído", "hc caido", "falla el hc", "falla en hc", "falla en el hc",
	"problemas con hc", "problemas con el hc", "el hc se cayó", "el hc se cayo",
];

const APPOINTMENT_KEYWORDS = [
	"agendar cita", "agendar una cita", "programar cita", "programar una cita",
	"crear cita", "agendar visita", "agendar reunion", "agendar reunión",
	"agendame", "agendarme", "agendar con", "cita con", "reservar cita",
	// Variantes de "quiero/necesito agendar/programar algo"
	"quiero agendar", "necesito agendar", "quisiera agendar", "puedo agendar",
	"quiero programar", "necesito programar", "quisiera programar",
	"agendar llamada", "programar llamada", "agendar una llamada", "programar una llamada",
	"agendar demo", "programar demo", "agendar una demo", "programar una demo",
	"sacar una cita", "sacar cita", "pedir una cita", "pedir cita",
	"agendar un turno", "programar un turno", "reservar un turno", "reservar turno",
	"coordinar una cita", "coordinar cita", "coordinar una visita", "coordinar visita",
	"coordinar una llamada", "coordinar llamada", "coordinar una reunion", "coordinar una reunión",
];

const ABSENCE_KEYWORDS = [
	"eliminar ausente", "eliminar mi ausente", "quitar ausente", "quitar mi ausente",
	"borrar ausente", "borrar mi ausente", "me marcaron ausente",
	"me pusieron ausente", "figure ausente", "figuro ausente",
	"aparezco ausente", "estoy marcado ausente", "saquen mi ausente",
	"quitar ausencia", "quitar la ausencia", "eliminar ausencia", "borrar ausencia",
	"eliminar mi ausencia", "borrar mi ausencia", "sacar mi ausencia",
	"eliminar la ausencia", "borrar la ausencia", "sacar la ausencia", "sacar ausencia",
	"quiten la ausencia", "quiten mi ausencia", "saquen la ausencia", "sacar ausente",
	"quitar falta", "eliminar falta", "borrar falta", "me marcaron falta",
	"sacar mi falta", "borrar mi falta", "eliminar mi falta",
	"tengo ausente", "me aparece ausente", "me sale ausente",
];

// ── Detección de "casi-aciertos" ────────────────────────────────────────────
// Señales más amplias/difusas que las listas de arriba (a propósito). Si un mensaje
// llega hasta el chat genérico de IA pero menciona algo de esto, es señal de que
// probablemente faltó una palabra clave — se loguea para revisar y ampliar listas.
const NEAR_MISS_SIGNALS: Record<string, string[]> = {
	appointment: ["cita", "agendar", "agenda", "demo", "reunion", "reunión", "visita"],
	offline: [
		"luz", "internet", "señal", "energia", "energía", "apagon", "apagón",
		"computador", "computadora", "falla electrica", "falla eléctrica", "hc lent",
		"hc no", "hc se", "hc cai", "se cayo el hc", "se cayó el hc",
	],
	absence: ["ausente", "ausencia", "falta"],
	schedule: ["mi turno", "mis turnos", "horario"],
	metrics: ["metricas", "métricas", "calificacion", "calificación", "desempeño", "kpi"],
};

function detectNearMissCategories(text: string): string[] {
	const lower = text.toLowerCase();
	const categories: string[] = [];
	for (const [category, signals] of Object.entries(NEAR_MISS_SIGNALS)) {
		if (signals.some((s) => lower.includes(s))) categories.push(category);
	}
	return categories;
}

// ── Monitoreo del grupo "CS reporte fallas Internet/Luz" ───────────────────
// Los agentes reportan ahí (no por DM) caídas de internet, luz y fallas de HC.
// El bot detecta esos reportes, identifica al remitente real (no al grupo) y
// le abre/continúa la conversación por privado para confirmar antes de tocar nada.
export const FALLAS_GROUP_JID = "5491151522899-1587685231@g.us";
const FALLAS_GROUP_DEBOUNCE_MS = 75_000; // ventana para agrupar mensajes separados del mismo agente
const FALLAS_GROUP_DEBOUNCE_TTL = 120; // segundos que vive el acumulado en Redis
const GROUP_REPORT_PENDING_TTL = 600; // 10 minutos para confirmar por privado

const RESOLVED_REPORT_KEYWORDS = [
	"ya llegó la luz", "ya llego la luz", "ya volvió la luz", "ya volvio la luz",
	"ya tengo luz", "ya tengo internet", "ya volvió el internet", "ya volvio el internet",
	"ya se solucionó", "ya se solucino", "ya está resuelto", "ya esta resuelto",
	"ya quedó resuelto", "ya quedo resuelto", "ya regresó la luz", "ya regreso la luz",
	"ya está normal", "ya esta normal", "ya volvió todo", "ya volvio todo",
];

const fallasGroupDebounceKey = (phone: string) => `bot:fallas_group_debounce:${phone}`;
const groupReportPendingKey = (phone: string) => `bot:group_report_pending:${phone}`;
const fallasGroupTimers = new Map<string, NodeJS.Timeout>();

interface GroupReportPending {
	id: number; // fila en group_failure_reports, para poder marcar confirmed/queued_offline
	email?: string;
	reason: string;
	formStatus: "yes" | "no" | "unknown";
	senderName: string;
}

function extractGroupMessageText(msg: any): string {
	return msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
}

/** El participante de un grupo puede venir como @lid; participantPn trae el teléfono real. */
function resolveFallasGroupSenderPhone(msg: any): string | undefined {
	const participantPn = msg.key?.participantPn as string | undefined;
	if (participantPn) return participantPn.replace(/\D/g, "");
	const participant = msg.key?.participant as string | undefined;
	if (!participant) return undefined;
	if (participant.endsWith("@s.whatsapp.net")) return participant.replace(/\D/g, "");
	if (participant.endsWith("@lid")) {
		const mapped = lidToPhoneJid.get(participant);
		if (mapped) return mapped.replace(/\D/g, "");
	}
	return undefined;
}

/** Detecta si mencionan haber llenado (o no) el formulario/archivo de desconexión. */
function detectFormStatus(text: string): "yes" | "no" | "unknown" {
	const lower = text.toLowerCase();
	if (!/formulario|archivo/.test(lower)) return "unknown";
	const negative = /no\s+(me\s+dej[oó]|pud[eo]|me\s+permiti[oó]|(lo\s+)?(llen[eé]|complet[eé]))/.test(lower);
	return negative ? "no" : "yes";
}

function isResolvedReportMessage(text: string): boolean {
	const lower = text.toLowerCase();
	return RESOLVED_REPORT_KEYWORDS.some((kw) => lower.includes(kw));
}

// Pending intent system: when any handler finds no profile it saves the intent
// type so that tryRegisterEmailReply can chain back to the right flow.
type PendingIntent =
	| "absence" | "absence_date" | "offline" | "offline_reason" | "schedule" | "metrics"
	| "appointment" | "appointment_role" | "appointment_phone" | "appointment_date" | "appointment_time" | "appointment_name";
const pendingIntentKey = (phone: string) => `bot:pending_intent:${phone}`;
const PENDING_INTENT_TTL = 300; // 5 minutes

// Acumula los datos parciales de una cita en construcción durante el flujo multi-turno.
// "role" distingue si quien escribe es un agente (agenda para un tercero) o un cliente
// nuevo de vtlik (agenda para sí mismo, con su propio número de WhatsApp).
interface AppointmentPartial {
	role?: "agent" | "client";
	clientPhone?: string;
	dateISO?: string;
	hour?: number;
	minute?: number;
	clientName?: string;
}
const pendingAppointmentDataKey = (phone: string) => `bot:pending_appointment:${phone}`;

// Legacy alias kept for the absence date follow-up check (multi-turn)
const absencePendingKey = (phone: string) => pendingIntentKey(phone);
const ABSENCE_PENDING_TTL = PENDING_INTENT_TTL;

// Detects absence-removal intent even when phrased with gerunds or natural language
// e.g. "me ayudas eliminando una ausencia", "ayuda eliminando mi ausente"
function matchesAbsenceIntent(msgLower: string): boolean {
	if (ABSENCE_KEYWORDS.some((kw) => msgLower.includes(kw))) return true;
	const hasAbsenceNoun = /\b(ausenci[ao]|ausente|faltas?)\b/.test(msgLower);
	const hasRemovalVerb = /\b(elimin[a-záéíóúñü]{0,6}|quit[a-záéíóúñü]{0,6}|borr[a-záéíóúñü]{0,6}|sac[a-záéíóúñü]{0,6}|remov[a-záéíóúñü]{0,6})\b/.test(msgLower);
	return hasAbsenceNoun && hasRemovalVerb;
}

function buildDirectReply(part1: string, part2 = "", part3 = ""): string {
	return JSON.stringify({
		response: { part_1: part1, part_2: part2, part_3: part3 },
		handoff: { required: false, reason: "" },
	});
}

function fmtPct(v: number | null): string {
	if (v === null) return "N/D";
	const pct = v <= 1 ? v * 100 : v;
	return `${pct.toFixed(1)}%`;
}

function fmtAht(seconds: number | null): string {
	if (!seconds) return "N/D";
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}:${String(s).padStart(2, "0")} min`;
}

/** "juan.perez@pedidosya.com" → "Juan". Si no hay punto en el local-part, usa todo. */
function deriveFirstNameFromEmail(email: string): string {
	const localPart = email.split("@")[0] || "";
	const firstToken = localPart.split(".")[0] || localPart;
	if (!firstToken) return "";
	return firstToken.charAt(0).toUpperCase() + firstToken.slice(1).toLowerCase();
}

function vsObjective(
	value: number | null,
	objKey: string,
	objectives: Record<string, { target: number; condition: string }>,
): string {
	if (value === null || !objectives[objKey]) return "";
	const { target, condition } = objectives[objKey];
	// Time metrics (seconds) are compared raw; percentage metrics normalized to 0–1
	const isTime = ["aht", "frt", "wut", "att"].includes(objKey);
	const v = isTime ? value : (value <= 1 ? value : value / 100);
	const meetsTarget =
		condition === ">=" ? v >= target :
		condition === "<=" ? v <= target : v >= target;
	return meetsTarget ? " ✅" : " ❌";
}

async function tryIssueLookupReply(caseId: string): Promise<string | null> {
	const result = await lookupCase(caseId);
	if (!result) return null;
	const lines = [
		`🔍 *Caso encontrado*`,
		`ID: ${caseId.substring(0, 8)}...`,
		result.agentEmail ? `Agente: ${result.agentEmail}` : "",
		result.cr3 ? `CR3: ${result.cr3}` : "",
		result.lob ? `LOB: ${result.lob}` : "",
		result.fecha ? `Fecha: ${result.fecha.toString().substring(0, 10)}` : "",
	].filter(Boolean);
	return buildDirectReply(lines.join("\n"));
}

async function tryAgentMetricsReply(phone: string, mode: "mtd" | "latest" = "mtd"): Promise<string | null> {
	const profile = await getAgentProfile(phone);
	if (!profile) {
		await redisClient.set(pendingIntentKey(phone), "metrics", "EX", PENDING_INTENT_TTL);
		return buildDirectReply(
			"Para ver tus métricas necesito tu email corporativo 📧",
			'Respondé con tu email corporativo, ej: "luis@pedidosya.com"',
		);
	}

	const data = await getAgentMetrics(profile.email, mode);
	if (!data) return buildDirectReply(
		"No encontré datos de métricas para tu usuario 😕",
		"Verificá que tu email sea el correcto o contactá al TL.",
	);

	const { metrics, objectives, period, lob } = data;
	const obj = lob && objectives[lob] ? objectives[lob] : {};
	const firstName = deriveFirstNameFromEmail(profile.email);
	const modeLabel = mode === "latest" ? `📅 Último día: ${period.end}` : `📊 Acumulado: ${period.start} → ${period.end}`;
	const lines = [
		`*${firstName ? `${firstName}, tus` : "Tus"} métricas* ${lob ? `· ${lob}` : ""}`,
		modeLabel,
		`CSAT: ${fmtPct(metrics.csat)}${vsObjective(metrics.csat, "csat", obj)}`,
		`AHT: ${fmtAht(metrics.aht_seconds)}${vsObjective(metrics.aht_seconds, "aht", obj)}`,
		`GA Crítica: ${fmtPct(metrics.ga_critica)}${vsObjective(metrics.ga_critica, "gacrit", obj)}`,
		metrics.apego !== null ? `Apego: ${fmtPct(metrics.apego)}${vsObjective(metrics.apego, "apego", obj)}` : "",
		`Interacciones: ${metrics.total_interactions}`,
		`\n_Para ver el último día: "ultimo dia"_`,
	].filter(Boolean);
	return buildDirectReply(lines.join("\n"));
}

async function tryScheduleReply(phone: string): Promise<string | null> {
	const profile = await getAgentProfile(phone);
	if (!profile) {
		await redisClient.set(pendingIntentKey(phone), "schedule", "EX", PENDING_INTENT_TTL);
		return buildDirectReply(
			"Para ver tus turnos necesito tu email corporativo 📧",
			'Respondé con tu email, ej: "luis@pedidosya.com"',
		);
	}

	const settings = await getSettings();
	const id1 = (settings.programacion_1_id as string) || "";
	const id2 = (settings.programacion_2_id as string) || "";
	const ids  = [id1, id2].filter(Boolean);

	if (!ids.length) {
		return buildDirectReply("Las programaciones no están configuradas aún. Contactá al TL.");
	}

	try {
		const shifts = await getAgentSchedule(profile.email, ids);
		if (!shifts.length) {
			return buildDirectReply(
				"No encontré turnos registrados para tu usuario 😕",
				"Verificá con el TL que tu email esté en la planilla.",
			);
		}

		const firstName = deriveFirstNameFromEmail(profile.email);
		const lines = [`📅 *${firstName ? `${firstName}, tus` : "Tus"} turnos*`];
		for (const s of shifts) {
			const parts = [s.fecha, s.horario, s.estado].filter(Boolean).join(" · ");
			const novedad = s.novedades ? ` — ${s.novedades}` : "";
			lines.push(`${parts}${novedad}`);
		}
		return buildDirectReply(lines.join("\n"));
	} catch (err) {
		console.error("[schedule] Error:", err);
		return buildDirectReply("No pude consultar tus turnos en este momento. Intentá de nuevo en unos minutos.");
	}
}

/** Parse a date from the message and return YYYY-MM-DD, or undefined if none found */
function parseDateFromMessage(text: string): string | undefined {
	const lower = text.toLowerCase();

	// "hoy" → fecha de hoy en Argentina
	if (/\bhoy\b/.test(lower)) {
		return new Date(
			new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }),
		).toISOString().slice(0, 10);
	}

	// "mañana" / "manana" → fecha de mañana en Argentina
	if (/\bma[nñ]ana\b/.test(lower)) {
		const d = new Date(
			new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }),
		);
		d.setDate(d.getDate() + 1);
		return d.toISOString().slice(0, 10);
	}

	// DD/MM/YYYY or DD-MM-YYYY
	let m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
	if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
	// DD/MM or DD-MM (assume current year, Argentina time)
	m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
	if (m) {
		const year = new Date(
			new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }),
		).getFullYear();
		return `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
	}
	return undefined;
}

/** Parse a time from the message and return {hour, minute}, or undefined if none found */
function parseTimeFromMessage(text: string): { hour: number; minute: number } | undefined {
	const lower = text.toLowerCase();

	// HH:mm (24h) — "15:00", "9:30"
	let m = lower.match(/\b(\d{1,2}):(\d{2})\b/);
	if (m) {
		const hour = parseInt(m[1], 10);
		const minute = parseInt(m[2], 10);
		if (hour <= 23 && minute <= 59) return { hour, minute };
	}

	// "3pm" / "3 pm" / "3:30pm"
	m = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
	if (m) {
		let hour = parseInt(m[1], 10) % 12;
		const minute = m[2] ? parseInt(m[2], 10) : 0;
		if (m[3] === "pm") hour += 12;
		return { hour, minute };
	}

	// "a las 3" / "a las 3 de la tarde" / "3 de la tarde" / "3 de la mañana"
	m = lower.match(/\b(?:a las\s+)?(\d{1,2})\s*(?:de la (tarde|noche|ma[nñ]ana))?\b/);
	if (m && /\b(a las|de la tarde|de la noche|de la ma[nñ]ana)\b/.test(lower)) {
		let hour = parseInt(m[1], 10);
		const period = m[2];
		if ((period === "tarde" || period === "noche") && hour < 12) hour += 12;
		return { hour: hour % 24, minute: 0 };
	}

	return undefined;
}

/** Extrae el teléfono del cliente de un mensaje de agendamiento (7-15 dígitos corridos) */
function parseClientPhoneFromMessage(text: string): string | undefined {
	const m = text.match(/\b(\+?\d{7,15})\b/);
	return m ? m[1].replace(/\D/g, "") : undefined;
}

async function stashAppointmentPartial(phone: string, message: string): Promise<AppointmentPartial> {
	const raw = await redisClient.get(pendingAppointmentDataKey(phone));
	const partial: AppointmentPartial = raw ? JSON.parse(raw) : {};

	if (!partial.clientPhone) {
		const clientPhone = parseClientPhoneFromMessage(message);
		if (clientPhone) partial.clientPhone = clientPhone;
	}
	if (!partial.dateISO) {
		const dateISO = parseDateFromMessage(message);
		if (dateISO) partial.dateISO = dateISO;
	}
	if (partial.hour === undefined) {
		const time = parseTimeFromMessage(message);
		if (time) {
			partial.hour = time.hour;
			partial.minute = time.minute;
		}
	}
	if (!partial.clientName) {
		// Una vez removidos teléfono/fecha/hora del texto, lo que queda es el nombre/motivo.
		const remainder = message
			.replace(/\b(\+?\d{7,15})\b/, "")
			.replace(/\b(\d{1,2})[\/\-](\d{1,2})([\/\-](\d{4}))?\b/, "")
			.replace(/\b(\d{1,2}):(\d{2})\b/, "")
			.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, "")
			.replace(/\b(?:a las\s+)?\d{1,2}\s*(?:de la (?:tarde|noche|ma[nñ]ana))\b/i, "")
			.replace(/\ba las\s+\d{1,2}\b/i, "")
			.replace(/\b(agendar|programar|crear|reservar)\b.*?\b(cita|visita|reunion|reunión)\b/i, "")
			.replace(/\bcon\b/i, "")
			.replace(/\bma[nñ]ana\b/i, "")
			.replace(/\bhoy\b/i, "")
			.replace(/[,.]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (remainder.length >= 2) partial.clientName = remainder.slice(0, 140);
	}

	await redisClient.set(pendingAppointmentDataKey(phone), JSON.stringify(partial), "EX", PENDING_INTENT_TTL);
	return partial;
}

async function clearAppointmentState(phone: string): Promise<void> {
	await redisClient.del(pendingIntentKey(phone));
	await redisClient.del(pendingAppointmentDataKey(phone));
}

async function getAppointmentPartial(phone: string): Promise<AppointmentPartial> {
	const raw = await redisClient.get(pendingAppointmentDataKey(phone));
	return raw ? JSON.parse(raw) : {};
}

async function saveAppointmentPartial(phone: string, partial: AppointmentPartial): Promise<void> {
	await redisClient.set(pendingAppointmentDataKey(phone), JSON.stringify(partial), "EX", PENDING_INTENT_TTL);
}

async function finalizeAppointment(
	phone: string,
	profile: { phone: string; email: string } | null,
	partial: Required<Omit<AppointmentPartial, "role">>,
): Promise<string> {
	const settings = await getSettings();
	const durationMinutes = Number(settings.appointment_duration_minutes ?? 30);
	const calendarId = (settings.appointments_calendar_id as string) || "";
	const refreshToken = (settings.google_oauth_refresh_token as string) || "";

	const [year, month, day] = partial.dateISO.split("-").map((p) => parseInt(p, 10));
	const pad = (n: number) => String(n).padStart(2, "0");
	const startLocal = `${year}-${pad(month)}-${pad(day)}T${pad(partial.hour)}:${pad(partial.minute)}:00`;
	const appointmentAt = new Date(`${startLocal}-03:00`); // Argentina (UTC-3, sin DST actual)

	// Si no hay perfil de agente, quien agenda es el propio cliente (autoagendado).
	const bookedBy = profile ? profile.email : `cliente ${partial.clientPhone} (autoagendado)`;

	let calendarEventId: string | null = null;
	if (calendarId && refreshToken) {
		const endDate = new Date(appointmentAt.getTime() + durationMinutes * 60_000);
		const endLocal = endDate.toLocaleString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" }).replace(" ", "T");
		const event = await createCalendarEvent({
			calendarId,
			summary: `Cita con ${partial.clientName}`,
			description: `Agendada por ${bookedBy} vía WhatsApp.`,
			startISO: startLocal,
			endISO: endLocal,
			refreshToken,
		});
		calendarEventId = event?.id ?? null;
	}

	const clientJid = `${partial.clientPhone}@s.whatsapp.net`;
	const conversation = await getOrCreateConversation(partial.clientPhone, clientJid, partial.clientName);

	await saveCrmTask({
		task_type: "appointment",
		title: `Cita con ${partial.clientName}`,
		description: `Agendada por ${bookedBy}`,
		conversation_id: conversation.id,
		agent_phone: profile ? phone : null,
		calendar_event_id: calendarEventId,
		appointment_at: appointmentAt,
		due_at: appointmentAt,
	});

	await clearAppointmentState(phone);

	const fechaLegible = appointmentAt.toLocaleString("es-AR", {
		timeZone: "America/Argentina/Buenos_Aires",
		dateStyle: "short",
		timeStyle: "short",
	});

	const firstName = profile ? deriveFirstNameFromEmail(profile.email) : "";
	return buildDirectReply(
		firstName ? `✅ Listo, ${firstName}: cita agendada` : "✅ Cita agendada",
		`Cliente: ${partial.clientName} (${partial.clientPhone})`,
		`Fecha: ${fechaLegible}${calendarEventId ? " · agregada al calendario" : ""}`,
	);
}

/** Pide los datos que falten (cliente/fecha/hora/nombre) y agenda cuando ya están completos. */
async function continueAppointmentFlow(
	phone: string,
	partial: AppointmentPartial,
	profile: { phone: string; email: string } | null,
): Promise<string> {
	if (!partial.clientPhone) {
		await redisClient.set(pendingIntentKey(phone), "appointment_phone", "EX", PENDING_INTENT_TTL);
		return buildDirectReply("¿Cuál es el número de WhatsApp del cliente?", 'Ej: "5512345678"');
	}
	if (!partial.dateISO) {
		await redisClient.set(pendingIntentKey(phone), "appointment_date", "EX", PENDING_INTENT_TTL);
		return buildDirectReply("¿Para qué fecha es la cita?", 'Ej: "mañana" o "25/06/2026"');
	}
	if (partial.hour === undefined) {
		await redisClient.set(pendingIntentKey(phone), "appointment_time", "EX", PENDING_INTENT_TTL);
		return buildDirectReply("¿A qué hora?", 'Ej: "15:00" o "3pm"');
	}
	if (!partial.clientName) {
		await redisClient.set(pendingIntentKey(phone), "appointment_name", "EX", PENDING_INTENT_TTL);
		return buildDirectReply(
			profile ? "¿Nombre del cliente o motivo de la cita?" : "¿Cuál es tu nombre?",
			profile ? 'Ej: "Juan Pérez, presupuesto"' : 'Ej: "Juan Pérez"',
		);
	}

	return await finalizeAppointment(phone, profile, partial as Required<Omit<AppointmentPartial, "role">>);
}

async function tryScheduleAppointmentReply(phone: string, message: string): Promise<string | null> {
	const profile = await getAgentProfile(phone);

	if (profile) {
		const partial = await stashAppointmentPartial(phone, message);
		return await continueAppointmentFlow(phone, partial, profile);
	}

	// Sin perfil de agente vinculado: puede ser un agente que todavía no registró su email,
	// o un cliente nuevo de vtlik que quiere agendar para sí mismo. Hay que preguntar para
	// no pedirle "tu email corporativo" a un cliente externo, ni agendarle una cita a ciegas.
	let partial = await getAppointmentPartial(phone);

	if (partial.role === "agent") {
		await stashAppointmentPartial(phone, message);
		await redisClient.set(pendingIntentKey(phone), "appointment", "EX", PENDING_INTENT_TTL);
		return buildDirectReply(
			"Para agendar una cita necesito tu email corporativo 📧",
			'Respondé con tu email, ej: "luis@pedidosya.com"',
		);
	}

	if (partial.role === "client") {
		partial = await stashAppointmentPartial(phone, message);
		partial.clientPhone = phone; // el cliente agenda para sí mismo, con su propio número
		await saveAppointmentPartial(phone, partial);
		return await continueAppointmentFlow(phone, partial, null);
	}

	const pending = await redisClient.get(pendingIntentKey(phone));
	if (pending === "appointment_role") {
		// Esta respuesta es exclusivamente "agente"/"cliente": no se parsea como fecha/hora/nombre.
		const lower = message.toLowerCase();
		if (lower.includes("agente")) {
			partial.role = "agent";
			await saveAppointmentPartial(phone, partial);
			await redisClient.set(pendingIntentKey(phone), "appointment", "EX", PENDING_INTENT_TTL);
			return buildDirectReply(
				"Para agendar una cita necesito tu email corporativo 📧",
				'Respondé con tu email, ej: "luis@pedidosya.com"',
			);
		}
		if (lower.includes("cliente")) {
			partial.role = "client";
			partial.clientPhone = phone; // el cliente agenda para sí mismo, con su propio número
			await saveAppointmentPartial(phone, partial);
			return await continueAppointmentFlow(phone, partial, null);
		}
		return buildDirectReply('No entendí 🙏 Respondé "agente" o "cliente" para continuar.');
	}

	// Primera vez que pide una cita sin perfil registrado: guardar lo que ya haya dado y preguntar el rol.
	partial = await stashAppointmentPartial(phone, message);
	await redisClient.set(pendingIntentKey(phone), "appointment_role", "EX", PENDING_INTENT_TTL);
	return buildDirectReply(
		"¿Sos agente de vtlik o querés agendar como cliente?",
		'Respondé "agente" o "cliente".',
	);
}

async function tryRemoveAbsenceReply(phone: string, message: string): Promise<string | null> {
	const profile = await getAgentProfile(phone);
	if (!profile) {
		// No profile yet — save intent so the registration flow can chain back here
		await redisClient.set(pendingIntentKey(phone), "absence", "EX", PENDING_INTENT_TTL);
		return buildDirectReply(
			"Para gestionar tu asistencia necesito tu email corporativo 📧",
			'Respondé con tu email, ej: "luis@pedidosya.com"',
		);
	}

	const settings = await getSettings();
	const ids = [
		(settings.programacion_1_id as string) || "",
		(settings.programacion_2_id as string) || "",
	].filter(Boolean);

	if (!ids.length) {
		return buildDirectReply("Las programaciones no están configuradas. Contactá al TL.");
	}

	const targetDate = parseDateFromMessage(message);

	if (!targetDate) {
		// No date yet — ask for it and keep the intent alive in Redis
		await redisClient.set(pendingIntentKey(phone), "absence_date", "EX", PENDING_INTENT_TTL);
		return buildDirectReply(
			"Para eliminar la ausencia necesito la fecha 📅",
			'Indicá el día/mes/año, ej: "08/06/2026" o simplemente "hoy".',
		);
	}

	// Date received — clear pending state
	await redisClient.del(absencePendingKey(phone));

	try {
		const result = await clearAgentAbsence(profile.email, ids, targetDate);

		if (result.success) {
			const firstName = deriveFirstNameFromEmail(profile.email);
			const detail = [result.fecha, result.horario].filter(Boolean).join(" — ");
			return buildDirectReply(
				firstName ? `✅ Listo, ${firstName}: ausente eliminado correctamente` : "✅ Ausente eliminado correctamente",
				detail ? `Turno: ${detail}` : "",
				"Si el sistema lo vuelve a marcar, contactá al TL para revisarlo.",
			);
		}

		if (result.reason === "multiple") {
			const lines = ["Tenés ausentes en varias fechas. Indicá cuál querés eliminar:"];
			const seen = new Set<string>();
			for (const a of result.absences) {
				const key = `${a.fecha}|${a.horario}`;
				if (seen.has(key)) continue;
				seen.add(key);
				lines.push(`• ${[a.fecha, a.horario].filter(Boolean).join(" — ")}`);
			}
			lines.push('Escribí: "eliminar ausente DD/MM" con la fecha exacta.');
			// Keep pending state so next message (with corrected date) is also caught
			await redisClient.set(pendingIntentKey(phone), "absence_date", "EX", PENDING_INTENT_TTL);
			return buildDirectReply(lines.join("\n"));
		}

		if (result.reason === "not_found") {
			return buildDirectReply(
				`No encontré ausente para el ${targetDate.split("-").reverse().join("/")} 🤔`,
				"Verificá que el email registrado sea el correcto o consultá con el TL.",
			);
		}

		return buildDirectReply("No pude procesar tu solicitud en este momento. Intentá de nuevo.");
	} catch (err) {
		console.error("[absence] Error:", err);
		return buildDirectReply("Ocurrió un error al intentar eliminar el ausente. Intentá de nuevo en unos minutos.");
	}
}

async function tryGoOfflineReply(phone: string, message: string): Promise<string | null> {
	const profile = await getAgentProfile(phone);
	if (!profile) {
		await redisClient.set(pendingIntentKey(phone), "offline", "EX", PENDING_INTENT_TTL);
		return buildDirectReply(
			"Para gestionar tu estado necesito tu email corporativo 📧",
			'Respondé con tu email, ej: "luis@pedidosya.com"',
		);
	}

	const settings = await getSettings();
	const spreadsheetId = (settings.offline_queue_sheet_id as string) || "";

	if (!spreadsheetId) {
		return buildDirectReply(
			"La función de cambio de estado no está configurada. Contactá al TL.",
		);
	}

	const msgLower = message.toLowerCase();
	const isInternetIssue = msgLower.includes("internet") || msgLower.includes("caí") || msgLower.includes("cai")
		|| msgLower.includes("cay") || msgLower.includes("señal") || msgLower.includes("conexi");
	const isPowerOrPcIssue = msgLower.includes("luz") || msgLower.includes("energ") || msgLower.includes("corriente")
		|| msgLower.includes("apag") || msgLower.includes("electric") || msgLower.includes("eléctric")
		|| /\bpc\b/.test(msgLower) || msgLower.includes("computador");
	const reason = isInternetIssue
		? "Internet caído — solicitud del agente"
		: isPowerOrPcIssue
			? "Falla de energía/PC — solicitud del agente"
			: message.trim() || "Solicitud directa del agente";

	try {
		const queued = await queueAgentOffline(profile.email, reason, spreadsheetId);
		if (queued) {
			await redisClient.del(pendingIntentKey(phone));
			const firstName = deriveFirstNameFromEmail(profile.email);
			return buildDirectReply(
				firstName ? `✅ Listo, ${firstName}` : "✅ Solicitud recibida",
				"Voy a cambiarte a *Fuera de línea* en los próximos 1-3 minutos.",
				"Si tenés chats activos esperá a que el sistema procese el cambio.",
			);
		}
		return buildDirectReply("No pude registrar la solicitud en este momento. Intentá de nuevo o contactá al TL.");
	} catch (err) {
		console.error("[offline] Error:", err);
		return buildDirectReply("Ocurrió un error al registrar tu solicitud. Intentá de nuevo en unos minutos.");
	}
}

/**
 * Se llama una vez vencida la ventana de debounce de un reporte en el grupo de fallas.
 * Junta los mensajes acumulados del mismo agente, intenta resolver el correo (del texto
 * o del perfil ya vinculado a ese número) y le abre la conversación por privado para
 * confirmar antes de tocar nada. Siempre avisa a Telegram, confirme o no el agente.
 */
async function processFallasGroupReport(phone: string, senderName: string): Promise<void> {
	const debounceKey = fallasGroupDebounceKey(phone);
	const raw = await redisClient.get(debounceKey);
	await redisClient.del(debounceKey);
	if (!raw) return;

	const parts: string[] = JSON.parse(raw);
	const reason = parts.join(" ").trim();
	if (!reason) return;

	const emailMatch = reason.match(EMAIL_REGEX);
	const profile = await getAgentProfile(phone);
	// Si el número ya está registrado, su correo verificado manda siempre — un correo
	// suelto en el texto (typo, el de un compañero, etc.) nunca debe pisarlo.
	const email = profile?.email || (emailMatch ? emailMatch[0].toLowerCase() : undefined);
	const formStatus = detectFormStatus(reason);

	try {
		await notifyGroupFailureReport({ phone, senderName, email, reason, formStatus, resolved: false });
	} catch (err) {
		console.error("[fallas-group] Error notificando a Telegram:", err);
	}

	let reportId: number | null = null;
	try {
		const saved = await insertGroupFailureReport({ phone, senderName, email, reason, formStatus });
		reportId = saved.id;
	} catch (err) {
		console.error("[fallas-group] Error guardando el reporte en la base:", err);
	}
	if (reportId === null) return; // sin fila persistida no podemos rastrear la confirmación

	const pending: GroupReportPending = { id: reportId, email, reason, formStatus, senderName };
	await redisClient.set(groupReportPendingKey(phone), JSON.stringify(pending), "EX", GROUP_REPORT_PENDING_TTL);

	if (!(globalSock && isSocketConnected)) return;

	const formNote = formStatus === "yes" ? "✅ sí" : formStatus === "no" ? "⚠️ no" : "no detectado";
	const firstName = email ? deriveFirstNameFromEmail(email) : "";
	const recap = [
		firstName ? `Hola ${firstName}, vi tu reporte en el grupo de fallas 👀` : "Vi tu reporte en el grupo de fallas 👀",
		email ? `Correo: ${email}` : "No identifiqué tu correo — respondé acá con tu correo corporativo para poder gestionarlo.",
		`Motivo: ${reason.slice(0, 300)}`,
		`Formulario de desconexión: ${formNote}`,
		email ? '¿Es correcto? Respondé "sí" para que te cambie a *Fuera de línea*.' : "",
	].filter(Boolean).join("\n");

	try {
		await globalSock.sendMessage(`${phone}@s.whatsapp.net`, { text: recap });
	} catch (err) {
		console.error(`[fallas-group] No se pudo enviar el DM de confirmación a ${phone}:`, err);
	}
}

/** Detecta un mensaje del grupo de fallas y programa su procesamiento agregado por agente. */
async function handleFallasGroupMessage(msg: any): Promise<void> {
	const text = extractGroupMessageText(msg).trim();
	if (!text) return;

	const phone = resolveFallasGroupSenderPhone(msg);
	if (!phone) return;

	const senderName = (msg.pushName as string) || phone;

	if (isResolvedReportMessage(text)) {
		// Limpiar cualquier confirmación pendiente: ya se resolvió solo, no tiene sentido
		// procesar un "sí" desactualizado contra un reporte que ya no aplica.
		await redisClient.del(groupReportPendingKey(phone));
		try {
			await markLatestGroupFailureReportResolved(phone);
		} catch (err) {
			console.error("[fallas-group] Error marcando el reporte como resuelto en la base:", err);
		}
		try {
			await notifyGroupFailureReport({ phone, senderName, reason: text, formStatus: "unknown", resolved: true });
		} catch (err) {
			console.error("[fallas-group] Error notificando resolución a Telegram:", err);
		}
		return;
	}

	// Solo arranca una acumulación nueva si el mensaje en sí menciona una falla. Si ya hay
	// un reporte en curso para este agente, cualquier mensaje suyo se suma (correo, LOB,
	// "ayuda", etc.) aunque no repita la palabra clave — así no se pierde info repartida
	// en varios mensajes seguidos.
	const lower = text.toLowerCase();
	const hasFailureKeyword = OFFLINE_KEYWORDS.some((kw) => lower.includes(kw));
	const hasActiveReport = fallasGroupTimers.has(phone);
	if (!hasFailureKeyword && !hasActiveReport) return;

	const debounceKey = fallasGroupDebounceKey(phone);
	const raw = await redisClient.get(debounceKey);
	const accumulated: string[] = raw ? JSON.parse(raw) : [];
	accumulated.push(text);
	await redisClient.set(debounceKey, JSON.stringify(accumulated), "EX", FALLAS_GROUP_DEBOUNCE_TTL);

	if (hasActiveReport) return; // ya hay un timer corriendo, este mensaje solo se acumula
	const timer = setTimeout(() => {
		fallasGroupTimers.delete(phone);
		processFallasGroupReport(phone, senderName).catch((err) =>
			console.error("[fallas-group] Error procesando reporte agregado:", err),
		);
	}, FALLAS_GROUP_DEBOUNCE_MS);
	fallasGroupTimers.set(phone, timer);
}

/**
 * Atiende la respuesta por DM a la confirmación que se envió tras un reporte en el grupo
 * de fallas. Tiene prioridad sobre el resto de los intents mientras esté pendiente.
 */
async function tryHandleGroupReportConfirmation(phone: string, message: string): Promise<string | null> {
	const raw = await redisClient.get(groupReportPendingKey(phone));
	if (!raw) return null;
	const pending: GroupReportPending = JSON.parse(raw);

	const emailMatch = message.match(EMAIL_REGEX);
	if (!pending.email && emailMatch) {
		pending.email = emailMatch[0].toLowerCase();
		await redisClient.set(groupReportPendingKey(phone), JSON.stringify(pending), "EX", GROUP_REPORT_PENDING_TTL);
		return buildDirectReply(
			`Correo: ${pending.email}`,
			`Motivo: ${pending.reason}`,
			'¿Es correcto? Respondé "sí" para que te cambie a *Fuera de línea*.',
		);
	}

	const trimmedLower = message.trim().toLowerCase();
	const isConfirmation = /^(s[ií]|correcto|as[ií] es|exacto|eso es|confirmo)\b/.test(trimmedLower);
	const isNegative = /^(no|negativo)\b/.test(trimmedLower);

	if (isConfirmation) {
		if (!pending.email) {
			return buildDirectReply("Antes necesito tu correo corporativo 📧 para poder gestionar el cambio.");
		}
		const settings = await getSettings();
		const spreadsheetId = (settings.offline_queue_sheet_id as string) || "";
		await redisClient.del(groupReportPendingKey(phone));
		if (!spreadsheetId) {
			return buildDirectReply("La función de cambio de estado no está configurada. Contactá al TL.");
		}
		try {
			const queued = await queueAgentOffline(pending.email, `${pending.reason} (reportado en grupo de fallas)`, spreadsheetId);
			try {
				await markGroupFailureReportConfirmed(pending.id, queued);
			} catch (err) {
				console.error("[fallas-group] Error marcando el reporte como confirmado en la base:", err);
			}
			if (queued) {
				return buildDirectReply(
					"✅ Listo",
					"Voy a cambiarte a *Fuera de línea* en los próximos 1-3 minutos.",
					"Si tenés chats activos esperá a que el sistema procese el cambio.",
				);
			}
			return buildDirectReply("No pude registrar la solicitud en este momento. Contactá al TL.");
		} catch (err) {
			console.error("[fallas-group] Error confirmando offline:", err);
			await markGroupFailureReportConfirmed(pending.id, false).catch(() => {});
			return buildDirectReply("Ocurrió un error al registrar tu solicitud. Intentá de nuevo en unos minutos.");
		}
	}

	if (isNegative) {
		await redisClient.del(groupReportPendingKey(phone));
		return buildDirectReply("Ok, no hago nada. Si necesitás algo escribime directamente acá 🙏");
	}

	// Cualquier otro texto se toma como una corrección del motivo.
	pending.reason = message.trim() || pending.reason;
	await redisClient.set(groupReportPendingKey(phone), JSON.stringify(pending), "EX", GROUP_REPORT_PENDING_TTL);
	return buildDirectReply(
		pending.email ? `Correo: ${pending.email}` : "Todavía no tengo tu correo corporativo.",
		`Motivo actualizado: ${pending.reason}`,
		'¿Es correcto? Respondé "sí" para continuar.',
	);
}

async function tryRegisterEmailReply(phone: string, message: string): Promise<string | null> {
	const emailMatch = message.match(EMAIL_REGEX);
	if (!emailMatch) return null;
	const email = emailMatch[0].toLowerCase();

	// Verificar si este teléfono ya tiene un email vinculado
	const existing = await getAgentProfile(phone);
	if (existing) {
		if (existing.email.toLowerCase() === email) {
			// Es el mismo email — encadenar al intent pendiente si lo hay, igual que en registro nuevo
			const pending = (await redisClient.get(pendingIntentKey(phone))) as PendingIntent | null;
			const firstName = deriveFirstNameFromEmail(existing.email);
			const alreadyRegistered = firstName
				? `✅ Hola ${firstName}, tu email *${email}* ya está registrado.`
				: `✅ Tu email *${email}* ya está registrado.`;

			if (pending === "absence" || pending === "absence_date") {
				await redisClient.set(pendingIntentKey(phone), "absence_date", "EX", PENDING_INTENT_TTL);
				return buildDirectReply(
					alreadyRegistered,
					"Para eliminar la ausencia necesito la fecha 📅",
					'Indicá el día/mes/año, ej: "08/06/2026" o simplemente "hoy".',
				);
			}

			const capabilities = "📊 métricas · 📅 turnos · ✏️ eliminar ausencias · 🔴 pasarte a offline";

			if (pending === "schedule") {
				await redisClient.del(pendingIntentKey(phone));
				const scheduleReply = await tryScheduleReply(phone);
				return scheduleReply ?? buildDirectReply(
					alreadyRegistered,
					`Podés pedir: ${capabilities}`,
				);
			}

			if (pending === "metrics") {
				await redisClient.del(pendingIntentKey(phone));
				const metricsReply = await tryAgentMetricsReply(phone, "mtd");
				return metricsReply ?? buildDirectReply(
					alreadyRegistered,
					`Podés pedir: ${capabilities}`,
				);
			}

			if (pending === "offline") {
				await redisClient.set(pendingIntentKey(phone), "offline_reason", "EX", PENDING_INTENT_TTL);
				return buildDirectReply(
					alreadyRegistered,
					`Podés pedir: ${capabilities}`,
					'Para pasarte a offline ahora respondé con el motivo, ej: "internet caído".',
				);
			}

			if (pending === "appointment" || pending === "appointment_role") {
				await redisClient.del(pendingIntentKey(phone));
				const reply = await tryScheduleAppointmentReply(phone, "");
				return reply ?? buildDirectReply(
					alreadyRegistered,
					`Podés pedir: ${capabilities}`,
				);
			}

			return buildDirectReply(
				alreadyRegistered,
				`Con él podés pedir: ${capabilities}.`,
			);
		}
		// Intento de cambiar a otro email — bloqueado
		return buildDirectReply(
			`⚠️ Ya tenés vinculado el email *${existing.email}* a este número.`,
			"Para cambiar de email necesitás que el admin desvincule tu número actual.",
			"Contactá a tu supervisor para gestionarlo.",
		);
	}

	// Verificar si el email ya está vinculado a OTRO teléfono
	const takenBy = await getAgentProfileByEmail(email);
	if (takenBy) {
		return buildDirectReply(
			`⚠️ El email *${email}* ya está vinculado a otro número.`,
			"Si cambiaste de número, pedile al admin que desvincule el número anterior.",
			"Contactá a tu supervisor para gestionarlo.",
		);
	}

	// Registro libre — guardar
	await saveAgentProfile(phone, email);

	// Encadenar al intent original si había uno pendiente
	const pending = (await redisClient.get(pendingIntentKey(phone))) as PendingIntent | null;
	const firstName = deriveFirstNameFromEmail(email);
	const justRegistered = firstName
		? `✅ ¡Hola ${firstName}! Email registrado: *${email}*`
		: `✅ Email registrado: *${email}*`;

	if (pending === "absence" || pending === "absence_date") {
		await redisClient.set(pendingIntentKey(phone), "absence_date", "EX", PENDING_INTENT_TTL);
		return buildDirectReply(
			justRegistered,
			"Para eliminar la ausencia necesito la fecha 📅",
			'Indicá el día/mes/año, ej: "08/06/2026" o simplemente "hoy".',
		);
	}

	const capabilities = "📊 métricas · 📅 turnos · ✏️ eliminar ausencias · 🔴 pasarte a offline";

	if (pending === "schedule") {
		await redisClient.del(pendingIntentKey(phone));
		const scheduleReply = await tryScheduleReply(phone);
		return scheduleReply ?? buildDirectReply(
			justRegistered,
			`Podés pedir: ${capabilities}`,
		);
	}

	if (pending === "metrics") {
		await redisClient.del(pendingIntentKey(phone));
		const metricsReply = await tryAgentMetricsReply(phone, "mtd");
		return metricsReply ?? buildDirectReply(
			justRegistered,
			`Podés pedir: ${capabilities}`,
		);
	}

	if (pending === "offline") {
		await redisClient.set(pendingIntentKey(phone), "offline_reason", "EX", PENDING_INTENT_TTL);
		return buildDirectReply(
			justRegistered,
			`Podés pedir: ${capabilities}`,
			'Para pasarte a offline ahora respondé con el motivo, ej: "internet caído".',
		);
	}

	if (pending === "appointment" || pending === "appointment_role") {
		await redisClient.del(pendingIntentKey(phone));
		const reply = await tryScheduleAppointmentReply(phone, "");
		return reply ?? buildDirectReply(
			justRegistered,
			`Podés pedir: ${capabilities}`,
		);
	}

	return buildDirectReply(
		justRegistered,
		`Podés pedir: ${capabilities}`,
	);
}

// ── Redis and inbound handler setup ─────────────────────────────────────────

// Cliente global de Redis
const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");
const turnState = createIoredisTurnState(redisClient as any);

// Mapping @lid JID → @s.whatsapp.net JID built from contacts events.
// WhatsApp accounts migrated to the new linked-device protocol send messages
// from a LID JID instead of their phone JID. Without this map the extracted
// "phone" would be the LID number (not the real phone), breaking profile lookups.
const lidToPhoneJid = new Map<string, string>();

// Instancia global del socket y controlador de reconexión
export let globalSock: ReturnType<typeof makeWASocket> | null = null;
// Verdadero sólo cuando el socket alcanzó el estado "open" (conexión establecida con WhatsApp).
// globalSock puede ser no-null durante "connecting" o "qr", pero enviar en esos estados
// produce mensajes en estado "cargando" permanente en el destinatario.
let isSocketConnected = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let outboxInterval: NodeJS.Timeout | null = null;
let profilePicInterval: NodeJS.Timeout | null = null;

// Creamos el Inbound Handler inyectando las dependencias necesarias
export const inboundHandler = createInboundHandler({
	now: () => new Date(),
	repo: {
		getOrCreateConversation: (input) =>
			getOrCreateConversation(input.phone, input.jid, input.name, input.lidJid),
		getConversationById,
		insertMessageAndTouchConversation,
		updateConversation,
		setMode,
		recordConversationEvent,
		getSettings,
	},
	turnState,
	resolveLid: (lidJid) => lidToPhoneJid.get(lidJid),
	getRecentHistory,
	getActiveSystemPrompt,
	callDeepSeek: async (input) => {
		// Si el número ya está identificado como agente registrado, se inyecta en el
		// prompt para que la IA lo trate por su nombre y no vuelva a pedirle el correo.
		let identityContext = "";
		try {
			// Extract last user message from history + queued
			const allMessages = [
				...input.history,
				...input.queuedMessages.map((m) => ({ role: "user" as const, content: m.text })),
			];
			const lastUserMsg = [...allMessages].reverse().find((m) => m.role === "user")?.content ?? "";
			const msgLower = lastUserMsg.toLowerCase();

			// Determine if this is a 1-on-1 conversation (not a group)
			const conv = await getConversationById(input.conversationId);
			const isGroup = conv?.jid?.endsWith("@g.us") ?? false;

			if (!isGroup && conv) {
				const identifiedProfile = await getAgentProfile(conv.phone);
				if (identifiedProfile) {
					const firstName = deriveFirstNameFromEmail(identifiedProfile.email);
					identityContext = `[Sistema — Este número ya está identificado como agente registrado. Nombre: ${firstName}. Correo: ${identifiedProfile.email}. Llamalo por su nombre y no le pidas el correo de nuevo; cualquier consulta que requiera su correo debe usar este, no otro que mencione.]\n`;
				}
			}

			if (!isGroup) {
				// Confirmación de un reporte capturado en el grupo de fallas — tiene prioridad
				// sobre cualquier otro intent mientras esté pendiente (le acabamos de preguntar algo puntual).
				if (conv) {
					const groupReportReply = await tryHandleGroupReportConfirmation(conv.phone, lastUserMsg);
					if (groupReportReply) return groupReportReply;
				}

				// Email registration always works regardless of BigQuery config.
				// Also check queued messages: if the email arrived in the same debounce batch as
				// another intent (e.g. user sent email then immediately "eliminar ausencia"), save
				// the profile silently so the intent below finds it in the same turn.
				if (conv) {
					if (EMAIL_REGEX.test(lastUserMsg)) {
						const reply = await tryRegisterEmailReply(conv.phone, lastUserMsg);
						if (reply) return reply;
					} else {
						const batchEmail = input.queuedMessages.find((m) => EMAIL_REGEX.test(m.text));
						if (batchEmail) {
							// Register profile without returning — continue to handle lastUserMsg intent
							await tryRegisterEmailReply(conv.phone, batchEmail.text);
						}
					}
				}

				// Agent metrics intent (BigQuery required)
				const wantsLatest = METRICS_LATEST_KEYWORDS.some((kw) => msgLower.includes(kw));
				const wantsMtd = METRICS_KEYWORDS.some((kw) => msgLower.includes(kw));
				if ((wantsLatest || wantsMtd) && conv) {
					const reply = await tryAgentMetricsReply(conv.phone, wantsLatest ? "latest" : "mtd");
					if (reply) return reply;
				}

				// Schedule intent (Google Sheets)
				if (SCHEDULE_KEYWORDS.some((kw) => msgLower.includes(kw)) && conv) {
					const reply = await tryScheduleReply(conv.phone);
					if (reply) return reply;
				}

				// Appointment scheduling intent (Google Calendar + recordatorios)
				// También cubre los turnos siguientes mientras se completan los datos de la cita.
				const pendingAppointment = conv ? await redisClient.get(pendingIntentKey(conv.phone)) : null;
				const isAppointmentFollowUp = typeof pendingAppointment === "string" && pendingAppointment.startsWith("appointment");
				if ((APPOINTMENT_KEYWORDS.some((kw) => msgLower.includes(kw)) || isAppointmentFollowUp) && conv) {
					const reply = await tryScheduleAppointmentReply(conv.phone, lastUserMsg);
					if (reply) return reply;
				}

				// Offline request intent (queued via Google Sheets → Monitor)
				// Also catches multi-turn follow-up where user provides the reason after the bot asked
				const pendingOffline = conv ? await redisClient.get(pendingIntentKey(conv.phone)) : null;
				const isOfflineReasonFollowUp = pendingOffline === "offline_reason";
				if ((OFFLINE_KEYWORDS.some((kw) => msgLower.includes(kw)) || isOfflineReasonFollowUp) && conv) {
					const reply = await tryGoOfflineReply(conv.phone, lastUserMsg);
					if (reply) return reply;
				}

				// Absence removal intent (Google Sheets write)
				// Also catches multi-turn follow-ups where user provides the date after the bot asked
				const hasPendingAbsence = conv && !!(await redisClient.get(absencePendingKey(conv.phone)));
				const isAbsenceDateFollowUp = hasPendingAbsence && !!parseDateFromMessage(lastUserMsg);
				if ((matchesAbsenceIntent(msgLower) || isAbsenceDateFollowUp) && conv) {
					const reply = await tryRemoveAbsenceReply(conv.phone, lastUserMsg);
					if (reply) return reply;
				}

				// Si llegamos hasta acá, ningún intent de arriba matcheó. Si el mensaje de todas
				// formas menciona algo relacionado a una capacidad conocida, lo logueamos para
				// revisar y ampliar las palabras clave — no afecta la respuesta de este turno.
				if (conv) {
					const nearMissCategories = detectNearMissCategories(lastUserMsg);
					if (nearMissCategories.length > 0) {
						logNearMissIntent({
							conversationId: conv.id,
							phone: conv.phone,
							message: lastUserMsg,
							categories: nearMissCategories,
						}).catch((err) => console.error("[near-miss] Error logueando intent:", err));
					}
				}
			}

			// UUID case lookup (BigQuery required, works in groups too)
			const uuidMatch = lastUserMsg.match(UUID_REGEX);
			if (uuidMatch) {
				const reply = await tryIssueLookupReply(uuidMatch[0]);
				if (reply) return reply;
			}
		} catch (err) {
			console.error("[dashbig] Intent detection error, falling back to DeepSeek:", err);
		}

		const settings = await getSettings();
		const chatClient = createConfiguredChatClient(settings);
		const colombiaDate = new Date().toLocaleString("es-CO", {
			timeZone: "America/Bogota",
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: true,
		});
		const enrichedSystemPrompt = `[Sistema — Fecha y hora actual en Colombia: ${colombiaDate}]\n${identityContext}\n${input.systemPrompt}`;
		const res = await chatClient.generateNormalReply({
			systemPrompt: enrichedSystemPrompt,
			history: input.history,
			queuedMessages: input.queuedMessages,
		});
		if (!res.ok) {
			// No lanzamos — devolvemos un string que parseNormalReply rechazará.
			// Esto permite que el inbound handler ejecute su path ai_invalid_json,
			// que detiene el indicador "escribiendo..." y registra el evento en DB.
			console.warn(`[bot] generateNormalReply falló (${res.reason}); delegando a path ai_invalid_json.`);
			return `{"_deepseek_error":${JSON.stringify(res.reason)}}`;
		}
		return res.rawContent;
	},
	qualifyLead: async (input) => {
		const settings = await getSettings();
		const chatClient = createConfiguredChatClient(settings);
		const crmLink = await runtimeCrmRepository.getConversationCrmLink(
			input.conversation.id,
		);
		await qualifyLeadAndCreateSuggestions({
			conversation: {
				id: input.conversation.id,
				contact_id: crmLink?.contact_id ?? null,
			},
			history: [
				...input.history,
				...input.queuedMessages.map((message) => ({
					role: "user" as const,
					content: message.text,
				})),
			],
			crmRepo: runtimeCrmRepository,
			aiClient: chatClient,
		});
	},
	sendMessage: async (jid, text) => {
		if (globalSock && isSocketConnected) {
			await globalSock.sendMessage(jid, { text });
		} else {
			throw new Error("[bot] Socket no conectado o no listo. No se puede enviar mensaje.");
		}
	},
	notifyTelegramHumanNeeded: async (payload) => {
		await notifyTelegramHumanNeeded({
			conversation: {
				id: payload.conversationId,
				phone: payload.phone,
				jid: payload.jid,
			},
			reason: payload.reason,
			lastMessage: payload.lastMessage,
		});
	},
	generateToken: () => Math.random().toString(36).substring(2, 15),
	readMessages: async (keys) => {
		if (globalSock) {
			await globalSock.readMessages(keys);
		}
	},
	sendPresenceUpdate: async (presence, jid) => {
		if (globalSock) {
			await globalSock.sendPresenceUpdate(presence, jid);
		}
	},
	fetchProfilePictureUrl: async (jid) => {
		if (!globalSock) return null;
		try {
			return (await globalSock.profilePictureUrl(jid, "image")) ?? null;
		} catch {
			return null;
		}
	},
	downloadMedia: async (message) => {
		try {
			const buffer = await downloadMediaMessage(
				message as any,
				"buffer",
				{},
				{
					logger,
					reuploadRequest: (msg) => {
						if (globalSock?.updateMediaMessage) {
							return globalSock.updateMediaMessage(msg);
						}
						return Promise.reject(new Error("Socket or updateMediaMessage not available"));
					},
				}
			);
			return buffer;
		} catch (error) {
			console.error("[bot-error] Falló al descargar mensaje multimedia:", error);
			return null;
		}
	},
	transcribeAudio: async (input) => transcribeAudio(input),
	describeImage: async (input) => describeImage(input),
});

let isProcessingOutbox = false;
const outboxAttempts = new Map<number, number>();

function mediaPathFromUrl(mediaUrl: string | null | undefined) {
	if (!mediaUrl) return null;
	const filename = path.basename(mediaUrl);
	if (!filename || filename !== mediaUrl.split("/").pop()) return null;
	return path.join(runtimePaths.mediaDir, filename);
}

function outboxMetadata(item: any): Record<string, unknown> {
	return item.metadata && typeof item.metadata === "object" ? item.metadata : {};
}

function outboxMimeType(item: any) {
	const metadata = outboxMetadata(item);
	return typeof metadata.mimeType === "string" ? metadata.mimeType : undefined;
}

function outboxSendPayload(item: any) {
	const mediaType = item.media_type ?? "text";
	if (mediaType === "image" || mediaType === "audio") {
		const mediaPath = mediaPathFromUrl(item.media_url);
		if (!mediaPath || !fs.existsSync(mediaPath)) {
			throw new Error(`Archivo multimedia no disponible para outbox ${item.id}: ${item.media_url || "sin ruta"}`);
		}
		const buffer = fs.readFileSync(mediaPath);
		if (mediaType === "image") {
			const caption = item.content && item.content !== "Imagen enviada" ? item.content : undefined;
			return { image: buffer, caption, mimetype: outboxMimeType(item) };
		}
		return {
			audio: buffer,
			mimetype: outboxMimeType(item) ?? "audio/ogg; codecs=opus",
			ptt: true,
		};
	}
	return { text: item.content };
}

// Loop que procesa la cola de salida (Outbox) cada 2 segundos
function startOutboxProcessor() {
	if (outboxInterval) return;
	outboxInterval = setInterval(async () => {
		if (!globalSock || !isSocketConnected || isProcessingOutbox) return;
		isProcessingOutbox = true;
		try {
			const pending = await getPendingOutbox(20);
			for (const item of pending) {
				const jid = outboxDestinationForConversation({
					phone: item.conversation_phone ?? item.phone,
					jid: item.conversation_jid ?? null,
				});
				console.log(
					`[bot] Enviando ${item.media_type ?? "text"} de Outbox a ${jid}: "${item.content.substring(0, 30)}..."`,
				);
				try {
					await globalSock.sendMessage(jid, outboxSendPayload(item));
					await markOutboxSent(item.id);
					outboxAttempts.delete(item.id);
					console.log(`[bot] Mensaje de Outbox id ${item.id} enviado exitosamente.`);
				} catch (sendError: any) {
					const attempts = outboxAttempts.get(item.id) || 0;
					const newAttempts = attempts + 1;
					console.error(
						`[bot-error] Falló el envío del mensaje de Outbox id ${item.id} a ${jid} (intento ${newAttempts}/3). Error:`,
						sendError?.message || sendError
					);
					if (newAttempts >= 3) {
						await markOutboxFailed(item.id);
						outboxAttempts.delete(item.id);
						console.error(`[bot-error] Mensaje de Outbox id ${item.id} marcado como fallido de forma definitiva.`);
					} else {
						outboxAttempts.set(item.id, newAttempts);
					}
				}
			}
		} catch (error) {
			console.error("[bot] Error en el procesador de Outbox:", error);
		} finally {
			isProcessingOutbox = false;
		}
	}, 2000);
}

function stopOutboxProcessor() {
	if (outboxInterval) {
		clearInterval(outboxInterval);
		outboxInterval = null;
	}
}

async function refreshAllProfilePictures() {
	if (!globalSock) return;
	try {
		console.log("[bot] Iniciando actualización proactiva de fotos de perfil...");
		const conversations = await listConversations();
		const now = new Date();
		for (const convo of conversations) {
			const jid = convo.jid || (convo.phone.includes("@") ? convo.phone : `${convo.phone}@s.whatsapp.net`);
			const shouldRefresh = !convo.profile_picture_url || 
				!convo.profile_picture_fetched_at || 
				(now.getTime() - new Date(convo.profile_picture_fetched_at).getTime() > 24 * 60 * 60 * 1000);
			
			if (shouldRefresh) {
				try {
					const url = await globalSock.profilePictureUrl(jid, "image");
					await updateConversation(convo.id, {
						profile_picture_url: url || null,
						profile_picture_fetched_at: now,
					});
					await new Promise((resolve) => setTimeout(resolve, 1000));
				} catch {
					// not-authorized o item-not-found son esperados según privacidad del contacto
					await updateConversation(convo.id, {
						profile_picture_fetched_at: now,
					});
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
		}
		console.log("[bot] Finalizada la actualización proactiva de fotos de perfil.");
	} catch (error) {
		console.error("[bot] Error en refreshAllProfilePictures:", error);
	}
}

// Función principal para iniciar el socket de Baileys
export async function startWASocket() {
	const activeInstance = await getActiveWhatsAppInstance();
	const instanceAuthDir = getInstanceAuthDir(activeInstance.id);
	if (!fs.existsSync(instanceAuthDir)) {
		fs.mkdirSync(instanceAuthDir, { recursive: true });
	}
	console.log(`[bot] Iniciando conexion con WhatsApp para instancia "${activeInstance.name}" (#${activeInstance.id})...`);

	let version: [number, number, number] | undefined;
	try {
		const fetched = await fetchLatestBaileysVersion();
		version = fetched.version;
		if (version) {
			console.log(
				`[bot] Usando última versión de Baileys detectada: ${version.join(".")}`,
			);
		}
	} catch (err) {
		console.warn(
			"[bot] No se pudo obtener la última versión de Baileys de forma dinámica, usando fallback.",
		);
	}

	const { state, saveCreds } = await getMultiFileAuthState(instanceAuthDir);

	const sock = makeWASocket({
		version: version as any,
		auth: state,
		logger,
		browser: Browsers.macOS("Desktop"), // Browser fingerprint conocido
		markOnlineOnConnect: false,
		syncFullHistory: false,
		connectTimeoutMs: 60000,
		defaultQueryTimeoutMs: 120000,
		fireInitQueries: false,
		getMessage: async (key) => {
			if (key.id) {
				const content = await getMessageContentByWhatsappId(key.id).catch(() => null);
				if (content) return { conversation: content };
			}
			return undefined;
		},
	});

	globalSock = sock;

	sock.ev.on("creds.update", saveCreds);

	sock.ev.on("connection.update", async (update: any) => {
		const { connection, lastDisconnect, qr } = update;

		// 1. Manejo del código QR
		if (qr) {
			console.log("[bot] Código QR generado, actualizando estado de conexión.");
			await setConnectionState({
				status: "qr",
				qr_string: qr,
				phone: null,
			});
			await updateWhatsAppInstanceState(activeInstance.id, {
				status: "qr",
				qr_string: qr,
				phone: null,
			});
			// Generar ASCII QR de fallback en consola
			try {
				const qrcodeTerminal = await import("qrcode-terminal");
				const generateFn = qrcodeTerminal.default?.generate || qrcodeTerminal.generate;
				if (typeof generateFn === "function") {
					generateFn(qr, { small: true });
				} else {
					console.warn("[bot] No se encontro la funcion generate en qrcode-terminal");
				}
			} catch (error: any) {
				console.warn(
					`[bot] QR disponible en el panel web; no se pudo imprimir fallback en consola (${error?.message || error}).`,
				);
			}
		}

		// 2. Estado de conexión: connecting
		if (connection === "connecting") {
			const current = await getConnectionState();
			if (current.status === "disconnected") {
				await setConnectionState({
					status: "connecting",
					qr_string: current.qr_string,
					phone: null,
				});
				await updateWhatsAppInstanceState(activeInstance.id, {
					status: "connecting",
					qr_string: current.qr_string ?? null,
					phone: null,
				});
			}
		}

		// 3. Estado de conexión: open (conectado)
		if (connection === "open") {
			isSocketConnected = true;
			console.log("[bot] Conexión abierta con éxito.");
			const rawId = sock.user?.id || "";
			const selfName = typeof sock.user?.name === "string" ? sock.user.name.trim() : "";
			const numericPhone = rawId.split(":")[0] || rawId.split("@")[0] || "";
			console.log(`[bot] Número de teléfono conectado: ${numericPhone}`);

			await setConnectionState({
				status: "connected",
				qr_string: null,
				phone: numericPhone,
			});
			await updateWhatsAppInstanceState(activeInstance.id, {
				status: "connected",
				qr_string: null,
				phone: numericPhone,
			});

			startOutboxProcessor();
			void refreshAllProfilePictures();

			if (profilePicInterval) clearInterval(profilePicInterval);
			profilePicInterval = setInterval(() => {
				void refreshAllProfilePictures();
			}, 6 * 60 * 60 * 1000);

			// Obtener información propia de perfil y guardarla en settings
			void (async () => {
				const selfJid = rawId.includes("@") ? rawId.split(":")[0] + "@s.whatsapp.net" : `${numericPhone}@s.whatsapp.net`;
				let selfPpUrl: string | null = null;
				try {
					selfPpUrl = (await sock.profilePictureUrl(selfJid, "image")) || null;
					await updateWhatsAppInstanceState(activeInstance.id, {
						profile_picture_url: selfPpUrl,
					});
				} catch (e) {
					console.log("[bot] No se pudo obtener la foto de perfil propia.");
				}

				let selfBusinessProfile: any = null;
				try {
					selfBusinessProfile = await sock.getBusinessProfile(selfJid);
				} catch (e) {
					console.log("[bot] No se pudo obtener el perfil comercial propio.");
				}

				let selfStatus: string | null = null;
				try {
					const statusRes: any = await sock.fetchStatus(selfJid);
					selfStatus = normalizeProfileStatus(statusRes);
					await updateWhatsAppInstanceState(activeInstance.id, {
						profile_status: selfStatus,
					});
				} catch (e) {
					console.log("[bot] No se pudo obtener el estado propio.");
				}

				await setSetting("bot_profile", {
					name: selfName || null,
					phone: numericPhone,
					profile_picture_url: selfPpUrl,
					status: selfStatus,
					business: selfBusinessProfile ? {
						description: selfBusinessProfile.description || "",
						category: selfBusinessProfile.category || "",
						email: selfBusinessProfile.email || "",
						website: selfBusinessProfile.website || [],
						address: selfBusinessProfile.address || "",
					} : null
				});
			})();
		}

		// 4. Estado de conexión: close (desconectado/caído)
		if (connection === "close") {
			isSocketConnected = false;
			stopOutboxProcessor();
			const status = (lastDisconnect?.error as any)?.output?.statusCode || 0;
			console.log(`[bot] Conexión cerrada. Status code: ${status}`);

			if (status === DisconnectReason.loggedOut) {
				console.log(
					"[bot] Sesión cerrada (loggedOut). Limpiando credenciales.",
				);
				await setConnectionState({
					status: "disconnected",
					qr_string: null,
					phone: null,
				});
				await updateWhatsAppInstanceState(activeInstance.id, {
					status: "disconnected",
					qr_string: null,
					phone: null,
				});
				try {
					clearDirectoryContents(instanceAuthDir);
				} catch (error) {
					console.warn(
						"[bot] No se pudo limpiar el directorio de credenciales:",
						error,
					);
				}
				globalSock = null;
				console.log("[bot] Reiniciando conexión para generar nuevo código QR...");
				scheduleReconnect(1000);
			} else {
				await updateWhatsAppInstanceState(activeInstance.id, {
					status: "disconnected",
					qr_string: null,
				}).catch(() => {});
				// Reconexión con backoff
				const delay = status === 440 ? 15000 : 5000;
				console.log(`[bot] Intentando reconectar en ${delay / 1000}s...`);
				scheduleReconnect(delay);
			}
		}
	});

	// Registro del handler de mensajes entrantes con depuración
	sock.ev.on("messages.upsert", async (upsert: any) => {
		// Pre-populate LID→phone map from incoming messages that carry senderPn.
		// This ensures canonicalChatJid can resolve @lid JIDs even before contacts events fire.
		for (const msg of upsert.messages || []) {
			if (msg.key?.remoteJid?.endsWith("@lid") && msg.key?.senderPn && !msg.key?.fromMe) {
				const lidJid = msg.key.remoteJid as string;
				const phoneJid = (msg.key.senderPn as string).endsWith("@s.whatsapp.net")
					? (msg.key.senderPn as string)
					: `${msg.key.senderPn}@s.whatsapp.net`;
				lidToPhoneJid.set(lidJid, phoneJid);
			}
		}

		console.log(
			`[bot-debug] messages.upsert recibido. Tipo: ${upsert.type}, Cantidad: ${upsert.messages?.length}`,
		);
		for (const msg of upsert.messages || []) {
			console.log(
				`[bot-debug] Mensaje key: ${JSON.stringify(msg.key)}, pushName: ${msg.pushName}, timestamp: ${msg.messageTimestamp}`,
			);

			// Detectar si el mensaje no pudo ser desencriptado (Bad MAC / Ciphertext stub / MessageCounterError)
			// Un mensaje ha fallado en desencriptarse si no tiene contenido legible de texto ni multimedia,
			// no es de nosotros mismos, y no representa un stub/actualización del sistema de WhatsApp.
			const hasContent = !!(
				msg.message?.conversation ||
				msg.message?.extendedTextMessage?.text ||
				msg.message?.audioMessage ||
				msg.message?.imageMessage ||
				msg.message?.videoMessage ||
				msg.message?.documentMessage ||
				msg.message?.stickerMessage ||
				msg.message?.contactMessage ||
				msg.message?.contactsArrayMessage ||
				msg.message?.locationMessage ||
				msg.message?.liveLocationMessage ||
				msg.message?.viewOnceMessage ||
				msg.message?.viewOnceMessageV2 ||
				msg.message?.ephemeralMessage
			);
			const isDecryptionFailure = !msg.key.fromMe && !hasContent && (
				!msg.messageStubType || 
				msg.messageStubType === 0 || 
				msg.messageStubType === 1
			);
			console.log(
				`[bot-debug] Evaluando mensaje: fromMe=${msg.key.fromMe}, remoteJid=${msg.key.remoteJid}, messageKeys=${msg.message ? Object.keys(msg.message).join(", ") : "none"}, stubType=${msg.messageStubType}, hasContent=${hasContent}, isDecryptionFailure=${isDecryptionFailure}`
			);
			if (isDecryptionFailure && msg.key.remoteJid) {
				const remoteJid = msg.key.remoteJid;
				// Aplicar solo para chats 1:1
				if (remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid")) {
					console.warn(
						`[bot-warning] Detectado posible error de desencriptación (Bad MAC) para el JID ${remoteJid}. Forzando recreación de sesión de Signal...`
					);
					try {
						await sock.assertSessions([remoteJid], true);
						console.log(`[bot] Sesión de Signal para ${remoteJid} restablecida exitosamente.`);
					} catch (err) {
						console.error(`[bot-error] Falló al establecer sesión de Signal para ${remoteJid}:`, err);
					}
				}
			}

			if (!msg.key.fromMe && msg.key?.remoteJid === FALLAS_GROUP_JID) {
				try {
					await handleFallasGroupMessage(msg);
				} catch (err) {
					console.error("[fallas-group] Error procesando mensaje del grupo de fallas:", err);
				}
			}
		}
		try {
			await inboundHandler.handleUpsert(upsert);
		} catch (error) {
			console.error(
				"[bot] Error procesando mensaje entrante en handleUpsert:",
				error,
			);
		}
	});

	function processContactForLid(contact: any) {
		// Build LID↔phone mapping for accounts using the new linked-device protocol.
		// WhatsApp provides contact.lid (the @lid JID) when contact.id is the @s.whatsapp.net JID.
		// We store lid→phoneJid so canonicalChatJid can resolve incoming @lid messages.
		if (contact.id?.endsWith("@s.whatsapp.net") && contact.lid) {
			const lidJid = contact.lid.endsWith("@lid") ? contact.lid : `${contact.lid}@lid`;
			lidToPhoneJid.set(lidJid, contact.id);
		}
		// Also handle the inverse: id is @lid, verifiedName or senderPn gives us the phone
		if (contact.id?.endsWith("@lid") && contact.senderPn) {
			const phoneJid = contact.senderPn.endsWith("@s.whatsapp.net")
				? contact.senderPn
				: `${contact.senderPn}@s.whatsapp.net`;
			lidToPhoneJid.set(contact.id, phoneJid);
		}
	}

	sock.ev.on("contacts.upsert", async (contacts: any[]) => {
		await Promise.all(contacts.map(async (contact) => {
			processContactForLid(contact);
			if (contact.id && !contact.id.endsWith("@g.us")) {
				// Skip pure @lid contacts — they have no real phone number.
				// Only process @s.whatsapp.net contacts (real phone JIDs).
				if (contact.id.endsWith("@lid")) return;
				const name = contact.name?.trim() || contact.notify?.trim() || contact.verifiedName?.trim();
				if (name && name !== "WOpen" && name !== "Azokia" && name !== "Azokiallc") {
					try {
						const phone = contact.id.replace(/@.*/, "");
						// If the contact has a .lid field, store it so future @lid messages resolve here
						const lidJid = contact.lid
							? (contact.lid.endsWith("@lid") ? contact.lid : `${contact.lid}@lid`)
							: null;
						await getOrCreateConversation(phone, contact.id, name, lidJid);
					} catch (err) {
						console.error("[bot-error] Falló al procesar contacts.upsert para el JID " + contact.id + ":", err);
					}
				}
			}
		}));
	});

	sock.ev.on("contacts.update", async (contacts: any[]) => {
		await Promise.all(contacts.map(async (contact) => {
			processContactForLid(contact);
			if (contact.id && !contact.id.endsWith("@g.us")) {
				if (contact.id.endsWith("@lid")) return;
				const name = contact.name?.trim() || contact.notify?.trim() || contact.verifiedName?.trim();
				if (name && name !== "WOpen" && name !== "Azokia" && name !== "Azokiallc") {
					try {
						const phone = contact.id.replace(/@.*/, "");
						const lidJid = contact.lid
							? (contact.lid.endsWith("@lid") ? contact.lid : `${contact.lid}@lid`)
							: null;
						await getOrCreateConversation(phone, contact.id, name, lidJid);
					} catch (err) {
						console.error("[bot-error] Falló al procesar contacts.update para el JID " + contact.id + ":", err);
					}
				}
			}
		}));
	});
}

// Programador de reconexión defensivo
function scheduleReconnect(delay: number) {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(async () => {
		reconnectTimer = null;
		await shutdownWASocket();
		await startWASocket();
	}, delay);
}

// Cierre seguro del socket viejo y limpieza de listeners
export async function shutdownWASocket() {
	stopOutboxProcessor();
	if (profilePicInterval) {
		clearInterval(profilePicInterval);
		profilePicInterval = null;
	}
	if (globalSock) {
		try {
			globalSock.ev.removeAllListeners("connection.update");
			globalSock.ev.removeAllListeners("creds.update");
			globalSock.ev.removeAllListeners("messages.upsert");
			globalSock.ev.removeAllListeners("contacts.upsert");
			globalSock.ev.removeAllListeners("contacts.update");
			globalSock.end(undefined);
		} catch (error) {
			console.warn("[bot] Error cerrando el socket anterior:", error);
		}
		globalSock = null;
		isSocketConnected = false;
	}
}
