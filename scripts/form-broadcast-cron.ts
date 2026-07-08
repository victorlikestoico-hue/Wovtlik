import "./env-loader.ts";
import { Redis } from "ioredis";
import { msUntilNextTopOfHour } from "../src/lib/colombia-schedule.ts";
import { listFormAgents } from "../src/lib/db.ts";
import { getWarmupPhase, isBroadcastBlocked } from "../src/lib/warmup-throttle.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

const COLOMBIA_TZ = "America/Bogota";
const FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSfAhKXTXOHL6ftaFhaXjy8QTRLxBgVM4MY885iA74-PQdB0qw/viewform";

// Días del mes en que se envía (hora 9 AM Colombia) y ventana máxima de recuperación (+2h)
const SEND_DAYS = [2, 7] as const;
const SEND_HOUR_START = 9;
const SEND_HOUR_END = 11; // si el bot estaba caído a las 9h, aún envía hasta las 11h

// Reintento cuando el socket todavía no autenticó (recién arrancado el proceso)
const NOT_READY_RETRY_MS = 30_000;

function colombiaDateNow() {
	return new Date(new Date().toLocaleString("en-US", { timeZone: COLOMBIA_TZ }));
}

function cooldownKey(year: number, month: number, sendIndex: 1 | 2): string {
	return `bot:form_broadcast:${year}-${String(month).padStart(2, "0")}:send${sendIndex}`;
}

function buildMessage(name: string): string {
	return `Hola ${name}! 👋 Recuerda diligenciar el formulario mensual antes del día 10:\n${FORM_URL}`;
}

export async function runFormBroadcastOnce(): Promise<
	"sent" | "skipped" | "not_ready" | "outside_window" | "warmup_blocked" | "error"
> {
	try {
		const now = colombiaDateNow();
		const day = now.getDate();
		const hour = now.getHours();
		const year = now.getFullYear();
		const month = now.getMonth() + 1;

		const sendIndex = SEND_DAYS.indexOf(day as (typeof SEND_DAYS)[number]);
		const isTargetDay = sendIndex !== -1;
		const isWithinWindow = hour >= SEND_HOUR_START && hour <= SEND_HOUR_END;

		if (!isTargetDay || !isWithinWindow) return "outside_window";

		const key = cooldownKey(year, month, (sendIndex + 1) as 1 | 2);
		if (await redisClient.get(key)) return "skipped";

		const { globalSock, sendViaGlobalSock } = await import("../src/lib/baileys/client.ts");
		if (!globalSock?.user?.id) {
			console.warn("[form-broadcast] Socket todavía no autenticado, reintento en breve.");
			return "not_ready";
		}

		const agents = await listFormAgents();
		if (!agents.length) {
			console.warn("[form-broadcast] No hay agentes configurados, cancelando.");
			return "skipped";
		}

		if (isBroadcastBlocked(await getWarmupPhase())) {
			// No se marca el cooldown: se reintenta en el próximo tick dentro de la ventana
			// (o el día 2/7 siguiente) una vez pasado el período de calentamiento.
			console.warn("[form-broadcast] Número en período de calentamiento post-relogin, se pospone el envío.");
			return "warmup_blocked";
		}

		// Marcar antes del loop para que un reinicio a mitad no duplique el envío
		await redisClient.set(key, Date.now().toString(), "EX", 60 * 60 * 24 * 5);
		console.log(`[form-broadcast] Enviando formulario a ${agents.length} agentes (envío ${sendIndex + 1}/2 del mes ${year}-${String(month).padStart(2, "0")})...`);

		for (const agent of agents) {
			const jid = `${agent.phone}@s.whatsapp.net`;
			try {
				await sendViaGlobalSock(jid, { text: buildMessage(agent.name) }, { kind: "broadcast" });
				console.log(`[form-broadcast] Enviado a ${agent.name} (${agent.phone})`);
			} catch (err) {
				console.error(`[form-broadcast] Falló el envío a ${agent.name} (${agent.phone}):`, err);
			}
		}

		console.log("[form-broadcast] Broadcast completado.");
		return "sent";
	} catch (err) {
		console.error("[form-broadcast] Error crítico ejecutando el tick:", err);
		return "error";
	}
}

export function startFormBroadcastCron(): void {
	console.log("[form-broadcast] Iniciando cron de formulario mensual (días 2 y 7 a las 9h Colombia)...");
	const tick = async () => {
		const result = await runFormBroadcastOnce();
		if (result !== "outside_window") {
			console.log(`[form-broadcast] tick: ${result}`);
		}
		const delay = result === "not_ready" ? NOT_READY_RETRY_MS : msUntilNextTopOfHour();
		setTimeout(tick, delay);
	};
	setTimeout(tick, msUntilNextTopOfHour());
}
