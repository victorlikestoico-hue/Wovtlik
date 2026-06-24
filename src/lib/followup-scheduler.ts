import type {
	ConversationEventRow,
	ConversationRow,
	FollowUpQueryInput,
	InsertMessageInput,
} from "./db-contract.ts";
import type { DeepSeekHistoryMessage } from "./deepseek-client.ts";

type MaybePromise<T> = T | Promise<T>;

type TurnState = {
	hasActiveTurnState(conversationId: number): MaybePromise<boolean>;
	acquireFollowupRunnerLock(
		token: string,
		options: { ttlMs: number },
	): MaybePromise<boolean>;
	releaseFollowupRunnerLock(token: string): MaybePromise<boolean>;
	acquireFollowupConversationLock(
		conversationId: number,
		token: string,
		options: { ttlMs: number },
	): MaybePromise<boolean>;
	releaseFollowupConversationLock(
		conversationId: number,
		token: string,
	): MaybePromise<boolean>;
};
type Decision =
	| {
			ok: true;
			parsed: { ok: true; shouldSend: boolean; message: string | null };
	  }
	| { ok: false; reason: string };

type EventInput = {
	conversation_id: number;
	event_type: "followup_sent" | "followup_skipped" | "deepseek_json_invalid";
	actor_role: "assistant" | "system";
	reason?: string | null;
	metadata?: Record<string, unknown>;
	created_at?: Date;
};

export interface FollowUpSchedulerRepository {
	getSettings(): MaybePromise<Record<string, unknown>>;
	getPendingFollowUps(
		input: FollowUpQueryInput,
	): MaybePromise<ConversationRow[]>;
	getConversationById(id: number): MaybePromise<ConversationRow | null>;
	insertMessageAndTouchConversation(
		input: InsertMessageInput,
	): MaybePromise<{ id: number }>;
	updateConversation(
		id: number,
		patch: Partial<ConversationRow>,
	): MaybePromise<ConversationRow>;
	recordConversationEvent(
		input: EventInput,
	): MaybePromise<ConversationEventRow>;
	markFollowUpBlocked(
		conversationId: number,
		reason: string,
		blockedAt?: Date,
	): MaybePromise<ConversationEventRow>;
}

export interface FollowUpSchedulerDeps {
	now: () => Date;
	repo: FollowUpSchedulerRepository;
	turnState: TurnState;
	getRecentHistory: (
		conversationId: number,
	) => Promise<DeepSeekHistoryMessage[]>;
	decideFollowUp: (history: DeepSeekHistoryMessage[]) => Promise<Decision>;
	sendWhatsAppMessage: (jid: string, text: string) => Promise<void>;
	notifyFollowupBlocked: (input: {
		conversationId: number;
		phone: string;
		reason: string;
	}) => Promise<unknown>;
	generateToken: () => string;
	logger?: Pick<typeof console, "log" | "warn" | "error">;
	// Pausa entre candidatos para no mandar varios follow-ups en paralelo/sin pausa
	// (firma de comportamiento bot que los sistemas anti-abuso de WhatsApp detectan).
	// Sin override (p. ej. en tests) no se espera nada.
	waitBetweenSends?: () => Promise<void>;
}

export interface FollowUpRunResult {
	status: "completed" | "skipped_runner_locked";
	processed: number;
	candidates: number;
	sent: number;
	blocked24h: number;
	skippedActiveTurn: number;
	skippedConversationLocked: number;
	skippedByDecision: number;
	invalidDecisions: number;
	neverTouches: string[];
}

const n = (settings: Record<string, unknown>, key: string) =>
	Number(settings[key]);
const b = (settings: Record<string, unknown>, key: string) =>
	settings[key] === true;
