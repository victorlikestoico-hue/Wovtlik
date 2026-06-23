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

export interface GroupFailureReportNotificationInput {
	phone: string;
	senderName: string;
	email?: string;
	reason: string;
	formStatus: "yes" | "no" | "unknown";
	resolved: boolean;
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

export function formatGroupFailureReportNotification(
	input: GroupFailureReportNotificationInput,
): string {
	const formLabel = input.formStatus === "yes"
		? "✅ sí"
		: input.formStatus === "no"
			? "⚠️ no"
			: "no mencionado";

	return [
		input.resolved ? "✅ <b>Falla reportada como resuelta</b>" : "🚨 <b>Reporte de falla (grupo)</b>",
		`Agente: ${escapeHtml(input.senderName)} (${escapeHtml(input.phone)})`,
		input.email ? `Correo: ${escapeHtml(input.email)}` : "Correo: no identificado",
		`Motivo: ${escapeHtml(input.reason)}`,
		input.resolved ? "" : `Formulario de desconexión: ${formLabel}`,
	].filter(Boolean).join("\n");
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
	};
}
