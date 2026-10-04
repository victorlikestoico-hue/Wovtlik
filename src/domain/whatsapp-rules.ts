export type ConversationMode = "AI" | "HUMAN";
export type MessageRole = "user" | "assistant" | "human";
export const LEAD_LABELS = [
	"frio",
	"neutro",
	"caliente",
	"cliente_potencial",
] as const;
export type LeadLabel = (typeof LEAD_LABELS)[number];

export function isLeadLabel(value: unknown): value is LeadLabel {
	return (
		typeof value === "string" &&
		(LEAD_LABELS as readonly string[]).includes(value)
	);
}

export function normalizeLeadLabels(value: unknown): LeadLabel[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter(isLeadLabel))];
}

export interface AutomationSettings {
	botOnKeyword: string;
	keywordCaseSensitive: boolean;
	followupMaxAttempts: number;
	followupMinHoursAfterAssistant: number;
	whatsappFreeformWindowHours: number;
	blockOutside24hFollowups: boolean;
}

export type OwnerKeywordAction = "enable_bot" | "none";

export function normalizeKeyword(
	value: string,
	settings: Pick<AutomationSettings, "keywordCaseSensitive">,
): string {
	const trimmed = value.trim();
	return settings.keywordCaseSensitive ? trimmed : trimmed.toLocaleLowerCase();
}

export function decideOwnerKeywordAction(input: {
	text: string;
	fromMe: boolean;
	settings: Pick<AutomationSettings, "botOnKeyword" | "keywordCaseSensitive">;
}): OwnerKeywordAction {
	if (!input.fromMe) return "none";
	const text = normalizeKeyword(input.text, input.settings);
	if (text === normalizeKeyword(input.settings.botOnKeyword, input.settings))
		return "enable_bot";
	return "none";
}

// Frases con las que un agente avisa que no le llegan / no puede ver las respuestas del bot
// (típicamente "Esperando el mensaje…" de WhatsApp cuando no puede descifrar lo que le
// mandamos). Seguir respondiéndole solo agrega más mensajes que tampoco va a ver, así que en
// ese caso el bot se calla. Se evalúa sobre el texto normalizado (minúsculas, sin tildes ni
// puntuación). "los mensajes" a secas no cuenta si sigue "de …" ("no me llegan los mensajes
// de los clientes" es otro problema, no de este chat).
const CANNOT_SEE_REPLIES_PATTERNS: RegExp[] = [
	/\bno me (llega|llegan|llego|llegaron|aparece|aparecen|carga|cargan|abre|abren) (tus|sus|las|tu|su) (mensajes?|respuestas?)\b/,
	/\bno me (llega|llegan|llego|llegaron|aparece|aparecen|carga|cargan) (el|los) mensajes?\b(?! de )/,
	/\bno me (llega|llegan|llego|llegaron) (nada|ninguna respuesta|ningun mensaje|la respuesta)\b(?! de )/,
	/\bno (recibo|estoy recibiendo|he recibido|recibi) (tus|sus|los|las|ningun|ninguna|tu|su|el|la) (mensajes?|respuestas?)\b(?! de )/,
	/\bno (puedo|logro|alcanzo a|me deja) (ver|leer|abrir) (tus|sus|los|las|tu|su|el|la) (mensajes?|respuestas?)\b(?! de )/,
	/\bno (veo|se ve|se ven) (tus|sus|los|las|tu|su|el|la) (mensajes?|respuestas?)\b(?! de )/,
	/\bno (puedo |logro |alcanzo a )?(ver|veo|leer|leo|abrir) lo que (me )?(respond|escrib|mand|envi|dic|contest)/,
	/\besperando (el|este|un|los|estos) mensajes?\b/,
	/\bmensajes? (en blanco|vacios?|bloqueados?|cifrados?)\b/,
];

function normalizeForMatching(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLocaleLowerCase()
		.replace(/[^a-z0-9ñ]+/g, " ")
		.trim();
}