const safeNumber = (settings: Record<string, unknown>, key: string) => {
	const value = Number(settings[key]);
	return Number.isFinite(value) && value > 0 ? value : 0;
};
export const followUpDurationHours = (
	settings: Record<string, unknown>,
	hoursKey: string,
	minutesKey: string,
) => {
	const hours = safeNumber(settings, hoursKey);
	const minutes = safeNumber(settings, minutesKey);
	return (hours * 60 + minutes) / 60;
};
const durationText = (hoursDecimal: number) => {
	const totalMinutes = Math.round(hoursDecimal * 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h`;
	return `${minutes}m`;
};
const hoursBetween = (later: Date, earlier: Date) =>
	(later.getTime() - earlier.getTime()) / 3_600_000;
const outsideWindow = (
	c: ConversationRow,
	now: Date,
	hours: number,
	block: boolean,
) =>
	block &&
	(!c.last_user_message_at ||
		hoursBetween(now, c.last_user_message_at) > hours);

function result(status: FollowUpRunResult["status"]): FollowUpRunResult {
	return {
		status,
		processed: 0,
		candidates: 0,
		sent: 0,
		blocked24h: 0,
		skippedActiveTurn: 0,
		skippedConversationLocked: 0,
		skippedByDecision: 0,
		invalidDecisions: 0,
		neverTouches: ["./auth/", "baileys-session"],
	};
}

export function createFollowUpScheduler(deps: FollowUpSchedulerDeps) {
	const logger = deps.logger ?? console;
	const waitBetweenSends = deps.waitBetweenSends ?? (async () => {});

	async function processCandidate(
		candidate: ConversationRow,
		query: FollowUpQueryInput,
		run: FollowUpRunResult,
		now: Date,
	) {
		logger.log(
			`[followup] Evaluando conversación #${candidate.id} (${candidate.phone}). Intentos=${candidate.followup_attempts}/${query.maxAttempts}, último usuario=${candidate.last_user_message_at?.toISOString() ?? "sin registro"}, última IA=${candidate.last_assistant_message_at?.toISOString() ?? "sin registro"}.`,
		);
		if (await deps.turnState.hasActiveTurnState(candidate.id)) {
			logger.log(
				`[followup] Conversación #${candidate.id} omitida: hay un turno entrante activo o en cola. No mandamos seguimiento para no pisar una respuesta del cliente.`,
			);
			return void (run.skippedActiveTurn += 1);
		}
		const token = deps.generateToken();
		if (
			!(await deps.turnState.acquireFollowupConversationLock(
				candidate.id,
				token,
				{
					ttlMs: 120_000,
				},
			))
		) {
			logger.log(
				`[followup] Conversación #${candidate.id} omitida: otro proceso ya tomó el lock de seguimiento.`,
			);
			return void (run.skippedConversationLocked += 1);
		}
		try {
			const fresh = await deps.repo.getConversationById(candidate.id);
			if (!fresh) {
				logger.warn(
					`[followup] Conversación #${candidate.id} omitida: ya no existe al refrescar desde DB.`,
				);
				return void (run.skippedActiveTurn += 1);
			}
			if (await deps.turnState.hasActiveTurnState(candidate.id)) {
				logger.log(
					`[followup] Conversación #${fresh.id} omitida después de refrescar: entró actividad nueva mientras evaluábamos.`,
				);
				return void (run.skippedActiveTurn += 1);
			}
			if (
				fresh.last_followup_at &&
				hoursBetween(now, fresh.last_followup_at) < query.minHoursAfterAssistant
			) {
				logger.log(
					`[followup] Conversacion #${fresh.id} omitida: ultimo seguimiento=${fresh.last_followup_at.toISOString()} todavia no cumple la espera minima (${durationText(query.minHoursAfterAssistant)}).`,
				);
				await deps.repo.recordConversationEvent({
					conversation_id: fresh.id,
					event_type: "followup_skipped",
					actor_role: "system",
					reason: "followup_interval_not_elapsed",
					created_at: now,
				});
				run.skippedByDecision += 1;
				return;
			}
			if (
				outsideWindow(
					fresh,
					now,
					query.freeformWindowHours,
					query.blockOutside24h,
				)
			) {
				const reason = "outside_24h_window";
				logger.log(
					`[followup] Conversación #${fresh.id} BLOQUEADA: último mensaje del cliente fue ${fresh.last_user_message_at?.toISOString() ?? "desconocido"} y supera la ventana libre de WhatsApp (${durationText(query.freeformWindowHours)}). No se envía para evitar spam/política 24h.`,
				);
				await deps.repo.markFollowUpBlocked(fresh.id, reason, now);
				await deps.notifyFollowupBlocked({
					conversationId: fresh.id,
					phone: fresh.phone,
					reason,
				});
				run.blocked24h += 1;
				return;
			}

			const history = await deps.getRecentHistory(fresh.id);
			logger.log(
				`[followup] Conversación #${fresh.id}: historial cargado (${history.length} mensaje(s)). Se consultará a IA para decidir SI/NO.`,
			);
			if (history.length > 0) {
				logger.log(`[followup] Conversación #${fresh.id}: últimos mensajes:`);
				history.slice(-3).forEach((m) => {
					logger.log(`  - [${m.role}]: "${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}"`);
				});
			}

			const decision = await deps.decideFollowUp(history);
			if (!decision.ok) {
				logger.warn(
					`[followup] Conversación #${fresh.id}: IA devolvió error/JSON inválido (${decision.reason}). No se envía seguimiento.`,
				);
				await deps.repo.recordConversationEvent({
					conversation_id: fresh.id,
					event_type: "deepseek_json_invalid",
					actor_role: "assistant",
					reason: decision.reason,
					created_at: now,
				});
				run.invalidDecisions += 1;
				return;
			}
			const message = decision.parsed.message?.trim() ?? "";
			if (!decision.parsed.shouldSend || !message) {
				logger.log(
					`[followup] Conversación #${fresh.id}: decisión IA = NO enviar. Se registra followup_skipped.`,
				);
				await deps.repo.recordConversationEvent({
					conversation_id: fresh.id,
					event_type: "followup_skipped",
					actor_role: "assistant",
					reason: "deepseek_decision_no",
					created_at: now,
				});
				run.skippedByDecision += 1;
				return;
			}

			const cleanText = (txt: string) =>
				txt
					.toLowerCase()
					.normalize("NFD")
					.replace(/[\u0300-\u036f]/g, "")
					.replace(/[^a-z0-9]/g, "");

			const cleanNew = cleanText(message);
			const isDuplicate = history.some(
				(m) => m.role === "assistant" && cleanText(m.content) === cleanNew,
			);

			if (isDuplicate) {
				logger.log(
					`[followup] Conversación #${fresh.id}: omitida por duplicado. La IA propuso un mensaje igual a uno anterior.`,
				);
				await deps.repo.recordConversationEvent({
					conversation_id: fresh.id,
					event_type: "followup_skipped",
					actor_role: "assistant",
					reason: "duplicate_followup_message",
					created_at: now,
				});
				run.skippedByDecision += 1;
				return;
			}

			logger.log(
				`[followup] Conversación #${fresh.id}: decisión IA = SI enviar. JID destino=${fresh.jid ?? `${fresh.phone}@s.whatsapp.net`}. Mensaje="${message}"`,
			);

			await Promise.all([
				deps.sendWhatsAppMessage(
					fresh.jid ?? `${fresh.phone}@s.whatsapp.net`,
					message,
				),
				deps.repo.insertMessageAndTouchConversation({
					conversation_id: fresh.id,
					direction: "outbound",
					role: "assistant",
					content: message,
					media_type: "text",
					source: "scheduler",
					from_me: false,
					created_at: now,
				}),
				deps.repo.updateConversation(fresh.id, {
					followup_attempts: fresh.followup_attempts + 1,
					last_followup_at: now,
					last_assistant_message_at: now,
					updated_at: now,
				}),
				deps.repo.recordConversationEvent({
					conversation_id: fresh.id,
					event_type: "followup_sent",
					actor_role: "assistant",
					reason: "deepseek_decision_si",
					created_at: now,
				})
			]);

			run.sent += 1;
			logger.log(
				`[followup] Conversación #${fresh.id}: seguimiento enviado y auditado correctamente. Intentos ahora=${fresh.followup_attempts + 1}.`,
			);
		} finally {
			await deps.turnState.releaseFollowupConversationLock(candidate.id, token);
		}
	}

	return {
		async runOnce(): Promise<FollowUpRunResult> {
			const now = deps.now(),
				runnerToken = deps.generateToken();
			logger.log(
				`[followup] ===== Inicio evaluación de seguimientos: ${now.toISOString()} =====`,
			);
			if (
				!(await deps.turnState.acquireFollowupRunnerLock(runnerToken, {
					ttlMs: 300_000,
				}))
			) {
				logger.log(
					"[followup] Evaluación omitida: otro runner tiene el lock global. Esto evita envíos duplicados.",
				);
				return result("skipped_runner_locked");
			}
			const run = result("completed");
			try {
				const settings = await deps.repo.getSettings();
				const minHoursAfterAssistant = followUpDurationHours(
					settings,
					"followup_min_hours_after_assistant",
					"followup_min_minutes_after_assistant",
				);
				const query = {
					now,
					minHoursAfterAssistant,
					maxAttempts: n(settings, "followup_max_attempts"),
					freeformWindowHours: n(settings, "whatsapp_freeform_window_hours"),
					blockOutside24h: b(settings, "block_outside_24h_followups"),
				};
				logger.log(
					`[followup] Configuración activa: espera mínima tras IA=${durationText(query.minHoursAfterAssistant)}, intentos máximos=${query.maxAttempts}, ventana WhatsApp=${durationText(query.freeformWindowHours)}, bloqueo 24h=${query.blockOutside24h ? "activo" : "inactivo"}.`,
				);
				const candidates = await deps.repo.getPendingFollowUps(query);
				run.candidates = candidates.length;
				logger.log(
					candidates.length === 0
						? "[followup] No hay conversaciones candidatas. Prefiltro DB descartó por modo HUMAN, último mensaje no-IA, respuesta nueva del cliente, intento máximo o espera mínima."
						: `[followup] Candidatas encontradas: ${candidates.length}. Se evaluarán una por una.`,
				);
				
				for (const [index, candidate] of candidates.entries()) {
					if (index > 0) await waitBetweenSends();
					await processCandidate(candidate, query, run, now);
				}

				run.processed =
					run.sent +
					run.blocked24h +
					run.skippedByDecision +
					run.invalidDecisions;
				logger.log(
					`[followup] ===== Fin evaluación: status=${run.status}, candidatas=${run.candidates}, procesadas=${run.processed}, enviadas=${run.sent}, bloqueadas24h=${run.blocked24h}, omitidasTurnoActivo=${run.skippedActiveTurn}, omitidasLock=${run.skippedConversationLocked}, omitidasIA=${run.skippedByDecision}, iaInvalidas=${run.invalidDecisions} =====`,
				);
				return run;
			} finally {
				await deps.turnState.releaseFollowupRunnerLock(runnerToken);
			}
		},
	};
}
