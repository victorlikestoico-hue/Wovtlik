import "./env-loader.ts";
import { Redis } from "ioredis";
import { isWithinColombiaSendWindow, msUntilNextTopOfHour } from "../src/lib/colombia-schedule.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

const FALLAS_TEMPLATE_COOLDOWN_KEY = "bot:fallas_template_last_sent";
// Mismo período que el intervalo: actúa como traba para no duplicar el envío si el
// bot se reinicia varias veces dentro de la ventana de 1h (deploys, crashes, etc.).
const FALLAS_TEMPLATE_COOLDOWN_SECONDS = 60 * 60;

const FALLAS_TEMPLATE_MESSAGE = [
	"📋 *Cómo reportar una falla en este grupo:*",
	"",
	"1️⃣ *Correo completo* → nombre.apellido@pedidosya.com",
	'2️⃣ *Motivo* → "se fue la luz", "cayó el internet", "HC no carga"',
	"3️⃣ *LOB* al que pertenecés",
	"4️⃣ Si ya llenaste el *formulario de desconexión*",
	"",
	"_Aplica si no podés retomar tus chats por falla de energía, internet o HC._",
].join("\n");

// Reintento corto cuando el socket todavía no terminó de autenticarse (recién arrancado el proceso).
// Sin esto, el primer tick tras cada reinicio choca con authState.creds.me aún sin definir
// dentro de Baileys y el recordatorio nunca llega a enviarse hasta el próximo ciclo de 2hs.
const FALLAS_TEMPLATE_NOT_READY_RETRY_MS = 30_000;

export async function runFallasTemplateCronOnce(): Promise<"sent" | "skipped" | "not_ready" | "outside_window" | "error"> {
	try {
		// Solo se envía entre 6am y 12am (medianoche) hora Colombia — fuera de ese rango no hay
		// agentes activos a quienes recordarles cómo reportar una falla.
		if (!isWithinColombiaSendWindow()) return "outside_window";

		const alreadySent = await redisClient.get(FALLAS_TEMPLATE_COOLDOWN_KEY);
		if (alreadySent) return "skipped";

		const { globalSock, FALLAS_GROUP_JID } = await import("../src/lib/baileys/client.ts");
		// sock.user.id solo existe una vez que la conexión terminó de autenticarse;
		// globalSock por sí solo ya existe apenas se crea el socket, antes de eso.
		if (!globalSock?.user?.id) {
			console.warn("[fallas-template-cron] Socket todavía no autenticado, reintento en breve.");
			return "not_ready";
		}

		await globalSock.sendMessage(FALLAS_GROUP_JID, { text: FALLAS_TEMPLATE_MESSAGE });
		await redisClient.set(FALLAS_TEMPLATE_COOLDOWN_KEY, Date.now().toString(), "EX", FALLAS_TEMPLATE_COOLDOWN_SECONDS);
		return "sent";
	} catch (err) {
		console.error("[fallas-template-cron] Error crítico ejecutando el tick:", err);
		return "error";
	}
}

export function startFallasTemplateCron(): void {
	console.log("[fallas-template-cron] Iniciando loop del recordatorio de reporte de fallas (cada hora en punto, 6am-12am Colombia)...");
	const tick = async () => {
		const result = await runFallasTemplateCronOnce();
		const delay = result === "not_ready" ? FALLAS_TEMPLATE_NOT_READY_RETRY_MS : msUntilNextTopOfHour();
		setTimeout(tick, delay);
	};
	// Primer tick alineado al próximo HH:00 en punto, no al instante en que arrancó el proceso.
	setTimeout(tick, msUntilNextTopOfHour());
}
