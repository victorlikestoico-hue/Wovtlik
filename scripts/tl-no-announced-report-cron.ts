import "./env-loader.ts";
import { Redis } from "ioredis";
import { getTlAnnouncementsForDay, notifyTlDailyMissedAnnouncements } from "../src/lib/db.ts";
import { getTLDaySchedule, type TLDayBlock } from "../src/lib/tl-guardia.ts";
import { getScheduledBlocksForDay, WOLFTLS_COVERED_LOBS } from "../src/lib/wolftls-client.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");
const URUGUAY_TZ = "America/Montevideo";

// Se manda una sola vez por día calendario, a las 02:00 UY: ya cerrado por completo el día
// anterior, incluidos los bloques que terminan cerca de medianoche.
const REPORT_HHMM = "02:00";

const reportSentDateKey = () => "bot:tl_no_announced_report_last_sent_date";

// Mismo orden que DAY_ORDER en wolftls-client.ts (L=lunes .. D=domingo), indexado a partir de
// Date.getDay() (0=domingo).
const DAY_LETTERS = ["L", "M", "X", "J", "V", "S", "D"] as const;

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

/** Fecha calendario (Uruguay) y su índice de día de semana (Date.getDay(), 0=domingo) para "ayer"
 * — el día que ya cerró por completo cuando este cron corre a las 02:00. Se calcula con aritmética
 * UTC pura sobre las partes de la fecha (sin reconvertir a través de un huso horario) para no
 * arrastrar corrimientos de zona horaria al restar el día. */
function yesterdayUruguay(): { iso: string; weekday: number } {
	const [y, m, d] = currentDateUruguayISO().split("-").map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	dt.setUTCDate(dt.getUTCDate() - 1);
	return { iso: dt.toISOString().slice(0, 10), weekday: dt.getUTCDay() };
}

function msUntilNextMinute(): number {
	const now = new Date();
	const next = new Date(now);
	next.setSeconds(0, 0);
	next.setMinutes(next.getMinutes() + 1);
	return next.getTime() - now.getTime();
}

/** Mismo criterio que nameFromEmail en tl-guardia.ts: "nombre.apellido_..." → "Nombre Apellido". */
function nameFromEmail(email: string): string {
	const local = email.split("@")[0] ?? "";
	const name = local.split("_")[0] ?? local;
	return name.split(".").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

export type MissedAnnouncement = { name: string; email: string | null; group: string; start: string; end: string };

const CS_SM_LOBS = new Set(["cs", "sm"]);
const PO_GO_LOBS = new Set(["po", "go"]);
const WOLFTLS_LOBS = new Set<string>(WOLFTLS_COVERED_LOBS);

/**
 * TL con turno asignado (rooster) para `dayIso` que nunca mandaron el "los acompaño con..." en el
 * grupo de desconexiones ese día. Cruza dos fuentes de turno independientes: el sheet de
 * tl-guardia.ts (CS/SM y PO/GO) y el rooster de Wolftls (Fraude/Across, ver WOLFTLS_COVERED_LOBS).
 * LOB sin rooster (ov, y los extra de client.ts sin fuente de turno) quedan afuera del reporte
 * porque no hay forma de saber si alguien tenía turno o no.
 *
 * "Rotación" (tl-guardia) se omite del reporte: no hay una persona puntual a quien atribuirle el
 * turno, así que reportarla generaría un falso "no anunciado".
 */
export async function buildMissedAnnouncementsReport(
	dayIso: string,
	weekday: number,
): Promise<MissedAnnouncement[]> {
	const announcements = await getTlAnnouncementsForDay(dayIso);
	const announcedEmails = {
		cs_sm: new Set(
			announcements.filter((a) => a.email && CS_SM_LOBS.has(a.lob)).map((a) => a.email!.toLowerCase()),
		),
		po_go: new Set(
			announcements.filter((a) => a.email && PO_GO_LOBS.has(a.lob)).map((a) => a.email!.toLowerCase()),
		),
		wolftls: new Set(
			announcements.filter((a) => a.email && WOLFTLS_LOBS.has(a.lob)).map((a) => a.email!.toLowerCase()),
		),
	};

	const misses: MissedAnnouncement[] = [];

	const daySchedule: TLDayBlock[] = await getTLDaySchedule(weekday);
	for (const block of daySchedule) {
		if (block.isRotacion || !block.email) continue;
		const announcedSet = block.group === "cs_sm" ? announcedEmails.cs_sm : announcedEmails.po_go;
		if (announcedSet.has(block.email)) continue;
		misses.push({
			name: block.name,
			email: block.email,
			group: block.group === "cs_sm" ? "CS/SM" : "PO/GO",
			start: block.inicioUY,
			end: block.finUY,
		});
	}

	const dayLetter = DAY_LETTERS[(weekday + 6) % 7];
	const wolftlsBlocks = await getScheduledBlocksForDay(dayLetter);
	for (const block of wolftlsBlocks) {
		const email = block.mail.toLowerCase().trim();
		if (!email || announcedEmails.wolftls.has(email)) continue;
		misses.push({
			name: nameFromEmail(email),
			email,
			group: "Fraude/Across",
			start: block.start,
			end: block.end,
		});
	}

	return misses;
}

export async function runTlNoAnnouncedReportCronOnce(): Promise<"sent" | "skipped" | "not_due" | "error"> {
	try {
		if (currentHHmmUruguay() !== REPORT_HHMM) return "not_due";

		const today = currentDateUruguayISO();
		const alreadySentDate = await redisClient.get(reportSentDateKey());
		if (alreadySentDate === today) return "skipped";

		const { iso, weekday } = yesterdayUruguay();
		const misses = await buildMissedAnnouncementsReport(iso, weekday);

		await notifyTlDailyMissedAnnouncements({ day: iso, misses });

		// TTL largo (36h) solo para que la key no quede huérfana si el proceso se cae justo después
		// de guardarla; el chequeo real de "ya se mandó hoy" es por fecha, no por TTL.
		await redisClient.set(reportSentDateKey(), today, "EX", 36 * 60 * 60);
		return "sent";
	} catch (err) {
		console.error("[tl-no-announced-report-cron] Error crítico ejecutando el tick:", err);
		return "error";
	}
}

export function startTlNoAnnouncedReportCron(): void {
	console.log(
		`[tl-no-announced-report-cron] Iniciando loop del reporte diario de TL sin anunciarse (chequeo cada minuto, envío a las ${REPORT_HHMM} UY)...`,
	);
	const tick = async () => {
		await runTlNoAnnouncedReportCronOnce();
		setTimeout(tick, msUntilNextMinute());
	};
	setTimeout(tick, msUntilNextMinute());
}
