export type TelegramFetchResponse = {
	ok: boolean;
	status: number;
	json?: () => Promise<unknown>;
};

export type TelegramFetch = (
	url: string | URL,
	init?: RequestInit,
) => Promise<TelegramFetchResponse>;

export interface TelegramNotifierConfig {
	botToken?: string | null;
	chatId?: string | null;
	fetch: TelegramFetch;
	apiBaseUrl?: string;
}

export interface HumanoHandoffNotificationInput {
	conversationId: number;
	phone: string;
	jid: string;
	reason: string;
	lastMessage: string;
}

export interface FollowupBlockedNotificationInput {
	conversationId: number;
	phone: string;
	reason: string;
}

export interface AppointmentReminderNotificationInput {
	conversationId: number;
	clientPhone: string;
	clientName: string;
	agentEmail: string;
	agentPhone: string;
	appointmentAt: string;
	description: string | null;
}

export interface BotDisconnectedNotificationInput {
	minutesDisconnected: number;
}

export interface DecryptionStormNotificationInput {
	failureCount: number;
	windowSeconds: number;
}

export interface TlCoverageAnnouncedNotificationInput {
	start: string;
	end: string;
	lobs: string[];
	name: string;
	phone: string;
}

export interface GroupFailureReportNotificationInput {
	phone: string;
	senderName: string;
	email?: string;
	reason: string;
	formStatus: "yes" | "no" | "unknown";
	resolved: boolean;
	lob?: string;
	failureType?: string;
}

export interface TlNotRespondingNotificationInput {
	agentName: string;
	agentPhone: string;
	lob: string | null;
	reason: string;
	minutesWaiting: number;
	tlName: string | null;
	tlPhone: string | null;
	tlUntil: string | null;
	/** "anuncio" = el TL lo escribió a mano en el grupo; "rooster" = viene del rooster de Wolftls
	 * (nadie anunció nada, pero según el cálculo de turnos debería estar cubriendo). */
	tlSource?: "anuncio" | "rooster";
}

export interface TlDailyMissedAnnouncementsNotificationInput {
	/** Fecha (Uruguay, YYYY-MM-DD) del día que cierra el reporte — el día calendario que acaba de terminar. */
	day: string;
	/** TL con turno asignado (rooster) que nunca mandaron el "los acompaño con..." ese día. Vacío = todos anunciaron. */
	misses: Array<{ name: string; email: string | null; group: string; start: string; end: string }>;
}

export type TelegramNotificationResult =
	| {
			ok: true;
			status: "sent";
			userMessage: string;
	  }
	| {
			ok: false;
			status: "skipped" | "failed";
			reason: "missing_config" | `telegram_http_${number}` | "network_error";
			userMessage: string;
	  };

function hasConfig(
	config: TelegramNotifierConfig,
): config is TelegramNotifierConfig & {
	botToken: string;
	chatId: string;
} {
	return !!config.botToken?.trim() && !!config.chatId?.trim();
}

