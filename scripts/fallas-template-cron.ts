import "./env-loader.ts";
import { Redis } from "ioredis";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

const FALLAS_TEMPLATE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 horas
const FALLAS_TEMPLATE_COOLDOWN_KEY = "bot:fallas_template_last_sent";
// Mismo período que el intervalo: actúa como traba para no duplicar el envío si el
// bot se reinicia varias veces dentro de la ventana de 2hs (deploys, crashes, etc.).
const FALLAS_TEMPLATE_COOLDOWN_SECONDS = 2 * 60 * 60;

const FALLAS_TEMPLATE_MESSAGE = [
	"📋 *Recordatorio: cómo reportar una falla acá*",
	"",
	"Si no podés retomar tus chats por falla de energía, internet, HC lento o HC trabado, escribí en este grupo:",
	"",
	"1️⃣ Tu correo corporativo",
	'2️⃣ El motivo (ej: "se fue la luz", "se cayó el internet", "HC no carga", "HC se quedó trabado")',
	"3️⃣ Si ya llenaste el formulario de desconexión",
	"",
	"Con esos 3 datos te confirmo por privado y gestiono el cambio a *Fuera de línea* más rápido. 🙏",
].join("\n");

export async function runFallasTemplateCronOnce(): Promise<void> {
	try {
		const alreadySent = await redisClient.get(FALLAS_TEMPLATE_COOLDOWN_KEY);
		if (alreadySent) return;

		const { globalSock, FALLAS_GROUP_JID } = await import("../src/lib/baileys/client.ts");
		if (!globalSock) {
			console.warn("[fallas-template-cron] Socket no conectado, reintento en el próximo tick.");
			return;
		}

		await globalSock.sendMessage(FALLAS_GROUP_JID, { text: FALLAS_TEMPLATE_MESSAGE });
		await redisClient.set(FALLAS_TEMPLATE_COOLDOWN_KEY, Date.now().toString(), "EX", FALLAS_TEMPLATE_COOLDOWN_SECONDS);
	} catch (err) {
		console.error("[fallas-template-cron] Error crítico ejecutando el tick:", err);
	}
}

export function startFallasTemplateCron(): void {
	console.log("[fallas-template-cron] Iniciando loop del recordatorio de reporte de fallas (cada 2hs)...");
	const tick = async () => {
		await runFallasTemplateCronOnce();
		setTimeout(tick, FALLAS_TEMPLATE_INTERVAL_MS);
	};
	tick();
}
