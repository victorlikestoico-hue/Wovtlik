import "./env-loader.ts";
import { Redis } from "ioredis";
import { getSettings, getAgentProfileByEmail } from "../src/lib/db.ts";
import { getOfflineQueueResults } from "../src/lib/sheets-client.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

// 6hs alcanza de sobra para no duplicar avisos sin acumular memoria indefinidamente.
const NOTIFIED_KEY_TTL_SECONDS = 60 * 60 * 6;
// Si Redis se reinicia y perdemos el registro de "ya avisado", esta ventana limita
// el daño a unas pocas filas recientes en vez de reenviar todo el historial de la planilla.
const MAX_ROW_AGE_MS = 2 * 60 * 60 * 1000;

const notifiedKey = (timestamp: string, email: string) => `bot:offline_notified:${timestamp}:${email}`;

function parseOfflineResult(result: string): { ok: boolean; reassigned: number; total: number } | null {
	const m = result.match(/Reasignados:\s*(\d+)\s*\/\s*(\d+)/i);
	if (!m) return null;
	return { ok: /^OK/i.test(result.trim()), reassigned: parseInt(m[1], 10), total: parseInt(m[2], 10) };
}

/** "juan.perez@pedidosya.com" → "Juan". Si no hay punto en el local-part, usa todo. */
function deriveFirstNameFromEmail(email: string): string {
	const localPart = email.split("@")[0] || "";
	const firstToken = localPart.split(".")[0] || localPart;
	if (!firstToken) return "";
	return firstToken.charAt(0).toUpperCase() + firstToken.slice(1).toLowerCase();
}

function buildResultMessage(status: string, result: string, email: string): string {
	const firstName = deriveFirstNameFromEmail(email);
	const greet = (text: string) => (firstName ? `${text.replace("Te pusimos", `${firstName}, te pusimos`)}` : text);

	const parsed = parseOfflineResult(result);
	if (!parsed) {
		return status.toLowerCase() === "done"
			? `📋 Resultado de tu solicitud de Fuera de línea: ${result || "procesada"}.`
			: `⚠️ No pudimos completar tu solicitud de Fuera de línea (${status}). Contactá al TL.`;
	}
	if (parsed.total === 0) {
		return parsed.ok
			? greet("✅ Te pusimos *Fuera de línea*. No tenías chats activos para reasignar.")
			: `⚠️ Hubo un problema cambiando tu estado. Detalle: ${result}. Contactá al TL.`;
	}
	if (parsed.reassigned === parsed.total) {
		return greet(`✅ Te pusimos *Fuera de línea*. Reasignamos ${parsed.reassigned} de ${parsed.total} chat${parsed.total === 1 ? "" : "s"} activo${parsed.total === 1 ? "" : "s"}.`);
	}
	return greet(`⚠️ Te pusimos *Fuera de línea*, pero solo se reasignaron ${parsed.reassigned} de ${parsed.total} chats. Revisá los que quedaron pendientes o avisale al TL.`);
}

export async function runOfflineResultsCronOnce(): Promise<void> {
	try {
		const settings = await getSettings();
		const spreadsheetId = (settings.offline_queue_sheet_id as string) || "";
		if (!spreadsheetId) return;

		const rows = await getOfflineQueueResults(spreadsheetId);
		const now = Date.now();

		for (const row of rows) {
			if (!row.status || row.status.toLowerCase() === "pending") continue;

			const rowTime = new Date(row.timestamp).getTime();
			if (!Number.isFinite(rowTime) || now - rowTime > MAX_ROW_AGE_MS) continue;

			const key = notifiedKey(row.timestamp, row.email);
			if (await redisClient.get(key)) continue;

			const profile = await getAgentProfileByEmail(row.email);
			if (!profile) {
				// No sabemos a qué número avisarle — no tiene sentido reintentar para siempre.
				await redisClient.set(key, "1", "EX", NOTIFIED_KEY_TTL_SECONDS);
				continue;
			}

			const { globalSock } = await import("../src/lib/baileys/client.ts");
			// sock.user.id solo existe una vez autenticado; globalSock ya existe antes de eso
			// y llamar sendMessage en ese punto rompe dentro de Baileys (authState.creds.me undefined).
			if (!globalSock?.user?.id) {
				console.warn(`[offline-results-cron] Socket todavía no autenticado, reintento en el próximo tick para ${row.email}.`);
				continue; // no se marca como notificado: se reintenta en 30s
			}

			try {
				await globalSock.sendMessage(`${profile.phone}@s.whatsapp.net`, {
					text: buildResultMessage(row.status, row.result, row.email),
				});
				await redisClient.set(key, "1", "EX", NOTIFIED_KEY_TTL_SECONDS);
			} catch (err) {
				console.error(`[offline-results-cron] Error enviando aviso a ${row.email}:`, err);
			}
		}
	} catch (err) {
		console.error("[offline-results-cron] Error crítico ejecutando el tick:", err);
	}
}

const OFFLINE_RESULTS_CRON_INTERVAL_MS = 30_000;

export function startOfflineResultsCron(): void {
	console.log("[offline-results-cron] Iniciando loop de notificación de resultados de Fuera de línea...");
	const tick = async () => {
		await runOfflineResultsCronOnce();
		setTimeout(tick, OFFLINE_RESULTS_CRON_INTERVAL_MS);
	};
	tick();
}
