import {
	makeWASocket,
	DisconnectReason,
	useMultiFileAuthState as getMultiFileAuthState,
	fetchLatestBaileysVersion,
	Browsers,
	downloadMediaMessage,
	type AnyMessageContent,
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
	notifyDecryptionStorm,
	notifyTlCoverageAnnounced,
	logNearMissIntent,
	insertGroupFailureReport,
	markGroupFailureReportConfirmed,
	markLatestGroupFailureReportResolved,
	findGroupFailureReportByMessageId,
	markGroupFailureReportReactedById,
	markTlReactionForLobOldest,
	markTlReactionOldestPending,
	listStaleUnreactedGroupFailureReports,
	markGroupFailureReportStaleAlertSent,
	notifyTlNotResponding,
	recordTlAnnouncement,
	type GroupFailureReportRow,
} from "../db.ts";
import { lookupCase, getAgentMetrics, isDashBigConfigured } from "../dashbig-client.ts";
import { getAgentSchedule, clearAgentAbsence, logAbsenceRemoval, queueAgentOffline, logNoConnectionReport, updatePendingOfflineReaction, getHorasCubrir, isHoraCubrirHHEE, findAgentSpreadsheetId, clearShiftChangeQueues } from "../sheets-client.ts";
import { createCalendarEvent } from "../google-calendar-client.ts";
import { runtimeCrmRepository } from "../repositories/runtime-crm.ts";
import { outboxDestinationForConversation } from "../outbox-routing.ts";
import { type SendKind } from "../send-pacing.ts";
import { enqueueSocketSend, getQueuedSendCount, setSendDelayMultiplierProvider } from "../send-queue.ts";
import { markSessionLinked, getWarmupPhase, warmupDelayMultiplier } from "../warmup-throttle.ts";
import { getScheduledTlForLob, WOLFTLS_COVERED_LOBS } from "../wolftls-client.ts";

// El pacing entre envíos se alarga automáticamente durante el período de calentamiento
// posterior a cualquier relogin con sesión nueva (ver warmup-throttle.ts).
setSendDelayMultiplierProvider(async () => warmupDelayMultiplier(await getWarmupPhase()));

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
	// "reinici*" cubre "reiniciar", "reiniciando", "reinicio", "reinicié", etc. — el agente
	// casi nunca dice "falla" o "dañó", solo avisa que está reiniciando el equipo/pc.
	"reinici",
	// Falla del aplicativo HC (donde están los chats)
	"hc no funciona", "hc no carga", "hc lento", "hc lenta", "lentitud en hc",
	"el hc no funciona", "el hc no carga", "se cae el hc", "se cae hc",
	"no me deja entrar al hc", "hc no abre", "se traba el hc", "se traba hc",
	"hc caído", "hc caido", "falla el hc", "falla en hc", "falla en el hc",
	"problemas con hc", "problemas con el hc", "el hc se cayó", "el hc se cayo",
	// Falla del aplicativo Hero (mismo patrón que HC)
	"hero no funciona", "hero no carga", "hero lento", "hero lenta", "lentitud en hero",
	"el hero no funciona", "el hero no carga", "se cae el hero", "se cae hero",
	"no me deja entrar al hero", "hero no abre", "se traba el hero", "se traba hero",
	"hero caído", "hero caido", "falla el hero", "falla en hero", "falla en el hero",
	"problemas con hero", "problemas con el hero", "el hero se cayó", "el hero se cayo",
	// Pantalla/aplicativo "en blanco" — suelto porque agentes lo dicen sobre distintos
	// nombres (Hero, Hero Care, HC) y a veces con palabras en el medio (ej. "Hero care
	// se queda en blanco"), así que un keyword pegado a "hero"/"hc" no lo cubre.
	"se queda en blanco", "queda en blanco", "pantalla en blanco", "pantalla blanca",
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
	"tengo marcado ausente", "me quedó marcado ausente", "me quedo marcado ausente",
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
		"hero no", "hero se", "hero cai", "se cayo el hero", "se cayó el hero",
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

// Extensiones de archivo comunes que looks como "nombre.apellido" pero no son un correo
// abreviado (ej. "formulario.pdf", "captura.jpg") — se excluyen para evitar falsos positivos.
const PARTIAL_EMAIL_FALSE_POSITIVE_EXT = /\.(com|net|org|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|mp4|zip|rar|txt|csv)$/i;

/**
 * Busca un token tipo "nombre.apellido" (correo sin @dominio) dentro de un mensaje más largo,
 * no solo cuando el mensaje entero es la abreviación. Los agentes casi siempre lo escriben
 * mezclado con el resto del reporte (ej. "correo: victor.garces, se cayó el internet").
 */
function findEmbeddedPartialEmailToken(text: string): string | null {
	const tokens = text.split(/\s+/);
	for (const rawToken of tokens) {
		const token = rawToken.replace(/^[^\wáéíóúñ]+|[^\wáéíóúñ]+$/gi, "");
		if (!token) continue;
		// Excepción a la exclusión de ".com": este patrón exacto es el typo del sufijo
		// corporativo sin arroba, no un archivo adjunto — se reconoce igual.
		if (CORPORATE_EMAIL_TYPO_RE.test(token)) return token;
		if (PARTIAL_EMAIL_FALSE_POSITIVE_EXT.test(token)) continue;
		if (matchesPartialEmail(token)) return token;
	}
	return null;
}

// Todos los correos corporativos de PedidosYa llevan este sufijo antes del dominio
// (ej. "victor.garces_ndo.ext@pedidosya.com"), pero los agentes casi nunca lo incluyen
// al abreviar su correo como "victor.garces". Hay que completarlo para que la desconexión
// llegue con el correo real, no uno inexistente.
const CORPORATE_EMAIL_SUFFIX = "_ndo.ext";
const CORPORATE_EMAIL_DOMAIN = "@pedidosya.com";

// Los agentes tercerizados/externos tienen su correo real terminado en "_ext" en vez de
// "_ndo.ext" — es un sufijo corporativo válido, no una abreviación a completar. Si ya viene
// con cualquiera de estos sufijos no hay que tocarlo, o se termina duplicando (ej. la agente
// escribe "karen.suarez_ext@pedidosya.com" y queda "karen.suarez_ext_ndo.ext@pedidosya.com").
const CORPORATE_EMAIL_KNOWN_SUFFIXES = [CORPORATE_EMAIL_SUFFIX, "_ext"];

// Typo frecuente: al agente se le va la mano y escribe ".com" en vez de "@pedidosya.com"
// después del sufijo corporativo (le falta la arroba), ej. "cristian.david_ndo.ext.com".
// Sin este caso especial, PARTIAL_EMAIL_FALSE_POSITIVE_EXT lo descarta por terminar en ".com"
// (pensando que es un archivo adjunto) y el correo real nunca se reconstruye.
const CORPORATE_EMAIL_TYPO_RE = /^([\wáéíóúñ+%-]+(?:\.[\wáéíóúñ+%-]+)+_ndo\.ext)\.com$/i;

/** "victor.garces" → "victor.garces_ndo.ext@pedidosya.com" (no duplica el sufijo si ya viene incluido). */
function buildFullCorporateEmail(localPart: string): string {
	const typoMatch = localPart.match(CORPORATE_EMAIL_TYPO_RE);
	const base = typoMatch ? typoMatch[1] : localPart;
	const hasSuffix = CORPORATE_EMAIL_KNOWN_SUFFIXES.some((suffix) => base.toLowerCase().endsWith(suffix));
	return `${base}${hasSuffix ? "" : CORPORATE_EMAIL_SUFFIX}${CORPORATE_EMAIL_DOMAIN}`;
}

const fallasGroupDebounceKey = (phone: string) => `bot:fallas_group_debounce:${phone}`;
const fallasGroupTimers = new Map<string, NodeJS.Timeout>();
// Última key de mensaje recibida por agente en el grupo de fallas, para poder reaccionarle
// con ✅ cuando se procese el reporte. Vive en memoria (igual que fallasGroupTimers) porque
// solo se usa dentro de la ventana de debounce activa.
const fallasGroupLastMsgKey = new Map<string, any>();

// Mismo mecanismo de acumulación que el reporte de fallas, pero para "me conecté tarde" /
// corrección de ausencia — track separado porque termina en una acción distinta (clearAgentAbsence
// en vez de queueAgentOffline) y no debe mezclarse con reportes de conectividad.
const absenceGroupDebounceKey = (phone: string) => `bot:fallas_group_absence_debounce:${phone}`;
const absenceGroupTimers = new Map<string, NodeJS.Timeout>();
const absenceGroupLastMsgKey = new Map<string, any>();

// Mismo patrón que absenceGroupTimers/absenceGroupLastMsgKey pero para reportes de "no puedo/
// no pude conectarme a mi turno" (ver processCannotConnectReport).
const cannotConnectGroupDebounceKey = (phone: string) => `bot:fallas_group_cannot_connect_debounce:${phone}`;
const cannotConnectGroupTimers = new Map<string, NodeJS.Timeout>();
const cannotConnectGroupLastMsgKey = new Map<string, any>();

function extractGroupMessageText(msg: any): string {
	return (
		msg.message?.conversation ||
		msg.message?.extendedTextMessage?.text ||
		msg.message?.imageMessage?.caption ||
		msg.message?.videoMessage?.caption ||
		""
	);
}

