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
	saveAgentProfile,
} from "../db.ts";
import { lookupCase, getAgentMetrics, isDashBigConfigured } from "../dashbig-client.ts";
import { getAgentSchedule, clearAgentAbsence } from "../sheets-client.ts";
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
const ABSENCE_KEYWORDS = [
	"eliminar ausente", "eliminar mi ausente", "quitar ausente", "quitar mi ausente",
	"borrar ausente", "borrar mi ausente", "me marcaron ausente",
	"me pusieron ausente", "figure ausente", "figuro ausente",
	"aparezco ausente", "estoy marcado ausente", "saquen mi ausente",
];

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
	const modeLabel = mode === "latest" ? `📅 Último día: ${period.end}` : `📊 Acumulado: ${period.start} → ${period.end}`;
	const lines = [
		`*Tus métricas* ${lob ? `· ${lob}` : ""}`,
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

		const lines = [`📅 *Tus turnos*`];
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

async function tryRemoveAbsenceReply(phone: string, message: string): Promise<string | null> {
	const profile = await getAgentProfile(phone);
	if (!profile) {
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

	try {
		const result = await clearAgentAbsence(profile.email, ids, targetDate);

		if (result.success) {
			const detail = [result.fecha, result.horario].filter(Boolean).join(" — ");
			return buildDirectReply(
				"✅ Ausente eliminado correctamente",
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
			return buildDirectReply(lines.join("\n"));
		}

		if (result.reason === "not_found") {
			const fechaStr = targetDate
				? `para el ${targetDate.split("-").reverse().join("/")}`
				: "en tu planilla";
			return buildDirectReply(
				`No encontré ausente ${fechaStr} 🤔`,
				"Verificá que el email registrado sea el correcto o consultá con el TL.",
			);
		}

		return buildDirectReply("No pude procesar tu solicitud en este momento. Intentá de nuevo.");
	} catch (err) {
		console.error("[absence] Error:", err);
		return buildDirectReply("Ocurrió un error al intentar eliminar el ausente. Intentá de nuevo en unos minutos.");
	}
}

async function tryRegisterEmailReply(phone: string, message: string): Promise<string | null> {
	const emailMatch = message.match(EMAIL_REGEX);
	if (!emailMatch) return null;
	const email = emailMatch[0].toLowerCase();
	await saveAgentProfile(phone, email);
	return buildDirectReply(
		`✅ Email registrado: *${email}*`,
		'Ahora podés escribir "mis métricas" para ver tus KPIs.',
	);
}

// ── Redis and inbound handler setup ─────────────────────────────────────────

// Cliente global de Redis
const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");
const turnState = createIoredisTurnState(redisClient as any);

// Instancia global del socket y controlador de reconexión
export let globalSock: ReturnType<typeof makeWASocket> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let outboxInterval: NodeJS.Timeout | null = null;
let profilePicInterval: NodeJS.Timeout | null = null;

// Creamos el Inbound Handler inyectando las dependencias necesarias
export const inboundHandler = createInboundHandler({
	now: () => new Date(),
	repo: {
		getOrCreateConversation: (input) =>
			getOrCreateConversation(input.phone, input.jid, input.name),
		getConversationById,
		insertMessageAndTouchConversation,
		updateConversation,
		setMode,
		recordConversationEvent,
		getSettings,
	},
	turnState,
	getRecentHistory,
	getActiveSystemPrompt,
	callDeepSeek: async (input) => {
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

			if (!isGroup) {
				// Email registration always works regardless of BigQuery config
				if (EMAIL_REGEX.test(lastUserMsg) && conv) {
					const reply = await tryRegisterEmailReply(conv.phone, lastUserMsg);
					if (reply) return reply;
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

				// Absence removal intent (Google Sheets write)
				if (ABSENCE_KEYWORDS.some((kw) => msgLower.includes(kw)) && conv) {
					const reply = await tryRemoveAbsenceReply(conv.phone, lastUserMsg);
					if (reply) return reply;
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
		const enrichedSystemPrompt = `[Sistema — Fecha y hora actual en Colombia: ${colombiaDate}]\n\n${input.systemPrompt}`;
		const res = await chatClient.generateNormalReply({
			systemPrompt: enrichedSystemPrompt,
			history: input.history,
			queuedMessages: input.queuedMessages,
		});
		if (!res.ok) {
			throw new Error(res.reason);
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
		if (globalSock) {
			await globalSock.sendMessage(jid, { text });
		} else {
			throw new Error("[bot] Socket no conectado. No se puede enviar mensaje.");
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
		if (!globalSock || isProcessingOutbox) return;
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

	sock.ev.on("contacts.upsert", async (contacts: any[]) => {
		await Promise.all(contacts.map(async (contact) => {
			if (contact.id && !contact.id.endsWith("@g.us")) {
				const name = contact.name?.trim() || contact.notify?.trim() || contact.verifiedName?.trim();
				if (name && name !== "WOpen" && name !== "Azokia" && name !== "Azokiallc") {
					try {
						const phone = contact.id.replace(/@.*/, "");
						await getOrCreateConversation(phone, contact.id, name);
					} catch (err) {
						console.error("[bot-error] Falló al procesar contacts.upsert para el JID " + contact.id + ":", err);
					}
				}
			}
		}));
	});

	sock.ev.on("contacts.update", async (contacts: any[]) => {
		await Promise.all(contacts.map(async (contact) => {
			if (contact.id && !contact.id.endsWith("@g.us")) {
				const name = contact.name?.trim() || contact.notify?.trim() || contact.verifiedName?.trim();
				if (name && name !== "WOpen" && name !== "Azokia" && name !== "Azokiallc") {
					try {
						const phone = contact.id.replace(/@.*/, "");
						await getOrCreateConversation(phone, contact.id, name);
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
	}
}
