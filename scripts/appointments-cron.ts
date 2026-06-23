import "./env-loader.ts";
import { createTelegramNotifier } from "../src/lib/telegram-notifier.ts";
import {
	getSettings,
	getPendingAppointmentReminders,
	markCrmTaskReminderSent,
	markMissedAppointmentReminders,
	enqueueOutbox,
	getAgentProfile,
} from "../src/lib/db.ts";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const notifier = createTelegramNotifier({
	botToken,
	chatId,
	fetch: globalThis.fetch as any,
});

export async function runAppointmentsCronOnce(): Promise<void> {
	try {
		await markMissedAppointmentReminders();

		const settings = await getSettings();
		const leadMinutes = Number(settings.appointment_reminder_lead_minutes ?? 60);
		const rows = await getPendingAppointmentReminders(leadMinutes);

		for (const row of rows) {
			try {
				const appointmentLocal = new Date(row.appointment_at).toLocaleString("es-AR", {
					timeZone: "America/Argentina/Buenos_Aires",
					dateStyle: "short",
					timeStyle: "short",
				});

				if (row.conversation_id && row.client_phone) {
					await enqueueOutbox(
						row.conversation_id,
						row.client_phone,
						`📅 Recordatorio: tenés una cita agendada para ${appointmentLocal}. ${row.description ?? ""}`.trim(),
					);
				}

				if (row.agent_phone) {
					const { globalSock } = await import("../src/lib/baileys/client.ts");
					if (globalSock) {
						await globalSock.sendMessage(`${row.agent_phone}@s.whatsapp.net`, {
							text: `📅 Recordatorio: tenés una cita con ${row.client_name ?? row.client_phone ?? "un cliente"} para ${appointmentLocal}.`,
						});
					} else {
						console.warn(`[appointments-cron] Socket no conectado, no se pudo avisar al agente #${row.id}.`);
					}
				}

				const agentProfile = row.agent_phone ? await getAgentProfile(row.agent_phone) : null;
				await notifier.notifyAppointmentReminder({
					conversationId: row.conversation_id ?? 0,
					clientPhone: row.client_phone ?? "desconocido",
					clientName: row.client_name ?? "Sin nombre",
					agentEmail: agentProfile?.email ?? "desconocido",
					agentPhone: row.agent_phone ?? "desconocido",
					appointmentAt: appointmentLocal,
					description: row.description,
				});

				await markCrmTaskReminderSent(row.id);
			} catch (err) {
				console.error(`[appointments-cron] Error procesando cita #${row.id}:`, err);
				// Best-effort: igual marcamos para no reintentar infinitamente y espamear al cliente/agente.
				await markCrmTaskReminderSent(row.id).catch(() => {});
			}
		}
	} catch (err) {
		console.error("[appointments-cron] Error crítico ejecutando el tick:", err);
	}
}

const APPOINTMENTS_CRON_INTERVAL_MS = 60_000;

export function startAppointmentsCron(): void {
	console.log("[appointments-cron] Iniciando loop de recordatorios de citas...");
	const tick = async () => {
		await runAppointmentsCronOnce();
		setTimeout(tick, APPOINTMENTS_CRON_INTERVAL_MS);
	};
	tick();
}