/** Intenta extraer el LOB del texto libre de un reporte del grupo. */
function extractLobFromText(text: string): string | null {
	// El separador entre "LOB" y el valor no siempre es ":" o un espacio — el formulario que
	// completan los agentes suele traer un guion ("3️⃣ Tu LOB - FR"), que antes no matcheaba y
	// dejaba el LOB sin extraer aunque el agente sí lo hubiera puesto.
	//
	// Algunos agentes escriben el formulario entero pegado, sin espacio ni salto de línea entre
	// campos (ej. "Motivo: Internet3️⃣ LOB: Cs Live4️⃣ Enviar Video o Foto"). El emoji numeral del
	// siguiente campo queda pegado justo después del valor, y como no es ninguno de los
	// terminadores explícitos (",", ";", ".", salto de línea o fin del texto) el match entero
	// fallaba y el LOB no se extraía. El lookahead genérico corta apenas aparece cualquier
	// carácter fuera del charset del valor (letras/espacios), sin depender de un separador
	// explícito; los dígitos se sacaron del charset del valor para que no se coman el "3️⃣"/"4️⃣".
	const m = text.match(/\blob[:\s-]+([a-záéíóúñüa-z\s]{2,40}?)(?=[,;.\n]|[^a-záéíóúñüa-z\s]|$)/i);
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

// El correo de ejemplo que usamos en la plantilla de "cómo reportar una falla". Si un TL (u otro
// agente) reenvía esa plantilla al grupo como recordatorio, jamás debe tratarse como el correo
// de un agente real reportando algo — ni tampoco procesarse como un reporte en sí.
const TEMPLATE_EXAMPLE_EMAIL = "victor.garces_ndo.ext@pedidosya.com";

/**
 * true si el texto es (o incluye) la plantilla informativa de "cómo reportar una falla",
 * reenviada como recordatorio puro — sin datos reales cargados encima.
 *
 * Algunos agentes copian la plantilla entera y solo reemplazan el correo de ejemplo por el
 * suyo real (dejando el resto de la redacción/encabezado igual). Eso SÍ es un reporte real,
 * no debe ignorarse — por eso, si aparece un correo (completo o parcial) distinto al de
 * ejemplo, se considera que el agente cargó su reporte sobre la plantilla y se procesa.
 */
function isReportTemplateMessage(text: string): boolean {
	const lower = text.toLowerCase();
	const hasHeader = lower.includes("cómo reportar una falla") || lower.includes("como reportar una falla");
	const hasTemplateExampleEmail = lower.includes(TEMPLATE_EXAMPLE_EMAIL);
	if (!hasHeader && !hasTemplateExampleEmail) return false;

	const emailMatch = text.match(EMAIL_REGEX);
	const hasRealFullEmail = emailMatch !== null && emailMatch[0].toLowerCase() !== TEMPLATE_EXAMPLE_EMAIL;
	const hasRealPartialEmail = emailMatch === null && findEmbeddedPartialEmailToken(text) !== null;
	return !hasRealFullEmail && !hasRealPartialEmail;
}

// Pending intent system: when any handler finds no profile it saves the intent
// type so that tryRegisterEmailReply can chain back to the right flow.
type PendingIntent =
	| "absence" | "absence_date" | "absence_reason" | "offline" | "offline_reason" | "schedule" | "metrics" | "horas_lob"
	| "appointment" | "appointment_role" | "appointment_phone" | "appointment_date" | "appointment_time" | "appointment_name"
	| "shift_change_stuck";
const pendingIntentKey = (phone: string) => `bot:pending_intent:${phone}`;
const PENDING_INTENT_TTL = 300; // 5 minutes
const horasLobListKey = (phone: string) => `bot:horas_lob_list:${phone}`;
// Guarda la fecha ya resuelta de la ausencia a eliminar mientras se le pide el motivo al agente
// (por qué se conectó tarde) — separado del pendingIntentKey porque este último solo guarda un tag.
const pendingAbsenceDateKey = (phone: string) => `bot:pending_absence_date:${phone}`;

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

// Detects absence-removal intent even when phrased with gerunds or natural language
// e.g. "me ayudas eliminando una ausencia", "ayuda eliminando mi ausente"
function matchesAbsenceIntent(msgLower: string): boolean {
	if (ABSENCE_KEYWORDS.some((kw) => msgLower.includes(kw))) return true;
	const hasAbsenceNoun = /\b(ausenci[ao]|ausente|faltas?)\b/.test(msgLower);
	// corregir es irregular (corrijo/corrigen/corregir) — corri[jg] cubre las formas con
	// raíz cambiada y correg cubre el infinitivo y las formas regulares (corregir, corregí).
	const hasRemovalVerb = /\b(elimin[a-záéíóúñü]{0,6}|quit[a-záéíóúñü]{0,6}|borr[a-záéíóúñü]{0,6}|sac[a-záéíóúñü]{0,6}|remov[a-záéíóúñü]{0,6}|corri[jg][a-záéíóúñü]{0,6}|correg[a-záéíóúñü]{0,6})\b/.test(msgLower);
	// El agente casi nunca pide explícitamente "sacar/corregir" la ausencia — a veces solo
	// cuenta que sí asistió/entró a horario (disputando la marca sin usar un verbo de
	// remoción), ej. "tengo marcado ausente, asistí a turno a la hora".
	const hasOnTimeClaim = /\b(a\s+la\s+hora|a\s+tiempo|puntual)\b/.test(msgLower);
	return hasAbsenceNoun && (hasRemovalVerb || hasOnTimeClaim);
}

// Frases de "me conecté tarde" en el grupo de fallas — el agente casi nunca dice "ausencia" o
// "eliminar", solo cuenta que llegó tarde. Se combina con matchesAbsenceIntent para cubrir
// también a quien sí pide la corrección explícitamente ("quitar mi ausente", etc.).
// OJO: "conexión tardía"/"conexion tardia" NO están acá a propósito — es la misma frase del
// CTA del template de fallas ("¿Ausencia por conexión tardía?"), así que un agente reportando
// una falla real (luz/HC/internet) que cita esa frase terminaba cayendo en este flujo (que solo
// limpia la ausencia) y nunca llegaba a encolarse como offline (que es lo que excusa los chats).
const LATE_CONNECTION_KEYWORDS = [
	"llegué tarde", "llegue tarde", "llegó tarde", "llego tarde",
	"me conecté tarde", "me conecte tarde", "me conecto tarde",
	"se conectó tarde", "se conecto tarde",
	"entré tarde", "entre tarde", "entró tarde", "entro tarde",
	"me atrasé", "me atrase", "me atrasó", "me atraso",
	"se me hizo tarde", "se me pasó la hora", "se me paso la hora",
];

function matchesLateConnectionIntent(msgLower: string): boolean {
	return LATE_CONNECTION_KEYWORDS.some((kw) => msgLower.includes(kw)) || matchesAbsenceIntent(msgLower);
}

// "No puedo/pude conectarme a mi turno" — a diferencia de LATE_CONNECTION_KEYWORDS (que asume
// que el agente sí llegó a conectarse, solo que tarde), esto cubre a quien avisa que directamente
// no va a poder o no pudo acceder a su turno. No hay nada que desconectar (nunca estuvo en línea)
// ni una ausencia que limpiar todavía (puede avisar antes de que el sistema lo marque ausente),
// así que solo se deja constancia del motivo — ver processCannotConnectReport.
const CANNOT_CONNECT_KEYWORDS = [
	"no puedo conectarme", "no me puedo conectar", "no podré conectarme", "no podre conectarme",
	"no voy a poder conectarme", "no voy a poder entrar", "no voy a poder acceder",
	"no pude conectarme", "no me pude conectar", "no logré conectarme", "no logre conectarme",
	"no logro conectarme", "no puedo entrar a mi turno", "no pude entrar a mi turno",
	"no puedo acceder a mi turno", "no pude acceder a mi turno",
	"no me pude conectar a tiempo", "no pude conectarme a tiempo", "no puedo conectarme a tiempo",
];

function matchesCannotConnectIntent(msgLower: string): boolean {
	return CANNOT_CONNECT_KEYWORDS.some((kw) => msgLower.includes(kw));
}

// "No puedo eliminar mi solicitud de cambio de turno" (por eso no puede hacer el cambio) — vacía
// por completo las colas "cambios_pendientes" y "notificaciones" de la planilla del agente, no solo
// su fila. Detección estricta a propósito (verbo de imposibilidad + verbo de eliminación + "solicitud"
// + "cambio ... turno") porque la acción es destructiva sobre datos compartidos por todo el LOB.
const SHIFT_CHANGE_STUCK_KEYWORDS = [
	"no puedo eliminar mi solicitud de cambio de turno", "no puedo eliminar la solicitud de cambio de turno",
	"no puedo borrar mi solicitud de cambio de turno", "no puedo borrar la solicitud de cambio de turno",
	"no puedo cancelar mi solicitud de cambio de turno", "no puedo cancelar la solicitud de cambio de turno",
	"no me deja eliminar mi solicitud de cambio de turno", "no me deja eliminar la solicitud de cambio de turno",
	"no me deja borrar mi solicitud de cambio de turno", "no me deja cancelar la solicitud de cambio de turno",
	"no pude eliminar mi solicitud de cambio de turno", "no pude eliminar la solicitud de cambio de turno",
];

function matchesShiftChangeStuckIntent(msgLower: string): boolean {
	if (SHIFT_CHANGE_STUCK_KEYWORDS.some((kw) => msgLower.includes(kw))) return true;
	const hasCannotClause  = /\bno\s+(puedo|pude|me\s+deja|logro|logré|logre)\b/.test(msgLower);
	const hasRemovalVerb   = /\b(elimin[a-záéíóúñü]{0,6}|borr[a-záéíóúñü]{0,6}|cancel[a-záéíóúñü]{0,6})\b/.test(msgLower);
	const hasRequestNoun   = /\bsolicitud(es)?\b/.test(msgLower);
	const hasShiftChangeNoun = /\bcambio\b[a-záéíóúñü\s]{0,15}\bturno\b/.test(msgLower);
	return hasCannotClause && hasRemovalVerb && hasRequestNoun && hasShiftChangeNoun;
}

// LOB sin sigla "conocida" fuera de cs/sm/po/go/ov (ver LOB_DETECT) que igual aparecen en los
// anuncios de los TL en el grupo de fallas (ej. "los acompaño con AJ, RV, PDI, FR, IM, LG, OUT
// y ATO"). No tienen nombre largo asociado en el bot, así que se matchean por sigla exacta.
const TL_ANNOUNCEMENT_EXTRA_LOBS = ["aj", "rv", "pdi", "fr", "im", "lg", "out", "ato", "ddc", "iv"] as const;
const TL_ANNOUNCEMENT_QUERYABLE_LOBS = ["cs", "sm", "po", "go", "ov", ...TL_ANNOUNCEMENT_EXTRA_LOBS];
const TL_ANNOUNCEMENT_CAP_SECONDS = 14 * 60 * 60;

// Correos corporativos de los TL — única fuente de verdad de "quién es TL" para no dejar que la
// reacción de un agente cualquiera en el grupo de fallas cuente como reacción de TL (ver
// markTlReactionAndUpdateSheet). El teléfono de quien reacciona se resuelve a un correo vía
// agent_profiles (mismo mapping que usa el resto del bot) y se valida contra esta lista.
const TL_KNOWN_EMAILS = new Set([
	"daniela.perez_ndo.ext@pedidosya.com",
	"paola.aguilar_ndo.ext@pedidosya.com",
	"maria.villamizar_ndo.ext@pedidosya.com",
	"esteban.ospina_ndo.ext@pedidosya.com",
	"luz.rodriguez_ndo.ext@pedidosya.com",
	"merlin.lopez_ndo.ext@pedidosya.com",
	"andrea.fernandez_ndo.ext@pedidosya.com",
	"luis.aguilar_ndo.ext@pedidosya.com",
	"diana.duran_ndo.ext@pedidosya.com",
	"jineth.basallo_ndo.ext@pedidosya.com",
	"andres.rojas_ndo.ext@pedidosya.com",
	"carlos.infante_ndo.ext@pedidosya.com",
	"carlos.rodriguez_ndo.ext@pedidosya.com",
	"victor.garces_ndo.ext@pedidosya.com",
	"dassy.angulos_ndo.ext@pedidosya.com",
	"kevin.jimenez_ndo.ext@pedidosya.com",
	"ana.sierra_ndo.ext@pedidosya.com",
	"angelica.gomez_ndo.ext@pedidosya.com",
	"julieth.roa_ndo.ext@pedidosya.com",
	"lorena.saen_ndo.ext@pedidosya.com",
	"valentina.gonzalez_ndo.ext@pedidosya.com",
	"paola.paz_ndo.ext@pedidosya.com",
	"maria.chia_ndo.ext@pedidosya.com",
]);

/** LOB que `phone` tiene anunciados como cobertura vigente ahora mismo (ver saveTlAnnouncement). */
async function findActiveTlLobsForPhone(phone: string): Promise<string[]> {
	const lobs: string[] = [];
	await Promise.all(
		TL_ANNOUNCEMENT_QUERYABLE_LOBS.map(async (lob) => {
			const announcement = await getTlAnnouncement(lob).catch(() => null);
			if (announcement?.phone === phone) lobs.push(lob);
		}),
	);
	return lobs;
}

/** Correo registrado (agent_profiles) para `phone`, sin validar todavía si es TL — ver
 * resolveReactorTlIdentity, que cruza esto contra TL_KNOWN_EMAILS y el rooster de Wolftls. */
async function resolveReactorProfileEmail(phone: string): Promise<string | null> {
	const profile = await getAgentProfile(phone).catch(() => null);
	return profile?.email ?? null;
}

/**
 * LOB de WOLFTLS_COVERED_LOBS que el rooster de Wolftls dice que `email` debería estar cubriendo
 * ahora mismo — fuente de verdad adicional a los anuncios manuales del grupo (ver
 * findActiveTlLobsForPhone). Si Wolftls no está configurado o `email` es null, devuelve [].
 */
async function findScheduledLobsForEmail(email: string | null): Promise<string[]> {
	if (!email) return [];
	const normalized = email.toLowerCase();
	const lobs: string[] = [];
	await Promise.all(
		WOLFTLS_COVERED_LOBS.map(async (lob) => {
			const scheduled = await getScheduledTlForLob(lob).catch(() => null);
			if (scheduled?.email === normalized) lobs.push(lob);
		}),
	);
	return lobs;
}

/** "los acompaño con...", "les acompaño...", "a partir de este momento los acompaño..." */
function isTlAnnouncementMessage(text: string): boolean {
	return /acompañ/i.test(text);
}

/** Detecta qué LOB dice estar cubriendo un TL en su mensaje de anuncio. */
function extractAnnouncedLobs(text: string): string[] {
	const found = new Set<string>();
	if (/\bcs\s*live\b/i.test(text) || /\bcs\b/i.test(text)) found.add("cs");
	if (/\bsocial\s*media\b/i.test(text) || /\bsm\b/i.test(text)) found.add("sm");
	if (/\bpago\s*online\b/i.test(text) || /\bpo\b/i.test(text)) found.add("po");
	if (/\bgesti[oó]n\s*offline\b/i.test(text) || /\bgo\b/i.test(text)) found.add("go");
	if (/\bovernight\b/i.test(text) || /\bov\b/i.test(text)) found.add("ov");
	for (const lob of TL_ANNOUNCEMENT_EXTRA_LOBS) {
		if (new RegExp(`\\b${lob}\\b`, "i").test(text)) found.add(lob);
	}
	return [...found];
}

/**
 * Cuántos segundos debe quedar vigente el anuncio de un TL. Si menciona una hora de fin
 * explícita ("hasta las 14:00", "hasta las 15uy", "de 21:00 a 02:00 UY") se usa esa hora —
 * siempre en huso horario Uruguay, como el resto de horarios que maneja el bot para este equipo
 * (ver getTLEnTurno). Sin hora explícita, o si la calculada supera el tope, se aplica un tope de
 * seguridad de 14hs para que el anuncio no quede vigente para siempre si el TL nunca avisa que
 * termina turno.
 */
function computeTlAnnouncementTtlSeconds(text: string, now: Date): number {
	const hastaMatch = text.match(/hasta\s+las?\s+(\d{1,2})(?::(\d{2}))?/i);
	const rangeMatch = !hastaMatch
		? text.match(/\bde\s+(\d{1,2})(?::(\d{2}))?\s*a\s+(\d{1,2})(?::(\d{2}))?\b/i)
		: null;
	if (!hastaMatch && !rangeMatch) return TL_ANNOUNCEMENT_CAP_SECONDS;

	const hour = Number(hastaMatch ? hastaMatch[1] : rangeMatch![3]);
	const minute = Number((hastaMatch ? hastaMatch[2] : rangeMatch![4]) ?? 0);
	if (!Number.isFinite(hour) || hour < 0 || hour > 23) return TL_ANNOUNCEMENT_CAP_SECONDS;

	const nowUY = new Date(now.toLocaleString("en-US", { timeZone: "America/Montevideo" }));
	const nowMinutes = nowUY.getHours() * 60 + nowUY.getMinutes();
	let endMinutes = hour * 60 + minute;
	// Si la hora de fin ya pasó respecto a ahora, el turno cruza medianoche (ej. "de 21:00 a
	// 02:00 UY") — corresponde al día siguiente.
	if (endMinutes <= nowMinutes) endMinutes += 24 * 60;
	const ttlSeconds = (endMinutes - nowMinutes) * 60;
	return Math.min(Math.max(ttlSeconds, 60), TL_ANNOUNCEMENT_CAP_SECONDS);
}

type TlAnnouncement = { phone: string; name: string; jid: string; until: string };
const tlAnnouncementKey = (lob: string) => `bot:tl_announcement:${lob}`;

/** Fecha de hoy (huso Uruguay) en formato YYYY-MM-DD — mismo formato que usa
 * tl-no-announced-report-cron.ts para cruzar contra el rooster del día. */
function currentDateUruguayISO(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: "America/Montevideo" });
}

