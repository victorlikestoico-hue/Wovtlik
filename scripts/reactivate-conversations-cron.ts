import "./env-loader.ts";
import { Redis } from "ioredis";
import { bulkSetMode } from "../src/lib/db.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");
const URUGUAY_TZ = "America/Montevideo";

// Mismo efecto que el botón "Activar IA" del dashboard (ver ConversationList.tsx), pero corrido
// solo una vez por día calendario a esta hora, sobre TODAS las conversaciones (archivadas y no
// archivadas) en vez de solo las visibles según el filtro de archivado activo en el dashboard.
const REACTIVATE_HHMM = "05:00";

const reactivateSentDateKey = () => "bot:reactivate_conversations_last_run_date";

function currentDateUruguayISO(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: URUGUAY_TZ }); // en-CA => YYYY-MM-DD
}

function currentHHmmUruguay(): string {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: URUGUAY_TZ,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(new Date());
	const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
	const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
	return `${hour}:${minute}`;
}

function msUntilNextMinute(): number {
	const now = new Date();
	const next = new Date(now);
	next.setSeconds(0, 0);
	next.setMinutes(next.getMinutes() + 1);
	return next.getTime() - now.getTime();
}

export async function runReactivateConversationsCronOnce(): Promise<
	"sent" | "skipped" | "not_due" | "error"
> {
	try {
		if (currentHHmmUruguay() !== REACTIVATE_HHMM) return "not_due";

		const today = currentDateUruguayISO();
		const alreadyRunDate = await redisClient.get(reactivateSentDateKey());
		if (alreadyRunDate === today) return "skipped";

		const updatedActive = await bulkSetMode("AI", false);
		const updatedArchived = await bulkSetMode("AI", true);
		console.log(
			`[reactivate-conversations-cron] Reactivadas ${updatedActive} conversaciones activas y ${updatedArchived} archivadas.`,
		);

		// TTL largo (36h) solo para que la key no quede huérfana si el proceso se cae justo después
		// de guardarla; el chequeo real de "ya corrió hoy" es por fecha, no por TTL.
		await redisClient.set(reactivateSentDateKey(), today, "EX", 36 * 60 * 60);
		return "sent";
	} catch (err) {
		console.error("[reactivate-conversations-cron] Error crítico ejecutando el tick:", err);
		return "error";
	}
}

export function startReactivateConversationsCron(): void {
	console.log(
		`[reactivate-conversations-cron] Iniciando loop de reactivación nocturna de modo IA (chequeo cada minuto, corre a las ${REACTIVATE_HHMM} UY)...`,
	);
	const tick = async () => {
		await runReactivateConversationsCronOnce();
		setTimeout(tick, msUntilNextMinute());
	};
	setTimeout(tick, msUntilNextMinute());
}
