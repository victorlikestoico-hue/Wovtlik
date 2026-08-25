import "./env-loader.ts";
import { Redis } from "ioredis";
import { getSettings } from "../src/lib/db.ts";
import { msUntilNextTopOfHour } from "../src/lib/colombia-schedule.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

// Mismo grupo identificado en scripts/list-groups.ts, hardcodeado siguiendo el mismo patrón que
// FALLAS_GROUP_JID / ANUNCIOS_HORAS_GROUP_JID en src/lib/baileys/client.ts (evita depender de una
// env var que Railway no tiene seteada del lado del bot-process).
const FRAUDE_GROUP_JID = "120363183203833850@g.us";

const FRAUDE_ROTATION_COOLDOWN_KEY = "bot:fraude_rotation_last_sent";
// Traba para no duplicar el envío si el bot se reinicia varias veces dentro de la ventana de 2h
// (deploys, crashes, etc.), igual que fallas-template-cron / horas-cubrir-cron.
const FRAUDE_ROTATION_COOLDOWN_SECONDS = 2 * 60 * 60;
const FRAUDE_ROTATION_NEXT_INDEX_KEY = "bot:fraude_rotation_next_index";

// Reintento corto cuando el socket todavía no terminó de autenticarse (recién arrancado el proceso).
const FRAUDE_ROTATION_NOT_READY_RETRY_MS = 30_000;

type FraudeAttachment = {
	id: string;
	label: string;
	fileName: string;
	mimetype: string;
	base64: string;
	message?: string;
};

/** Solo entran a la rotación los ítems que tengan archivo o texto propio para mandar. */
function isSendable(item: FraudeAttachment): boolean {
	return Boolean(item.fileName && item.base64) || Boolean(item.message?.trim());
}

export async function runFraudeRotationCronOnce(): Promise<
	"sent" | "skipped" | "disabled" | "empty" | "not_ready" | "error"
> {
	try {
		const settings = await getSettings();
		if (!settings.fraude_rotation_enabled) return "disabled";

		const attachments = ((settings.fraude_attachments as FraudeAttachment[]) || []).filter(isSendable);
		if (!attachments.length) return "empty";

		const alreadySent = await redisClient.get(FRAUDE_ROTATION_COOLDOWN_KEY);
		if (alreadySent) return "skipped";

		const { globalSock, sendViaGlobalSock } = await import("../src/lib/baileys/client.ts");
		// sock.user.id solo existe una vez que la conexión terminó de autenticarse;
		// globalSock por sí solo ya existe apenas se crea el socket, antes de eso.
		if (!globalSock?.user?.id) {
			console.warn("[fraude-rotation-cron] Socket todavía no autenticado, reintento en breve.");
			return "not_ready";
		}

		const rawIndex = Number(await redisClient.get(FRAUDE_ROTATION_NEXT_INDEX_KEY));
		const index = Number.isFinite(rawIndex) && rawIndex >= 0 ? rawIndex % attachments.length : 0;
		const item = attachments[index];

		const content = item.fileName && item.base64
			? {
					document: Buffer.from(item.base64, "base64"),
					fileName: item.fileName,
					mimetype: item.mimetype || "application/octet-stream",
					...(item.message?.trim() ? { caption: item.message.trim() } : {}),
				}
			: { text: item.message!.trim() };

		await sendViaGlobalSock(FRAUDE_GROUP_JID, content, { kind: "cron" });
		console.log(`[fraude-rotation-cron] Enviado "${item.label || item.fileName}" (${index + 1}/${attachments.length}) al grupo Fraude - Información.`);

		await redisClient.set(FRAUDE_ROTATION_COOLDOWN_KEY, Date.now().toString(), "EX", FRAUDE_ROTATION_COOLDOWN_SECONDS);
		await redisClient.set(FRAUDE_ROTATION_NEXT_INDEX_KEY, String((index + 1) % attachments.length), "EX", 30 * 24 * 60 * 60);
		return "sent";
	} catch (err) {
		console.error("[fraude-rotation-cron] Error crítico ejecutando el tick:", err);
		return "error";
	}
}

export function startFraudeRotationCron(): void {
	console.log(
		"[fraude-rotation-cron] Iniciando loop de rotación al grupo Fraude - Información (cada 2 horas, si está habilitado en Ajustes)...",
	);
	const tick = async () => {
		const result = await runFraudeRotationCronOnce();
		if (result !== "disabled") {
			console.log(`[fraude-rotation-cron] tick: ${result}`);
		}
		const delay = result === "not_ready" ? FRAUDE_ROTATION_NOT_READY_RETRY_MS : msUntilNextTopOfHour();
		setTimeout(tick, delay);
	};
	// Primer tick alineado al próximo HH:00 en punto, no al instante en que arrancó el proceso.
	setTimeout(tick, msUntilNextTopOfHour());
}