/**
 * Un anuncio nuevo para el mismo LOB siempre reemplaza al anterior (mismo SET, misma key).
 * `until` (hora de fin en ISO) se guarda junto al anuncio para poder mostrarla en el aviso de
 * Telegram de "TL sin responder" (ver checkStaleTlReactions) sin tener que recalcularla a partir
 * del TTL restante.
 */
async function saveTlAnnouncement(
	lob: string,
	announcement: Omit<TlAnnouncement, "until">,
	ttlSeconds: number,
): Promise<void> {
	const until = new Date(Date.now() + ttlSeconds * 1000).toISOString();
	await redisClient.set(tlAnnouncementKey(lob), JSON.stringify({ ...announcement, until }), "EX", ttlSeconds);
}

async function getTlAnnouncement(lob: string): Promise<TlAnnouncement | null> {
	const raw = await redisClient.get(tlAnnouncementKey(lob));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as TlAnnouncement;
	} catch {
		return null;
	}
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

// "Termino mi turno y tengo cola/casos pendientes, reasignen" — no es una falla técnica sino
// fin de turno con chats activos sin cerrar. Se resuelve con el mismo mecanismo de "Fuera de
// línea" (reasigna los chats vía el Monitor), solo cambia el motivo. Se exigen las dos señales
// combinadas para no confundir con un simple "ya termino mi turno" de saludo/aviso sin pedir nada.
const SHIFT_END_PATTERN = /\btermin[oóaeí]{0,3}\s+(el\s+|mi\s+)?turno\b/;
const PENDING_CASES_PATTERN = /reasign|tengo cola|casos pendientes|tengo casos|gestionando casos/;

function isEndOfShiftReassignRequest(msgLower: string): boolean {
	return SHIFT_END_PATTERN.test(msgLower) && PENDING_CASES_PATTERN.test(msgLower);
}

// Temas que a veces llegan al grupo de fallas con el mismo formato del formulario (correo +
// motivo + LOB) pero que NO son una falla de conectividad — dudas de horario de almuerzo o
// errores de Slack. No hay nada que desconectar acá: si se encolaran igual que una falla real
// (queueAgentOffline → status "pending"), el Monitor externo terminaría desconectando al agente
// por algo que no tiene nada que ver con su turno.
const NON_DISCONNECTION_TOPIC_KEYWORDS = [
	"slack",
	"almuerzo", "lunch", "hora de comer", "hora de comida",
];