export function isCannotSeeRepliesMessage(text: string): boolean {
	const normalized = normalizeForMatching(text);
	if (!normalized || normalized.includes("correo")) return false;
	return CANNOT_SEE_REPLIES_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function getTurnFinalizationCleanup(conversationId: string | number) {
	const id = String(conversationId);
	return {
		deleteKeys: [
			`wa:v1:turn:queue:${id}`,
			`wa:v1:turn:debounce:${id}`,
			`wa:v1:turn:processing:${id}`,
		],
		tokenSafeLockKey: `wa:v1:turn:lock:${id}`,
		touchesBaileysAuth: false,
		touchesDurableDatabase: false,
	};
}

export interface FollowUpCandidate {
	mode: ConversationMode;
	latestVisibleRole: MessageRole;
	hasUserAfterLatestAssistant: boolean;
	followupAttempts: number;
	lastAssistantAt: Date | null;
	lastUserMessageAt: Date | null;
	hasActiveTurnState: boolean;
	followupLockAcquired: boolean;
}

export type FollowUpEligibility =
	| { eligible: true }
	| { eligible: false; reason: string };

const hoursBetween = (later: Date, earlier: Date): number =>
	(later.getTime() - earlier.getTime()) / (60 * 60 * 1000);

export function isFollowUpEligible(
	candidate: FollowUpCandidate,
	settings: AutomationSettings,
	now: Date,
): FollowUpEligibility {
	if (candidate.mode !== "AI")
		return { eligible: false, reason: "not_ai_mode" };
	if (candidate.latestVisibleRole !== "assistant")
		return { eligible: false, reason: "latest_not_assistant" };
	if (candidate.hasUserAfterLatestAssistant)
		return { eligible: false, reason: "user_replied_after_assistant" };
	if (candidate.followupAttempts >= settings.followupMaxAttempts)
		return { eligible: false, reason: "max_attempts_reached" };
	if (!candidate.lastAssistantAt)
		return { eligible: false, reason: "missing_last_assistant_at" };
	if (
		hoursBetween(now, candidate.lastAssistantAt) <
		settings.followupMinHoursAfterAssistant
	) {
		return { eligible: false, reason: "too_soon_after_assistant" };
	}
	if (candidate.hasActiveTurnState)
		return { eligible: false, reason: "active_turn_state" };
	if (!candidate.followupLockAcquired)
		return { eligible: false, reason: "followup_lock_unavailable" };
	if (settings.blockOutside24hFollowups) {
		if (!candidate.lastUserMessageAt)
			return { eligible: false, reason: "missing_last_user_message_at" };
		if (
			hoursBetween(now, candidate.lastUserMessageAt) >
			settings.whatsappFreeformWindowHours
		) {
			return { eligible: false, reason: "outside_24h_window" };
		}
	}
	return { eligible: true };
}

export type NormalReplyParseResult =
	| {
			ok: true;
			parts: string[];
			handoff: { required: boolean; reason: string };
			lead: {
				labels: LeadLabel[];
				score: number | null;
				reason: string;
			};
	  }
	| { ok: false; sendRaw: false; reason: string };

function parseJsonObject(raw: string): unknown {
	return JSON.parse(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNormalReply(raw: string): NormalReplyParseResult {
	// Intentamos primero limpiar posibles bloques de código markdown que a veces envuelven la respuesta
	let cleanRaw = raw.trim();
	if (cleanRaw.startsWith("```json")) {
		cleanRaw = cleanRaw.substring(7);
		if (cleanRaw.endsWith("```")) {
			cleanRaw = cleanRaw.substring(0, cleanRaw.length - 3);
		}
		cleanRaw = cleanRaw.trim();
	} else if (cleanRaw.startsWith("```")) {
		cleanRaw = cleanRaw.substring(3);
		if (cleanRaw.endsWith("```")) {
			cleanRaw = cleanRaw.substring(0, cleanRaw.length - 3);
		}
		cleanRaw = cleanRaw.trim();
	}

	// 1. INTENTAMOS PARSEAR COMO JSON ESTRUCTURADO (Compatibilidad heredada)
	try {
		const data = JSON.parse(cleanRaw);
		if (isRecord(data) && isRecord(data.response)) {
			const rawParts = [
				data.response.part_1,
				data.response.part_2,
				data.response.part_3,
			];

			const parts = rawParts.flatMap((part) => {
				if (typeof part !== "string") return [];
				const trimmed = part.trim();
				return trimmed ? [trimmed] : [];
			});

			if (parts.length > 0) {
				const handoffRecord = isRecord(data.handoff) ? data.handoff : {};
				const leadRecord = isRecord(data.lead) ? data.lead : {};
				const rawScore = leadRecord.score;
				const score =
					typeof rawScore === "number" &&
					Number.isFinite(rawScore) &&
					rawScore >= 0 &&
					rawScore <= 100
						? Math.round(rawScore)
						: null;
				return {
					ok: true,
					parts,
					handoff: {
						required: handoffRecord.required === true,
						reason:
							typeof handoffRecord.reason === "string"
								? handoffRecord.reason
								: "",
					},
					lead: {
						labels: normalizeLeadLabels(leadRecord.labels),
						score,
						reason:
							typeof leadRecord.reason === "string"
								? leadRecord.reason.trim().slice(0, 240)
								: "",
					},
				};
			}
		}
	} catch {
		return { ok: false, sendRaw: false, reason: "invalid_json" };
	}

	return { ok: false, sendRaw: false, reason: "invalid_schema" };
}

export type FollowUpDecisionParseResult =
	| { ok: true; shouldSend: true; message: string }
	| { ok: true; shouldSend: false; message?: undefined }
	| { ok: false; shouldSend: false; sendRaw: false; reason: string };

export function parseFollowUpDecision(
	raw: string,
): FollowUpDecisionParseResult {
	let data: unknown;
	try {
		data = parseJsonObject(raw);
	} catch {
		return {
			ok: false,
			shouldSend: false,
			sendRaw: false,
			reason: "invalid_json",
		};
	}
	if (!isRecord(data) || typeof data.respuesta !== "string") {
		return {
			ok: false,
			shouldSend: false,
			sendRaw: false,
			reason: "invalid_schema",
		};
	}
	const respuesta = data.respuesta.trim().toLocaleUpperCase();
	if (respuesta === "NO") return { ok: true, shouldSend: false };
	if (respuesta !== "SI")
		return {
			ok: false,
			shouldSend: false,
			sendRaw: false,
			reason: "invalid_respuesta",
		};
	if (typeof data.mensaje !== "string" || data.mensaje.trim().length === 0) {
		return {
			ok: false,
			shouldSend: false,
			sendRaw: false,
			reason: "missing_message",
		};
	}
	return { ok: true, shouldSend: true, message: data.mensaje.trim() };
}

export interface HandoffSignal {
	required: boolean;
	reason: string;
}

export function planHandoffActions(signal: HandoffSignal) {
	if (!signal.required) return null;
	return {
		mode: "HUMAN" as const,
		eventType: "handoff_to_human" as const,
		notifyTelegram: true,
		reason: signal.reason,
	};
}
