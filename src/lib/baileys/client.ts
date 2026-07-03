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
import { getCachedResponse, isCacheable, setCachedResponse } from "../response-cache.ts";
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
	notifyBotDisconnected,
	logNearMissIntent,
	insertGroupFailureReport,
	markGroupFailureReportConfirmed,
	markLatestGroupFailureReportResolved,
} from "../db.ts";
import { lookupCase, getAgentMetrics, isDashBigConfigured } from "../dashbig-client.ts";
import { getAgentSchedule, clearAgentAbsence, queueAgentOffline, getHorasCubrir, isHoraCubrirHHEE } from "../sheets-client.ts";
import { createCalendarEvent } from "../google-calendar-client.ts";
import { runtimeCrmRepository } from "../repositories/runtime-crm.ts";
import { outboxDestinationForConversation } from "../outbox-routing.ts";
import { waitBetweenSends } from "../send-pacing.ts";

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
const HORAS_DISPONIBLES_KEYWORDS = [
	"horas disponibles", "horas para cubrir", "horas a cubrir", "horas sin cubrir",
	"hay horas", "horas libres", "horas extra", "hhee", "cubrir horas",
];
const OFFLINE_KEYWORDS = [
	"inactivame", "inactivarme", "ponme fuera de línea", "ponme fuera de linea",
	"ponme offline", "ponerme fuera de línea", "ponerme fuera de linea",
	"cambiarme a fuera de línea", "cambiarme a offline", "ponme en offline",
	"se me cayó el internet", "se me cayo el internet",
	"se cayó el internet", "se cayo el internet",
	"perdí internet", "perdi internet", "se me fue el internet", "se fue el internet",
	"sin internet y tengo chat", "tengo chats y sin internet",
	"internet falló", "internet fallo", "falló el internet", "fallo el internet",
	"falló mi internet", "fallo mi internet", "se me falló el internet", "se me fallo el internet",
	"falló la conexión", "fallo la conexion", "falló la señal", "fallo la senal",
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
	// Frases cortas de internet/señal que antes no matcheaban
	"sin internet", "no tengo internet",
	"tengo problemas de internet", "internet malo", "problemas de internet",
	"sin señal", "sin senal", "sin servicio",
	"no hay luz",
	"se me cayó", "se me cayo",  // suelto: cubre "se me cayó el HC", "se me cayó el sistema", etc.
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

const HELP_KEYWORDS = [
	"ayuda", "help", "menú", "menu", "que podes hacer", "qué podés hacer",
	"qué hacés", "que haces", "para qué sirves", "para que sirves",
	"qué me podés ayudar", "que me podes ayudar", "cómo funciona", "como funciona",
	"qué puedo pedir", "que puedo pedir", "opciones", "comandos",
];

const GREETING_KEYWORDS = [
	"hola", "buenas", "buenos días", "buenos dias", "buen día", "buen dia",
	"buenas tardes", "buenas noches", "hey", "saludos",
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

const RESOLVED_REPORT_KEYWORDS = [
	"ya llegó la luz", "ya llego la luz", "ya volvió la luz", "ya volvio la luz",
	"ya tengo luz", "ya tengo internet", "ya volvió el internet", "ya volvio el internet",
	"ya se solucionó", "ya se solucino", "ya está resuelto", "ya esta resuelto",
	"ya quedó resuelto", "ya quedo resuelto", "ya regresó la luz", "ya regreso la luz",
	"ya está normal", "ya esta normal", "ya volvió todo", "ya volvio todo",
];

const TL_TURNO_KEYWORDS = [
	"tl en turno", "tl de turno", "tl de guardia", "tl activo",
	"quien es el tl", "quién es el tl", "quien está de tl", "quién está de tl",
	"quien esta de tl", "quien esta el tl", "quién está el tl",
	"quien esta de guardia", "quién está de guardia", "quien está de guardia",
	"quien es el team leader", "el tl de hoy", "que tl hay", "qué tl hay",
	"que tl esta", "qué tl está", "quien atiende de tl", "tl disponible",
];

/** Detecta si un mensaje en el grupo es una consulta/saludo dirigido al TL en turno. */
function matchesTlTurnoQuery(lower: string): boolean {
	// "TL de [LOB]": cubre "TL de AJ", "TL de Fraude", "TL de turno", etc.
	if (lower.includes("tl de ")) return true;
	// Saludo dirigido al TL: "buenas tardes TL", "buenas noches TL"
	if (/\btl\b/.test(lower) && /buenas?\s+(noches?|tardes?|d[ií]as?)/i.test(lower)) return true;
	// Otras frases de búsqueda directa
	return TL_TURNO_KEYWORDS.some((kw) => lower.includes(kw));
}

// Local-part de un email (ej. "maria.tellez" o "victor.garces_ndo.ext") mandado solo, sin
// "@dominio". Los agentes suelen abreviar así al reportar una falla; hay que pedirles el
// correo completo. Los correos de la empresa pueden llevar guión bajo y sufijos (ej. "_ext"),
// por eso el charset es el mismo que el local-part de EMAIL_REGEX, exigiendo al menos un punto.
const PARTIAL_EMAIL_REGEX = /^[\wáéíóúñ+%-]+(\.[\wáéíóúñ+%-]+)+$/i;

/** true si el texto es solo un "nombre.apellido" sin @dominio (abreviación de correo). */
function matchesPartialEmail(text: string): boolean {
	return PARTIAL_EMAIL_REGEX.test(text.trim()) && !EMAIL_REGEX.test(text);
}

const fallasGroupDebounceKey = (phone: string) => `bot:fallas_group_debounce:${phone}`;
const fallasGroupTimers = new Map<string, NodeJS.Timeout>();
// Última key de mensaje recibida por agente en el grupo de fallas, para poder reaccionarle
// con ✅ cuando se procese el reporte. Vive en memoria (igual que fallasGroupTimers) porque
// solo se usa dentro de la ventana de debounce activa.
const fallasGroupLastMsgKey = new Map<string, any>();

function extractGroupMessageText(msg: any): string {
	return msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
}

/** Intenta extraer el LOB del texto libre de un reporte del grupo. */
function extractLobFromText(text: string): string | null {
	const m = text.match(/\blob[:\s]+([a-záéíóúñüa-z0-9\s]{2,40}?)(?:[,;.\n]|$)/i);
	return m ? m[1].trim() : null;
}

// Cache para el JID del grupo de fallas (se lee de settings para no requerir deploy si cambia).
let _fallasGroupJidCache: { value: string; expiresAt: number } | null = null;

async function getFallasGroupJid(): Promise<string> {
	if (_fallasGroupJidCache && Date.now() < _fallasGroupJidCache.expiresAt) {
		return _fallasGroupJidCache.value;
	}
	const settings = await getSettings().catch(() => ({} as Record<string, unknown>));
	const jid = (settings.fallas_group_jid as string) || FALLAS_GROUP_JID;
	_fallasGroupJidCache = { value: jid, expiresAt: Date.now() + 5 * 60 * 1000 };
	return jid;
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
	| "absence" | "absence_date" | "offline" | "offline_reason" | "schedule" | "metrics" | "horas_lob"
	| "appointment" | "appointment_role" | "appointment_phone" | "appointment_date" | "appointment_time" | "appointment_name";
const pendingIntentKey = (phone: string) => `bot:pending_intent:${phone}`;
const PENDING_INTENT_TTL = 300; // 5 minutes
const horasLobListKey = (phone: string) => `bot:horas_lob_list:${phone}`;

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

function buildMenuReply(firstName?: string): string {
	const greeting = firstName ? `Hola ${firstName}! 👋` : "Hola! 👋";
	return buildDirectReply(
		`${greeting} Soy el asistente de vtlik. Puedo ayudarte con:`,
		"📊 *Mis métricas* → escribí \"mis métricas\"\n📅 *Mis turnos* → escribí \"mis turnos\"\n✏️ *Eliminar ausente* → escribí \"eliminar ausente [fecha]\"\n🔴 *Pasarme a offline* → describí el problema (internet, luz, PC, HC)\n⏰ *Horas extra* → escribí \"horas extra\"",
		firstName ? "" : "Para activar estas funciones respondé con tu email corporativo 📧",
	);
}

/** Clasifica el tipo de falla a partir del texto libre del agente. */
function classifyFailureReason(text: string): string {
	const lower = text.toLowerCase();
	if (lower.includes("luz") || lower.includes("energ") || lower.includes("corriente")
		|| lower.includes("apag") || lower.includes("electric")) return "Falla de luz / energía eléctrica";
	if (/\bpc\b/.test(lower) || lower.includes("computador") || lower.includes("equipo")
		|| lower.includes("actualiz")) return "PC dañada o actualizando";
	if (lower.includes(" hc") || lower.includes("hc ") || lower.includes("hc\n") || lower === "hc"
		|| lower.startsWith("hc ")) return "Aplicativo HC no funciona";
	if (lower.includes("internet") || lower.includes("señal") || lower.includes("conexi")
		|| lower.includes("red ") || lower.includes("caí") || lower.includes("cai")) return "Internet / conexión caída";
	return "Falla de conectividad";
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
	if (meetsTarget) return " ✅";
	const targetLabel = isTime ? fmtAht(target) : fmtPct(target <= 1 ? target * 100 : target);
	return ` ❌ (obj: ${targetLabel})`;
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
	// new Set() evita duplicar los turnos si ambas configuraciones apuntan a la misma planilla.
	const ids = [...new Set([id1, id2].filter(Boolean))];

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

		// Detectar el próximo turno futuro comparando fechas
		const nowArg = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
		nowArg.setHours(0, 0, 0, 0);
		let nextShiftIdx = -1;
		let minDiff = Infinity;
		for (const [i, s] of shifts.entries()) {
			const raw = s.fecha || "";
			let d: Date | null = null;
			let m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
			if (m) d = new Date(`${m[1]}-${m[2]}-${m[3]}`);
			else {
				m = raw.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?/);
				if (m) {
					const yr = m[3] || String(nowArg.getFullYear());
					d = new Date(`${yr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
				}
			}
			if (d) {
				const diff = d.getTime() - nowArg.getTime();
				if (diff >= 0 && diff < minDiff) { minDiff = diff; nextShiftIdx = i; }
			}
		}

		const lines = [`📅 *${firstName ? `${firstName}, tus` : "Tus"} turnos*`];
		for (const [i, s] of shifts.entries()) {
			const parts = [s.fecha, s.horario, s.estado].filter(Boolean).join(" · ");
			const novedad = s.novedades ? ` — ${s.novedades}` : "";
			const marker = i === nextShiftIdx ? " ← *próximo*" : "";
			lines.push(`${parts}${novedad}${marker}`);
		}
		return buildDirectReply(lines.join("\n"));
	} catch (err) {
		console.error("[schedule] Error:", err);
		return buildDirectReply("No pude consultar tus turnos en este momento. Intentá de nuevo en unos minutos.");
	}
}

const DIACRITICS_REGEX = /[̀-ͯ]/g;

function normalizeLobText(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFD").replace(DIACRITICS_REGEX, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Busca si el mensaje del agente nombra a alguno de los LOBs con horas pendientes. */
function matchLobFromMessage(message: string, knownLobs: string[]): string | null {
	const normMsg = normalizeLobText(message);
	if (!normMsg) return null;
	for (const lob of knownLobs) {
		const normLob = normalizeLobText(lob);
		if (normLob && (normMsg.includes(normLob) || normLob.includes(normMsg))) return lob;
	}
	return null;
}

/** Consulta la hoja "horas-cubrir" (ambas programaciones) y confirma si hay horas sin cubrir para el LOB del agente. */
async function tryHorasDisponiblesReply(phone: string, message: string): Promise<string | null> {
	const settings = await getSettings();
	const id1 = (settings.programacion_1_id as string) || "";
	const id2 = (settings.programacion_2_id as string) || "";
	const ids = [...new Set([id1, id2].filter(Boolean))];

	if (!ids.length) {
		return buildDirectReply("Las programaciones no están configuradas aún. Contactá al TL.");
	}

	try {
		const entries = await getHorasCubrir(ids);
		if (!entries.length) {
			await redisClient.del(pendingIntentKey(phone));
			return buildDirectReply("Por ahora no hay horas extra sin cubrir en ningún LOB 👍");
		}

		const knownLobs = [...new Set(entries.map((e) => e.lob).filter(Boolean))];

		// Aceptar respuesta numérica cuando el bot previamente listó los LOBs numerados
		let requestedLob = matchLobFromMessage(message, knownLobs);
		if (!requestedLob) {
			const numMatch = message.trim().match(/^(\d+)$/);
			if (numMatch) {
				const storedList = await redisClient.get(horasLobListKey(phone));
				if (storedList) {
					const lobList: string[] = JSON.parse(storedList);
					const idx = parseInt(numMatch[1], 10) - 1;
					if (idx >= 0 && idx < lobList.length) requestedLob = lobList[idx];
				}
			}
		}

		if (!requestedLob) {
			await redisClient.set(pendingIntentKey(phone), "horas_lob", "EX", PENDING_INTENT_TTL);
			await redisClient.set(horasLobListKey(phone), JSON.stringify(knownLobs), "EX", PENDING_INTENT_TTL);
			const NUMERAL_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
			const lobOptions = knownLobs.map((lob, i) => `${NUMERAL_EMOJIS[i] ?? `${i + 1}.`} ${lob}`).join("\n");
			return buildDirectReply(
				"¿Para qué LOB querés consultar las horas disponibles? 🤔",
				lobOptions,
				"Respondé con el número o el nombre del LOB.",
			);
		}

		await redisClient.del(pendingIntentKey(phone));
		await redisClient.del(horasLobListKey(phone));
		const slots = entries.filter((e) => e.lob === requestedLob);
		const lines = [`⏰ *Horas sin cubrir · ${requestedLob}*`];
		for (const s of slots) {
			const detalle = isHoraCubrirHHEE(s) ? "HHEE, paga plus" : s.tipoGestion || "normal";
			lines.push(`${s.fecha} · ${s.horario} — ${detalle}`);
		}
		return buildDirectReply(lines.join("\n"));
	} catch (err) {
		console.error("[horas-disponibles] Error:", err);
		return buildDirectReply("No pude consultar las horas disponibles en este momento. Intentá de nuevo en unos minutos.");
	}
}

/** Returns true if the given YYYY-MM-DD date falls within the current Mon–Sun week in Argentina time. */
function isInCurrentWeekAR(dateISO: string): boolean {
	const nowAR = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
	const daysFromMonday = nowAR.getDay() === 0 ? 6 : nowAR.getDay() - 1;
	const monday = new Date(nowAR);
	monday.setDate(nowAR.getDate() - daysFromMonday);
	monday.setHours(0, 0, 0, 0);
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	sunday.setHours(23, 59, 59, 999);
	const target = new Date(dateISO + "T00:00:00");
	return target >= monday && target <= sunday;
}

/** Parse a date from the message and return YYYY-MM-DD, or undefined if none found */
function parseDateFromMessage(text: string): string | undefined {
	const lower = text.toLowerCase();

	const nowArg = (): Date => new Date(
		new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }),
	);

	// "hoy" → fecha de hoy en Argentina
	if (/\bhoy\b/.test(lower)) return nowArg().toISOString().slice(0, 10);

	// "ayer" → fecha de ayer en Argentina
	if (/\bayer\b/.test(lower)) {
		const d = nowArg();
		d.setDate(d.getDate() - 1);
		return d.toISOString().slice(0, 10);
	}

	// "mañana" / "manana" → fecha de mañana en Argentina
	if (/\bma[nñ]ana\b/.test(lower)) {
		const d = nowArg();
		d.setDate(d.getDate() + 1);
		return d.toISOString().slice(0, 10);
	}

	// "el lunes", "el martes", etc. → ocurrencia pasada más reciente de ese día
	const DAY_NAMES: Record<string, number> = {
		domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3,
		jueves: 4, viernes: 5, sabado: 6, sábado: 6,
	};
	const dayMatch = lower.match(/\b(?:el\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/);
	if (dayMatch) {
		const key = dayMatch[1].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
		const targetDay = DAY_NAMES[key];
		if (targetDay !== undefined) {
			const today = nowArg();
			const todayDay = today.getDay();
			let diff = todayDay - targetDay;
			if (diff <= 0) diff += 7; // semana anterior si es el mismo día o futuro
			today.setDate(today.getDate() - diff);
			return today.toISOString().slice(0, 10);
		}
	}

	// DD/MM/YYYY or DD-MM-YYYY
	let m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
	if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
	// DD/MM or DD-MM (assume current year, Argentina time)
	m = text.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
	if (m) {
		const year = nowArg().getFullYear();
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
	// new Set() evita procesar la misma planilla dos veces si ambas configuraciones coinciden.
	const ids = [...new Set([
		(settings.programacion_1_id as string) || "",
		(settings.programacion_2_id as string) || "",
	].filter(Boolean))];

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

	if (!isInCurrentWeekAR(targetDate)) {
		return buildDirectReply(
			"⚠️ Solo podés eliminar ausentes de la semana actual directamente acá.",
			"Para ausencias de semanas anteriores completá el siguiente formulario:",
			"https://docs.google.com/forms/d/e/1FAIpQLSeQchP9yHLO7s2w48k0SN3dS-p-ibVzkw9MQJIDLIrsww8LHQ/viewform",
		);
	}

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
			'Escribí tu email *completo*, ej: "luis@pedidosya.com" — no abrevies, incluí el @dominio.',
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
				`Motivo registrado: _${reason}_`,
				"Cambiándote a *Fuera de línea* en los próximos 1-3 minutos. Si tenés chats activos esperá a que el sistema procese el cambio.",
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
// Requiere correo completo + motivo para desconectar. Nunca inicia una conversación: si algo
// no se pudo interpretar (falta el correo), el reporte se ignora silenciosamente — solo queda
// registrado en Telegram/DB para revisión manual. Si se pudo procesar, la única señal de vuelta
// es una reacción ✅ sobre el último mensaje del agente (sin texto).
async function processFallasGroupReport(phone: string, senderName: string, lastMsgKey?: any): Promise<void> {
	const debounceKey = fallasGroupDebounceKey(phone);
	const raw = await redisClient.get(debounceKey);
	await redisClient.del(debounceKey);
	if (!raw) return;

	const parts: string[] = JSON.parse(raw);
	const reason = parts.join(" ").trim();
	if (!reason) return; // sin motivo no hay nada que procesar

	const emailMatch = reason.match(EMAIL_REGEX);
	const profile = await getAgentProfile(phone);
	// Si el número ya está registrado, su correo verificado manda siempre — un correo
	// suelto en el texto (typo, el de un compañero, etc.) nunca debe pisarlo.
	const email = profile?.email || (emailMatch ? emailMatch[0].toLowerCase() : undefined);
	const formStatus = detectFormStatus(reason);
	const lob = extractLobFromText(reason) ?? undefined;
	const failureType = classifyFailureReason(reason);

	try {
		await notifyGroupFailureReport({ phone, senderName, email, reason, formStatus, resolved: false, lob, failureType });
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

	// Sin correo identificado no hay a quién desconectar — se ignora sin pedir aclaraciones.
	if (!email || reportId === null) return;
	if (!(globalSock && isSocketConnected)) return;

	const settings = await getSettings().catch(() => ({} as Record<string, unknown>));
	const spreadsheetId = (settings.offline_queue_sheet_id as string) || "";
	if (!spreadsheetId) return;

	try {
		const queueReason = `${failureType}${lob ? ` — LOB ${lob}` : ""} (reportado en grupo de fallas)`;
		const queued = await queueAgentOffline(email, queueReason, spreadsheetId);
		await markGroupFailureReportConfirmed(reportId, queued);
		if (queued && lastMsgKey) {
			await globalSock.sendMessage(lastMsgKey.remoteJid as string, {
				react: { text: "✅", key: lastMsgKey },
			});
		}
	} catch (err) {
		console.error("[fallas-group] Error procesando offline directo:", err);
	}
}

/** Detecta un mensaje del grupo de fallas y programa su procesamiento agregado por agente. */
async function handleFallasGroupMessage(msg: any): Promise<void> {
	const text = extractGroupMessageText(msg).trim();
	if (!text) return;

	const phone = resolveFallasGroupSenderPhone(msg);
	if (!phone) return;

	const senderName = (msg.pushName as string) || phone;
	const lower = text.toLowerCase();

	// Consulta por el TL en turno → responder directamente en el grupo
	if (matchesTlTurnoQuery(lower)) {
		if (globalSock && isSocketConnected) {
			try {
				const CS_SM_LOBS = ["cs", "sm"];
				const GO_PO_LOBS = ["go", "po"];
				// Detectar si el mensaje menciona explícitamente uno de los LOBs objetivo
				// (ej: "TL de PO", "quien es el TL de CS")
				const mentionsCsSm = CS_SM_LOBS.some((lob) => new RegExp(`\\b${lob}\\b`, "i").test(lower));
				const mentionsGoPo = GO_PO_LOBS.some((lob) => new RegExp(`\\b${lob}\\b`, "i").test(lower));
				let detectedGroup: "cs_sm" | "go_po" | null = mentionsCsSm ? "cs_sm" : mentionsGoPo ? "go_po" : null;

				// Si no viene del texto, verificar el LOB registrado en el perfil del agente
				if (!detectedGroup && phone) {
					const profile = await getAgentProfile(phone).catch(() => null);
					const profileLob = profile?.lob?.toLowerCase().trim();
					if (profileLob && CS_SM_LOBS.includes(profileLob)) detectedGroup = "cs_sm";
					else if (profileLob && GO_PO_LOBS.includes(profileLob)) detectedGroup = "go_po";
				}

				const replyText = detectedGroup === "cs_sm"
					? "Entrá acá 👇\nhttps://docs.google.com/spreadsheets/d/e/2PACX-1vSMBOfczLNvjS3nncoU6rGU_GWKbKo4hgzUqRFw6Fqql9IUP4rvenlfQLw7cWXT6EedJL1FEwTLAk0N/pubhtml?gid=176485234&single=true"
					: detectedGroup === "go_po"
					? "Entrá acá 👇\nhttps://docs.google.com/spreadsheets/d/e/2PACX-1vSMBOfczLNvjS3nncoU6rGU_GWKbKo4hgzUqRFw6Fqql9IUP4rvenlfQLw7cWXT6EedJL1FEwTLAk0N/pubhtml?gid=276469694&single=true"
					: "Entrá acá 👇\nhttps://script.google.com/a/macros/pedidosya.com/s/AKfycby0mvlKtQACyQyd7-tTWIUN-jAWV-L95ei0rhMCzyPzCRPzwWN3NWyGCtsa2fd4oRO6/exec\n\nBuscá la pestaña 📋 *TL Activo*";
				await globalSock.sendMessage(msg.key.remoteJid as string, { text: replyText });
			} catch (err) {
				console.error("[fallas-group] Error respondiendo consulta de TL en turno:", err);
			}
		}
		return;
	}

	// Mandaron solo "nombre.apellido" (sin @dominio) → recordarles que el correo va completo.
	if (matchesPartialEmail(text)) {
		if (globalSock && isSocketConnected) {
			try {
				await globalSock.sendMessage(msg.key.remoteJid as string, {
					text: `Recordá enviar el correo *completo*, con @ y dominio (ej: "${text.trim()}@pedidosya.com"), no la abreviación.`,
				});
			} catch (err) {
				console.error("[fallas-group] Error respondiendo recordatorio de correo completo:", err);
			}
		}
		return;
	}

	if (isResolvedReportMessage(text)) {
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
	const hasFailureKeyword = OFFLINE_KEYWORDS.some((kw) => lower.includes(kw));
	const hasActiveReport = fallasGroupTimers.has(phone);
	// En este grupo dedicado a reportes de fallas, señales simples (internet, luz, HC) son
	// suficientes para disparar el proceso — el contexto del grupo ya garantiza que es un reporte.
	const nearMissCategoriesForGroup = detectNearMissCategories(text);
	const hasGroupOfflineSignal = nearMissCategoriesForGroup.includes("offline");
	if (!hasFailureKeyword && !hasGroupOfflineSignal && !hasActiveReport) {
		// No matcheó ninguna señal de falla. Loguear near-misses de otras categorías.
		if (nearMissCategoriesForGroup.length > 0) {
			logNearMissIntent({
				conversationId: null,
				phone,
				message: text,
				categories: nearMissCategoriesForGroup,
			}).catch((err) => console.error("[near-miss] Error logueando intent del grupo de fallas:", err));
		}
		return;
	}

	const debounceKey = fallasGroupDebounceKey(phone);
	const raw = await redisClient.get(debounceKey);
	const accumulated: string[] = raw ? JSON.parse(raw) : [];
	accumulated.push(text);
	await redisClient.set(debounceKey, JSON.stringify(accumulated), "EX", FALLAS_GROUP_DEBOUNCE_TTL);
	// Guardamos la key del último mensaje del agente para poder reaccionarle con ✅ una vez
	// procesado el reporte (no se puede reaccionar después de que expire el debounce en Redis).
	fallasGroupLastMsgKey.set(phone, msg.key);

	if (hasActiveReport) return; // ya hay un timer corriendo, este mensaje solo se acumula
	const timer = setTimeout(() => {
		fallasGroupTimers.delete(phone);
		const lastMsgKey = fallasGroupLastMsgKey.get(phone);
		fallasGroupLastMsgKey.delete(phone);
		processFallasGroupReport(phone, senderName, lastMsgKey).catch((err) =>
			console.error("[fallas-group] Error procesando reporte agregado:", err),
		);
	}, FALLAS_GROUP_DEBOUNCE_MS);
	fallasGroupTimers.set(phone, timer);
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

			const capabilities = "📊 métricas · 📅 turnos · ✏️ eliminar ausencias · 🔴 pasarte a offline · ⏰ horas extra disponibles";

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

	const capabilities = "📊 métricas · 📅 turnos · ✏️ eliminar ausencias · 🔴 pasarte a offline · ⏰ horas extra disponibles";

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
let disconnectionAlertTimer: NodeJS.Timeout | null = null;
const DISCONNECTION_ALERT_MINUTES = 10;

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
		let _cacheQuestion = "";
		let _useCache = false;
		try {
			// Extract last user message from history + queued
			const allMessages = [
				...input.history,
				...input.queuedMessages.map((m) => ({ role: "user" as const, content: m.text })),
			];
			const lastUserMsg = [...allMessages].reverse().find((m) => m.role === "user")?.content ?? "";
			const msgLower = lastUserMsg.toLowerCase();

			// Si el último mensaje es una nota de sistema de media (audio/imagen que no pudo
			// procesarse), los atajos de keywords no aplican — ir directo a DeepSeek.
			const isMediaSystemNote =
				lastUserMsg.startsWith("Nota de voz recibida. Nota de sistema:") ||
				lastUserMsg.startsWith("[Imagen] (Nota de sistema:");

			// Determine if this is a 1-on-1 conversation (not a group)
			const conv = await getConversationById(input.conversationId);
			const isGroup = conv?.jid?.endsWith("@g.us") ?? false;

			_cacheQuestion = lastUserMsg;
			_useCache = !isGroup && !isMediaSystemNote;

			if (!isGroup && conv) {
				const identifiedProfile = await getAgentProfile(conv.phone);
				if (identifiedProfile) {
					const firstName = deriveFirstNameFromEmail(identifiedProfile.email);
					identityContext = `[Sistema — Este número ya está identificado como agente registrado. Nombre: ${firstName}. Correo: ${identifiedProfile.email}. Llamalo por su nombre y no le pidas el correo de nuevo; cualquier consulta que requiera su correo debe usar este, no otro que mencione.]\n`;
				}
			}

			if (!isGroup && !isMediaSystemNote) {
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

				// Horas extra disponibles intent (Google Sheets, hoja "horas-cubrir")
				// También cubre el turno siguiente cuando el bot preguntó por el LOB.
				const pendingHorasLob = conv ? await redisClient.get(pendingIntentKey(conv.phone)) : null;
				const isHorasLobFollowUp = pendingHorasLob === "horas_lob";
				if ((HORAS_DISPONIBLES_KEYWORDS.some((kw) => msgLower.includes(kw)) || isHorasLobFollowUp) && conv) {
					const reply = await tryHorasDisponiblesReply(conv.phone, lastUserMsg);
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

				// Menú / ayuda
				if (HELP_KEYWORDS.some((kw) => msgLower.includes(kw)) && conv) {
					const agentProfile = await getAgentProfile(conv.phone);
					const firstName = agentProfile ? deriveFirstNameFromEmail(agentProfile.email) : undefined;
					return buildMenuReply(firstName);
				}

				// Saludo → bienvenida para nuevos, menú para registrados
				if (conv && GREETING_KEYWORDS.some((kw) =>
					msgLower === kw || msgLower.startsWith(`${kw} `) ||
					msgLower.startsWith(`${kw}!`) || msgLower.startsWith(`${kw},`)
				)) {
					const agentProfile = await getAgentProfile(conv.phone);
					if (!agentProfile) {
						return buildDirectReply(
							"Hola! 👋 Soy el asistente de vtlik.",
							"Puedo ayudarte con métricas 📊, turnos 📅, ausencias ✏️, cambio de estado 🔴 y horas extra ⏰.",
							"Para activar estas funciones respondé con tu email corporativo, ej: \"luis@pedidosya.com\"",
						);
					} else {
						return buildMenuReply(deriveFirstNameFromEmail(agentProfile.email));
					}
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

		// Respuesta en caché para consultas informativas frecuentes
		if (_useCache && isCacheable(_cacheQuestion)) {
			const cachedReply = await getCachedResponse(redisClient, _cacheQuestion);
			if (cachedReply) {
				console.log("[qa-cache] Hit:", _cacheQuestion.slice(0, 60));
				return cachedReply;
			}
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
		// Guardar en caché si es respuesta informativa sin handoff
		if (_useCache && isCacheable(_cacheQuestion)) {
			try {
				const parsed = JSON.parse(res.rawContent);
				if (!parsed?.handoff?.required) {
					await setCachedResponse(redisClient, _cacheQuestion, res.rawContent);
					console.log("[qa-cache] Guardado:", _cacheQuestion.slice(0, 60));
				}
			} catch { /* no interrumpir el flujo */ }
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
			for (const [index, item] of pending.entries()) {
				if (index > 0) await waitBetweenSends();
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
			if (disconnectionAlertTimer) {
				clearTimeout(disconnectionAlertTimer);
				disconnectionAlertTimer = null;
			}
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
			if (!disconnectionAlertTimer) {
				disconnectionAlertTimer = setTimeout(() => {
					disconnectionAlertTimer = null;
					void notifyBotDisconnected(DISCONNECTION_ALERT_MINUTES).catch((err) => {
						console.error("[bot] Error enviando alerta de desconexión a Telegram:", err);
					});
				}, DISCONNECTION_ALERT_MINUTES * 60 * 1000);
			}
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

			const fallasJid = await getFallasGroupJid();
			if (!msg.key.fromMe && msg.key?.remoteJid === fallasJid) {
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
