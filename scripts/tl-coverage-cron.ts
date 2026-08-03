import "./env-loader.ts";
import { Redis } from "ioredis";
import { getSettings } from "../src/lib/db.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

const URUGUAY_TZ = "America/Montevideo";

// Traba para no duplicar el envío del día si el bot tickea más de una vez dentro del
// mismo minuto configurado (o se reinicia justo en ese instante).
const tlCoverageSentDateKey = () => "bot:tl_coverage_last_sent_date";

// Mismo formato de key que saveTlAnnouncement en client.ts — se escribe directo acá para
// no tener que exportar internals de ese módulo solo para este cron.
const tlAnnouncementKey = (lob: string) => `bot:tl_announcement:${lob}`;

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

// Índice de Date.getDay() (0=domingo) → key del día, mismas keys que usa SettingsPanel.tsx
// para guardar tl_coverage_schedule.
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Key del día actual ("mon".."sun") calculada en hora Uruguay, no en la del server. */
function currentWeekdayKeyUruguay(): string {
	const weekday = new Intl.DateTimeFormat("en-US", { timeZone: URUGUAY_TZ, weekday: "short" })
		.format(new Date())
		.toLowerCase(); // "mon", "tue", "wed", "thu", "fri", "sat", "sun"
	return WEEKDAY_KEYS.includes(weekday as any) ? weekday : WEEKDAY_KEYS[new Date().getDay()];
}

/** Minutos transcurridos desde medianoche (hora Uruguay) para un "HH:mm". */
function toMinutes(hhmm: string): number | null {
	const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
	if (!m) return null;
	return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Segundos hasta el próximo HH:mm:00 (top del minuto), calculado en tiempo real del server. */
function msUntilNextMinute(): number {
	const now = new Date();
	const next = new Date(now);
	next.setSeconds(0, 0);
	next.setMinutes(next.getMinutes() + 1);
	return next.getTime() - now.getTime();
}

function formatLobList(lobs: string[]): string {
	const upper = lobs.map((l) => l.toUpperCase());
	if (upper.length <= 1) return upper.join("");
	return `${upper.slice(0, -1).join(", ")} & ${upper[upper.length - 1]}`;
}

function buildCoverageMessage(start: string, end: string, lobs: string[]): string {
	return `Hola equipo, los acompaño por aquí desde ahora ${start} hasta las ${end} UY con las desconexiones y fallos de internet a los equipos ${formatLobList(lobs)}`;
}

/** TTL del anuncio: minutos entre ahora y la hora de fin configurada (cruza medianoche si hace falta). */
function computeTtlSeconds(end: string): number {
	const nowMinutes = toMinutes(currentHHmmUruguay()) ?? 0;
	let endMinutes = toMinutes(end) ?? nowMinutes;
	if (endMinutes <= nowMinutes) endMinutes += 24 * 60;
	return Math.max((endMinutes - nowMinutes) * 60, 60);
}

export async function runTlCoverageCronOnce(): Promise<
	"sent" | "skipped" | "disabled" | "not_ready" | "not_due" | "misconfigured" | "error"
> {
	try {
		const settings = await getSettings();
		if (!settings.tl_coverage_enabled) return "disabled";

		const schedule = (settings.tl_coverage_schedule as Record<string, { enabled?: boolean; start?: string; end?: string }>) || {};
		const todayKey = currentWeekdayKeyUruguay();
		const daySchedule = schedule[todayKey];
		if (!daySchedule?.enabled) return "disabled";

		const start = daySchedule.start || "";
		const end = daySchedule.end || "";
		const phone = ((settings.tl_coverage_phone as string) || "").replace(/\D/g, "");
		const lobsRaw = (settings.tl_coverage_lobs as string) || "";
		const lobs = lobsRaw.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
		if (!start || !end || !phone || lobs.length === 0) return "misconfigured";

		if (currentHHmmUruguay() !== start) return "not_due";

		const today = currentDateUruguayISO();
		const alreadySentDate = await redisClient.get(tlCoverageSentDateKey());
		if (alreadySentDate === today) return "skipped";

		const { globalSock, FALLAS_GROUP_JID, sendViaGlobalSock } = await import("../src/lib/baileys/client.ts");
		if (!globalSock?.user?.id) {
			console.warn("[tl-coverage-cron] Socket todavía no autenticado, se omite este tick (se reintenta el próximo minuto).");
			return "not_ready";
		}

		const message = buildCoverageMessage(start, end, lobs);
		await sendViaGlobalSock(FALLAS_GROUP_JID, { text: message }, { kind: "cron" });

		// Sticker opcional configurado en Ajustes: viaja como base64 (no como archivo en disco)
		// por la misma razón que el outbox lo maneja así — mediaDir no está en el volumen
		// persistente de Railway. Si falla, no debe tumbar el resto del tick (el texto ya salió).
		const stickerBase64 = (settings.tl_coverage_sticker_base64 as string) || "";
		if (stickerBase64) {
			try {
				await sendViaGlobalSock(
					FALLAS_GROUP_JID,
					{ sticker: Buffer.from(stickerBase64, "base64") },
					{ kind: "cron" },
				);
			} catch (err) {
				console.error("[tl-coverage-cron] Error mandando el sticker de cobertura:", err);
			}
		}

		const name = (settings.tl_coverage_name as string) || phone;
		const jid = `${phone}@s.whatsapp.net`;
		const ttlSeconds = computeTtlSeconds(end);
		await Promise.all(
			lobs.map((lob) =>
				redisClient.set(tlAnnouncementKey(lob), JSON.stringify({ phone, name, jid }), "EX", ttlSeconds),
			),
		);

		// TTL largo (36h) solo para que la key no quede huérfana si el proceso se cae justo
		// después de guardarla; el chequeo real de "ya se mandó hoy" es por fecha, no por TTL.
		await redisClient.set(tlCoverageSentDateKey(), today, "EX", 36 * 60 * 60);
		return "sent";
	} catch (err) {
		console.error("[tl-coverage-cron] Error crítico ejecutando el tick:", err);
		return "error";
	}
}

export function startTlCoverageCron(): void {
	console.log("[tl-coverage-cron] Iniciando loop de anuncio de cobertura propia en el grupo de desconexiones (chequeo cada minuto)...");
	const tick = async () => {
		await runTlCoverageCronOnce();
		setTimeout(tick, msUntilNextMinute());
	};
	setTimeout(tick, msUntilNextMinute());
}