function escapeHtml(value: string | number): string {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function telegramSendMessageUrl(
	config: TelegramNotifierConfig & { botToken: string },
) {
	const base = config.apiBaseUrl ?? "https://api.telegram.org";
	return `${base.replace(/\/$/, "")}/bot${encodeURIComponent(config.botToken)}/sendMessage`;
}

export function formatHumanoHandoffNotification(
	input: HumanoHandoffNotificationInput,
): string {
	return [
		"🚨 <b>Humano requerido</b>",
		`Conversación: #${escapeHtml(input.conversationId)}`,
		`Teléfono: ${escapeHtml(input.phone)}`,
		`JID: ${escapeHtml(input.jid)}`,
		`Motivo: ${escapeHtml(input.reason)}`,
		`Último mensaje: ${escapeHtml(input.lastMessage)}`,
	].join("\n");
}

export function formatFollowupBlockedNotification(
	input: FollowupBlockedNotificationInput,
): string {
	return [
		"⚠️ <b>Seguimiento bloqueado</b>",
		`Conversación: #${escapeHtml(input.conversationId)}`,
		`Teléfono: ${escapeHtml(input.phone)}`,
		`Motivo: ${escapeHtml(input.reason)}`,
	].join("\n");
}

export function formatAppointmentReminderNotification(
	input: AppointmentReminderNotificationInput,
): string {
	return [
		"📅 <b>Recordatorio de cita</b>",
		`Cliente: ${escapeHtml(input.clientName)} (${escapeHtml(input.clientPhone)})`,
		`Agente: ${escapeHtml(input.agentEmail)} (${escapeHtml(input.agentPhone)})`,
		`Hora: ${escapeHtml(input.appointmentAt)}`,
		input.description ? `Detalle: ${escapeHtml(input.description)}` : "",
	].filter(Boolean).join("\n");
}

export function formatBotDisconnectedNotification(
	input: BotDisconnectedNotificationInput,
): string {
	return [
		"🔴 <b>Bot desconectado</b>",
		`El bot lleva más de ${input.minutesDisconnected} minutos sin conectarse a WhatsApp.`,
		"Revisá los logs en Railway para más detalles.",
	].join("\n");
}

export function formatDecryptionStormNotification(
	input: DecryptionStormNotificationInput,
): string {
	return [
		"🔴 <b>Tormenta de fallos de desencriptación</b>",
		`${input.failureCount} fallos de sesión de Signal (Bad MAC) en los últimos ${input.windowSeconds}s.`,
		"El bot puede haber dejado de procesar mensajes de grupos (ej. reacciones en el grupo de desconexiones). Revisá los logs en Railway.",
	].join("\n");
}

export function formatGroupFailureReportNotification(
	input: GroupFailureReportNotificationInput,
): string {
	return [
		input.resolved ? "✅ <b>Falla reportada como resuelta</b>" : "🚨 <b>Reporte de falla (grupo)</b>",
		`Agente: ${escapeHtml(input.senderName)} (${escapeHtml(input.phone)})`,
		input.email ? `Correo: ${escapeHtml(input.email)}` : "Correo: no identificado",
		input.lob ? `LOB: ${escapeHtml(input.lob)}` : "",
		input.failureType ? `Tipo: ${escapeHtml(input.failureType)}` : `Motivo: ${escapeHtml(input.reason.slice(0, 200))}`,
	].filter(Boolean).join("\n");
}

function formatLobList(lobs: string[]): string {
	const upper = lobs.map((l) => l.toUpperCase());
	if (upper.length <= 1) return upper.join("");
	return `${upper.slice(0, -1).join(", ")} & ${upper[upper.length - 1]}`;
}

export function formatTlCoverageAnnouncedNotification(
	input: TlCoverageAnnouncedNotificationInput,
): string {
	return [
		"📣 <b>Cobertura anunciada en el grupo de desconexiones</b>",
		`TL: ${escapeHtml(input.name)} (${escapeHtml(input.phone)})`,
		`Horario: ${escapeHtml(input.start)} a ${escapeHtml(input.end)} UY`,
		`LOB${input.lobs.length > 1 ? "s" : ""}: ${escapeHtml(formatLobList(input.lobs))}`,
	].join("\n");
}

export function formatTlNotRespondingNotification(
	input: TlNotRespondingNotificationInput,
): string {
	const lines = [
		"⏰ <b>TL sin responder</b>",
		`Agente: ${escapeHtml(input.agentName)} (${escapeHtml(input.agentPhone)})`,
		`LOB: ${input.lob ? escapeHtml(input.lob.toUpperCase()) : "no identificado"}`,
		`Motivo: ${escapeHtml(input.reason.slice(0, 200))}`,
		`Lleva ${escapeHtml(input.minutesWaiting)} min sin ninguna reacción de TL.`,
	];
	if (input.tlName) {
		const until = input.tlUntil ? ` hasta las ${escapeHtml(input.tlUntil)} UY` : "";
		const phone = input.tlPhone ? ` (${escapeHtml(input.tlPhone)})` : "";
		const sourceLabel = input.tlSource === "rooster"
			? " — según el rooster de Wolftls, nadie lo anunció en el grupo"
			: "";
		lines.push(`TL en turno: ${escapeHtml(input.tlName)}${phone}${until}${sourceLabel}, pero no reaccionó.`);
	} else {
		lines.push("Nadie anunció cobertura para este LOB en el grupo de fallas.");
	}
	return lines.join("\n");
}

export function formatTlDailyMissedAnnouncementsNotification(
	input: TlDailyMissedAnnouncementsNotificationInput,
): string {
	if (input.misses.length === 0) {
		return [
			"📋 <b>Reporte diario de anuncios de TL</b>",
			`Día: ${escapeHtml(input.day)}`,
			"Todos los TL con turno se anunciaron en el grupo de desconexiones.",
		].join("\n");
	}
	const lines = [
		"📋 <b>TL con turno que no se anunciaron</b>",
		`Día: ${escapeHtml(input.day)}`,
		"",
	];
	for (const miss of input.misses) {
		const who = miss.email ? `${escapeHtml(miss.name)} (${escapeHtml(miss.email)})` : escapeHtml(miss.name);
		lines.push(`• ${who} — ${escapeHtml(miss.group)} ${escapeHtml(miss.start)} a ${escapeHtml(miss.end)} UY`);
	}
	return lines.join("\n");
}

export function createTelegramNotifier(config: TelegramNotifierConfig) {
	async function sendText(text: string): Promise<TelegramNotificationResult> {
		if (!hasConfig(config)) {
			return {
				ok: false,
				status: "skipped",
				reason: "missing_config",
				userMessage: "Telegram notification skipped: missing configuration.",
			};
		}

		try {
			const response = await config.fetch(telegramSendMessageUrl(config), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					chat_id: config.chatId,
					text,
					parse_mode: "HTML",
					disable_web_page_preview: true,
				}),
			});

			if (!response.ok) {
				return {
					ok: false,
					status: "failed",
					reason: `telegram_http_${response.status}`,
					userMessage:
						"Telegram notification failed; caller turn can continue.",
				};
			}

			return {
				ok: true,
				status: "sent",
				userMessage: "Telegram notification sent.",
			};
		} catch {
			return {
				ok: false,
				status: "failed",
				reason: "network_error",
				userMessage: "Telegram notification failed; caller turn can continue.",
			};
		}
	}

	return {
		notifyHumanoHandoff(input: HumanoHandoffNotificationInput) {
			return sendText(formatHumanoHandoffNotification(input));
		},
		notifyFollowupBlocked(input: FollowupBlockedNotificationInput) {
			return sendText(formatFollowupBlockedNotification(input));
		},
		notifyAppointmentReminder(input: AppointmentReminderNotificationInput) {
			return sendText(formatAppointmentReminderNotification(input));
		},
		notifyGroupFailureReport(input: GroupFailureReportNotificationInput) {
			return sendText(formatGroupFailureReportNotification(input));
		},
		notifyBotDisconnected(input: BotDisconnectedNotificationInput) {
			return sendText(formatBotDisconnectedNotification(input));
		},
		notifyDecryptionStorm(input: DecryptionStormNotificationInput) {
			return sendText(formatDecryptionStormNotification(input));
		},
		notifyTlCoverageAnnounced(input: TlCoverageAnnouncedNotificationInput) {
			return sendText(formatTlCoverageAnnouncedNotification(input));
		},
		notifyTlNotResponding(input: TlNotRespondingNotificationInput) {
			return sendText(formatTlNotRespondingNotification(input));
		},
		notifyTlDailyMissedAnnouncements(input: TlDailyMissedAnnouncementsNotificationInput) {
			return sendText(formatTlDailyMissedAnnouncementsNotification(input));
		},
	};
}