/** true si el motivo del reporte es un tema que no amerita desconectar al agente (ver arriba). */
function isNonDisconnectionTopic(text: string): boolean {
	const lower = text.toLowerCase();
	return NON_DISCONNECTION_TOPIC_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Clasifica el tipo de falla a partir del texto libre del agente. */
function classifyFailureReason(text: string): string {
	const lower = text.toLowerCase();
	if (isEndOfShiftReassignRequest(lower)) return "Fin de turno con casos pendientes de reasignar";
	if (lower.includes("luz") || lower.includes("energ") || lower.includes("corriente")
		|| lower.includes("apag") || lower.includes("electric")) return "Falla de luz / energía eléctrica";
	if (/\bpc\b/.test(lower) || lower.includes("computador") || lower.includes("equipo")
		|| lower.includes("actualiz")) return "PC dañada o actualizando";
	if (lower.includes(" hc") || lower.includes("hc ") || lower.includes("hc\n") || lower === "hc"
		|| lower.startsWith("hc ")) return "Aplicativo HC no funciona";
	if (lower.includes(" hero") || lower.includes("hero ") || lower.includes("hero\n") || lower === "hero"
		|| lower.startsWith("hero ")) return "Aplicativo Hero no funciona";
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

/** Fecha actual en Argentina (YYYY-MM-DD) — usada cuando el agente no menciona una fecha explícita. */
function todayDateAR(): string {
	return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).toISOString().slice(0, 10);
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

	// El historial de eliminaciones se registra en la planilla del Monitor (misma de
	// offline_queue_sheet_id), no en la de Presentismo — ahí queda centralizado con el resto
	// de las acciones que el bot ejecuta sobre los agentes.
	const logSheetId = (settings.offline_queue_sheet_id as string) || "";

	// Ya tenemos la fecha resuelta de un turno anterior y estamos esperando el motivo por el
	// que se conectó tarde — este mensaje es la respuesta, no una fecha ni un nuevo pedido.
	const pendingDate = await redisClient.get(pendingAbsenceDateKey(phone));
	if (pendingDate) {
		const motivo = message.trim();
		if (!motivo) {
			return buildDirectReply(
				"Necesito el motivo por el que te conectaste tarde ese día 📝",
				'Ej: "se me pasó la hora", "se me fue la luz un rato", "problema con el internet al iniciar"',
			);
		}
		await redisClient.del(pendingAbsenceDateKey(phone));
		await redisClient.del(pendingIntentKey(phone));
		return await finalizeAbsenceRemoval(phone, profile.email, ids, pendingDate, motivo, logSheetId);
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

	if (!isInCurrentWeekAR(targetDate)) {
		await redisClient.del(pendingIntentKey(phone));
		return buildDirectReply(
			"⚠️ Solo podés eliminar ausentes de la semana actual directamente acá.",
			"Para ausencias de semanas anteriores completá el siguiente formulario:",
			"https://docs.google.com/forms/d/e/1FAIpQLSeQchP9yHLO7s2w48k0SN3dS-p-ibVzkw9MQJIDLIrsww8LHQ/viewform",
		);
	}

	// Fecha válida — antes de tocar la planilla se pide el motivo de la conexión tardía,
	// que va a quedar registrado junto con el correo y el día en la hoja de auditoría.
	await redisClient.set(pendingAbsenceDateKey(phone), targetDate, "EX", PENDING_INTENT_TTL);
	await redisClient.set(pendingIntentKey(phone), "absence_reason", "EX", PENDING_INTENT_TTL);
	return buildDirectReply(
		"Antes de eliminarla necesito un dato más 📝",
		"¿Cuál fue el motivo por el que te conectaste tarde ese día?",
	);
}

async function finalizeAbsenceRemoval(
	phone:       string,
	email:       string,
	ids:         string[],
	targetDate:  string,
	motivo:      string,
	logSheetId:  string,
): Promise<string> {
	try {
		const result = await clearAgentAbsence(email, ids, targetDate);

		if (result.success) {
			if (logSheetId) await logAbsenceRemoval(logSheetId, email, result.fecha, result.horario, motivo);
			const firstName = deriveFirstNameFromEmail(email);
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

		if (result.reason === "ctt_ceded") {
			return buildDirectReply(
				"⚠️ Esa ausencia no se puede eliminar: figura como turno cedido (CTT).",
				"Si creés que es un error, consultá con el TL.",
			);
		}

		return buildDirectReply("No pude procesar tu solicitud en este momento. Intentá de nuevo.");
	} catch (err) {
		console.error("[absence] Error:", err);
		return buildDirectReply("Ocurrió un error al intentar eliminar el ausente. Intentá de nuevo en unos minutos.");
	}
}

/**
 * Un agente que no puede eliminar su solicitud de cambio de turno queda trabado y no puede
 * realizar el cambio — se resetean por completo (solo encabezados) las pestañas
 * "cambios_pendientes" y "notificaciones" de SU planilla (según en cuál de las dos
 * programaciones configuradas figure su email), no solo su fila.
 */
async function tryClearShiftChangeQueuesReply(phone: string): Promise<string | null> {
	const profile = await getAgentProfile(phone);
	if (!profile) {
		await redisClient.set(pendingIntentKey(phone), "shift_change_stuck", "EX", PENDING_INTENT_TTL);
		return buildDirectReply(
			"Para revisar tu solicitud de cambio de turno necesito tu email corporativo 📧",
			'Respondé con tu email, ej: "luis@pedidosya.com"',
		);
	}

	const settings = await getSettings();
	const ids = [...new Set([
		(settings.programacion_1_id as string) || "",
		(settings.programacion_2_id as string) || "",
	].filter(Boolean))];
	if (!ids.length) {
		return buildDirectReply("Las programaciones no están configuradas. Contactá al TL.");
	}

	try {
		const targetId = await findAgentSpreadsheetId(profile.email, ids);
		if (!targetId) {
			return buildDirectReply(
				"No pude ubicar tu planilla de programación para hacer la limpieza 😕",
				"Consultá con el TL.",
			);
		}

		const { cambiosPendientes, notificaciones } = await clearShiftChangeQueues(targetId);
		const firstName = deriveFirstNameFromEmail(profile.email);
		return buildDirectReply(
			firstName ? `✅ Listo, ${firstName}: reinicié la cola de cambios de turno` : "✅ Reinicié la cola de cambios de turno",
			`Se vaciaron cambios_pendientes (${cambiosPendientes} fila${cambiosPendientes === 1 ? "" : "s"}) y notificaciones (${notificaciones} fila${notificaciones === 1 ? "" : "s"}).`,
			"Probá de nuevo desde la plataforma. Si sigue sin dejarte, avisale al TL.",
		);
	} catch (err) {
		console.error("[shift-change-stuck] Error limpiando colas:", err);
		return buildDirectReply("No pude limpiar la cola en este momento. Intentá de nuevo en unos minutos o avisale al TL.");
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
		if (queued.ok) {
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

// Envía un texto en el grupo de fallas simulando presencia humana ("escribiendo..." antes,
// "pausado" después) — a diferencia de las reacciones ✅ (que sí pueden ser instantáneas,
// reaccionar rápido a un mensaje es un patrón humano normal), un texto que llega sin ningún
// delay ni indicador de "escribiendo" es una señal de latencia sub-humana.
async function sendGroupTextWithPresence(jid: string, text: string, mentions?: string[]): Promise<void> {
	await globalSock?.sendPresenceUpdate("composing", jid).catch(() => {});
	await sendViaGlobalSock(jid, mentions ? { text, mentions } : { text }, { kind: "reactive" });
	await globalSock?.sendPresenceUpdate("paused", jid).catch(() => {});
}

// La reacción ✅ de confirmación cae justo en una de las ~46 desconexiones/reconexiones diarias
// (~5-10s cada una, ver isSocketConnected) con más frecuencia de lo que parece: sendViaGlobalSock
// tira si el socket no está listo y no hay cola/retry para reacciones, así que sin este helper el
// agente hacía todo el trabajo real (offline encolado, ausencia corregida, reporte confirmado) pero
// nunca veía el check — mismo síntoma visible que abortar el procesamiento entero. Reintenta un par
// de veces espaciado a la duración típica de una reconexión antes de rendirse (y loguearlo, en vez
// de tragarse el error en silencio).
async function sendReportReaction(lastMsgKey: any, reportId: number): Promise<void> {
	const delaysMs = [6000, 15000];
	for (let attempt = 0; ; attempt++) {
		try {
			await sendViaGlobalSock(
				lastMsgKey.remoteJid as string,
				{ react: { text: "✅", key: lastMsgKey } },
				{ kind: "reactive" },
			);
			return;
		} catch (err) {
			if (attempt >= delaysMs.length) {
				console.error(`[fallas-group] No se pudo mandar la reacción ✅ del reporte ${reportId} tras reintentos:`, err);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
		}
	}
}

async function processFallasGroupReport(phone: string, senderName: string, lastMsgKey?: any): Promise<void> {
	const debounceKey = fallasGroupDebounceKey(phone);
	const raw = await redisClient.get(debounceKey);
	await redisClient.del(debounceKey);
	if (!raw) return;

	const parts: string[] = JSON.parse(raw);
	const reason = parts.join(" ").trim();
	if (!reason) return; // sin motivo no hay nada que procesar

	const emailMatch = reason.match(EMAIL_REGEX);
	// El dominio/sufijo que haya puesto el agente se descarta siempre y se reconstruye con
	// buildFullCorporateEmail — igual que en tryRegisterEmailReply — para no grabar en la
	// planilla un typo de dominio (ej. "pedidisya.com") tal cual lo escribió el agente.
	const matchedEmail = emailMatch ? buildFullCorporateEmail(emailMatch[0].toLowerCase().split("@")[0]) : undefined;
	const profile = await getAgentProfile(phone);
	// Si el número ya está registrado, su correo verificado manda siempre — un correo
	// suelto en el texto (typo, el de un compañero, etc.) nunca debe pisarlo. El correo de
	// ejemplo de la plantilla nunca cuenta como correo real, aunque haya quedado pegado al texto.
	const email = profile?.email || (matchedEmail && matchedEmail !== TEMPLATE_EXAMPLE_EMAIL ? matchedEmail : undefined);
	const formStatus = detectFormStatus(reason);
	const lob = extractLobFromText(reason) ?? undefined;
	const failureType = classifyFailureReason(reason);
	const isNonDisconnection = isNonDisconnectionTopic(reason);

	try {
		await notifyGroupFailureReport({ phone, senderName, email, reason, formStatus, resolved: false, lob, failureType });
	} catch (err) {
		console.error("[fallas-group] Error notificando a Telegram:", err);
	}

	let reportId: number | null = null;
	try {
		const saved = await insertGroupFailureReport({ phone, senderName, email, reason, formStatus, lob, whatsappMessageId: lastMsgKey?.id ?? null });
		reportId = saved.id;
	} catch (err) {
		console.error("[fallas-group] Error guardando el reporte en la base:", err);
	}

	// Sin correo identificado no hay a quién desconectar — se ignora sin pedir aclaraciones.
	if (!email || reportId === null) return;

	const settings = await getSettings().catch(() => ({} as Record<string, unknown>));
	const spreadsheetId = (settings.offline_queue_sheet_id as string) || "";
	if (!spreadsheetId) return;

	try {
		let queued: { ok: boolean; row: number | null };
		if (isNonDisconnection) {
			// Slack, dudas de almuerzo, etc.: se deja constancia en la planilla (misma pestaña
			// "pending_offline") pero con status/result "ok" en vez de "pending" — igual que
			// logNoConnectionReport — para que el Monitor externo NO lo tome como una
			// desconexión a ejecutar. No hay nada que desconectar acá.
			queued = await logNoConnectionReport(email, reason, spreadsheetId, lob);
		} else {
			const queueReason = `${failureType}${lob ? ` — LOB ${lob}` : ""} (reportado en grupo de fallas)`;
			queued = await queueAgentOffline(email, queueReason, spreadsheetId, lob);
		}
		const confirmed = await markGroupFailureReportConfirmed(reportId, queued.ok, queued.row != null ? { spreadsheetId, row: queued.row } : null);
		// El TL puede reaccionar en el ratito entre insertGroupFailureReport y este confirm —
		// en ese caso markTlReactionForOthers ya corrió pero no encontró sheet_row, así que la
		// reacción quedó guardada solo en Postgres. Se completa acá si fue el caso.
		if (queued.row != null && confirmed.tl_reacted_at && confirmed.tl_reacted_by) {
			const seconds = Math.round((confirmed.tl_reacted_at.getTime() - confirmed.created_at.getTime()) / 1000);
			updatePendingOfflineReaction(spreadsheetId, queued.row, seconds, confirmed.tl_reacted_by).catch((err) =>
				console.error("[fallas-group] Error completando reacción de TL adelantada:", err),
			);
		}
		if (queued.ok && lastMsgKey) {
			await sendReportReaction(lastMsgKey, reportId);
		}
	} catch (err) {
		console.error("[fallas-group] Error procesando offline directo:", err);
	}
}

/**
 * Igual que processFallasGroupReport pero para "me conecté tarde" / corrección de ausencia:
 * junta el correo + motivo acumulados, resuelve la fecha (si no la mencionan, asume hoy) y
 * corrige directamente la ausencia en la planilla — sin diálogo, misma política que el resto
 * del grupo. El historial queda en la hoja "eliminacion de ausencia" del Monitor.
 */
async function processAbsenceCorrectionReport(phone: string, senderName: string, lastMsgKey?: any): Promise<void> {
	const debounceKey = absenceGroupDebounceKey(phone);
	const raw = await redisClient.get(debounceKey);
	await redisClient.del(debounceKey);
	if (!raw) return;

	const parts: string[] = JSON.parse(raw);
	const motivo = parts.join(" ").trim();
	if (!motivo) return;

	const emailMatch = motivo.match(EMAIL_REGEX);
	// Mismo criterio que processFallasGroupReport: se descarta el dominio/sufijo escrito por
	// el agente y se reconstruye siempre con buildFullCorporateEmail.
	const matchedEmail = emailMatch ? buildFullCorporateEmail(emailMatch[0].toLowerCase().split("@")[0]) : undefined;
	const profile = await getAgentProfile(phone);
	// El correo de ejemplo de la plantilla nunca cuenta como correo real.
	const email = profile?.email || (matchedEmail && matchedEmail !== TEMPLATE_EXAMPLE_EMAIL ? matchedEmail : undefined);
	const targetDate = parseDateFromMessage(motivo) || todayDateAR();

	try {
		await notifyGroupFailureReport({
			phone, senderName, email,
			reason: `Corrección de ausencia (conexión tardía): ${motivo}`,
			formStatus: "unknown", resolved: false,
		});
	} catch (err) {
		console.error("[fallas-group] Error notificando a Telegram (corrección de ausencia):", err);
	}

	let reportId: number | null = null;
	try {
		const saved = await insertGroupFailureReport({ phone, senderName, email, reason: motivo, formStatus: "unknown", whatsappMessageId: lastMsgKey?.id ?? null });
		reportId = saved.id;
	} catch (err) {
		console.error("[fallas-group] Error guardando el reporte de corrección de ausencia:", err);
	}

	// Sin correo identificado no hay a quién corregirle la ausencia — se ignora sin pedir aclaraciones.
	if (!email || reportId === null) return;

	const settings = await getSettings().catch(() => ({} as Record<string, unknown>));
	const ids = [...new Set([
		(settings.programacion_1_id as string) || "",
		(settings.programacion_2_id as string) || "",
	].filter(Boolean))];
	const logSheetId = (settings.offline_queue_sheet_id as string) || "";
	if (!ids.length) return;

	if (!isInCurrentWeekAR(targetDate)) {
		try {
			await sendGroupTextWithPresence(
				lastMsgKey?.remoteJid as string,
				"⚠️ Solo puedo corregir ausencias de la semana actual acá. Para semanas anteriores completá el formulario:\nhttps://docs.google.com/forms/d/e/1FAIpQLSeQchP9yHLO7s2w48k0SN3dS-p-ibVzkw9MQJIDLIrsww8LHQ/viewform",
			);
		} catch (err) {
			console.error("[fallas-group] Error avisando fuera de semana actual:", err);
		}
		return;
	}

	try {
		const result = await clearAgentAbsence(email, ids, targetDate);
		if (result.success) {
			if (logSheetId) await logAbsenceRemoval(logSheetId, email, result.fecha, result.horario, motivo);
			await markGroupFailureReportConfirmed(reportId, true);
			if (lastMsgKey) {
				await sendReportReaction(lastMsgKey, reportId);
			}
		} else if (result.reason === "not_found") {
			await markGroupFailureReportConfirmed(reportId, false);
			await sendGroupTextWithPresence(
				lastMsgKey?.remoteJid as string,
				`No encontré una ausencia registrada para vos el ${targetDate.split("-").reverse().join("/")}. Si creés que es un error, contactá al TL.`,
			);
		} else if (result.reason === "ctt_ceded") {
			await markGroupFailureReportConfirmed(reportId, false);
			await sendGroupTextWithPresence(
				lastMsgKey?.remoteJid as string,
				"⚠️ Esa ausencia no se puede corregir: figura como turno cedido (CTT). Si creés que es un error, contactá al TL.",
			);
		}
	} catch (err) {
		console.error("[fallas-group] Error procesando corrección de ausencia:", err);
	}
}

/**
 * Igual que processFallasGroupReport/processAbsenceCorrectionReport pero para "no puedo/no pude
 * conectarme a mi turno": junta correo + motivo acumulados y solo deja constancia en la planilla
 * (misma pestaña "pending_offline", con status/result "ok" en vez de "pending") — no encola un
 * offline (no hay nada que desconectar, el agente nunca llegó a conectarse) ni toca la planilla
 * de ausencias (puede estar avisando antes de que el sistema lo marque ausente).
 */
async function processCannotConnectReport(phone: string, senderName: string, lastMsgKey?: any): Promise<void> {
	const debounceKey = cannotConnectGroupDebounceKey(phone);
	const raw = await redisClient.get(debounceKey);
	await redisClient.del(debounceKey);
	if (!raw) return;

	const parts: string[] = JSON.parse(raw);
	const motivo = parts.join(" ").trim();
	if (!motivo) return;

	const emailMatch = motivo.match(EMAIL_REGEX);
	// Mismo criterio que el resto del grupo: se descarta el dominio/sufijo escrito por el agente
	// y se reconstruye siempre con buildFullCorporateEmail.
	const matchedEmail = emailMatch ? buildFullCorporateEmail(emailMatch[0].toLowerCase().split("@")[0]) : undefined;
	const profile = await getAgentProfile(phone);
	// El correo de ejemplo de la plantilla nunca cuenta como correo real.
	const email = profile?.email || (matchedEmail && matchedEmail !== TEMPLATE_EXAMPLE_EMAIL ? matchedEmail : undefined);
	const lob = extractLobFromText(motivo) ?? undefined;

	try {
		await notifyGroupFailureReport({
			phone, senderName, email,
			reason: `No pudo/no puede conectarse a su turno: ${motivo}`,
			formStatus: "unknown", resolved: false,
		});
	} catch (err) {
		console.error("[fallas-group] Error notificando a Telegram (no conexión a turno):", err);
	}

	let reportId: number | null = null;
	try {
		const saved = await insertGroupFailureReport({ phone, senderName, email, reason: motivo, formStatus: "unknown", lob, whatsappMessageId: lastMsgKey?.id ?? null });
		reportId = saved.id;
	} catch (err) {
		console.error("[fallas-group] Error guardando el reporte de no conexión a turno:", err);
	}

	// Sin correo identificado no hay a quién registrarle el reporte — se ignora sin pedir aclaraciones.
	if (!email || reportId === null) return;

	const settings = await getSettings().catch(() => ({} as Record<string, unknown>));
	const spreadsheetId = (settings.offline_queue_sheet_id as string) || "";
	if (!spreadsheetId) return;

	try {
		const logged = await logNoConnectionReport(email, motivo, spreadsheetId, lob);
		const confirmed = await markGroupFailureReportConfirmed(reportId, logged.ok, logged.row != null ? { spreadsheetId, row: logged.row } : null);
		// Mismo caso de carrera que en processFallasGroupReport: si el TL ya reaccionó antes de
		// que esta fila terminara de escribirse en el sheet, se completa recién acá.
		if (logged.row != null && confirmed.tl_reacted_at && confirmed.tl_reacted_by) {
			const seconds = Math.round((confirmed.tl_reacted_at.getTime() - confirmed.created_at.getTime()) / 1000);
			updatePendingOfflineReaction(spreadsheetId, logged.row, seconds, confirmed.tl_reacted_by).catch((err) =>
				console.error("[fallas-group] Error completando reacción de TL adelantada:", err),
			);
		}
		if (logged.ok && lastMsgKey) {
			await sendReportReaction(lastMsgKey, reportId);
		}
	} catch (err) {
		console.error("[fallas-group] Error registrando reporte de no conexión a turno:", err);
	}
}

/**
 * Marca que el TL reaccionó (reacción de WhatsApp) y, para el reporte que haya quedado marcado,
 * actualiza los segundos transcurridos en su fila del sheet "pending_offline". Solo cuenta la
 * reacción de WhatsApp (👍, ✅, etc.), no mensajes de texto: un mensaje de texto en el grupo puede
 * ser otro agente reportando su propia falla, no el TL respondiendo a esta. Los mensajes/reacciones
 * que manda el propio bot (fromMe) nunca llegan a esta función (ver el filtro del listener más
 * abajo), así que nunca se cuentan como si el "TL" fuera el bot.
 *
 * Antes de tocar cualquier reporte se valida que quien reaccionó sea un TL identificado, por
 * cualquiera de tres vías: correo en TL_KNOWN_EMAILS, cobertura anunciada vigente en el grupo
 * (findActiveTlLobsForPhone), o cobertura vigente según el rooster de Wolftls
 * (findScheduledLobsForEmail — ver wolftls-client.ts) — si ninguna aplica, la reacción se ignora
 * por completo: un agente cualquiera reaccionando en el grupo ya no le "roba" tiempo de reacción a
 * un reporte ajeno. Con la identidad ya validada, se resuelve el reporte en orden de precisión
 * decreciente: 1) el mensaje puntual reaccionado, si tiene reporte asociado; 2) si el TL tiene LOB
 * anunciados o programados en el rooster, el pendiente más viejo de esos LOB; 3) si no, el
 * pendiente más viejo de cualquier LOB (fallback, solo llega acá si la identidad ya viene
 * confirmada por whitelist).
 */
async function markTlReactionAndUpdateSheet(
	phone: string,
	reactedByName: string,
	targetMessageId?: string | null,
): Promise<void> {
	try {
		const [rawEmail, announcedLobs] = await Promise.all([
			resolveReactorProfileEmail(phone),
			findActiveTlLobsForPhone(phone),
		]);
		const isWhitelisted = !!rawEmail && TL_KNOWN_EMAILS.has(rawEmail.toLowerCase());
		const scheduledLobs = await findScheduledLobsForEmail(rawEmail);
		const effectiveLobs = [...new Set([...announcedLobs, ...scheduledLobs])];
		const isKnownTl = isWhitelisted || effectiveLobs.length > 0;
		if (!isKnownTl) {
			console.log(
				`[fallas-group] Reacción ignorada: ${reactedByName} (${phone}) no está identificado como TL (sin correo en la lista, sin cobertura anunciada, sin cobertura en el rooster de Wolftls).`,
			);
			return;
		}
		const tlEmail = isKnownTl ? rawEmail : null;

		const reactedAt = new Date();
		let rows: Array<{ id: number; phone: string; sheet_row: number | null; sheet_spreadsheet_id: string | null; created_at: Date }> = [];

		if (targetMessageId) {
			const report = await findGroupFailureReportByMessageId(targetMessageId);
			if (report && report.phone !== phone) {
				const updated = await markGroupFailureReportReactedById(report.id, reactedAt, reactedByName, tlEmail);
				if (updated) rows = [updated];
			}
		}

		if (rows.length === 0) {
			const cutoff = new Date(reactedAt.getTime() - 6 * 60 * 60 * 1000);
			rows = effectiveLobs.length > 0
				? await markTlReactionForLobOldest(phone, effectiveLobs, reactedAt, reactedByName, tlEmail, cutoff)
				: await markTlReactionOldestPending(phone, reactedAt, reactedByName, tlEmail, cutoff);
		}

		if (rows.length === 0) return;
		const fallbackSheetId = ((await getSettings().catch(() => ({} as Record<string, unknown>))).offline_queue_sheet_id as string) || "";
		for (const row of rows) {
			if (row.sheet_row == null) continue;
			const spreadsheetId = row.sheet_spreadsheet_id || fallbackSheetId;
			if (!spreadsheetId) continue;
			const seconds = Math.round((reactedAt.getTime() - row.created_at.getTime()) / 1000);
			updatePendingOfflineReaction(spreadsheetId, row.sheet_row, seconds, reactedByName).catch((err) =>
				console.error("[fallas-group] Error actualizando segundos de reacción en el sheet:", err),
			);
		}
	} catch (err) {
		console.error("[fallas-group] Error marcando reacción de TL:", err);
	}
}

/** Detecta un mensaje del grupo de fallas y programa su procesamiento agregado por agente. */
async function handleFallasGroupMessage(msg: any): Promise<void> {
	const phone = resolveFallasGroupSenderPhone(msg);
	if (!phone) return;

	const senderName = (msg.pushName as string) || phone;

	// Una reacción de WhatsApp (👍, ✅, etc.) sobre cualquier mensaje del grupo no trae texto
	// (extractGroupMessageText da ""), así que se resuelve acá antes de exigir texto — muchos TL
	// solo reaccionan al reporte en vez de responder con un mensaje.
	if (msg.message?.reactionMessage) {
		const targetMessageId = msg.message.reactionMessage.key?.id as string | undefined;
		void markTlReactionAndUpdateSheet(phone, senderName, targetMessageId);
		return;
	}

	let text = extractGroupMessageText(msg).trim();
	if (!text) return;

	const lower = text.toLowerCase();

	// Alguien (un TL, otro agente) reenvió la plantilla de "cómo reportar una falla" como
	// recordatorio — es puramente informativa, no un reporte real. Se ignora por completo:
	// no debe acumularse, ni cargarse a Telegram/DB/sheet.
	if (isReportTemplateMessage(text)) return;

	// Anuncio de un TL cubriendo LOB puntuales ("los acompaño con CS y SM hasta las 14:00 UY") —
	// se guarda por LOB individual para poder arrobar directo a ese TL cuando alguien pregunte
	// quién está de turno (ver más abajo), en vez de mandar el link genérico del sheet.
	if (isTlAnnouncementMessage(text)) {
		const announcedLobs = extractAnnouncedLobs(text);
		if (announcedLobs.length > 0) {
			const tlJid = (msg.key?.participant as string | undefined) ?? `${phone}@s.whatsapp.net`;
			const ttlSeconds = computeTlAnnouncementTtlSeconds(text, new Date());
			try {
				await Promise.all(
					announcedLobs.map((lob) =>
						saveTlAnnouncement(lob, { phone, name: senderName, jid: tlJid }, ttlSeconds),
					),
				);
				console.log(
					`[fallas-group] Anuncio de TL guardado: ${senderName} (${phone}) cubre [${announcedLobs.join(", ")}] por ${Math.round(ttlSeconds / 60)}min.`,
				);
				// Historial persistente (no expira como el SET de Redis de arriba) para el reporte de
				// fin de día de TL con turno que nunca se anunciaron — ver tl-no-announced-report-cron.ts.
				const announcerEmail = await resolveReactorProfileEmail(phone).catch(() => null);
				const announcementDay = currentDateUruguayISO();
				Promise.all(
					announcedLobs.map((lob) =>
						recordTlAnnouncement({ lob, phone, name: senderName, email: announcerEmail, day: announcementDay }),
					),
				).catch((err) => {
					console.error("[fallas-group] Error guardando historial persistente de anuncio de TL:", err);
				});
				// El aviso a Telegram de "se anunció cobertura" es solo para el propio anuncio del
				// dueño del bot (tl_coverage_phone en Ajustes) — el resto de los TL anunciándose
				// en el grupo es tráfico normal del día a día y no debe generar ruido en Telegram.
				const ownPhone = ((await getSettings().catch(() => ({} as Record<string, unknown>))).tl_coverage_phone as string || "").replace(/\D/g, "");
				if (ownPhone && phone === ownPhone) {
					const startLabel = formatUyTime(new Date().toISOString()) ?? "ahora";
					const endLabel = formatUyTime(new Date(Date.now() + ttlSeconds * 1000).toISOString()) ?? "";
					notifyTlCoverageAnnounced({
						start: startLabel,
						end: endLabel,
						lobs: announcedLobs,
						name: senderName,
						phone,
					}).catch((err) => {
						console.error("[fallas-group] Error avisando a Telegram del anuncio de TL:", err);
					});
				}
			} catch (err) {
				console.error("[fallas-group] Error guardando anuncio de TL:", err);
			}
			return;
		}
		// Dijo "acompaño" pero no reconocimos ningún LOB en el texto — se loguea para poder
		// ajustar la lista de siglas si hace falta, y se sigue procesando como mensaje normal.
		console.log(`[fallas-group] Mensaje de "acompaño" sin LOB reconocido: "${text}"`);
	}

	// Consulta por el TL en turno → responder directamente en el grupo
	if (matchesTlTurnoQuery(lower)) {
		if (globalSock && isSocketConnected) {
			try {
				// Si hay un anuncio vigente de un TL para el LOB puntual que se pregunta (ej. "tl de
				// aj", "quién cubre pdi"), lo arrobamos directo en vez de mandar el link del sheet —
				// más rápido y más preciso. Si nadie se anunció para ese LOB (o la consulta es
				// genérica sin LOB), seguimos con el comportamiento de siempre, más abajo.
				let candidateLobs = TL_ANNOUNCEMENT_QUERYABLE_LOBS.filter((lob) =>
					new RegExp(`\\b${lob}\\b`, "i").test(lower),
				);
				if (candidateLobs.length === 0 && phone) {
					const profile = await getAgentProfile(phone).catch(() => null);
					const profileLob = profile?.lob?.toLowerCase().trim();
					if (profileLob && TL_ANNOUNCEMENT_QUERYABLE_LOBS.includes(profileLob)) {
						candidateLobs = [profileLob];
					}
				}
				for (const lob of candidateLobs) {
					const announcement = await getTlAnnouncement(lob);
					if (announcement) {
						console.log(`[fallas-group] Consulta de TL respondida con anuncio vigente: ${lob} → ${announcement.name} (${announcement.phone}).`);
						await sendGroupTextWithPresence(
							msg.key.remoteJid as string,
							`@${announcement.phone} está cubriendo ${lob.toUpperCase()} ahora mismo 👋`,
							[announcement.jid],
						);
						return;
					}
				}

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

				// "tl de turno"/"tl de guardia" son frases genéricas, no un LOB. Si en cambio viene
				// una abreviación o nombre puntual después de "tl de" (ej: "tl de aj", "tl de fraude")
				// el agente ya especificó el LOB, aunque no sea uno de los dos grupos con link propio —
				// en ese caso no hay que preguntarle nada, se le manda el link genérico de siempre.
				const mentionedOtherLob = !detectedGroup
					&& /\btl\s+de\s+([a-záéíóúñü]+)/i.test(lower)
					&& !/\btl\s+de\s+(turno|guardia)\b/i.test(lower);

				// Solo se pregunta el LOB cuando el mensaje es genérico de punta a punta (sin LOB
				// en el texto, sin LOB en el perfil y sin ninguna otra abreviación/nombre mencionado).
				const replyText = detectedGroup === "cs_sm"
					? "Entrá acá 👇\nhttps://docs.google.com/spreadsheets/d/e/2PACX-1vSMBOfczLNvjS3nncoU6rGU_GWKbKo4hgzUqRFw6Fqql9IUP4rvenlfQLw7cWXT6EedJL1FEwTLAk0N/pubhtml?gid=176485234&single=true"
					: detectedGroup === "go_po"
					? "Entrá acá 👇\nhttps://docs.google.com/spreadsheets/d/e/2PACX-1vSMBOfczLNvjS3nncoU6rGU_GWKbKo4hgzUqRFw6Fqql9IUP4rvenlfQLw7cWXT6EedJL1FEwTLAk0N/pubhtml?gid=276469694&single=true"
					: mentionedOtherLob
					? "Entrá acá 👇\nhttps://script.google.com/a/macros/pedidosya.com/s/AKfycby0mvlKtQACyQyd7-tTWIUN-jAWV-L95ei0rhMCzyPzCRPzwWN3NWyGCtsa2fd4oRO6/exec\n\nBuscá la pestaña 📋 *TL Activo*"
					: "¿TL de qué LOB necesitás? 🤔";
				await sendGroupTextWithPresence(msg.key.remoteJid as string, replyText);
			} catch (err) {
				console.error("[fallas-group] Error respondiendo consulta de TL en turno:", err);
			}
		}
		return;
	}

	// Mandaron el correo sin @dominio — el mensaje entero o embebido en una frase más larga
	// (ej. "correo: victor.garces, se cayó el internet"). Se completa con el sufijo real
	// de los correos de la empresa (ej. "victor.garces_ndo.ext@pedidosya.com") y se sigue
	// procesando con ese correo armado — no hace falta que el agente vuelva a escribir nada
	// para que la desconexión se registre en el sheet. La corrección es silenciosa: no se
	// le avisa nada en el grupo de fallas/desconexiones.
	const embeddedPartialEmail = !EMAIL_REGEX.test(text) ? findEmbeddedPartialEmailToken(text) : null;
	if (embeddedPartialEmail) {
		const fullEmail = buildFullCorporateEmail(embeddedPartialEmail);
		text = text.replace(embeddedPartialEmail, fullEmail);
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

	// "No puedo/no pude conectarme a mi turno" — se evalúa antes que "me conecté tarde" porque
	// ese flujo asume que el agente sí llegó a conectarse (solo que tarde) y termina intentando
	// limpiar una ausencia ya marcada; acá puede no haber ausencia todavía (aviso previo) ni
	// nada que desconectar (nunca se conectó), así que solo se deja constancia del motivo.
	const isCannotConnectReport = matchesCannotConnectIntent(lower);
	const hasActiveCannotConnectReport = cannotConnectGroupTimers.has(phone);
	if (isCannotConnectReport || hasActiveCannotConnectReport) {
		const cannotConnectKey = cannotConnectGroupDebounceKey(phone);
		const cannotConnectAccumulated: string[] = JSON.parse((await redisClient.get(cannotConnectKey)) || "[]");
		cannotConnectAccumulated.push(text);
		await redisClient.set(cannotConnectKey, JSON.stringify(cannotConnectAccumulated), "EX", FALLAS_GROUP_DEBOUNCE_TTL);
		cannotConnectGroupLastMsgKey.set(phone, msg.key);

		if (!hasActiveCannotConnectReport) {
			const timer = setTimeout(() => {
				cannotConnectGroupTimers.delete(phone);
				const lastMsgKey = cannotConnectGroupLastMsgKey.get(phone);
				cannotConnectGroupLastMsgKey.delete(phone);
				processCannotConnectReport(phone, senderName, lastMsgKey).catch((err) =>
					console.error("[fallas-group] Error procesando reporte de no conexión a turno:", err),
				);
			}, FALLAS_GROUP_DEBOUNCE_MS);
			cannotConnectGroupTimers.set(phone, timer);
		}
		return;
	}

	// "Me conecté tarde" / corrección de ausencia — track separado del de fallas de conectividad,
	// misma lógica de acumulación (junta correo + motivo repartidos en varios mensajes) pero
	// termina corrigiendo la ausencia en la planilla en vez de encolar un offline.
	const isLateConnectionReport = matchesLateConnectionIntent(lower);
	const hasActiveAbsenceReport = absenceGroupTimers.has(phone);
	if (isLateConnectionReport || hasActiveAbsenceReport) {
		const absenceKey = absenceGroupDebounceKey(phone);
		const absenceAccumulated: string[] = JSON.parse((await redisClient.get(absenceKey)) || "[]");
		absenceAccumulated.push(text);
		await redisClient.set(absenceKey, JSON.stringify(absenceAccumulated), "EX", FALLAS_GROUP_DEBOUNCE_TTL);
		absenceGroupLastMsgKey.set(phone, msg.key);

		if (!hasActiveAbsenceReport) {
			const timer = setTimeout(() => {
				absenceGroupTimers.delete(phone);
				const lastMsgKey = absenceGroupLastMsgKey.get(phone);
				absenceGroupLastMsgKey.delete(phone);
				processAbsenceCorrectionReport(phone, senderName, lastMsgKey).catch((err) =>
					console.error("[fallas-group] Error procesando corrección de ausencia:", err),
				);
			}, FALLAS_GROUP_DEBOUNCE_MS);
			absenceGroupTimers.set(phone, timer);
		}
		return;
	}

	// Solo arranca una acumulación nueva si el mensaje en sí menciona una falla. Si ya hay
	// un reporte en curso para este agente, cualquier mensaje suyo se suma (correo, LOB,
	// "ayuda", etc.) aunque no repita la palabra clave — así no se pierde info repartida
	// en varios mensajes seguidos.
	const hasFailureKeyword = OFFLINE_KEYWORDS.some((kw) => lower.includes(kw)) || isEndOfShiftReassignRequest(lower);
	const hasActiveReport = fallasGroupTimers.has(phone);
	// En este grupo dedicado a reportes de fallas, señales simples (internet, luz, HC) son
	// suficientes para disparar el proceso — el contexto del grupo ya garantiza que es un reporte.
	const nearMissCategoriesForGroup = detectNearMissCategories(text);
	const hasGroupOfflineSignal = nearMissCategoriesForGroup.includes("offline");
	// Un agente completando el formulario (correo + motivo + LOB) está reportando algo aunque el
	// texto del motivo no matchee ninguna keyword de OFFLINE_KEYWORDS (ej. "no me ingresa a HC, me
	// pide acceso de Okta y vuelve a iniciar" — no es ninguna de las frases de la lista, así que
	// quedaba en silencio: sin reacción, sin acumular, sin quedar ni como near-miss). El correo es
	// la señal más confiable de que esto es un reporte real en este grupo — a esta altura `text` ya
	// tiene el correo embebido normalizado a formato completo (ver el bloque de arriba), así que
	// alcanza con EMAIL_REGEX para cubrir tanto el correo completo como el "nombre.apellido" suelto.
	const hasEmailSignal = EMAIL_REGEX.test(text);
	if (!hasFailureKeyword && !hasGroupOfflineSignal && !hasEmailSignal && !hasActiveReport) {
		// No matcheó ninguna señal de falla. Si quien escribió es un TL identificado, este texto
		// suelto (ej. "dale, ya lo estoy viendo", "gracias") cuenta como respuesta al reporte
		// pendiente más viejo de su LOB — mismo criterio que ya se usa para una reacción ✅, para
		// que un TL que responde con texto en vez de reaccionar no siga apareciendo como "sin
		// responder" en el aviso de Telegram (markTlReactionAndUpdateSheet valida la identidad y
		// no hace nada si no está identificado como TL).
		void markTlReactionAndUpdateSheet(phone, senderName);
		// Loguear near-misses de otras categorías.
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
	// El dominio/sufijo que haya puesto el agente se descarta siempre: todos los correos
	// corporativos son nombre.apellido_ndo.ext@pedidosya.com, así que reconstruimos a partir
	// del local-part sin importar qué dominio (gmail.com, @pedidosya.com sin sufijo, etc.) haya escrito.
	const rawLocalPart = emailMatch[0].toLowerCase().split("@")[0];
	const email = buildFullCorporateEmail(rawLocalPart);

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

			if (pending === "shift_change_stuck") {
				await redisClient.del(pendingIntentKey(phone));
				const reply = await tryClearShiftChangeQueuesReply(phone);
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

	if (pending === "shift_change_stuck") {
		await redisClient.del(pendingIntentKey(phone));
		const reply = await tryClearShiftChangeQueuesReply(phone);
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

// Último intento de assertSessions por JID (epoch ms) — evita releer/reforzar la misma sesión
// decenas de veces seguidas cuando llega una ráfaga de mensajes fallidos del mismo remitente en
// un solo upsert (cada assertSessions es una llamada de red a los servidores de WhatsApp).
const lastSessionAssertAt = new Map<string, number>();
const SESSION_ASSERT_COOLDOWN_MS = 30_000;

// Alerta temprana de tormenta de "Bad MAC" / fallos de desencriptación (ver incidente
// 2026-08-12: el bot quedó ~22hs sin procesar el grupo de fallas y nadie se enteró hasta que
// preguntaron por qué había dejado de reaccionar). Si se acumulan DECRYPTION_STORM_THRESHOLD
// fallos dentro de DECRYPTION_STORM_WINDOW_MS se avisa una vez por Telegram — con su propio
// cooldown para no espamear si la tormenta sigue — en vez de depender de que alguien lo note.
const decryptionFailureTimestamps: number[] = [];
const DECRYPTION_STORM_WINDOW_MS = 60_000;
const DECRYPTION_STORM_THRESHOLD = 30;
const DECRYPTION_STORM_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
let lastDecryptionStormAlertAt = 0;

/** Registra un fallo de desencriptación y dispara la alerta de Telegram si cruza el umbral. */
function trackDecryptionFailureAndMaybeAlert(): void {
	const now = Date.now();
	decryptionFailureTimestamps.push(now);
	while (decryptionFailureTimestamps.length > 0 && now - decryptionFailureTimestamps[0] > DECRYPTION_STORM_WINDOW_MS) {
		decryptionFailureTimestamps.shift();
	}
	if (decryptionFailureTimestamps.length < DECRYPTION_STORM_THRESHOLD) return;
	if (now - lastDecryptionStormAlertAt < DECRYPTION_STORM_ALERT_COOLDOWN_MS) return;
	lastDecryptionStormAlertAt = now;
	const count = decryptionFailureTimestamps.length;
	void notifyDecryptionStorm(count, Math.round(DECRYPTION_STORM_WINDOW_MS / 1000)).catch((err) =>
		console.error("[bot] Error enviando alerta de tormenta de desencriptación a Telegram:", err),
	);
}

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

export { enqueueSocketSend, getQueuedSendCount };

// Único punto de contacto real con globalSock.sendMessage. Todo envío saliente (respuestas
// reactivas de IA, outbox, crons, grupo de fallas) debe pasar por acá para quedar serializado
// y paceado por la cola global — nunca llamar a globalSock.sendMessage directamente en otro lado.
export async function sendViaGlobalSock(
	jid: string,
	content: AnyMessageContent,
	opts?: { kind?: SendKind },
): Promise<void> {
	await enqueueSocketSend(async () => {
		if (globalSock && isSocketConnected) {
			await globalSock.sendMessage(jid, content);
		} else {
			throw new Error("[bot] Socket no conectado o no listo. No se puede enviar mensaje.");
		}
	}, opts);
}

// Diagnóstico puntual (ver .list-groups-request en start-bot.ts): lista todos los grupos donde
// participa la cuenta conectada, para identificar el gid de un grupo nuevo sin adivinar por logs.
export async function listAllGroups(): Promise<Array<{ id: string; subject: string; participantsCount: number }>> {
	if (!globalSock || !isSocketConnected) {
		throw new Error("[bot] Socket no conectado o no listo. No se puede listar grupos.");
	}
	const groups = await globalSock.groupFetchAllParticipating();
	return Object.values(groups).map((g) => ({
		id: g.id,
		subject: g.subject,
		participantsCount: g.participants?.length ?? 0,
	}));
}

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
				if ((OFFLINE_KEYWORDS.some((kw) => msgLower.includes(kw)) || isEndOfShiftReassignRequest(msgLower) || isOfflineReasonFollowUp) && conv) {
					const reply = await tryGoOfflineReply(conv.phone, lastUserMsg);
					if (reply) return reply;
				}

				// Absence removal intent (Google Sheets write)
				// Also catches multi-turn follow-ups: the date after the bot asked for it, or the
				// motivo (por qué se conectó tarde) after the bot asked for that.
				const pendingAbsence = conv ? await redisClient.get(pendingIntentKey(conv.phone)) : null;
				const isAbsenceDateFollowUp = (pendingAbsence === "absence" || pendingAbsence === "absence_date") && !!parseDateFromMessage(lastUserMsg);
				const isAbsenceReasonFollowUp = pendingAbsence === "absence_reason";
				if ((matchesAbsenceIntent(msgLower) || isAbsenceDateFollowUp || isAbsenceReasonFollowUp) && conv) {
					const reply = await tryRemoveAbsenceReply(conv.phone, lastUserMsg);
					if (reply) return reply;
				}

				// No puede eliminar su solicitud de cambio de turno → reset de las colas
				// cambios_pendientes/notificaciones en su planilla (Google Sheets write)
				const pendingShiftChangeStuck = conv ? await redisClient.get(pendingIntentKey(conv.phone)) : null;
				const isShiftChangeStuckFollowUp = pendingShiftChangeStuck === "shift_change_stuck";
				if ((matchesShiftChangeStuckIntent(msgLower) || isShiftChangeStuckFollowUp) && conv) {
					const reply = await tryClearShiftChangeQueuesReply(conv.phone);
					if (reply) return reply;
				}

				// Menú / ayuda
				if (HELP_KEYWORDS.some((kw) => msgLower.includes(kw)) && conv) {
					const agentProfile = await getAgentProfile(conv.phone);
					const firstName = agentProfile ? deriveFirstNameFromEmail(agentProfile.email) : undefined;
					return buildMenuReply(firstName);
				}

				// Saludo → bienvenida para nuevos; para registrados se deja pasar a la IA
				// (el menú de opciones ya no se manda automático, solo si lo piden explícitamente arriba)
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
		await sendViaGlobalSock(jid, { text }, { kind: "reactive" });
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
	// Los stickers viajan inline en metadata (base64) en vez de por archivo en disco: mediaDir
	// no está en el volumen persistente, así que un sticker en disco no sobreviviría un redeploy.
	const stickerBase64 = outboxMetadata(item).stickerBase64;
	if (mediaType === "image" && typeof stickerBase64 === "string" && stickerBase64) {
		return { sticker: Buffer.from(stickerBase64, "base64") };
	}
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
					await sendViaGlobalSock(jid, outboxSendPayload(item), {
						kind: item.broadcast_batch_id ? "broadcast" : "cron",
					});
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

// Umbral para el (único) aviso de "TL sin responder": se manda una sola vez, entre los 5 y los
// 10 minutos de creado el reporte. Pasados los 10 minutos sin reacción se deja de insistir por
// Telegram con ese reporte puntual — un aviso a tiempo alcanza, y bombardear el chat por reportes
// viejos que el TL ya no va a atender solo genera ruido.
const TL_STALE_FIRST_ALERT_MINUTES = 5;
const TL_STALE_CUTOFF_MINUTES = 10;
const TL_STALE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
let staleTlCheckInterval: NodeJS.Timeout | null = null;
// Momento en que arrancó este proceso: el checker sólo avisa de reportes creados desde acá en
// adelante, para no bombardear Telegram con reportes viejos (de días previos) que quedaron sin
// reacción/sin resolver desde antes de este deploy.
const staleTlCheckerStartedAt = new Date();

function formatUyTime(iso: string | null | undefined): string | null {
	if (!iso) return null;
	try {
		return new Date(iso).toLocaleTimeString("es-UY", {
			timeZone: "America/Montevideo",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return null;
	}
}

/**
 * Corre cada TL_STALE_CHECK_INTERVAL_MS: busca reportes del grupo de fallas sin ninguna reacción
 * de TL desde hace TL_STALE_FIRST_ALERT_MINUTES y avisa por Telegram, arrobando quién es el TL en
 * turno para ese LOB y hasta qué hora dijo (o le tocaba) cubrir — para que quede claro a quién
 * corresponde el tiempo que se está acumulando ahí. Prioriza el anuncio manual del grupo (más
 * específico, lo escribió el TL mismo); si nadie anunció nada para ese LOB, cae al rooster de
 * Wolftls (ver wolftls-client.ts) — así el aviso sigue identificando al TL responsable aunque
 * jamás haya escrito "los acompaño con...". Es un aviso único por reporte: pasados
 * TL_STALE_CUTOFF_MINUTES sin reacción se deja de considerar (ver
 * listStaleUnreactedGroupFailureReports).
 */
async function checkStaleTlReactions(): Promise<void> {
	let stale: GroupFailureReportRow[];
	try {
		stale = await listStaleUnreactedGroupFailureReports(
			TL_STALE_FIRST_ALERT_MINUTES,
			TL_STALE_CUTOFF_MINUTES,
			staleTlCheckerStartedAt,
		);
	} catch (err) {
		console.error("[fallas-group] Error consultando reportes sin reacción de TL:", err);
		return;
	}

	for (const report of stale) {
		const minutesWaiting = Math.round((Date.now() - report.created_at.getTime()) / 60000);
		const announcement = report.lob ? await getTlAnnouncement(report.lob).catch(() => null) : null;

		let tlName = announcement?.name ?? null;
		let tlPhone = announcement?.phone ?? null;
		let tlUntil = formatUyTime(announcement?.until);
		let tlSource: "anuncio" | "rooster" | undefined = announcement ? "anuncio" : undefined;

		if (!announcement && report.lob) {
			const scheduled = await getScheduledTlForLob(report.lob).catch(() => null);
			if (scheduled) {
				const scheduledProfile = await getAgentProfileByEmail(scheduled.email).catch(() => null);
				tlName = scheduled.email;
				tlPhone = scheduledProfile?.phone ?? null;
				tlUntil = scheduled.until;
				tlSource = "rooster";
			}
		}

		try {
			// notifyTlNotResponding no rechaza la promesa en un fallo de la API de Telegram (ver
			// logIfTelegramNotificationFailed en db.ts) — devuelve `false`. Solo se marca el reporte
			// como avisado si de verdad se mandó; si falla (ej. hipo de red puntual), se deja sin
			// marcar para que el próximo tick (dentro de la ventana de TL_STALE_CUTOFF_MINUTES) lo
			// vuelva a intentar en vez de perder el aviso en silencio para siempre.
			const sent = await notifyTlNotResponding({
				agentName: report.sender_name,
				agentPhone: report.phone,
				lob: report.lob,
				reason: report.reason,
				minutesWaiting,
				tlName,
				tlPhone,
				tlUntil,
				tlSource,
			});
			if (sent) {
				await markGroupFailureReportStaleAlertSent(report.id, new Date());
			}
		} catch (err) {
			console.error(`[fallas-group] Error avisando por Telegram que el TL no responde (reporte ${report.id}):`, err);
		}
	}
}

function startStaleTlReactionChecker() {
	if (staleTlCheckInterval) return;
	staleTlCheckInterval = setInterval(() => {
		void checkStaleTlReactions();
	}, TL_STALE_CHECK_INTERVAL_MS);
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
	// Si no había credenciales previas, esta conexión va a requerir un QR nuevo — es el momento
	// de mayor riesgo de baneo (ver warmup-throttle.ts). Se detecta antes de que
	// getMultiFileAuthState() cree el archivo, y se usa al abrir la conexión más abajo.
	const isFreshLogin = !fs.existsSync(path.join(instanceAuthDir, "creds.json"));
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

	// Prueba diagnóstica: si PAIRING_CODE_PHONE está seteada y es un login nuevo, pedimos
	// código de emparejamiento en vez de esperar el QR, para descartar si el 405 en el
	// handshake bloquea también este camino (ver investigación del loop de reconexión).
	if (isFreshLogin && process.env.PAIRING_CODE_PHONE) {
		setTimeout(async () => {
			try {
				const code = await sock.requestPairingCode(process.env.PAIRING_CODE_PHONE!);
				console.log(`[bot] Código de emparejamiento generado: ${code}`);
			} catch (error) {
				console.error("[bot] Error solicitando código de emparejamiento:", error);
			}
		}, 3000);
	}

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
			if (isFreshLogin) {
				await markSessionLinked().catch((err) =>
					console.error("[bot] No se pudo registrar session_linked_at:", err),
				);
				console.log("[bot] Sesión nueva detectada — entrando en período de calentamiento post-relogin.");
			}
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
			startStaleTlReactionChecker();
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

			// Detectar si el mensaje no pudo ser desencriptado (Bad MAC / Ciphertext stub / MessageCounterError).
			// No se usa una whitelist de tipos "conocidos" (texto/audio/imagen/etc.) porque quedaba
			// corta: mensajes legítimos como reactionMessage, encReactionMessage, protocolMessage o
			// secretEncryptedMessage (voto de encuesta) no estaban en la lista y se marcaban como
			// fallo de desencriptación, disparando assertSessions sobre sesiones sanas (visto en
			// producción tras el fix de fromMe: ~30 falsos positivos, todos reacciones/protocolo).
			// Baileys solo deja `.message` vacío (o con únicamente `messageContextInfo`, que es
			// metadata, no contenido) cuando la desencriptación realmente falló — cualquier otra key
			// presente significa que sí se desencriptó algo, sea o no un tipo que el bot procese.
			const meaningfulMessageKeys = msg.message
				? Object.keys(msg.message).filter((key) => key !== "messageContextInfo")
				: [];
			const hasContent = meaningfulMessageKeys.length > 0;
			// OJO: en la práctica la gran mayoría de estos fallos llegan con fromMe:true — son ecos
			// de mensajes propios rebotando desde otro dispositivo vinculado (multi-device) cuya
			// sesión de Signal quedó desincronizada. La versión anterior de este chequeo exigía
			// `!msg.key.fromMe`, así que nunca reparaba justo el caso que más aparece en producción
			// (ver incidente 2026-08-05: cientos de "Bad MAC"/"MessageCounterError" con fromMe:true
			// que nunca disparaban assertSessions). El fromMe del mensaje no cambia si la sesión de
			// Signal de ese JID está rota, así que no debe excluirse acá.
			const isDecryptionFailure = !hasContent && (
				!msg.messageStubType ||
				msg.messageStubType === 0 ||
				msg.messageStubType === 1
			);
			console.log(
				`[bot-debug] Evaluando mensaje: fromMe=${msg.key.fromMe}, remoteJid=${msg.key.remoteJid}, messageKeys=${msg.message ? Object.keys(msg.message).join(", ") : "none"}, stubType=${msg.messageStubType}, hasContent=${hasContent}, isDecryptionFailure=${isDecryptionFailure}`
			);
			if (isDecryptionFailure) {
				trackDecryptionFailureAndMaybeAlert();
			}
			if (isDecryptionFailure && msg.key.remoteJid) {
				const remoteJid = msg.key.remoteJid;
				// En 1:1 el JID a reparar es el propio remoteJid. En grupos (@g.us) la sesión rota es
				// la del participante que envió el mensaje, no la del grupo — @g.us no es una sesión
				// de Signal válida para assertSessions, así que ahí hay que resolver al remitente.
				const sessionJid = remoteJid.endsWith("@g.us")
					? ((msg.key?.participantPn as string | undefined) ?? (msg.key?.participant as string | undefined))
					: (remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid") ? remoteJid : undefined);
				const lastAssertAt = sessionJid ? lastSessionAssertAt.get(sessionJid) ?? 0 : 0;
				if (sessionJid && Date.now() - lastAssertAt < SESSION_ASSERT_COOLDOWN_MS) {
					// Ya se reforzó esta sesión hace poco (ráfaga del mismo remitente en un solo
					// upsert) — evita machacar la API de WhatsApp con asserts redundantes.
				} else if (sessionJid) {
					lastSessionAssertAt.set(sessionJid, Date.now());
					console.warn(
						`[bot-warning] Detectado posible error de desencriptación (Bad MAC) para el JID ${sessionJid}${remoteJid !== sessionJid ? ` (grupo ${remoteJid})` : ""}. Forzando recreación de sesión de Signal...`
					);
					try {
						await sock.assertSessions([sessionJid], true);
						console.log(`[bot] Sesión de Signal para ${sessionJid} restablecida exitosamente.`);
					} catch (err) {
						console.error(`[bot-error] Falló al establecer sesión de Signal para ${sessionJid}:`, err);
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
