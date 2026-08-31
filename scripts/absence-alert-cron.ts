import "./env-loader.ts";
import { Redis } from "ioredis";
import { getSettings } from "../src/lib/db.ts";
import { getAgentProfileByEmail } from "../src/lib/db.ts";
import { getAbsentAgentsWithoutJustification } from "../src/lib/sheets-client.ts";
import { getCurrentBlockForEmail, MI_COBERTURA_EMAIL } from "../src/lib/wolftls-client.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

const URUGUAY_TZ = "America/Montevideo";
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Un mensaje individual por agente por turno: sin esto, cada tick de 5 min volvería a
// mandar el mismo aviso mientras el agente siga marcado Ausente en la ventana de cobertura.
const ALERT_SENT_TTL_SECONDS = 26 * 60 * 60;
const alertSentKey = (fecha: string, email: string, horario: string) =>
	`bot:absence_alert_sent:${fecha}:${email}:${horario}`;

function currentDateUruguayISO(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: URUGUAY_TZ }); // en-CA => YYYY-MM-DD
}

function toMinutes(hhmm: string): number | null {
	const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
	if (!m) return null;
	return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** true si un instante (en minutos desde medianoche) cae dentro de [start, end), soportando ventanas que cruzan medianoche. */
function isWithinWindow(min: number, start: number, end: number): boolean {
	if (end <= start) return min >= start || min < end; // cruza medianoche
	return min >= start && min < end;
}

/** Extrae la hora de inicio del turno ("HH:mm - HH:mm" o similar) en minutos desde medianoche. */
function horarioStartMinutes(horario: string): number | null {
	const m = horario.match(/(\d{1,2}):(\d{2})/);
	if (!m) return null;
	return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function nombreDesdeEmail(email: string): string {
	const local = email.split("@")[0] ?? "";
	const first = local.split(".")[0] ?? local;
	return first ? first.charAt(0).toUpperCase() + first.slice(1) : "";
}

function buildAlertMessage(email: string, horario: string): string {
	const nombre = nombreDesdeEmail(email);
	return `Hola ${nombre}${nombre ? " 👋" : ""} Vemos que tu turno${horario ? ` de las ${horario}` : ""} figura sin conexión. Si tuviste un problema (falla de internet, luz, aplicativo, etc.) contanos por acá para dejarlo registrado. Si fue otro motivo, avisale a tu TL.`;
}

export async function runAbsenceAlertCronOnce(): Promise<
	"sent" | "no_candidates" | "disabled" | "not_ready" | "not_due" | "misconfigured" | "error"
> {
	try {
		const settings = await getSettings();
		// Reutiliza exactamente la misma fuente que "Mi Cobertura en el Grupo de Desconexiones"
		// (ver tl-coverage-cron.ts): esta alerta solo puede dispararse mientras el rooster de
		// Wolftls dice que Victor está activamente cubriendo. Fuera de esa ventana, el chequeo ni
		// siquiera corre.
		if (!settings.tl_coverage_enabled) return "disabled";

		const myBlock = await getCurrentBlockForEmail(MI_COBERTURA_EMAIL);
		if (!myBlock) return "not_due";

		const startMin = toMinutes(myBlock.start);
		const endMin = toMinutes(myBlock.end);
		if (startMin === null || endMin === null) return "misconfigured";

		const spreadsheetIds = [
			(settings.programacion_1_id as string) || "",
			(settings.programacion_2_id as string) || "",
		].filter(Boolean);
		if (spreadsheetIds.length === 0) return "misconfigured";

		const { globalSock, sendViaGlobalSock } = await import("../src/lib/baileys/client.ts");
		if (!globalSock?.user?.id) {
			console.warn("[absence-alert-cron] Socket todavía no autenticado, se omite este tick.");
			return "not_ready";
		}

		const today = currentDateUruguayISO();
		const allCandidates = await getAbsentAgentsWithoutJustification(spreadsheetIds, today);
		// Solo avisar por turnos que arrancan dentro del tramo que se está cubriendo ahora — un
		// ausente de un turno de horas antes (ej. 12:00 con cobertura 14-18) no es "de este tramo"
		// y no debe generar un mensaje recién cuando arranca la cobertura.
		const candidates = allCandidates.filter((c) => {
			const start = horarioStartMinutes(c.horario);
			return start !== null && isWithinWindow(start, startMin, endMin);
		});
		if (candidates.length === 0) return "no_candidates";

		let sentAny = false;
		for (const candidate of candidates) {
			const key = alertSentKey(candidate.fecha, candidate.email, candidate.horario);
			const alreadySent = await redisClient.get(key);
			if (alreadySent) continue;

			const profile = await getAgentProfileByEmail(candidate.email);
			if (!profile?.phone) {
				console.warn(`[absence-alert-cron] Sin teléfono vinculado para ${candidate.email}, no se puede avisar por WhatsApp.`);
				continue;
			}

			try {
				await sendViaGlobalSock(
					`${profile.phone}@s.whatsapp.net`,
					{ text: buildAlertMessage(candidate.email, candidate.horario) },
					{ kind: "reactive" },
				);
				await redisClient.set(key, "1", "EX", ALERT_SENT_TTL_SECONDS);
				sentAny = true;
			} catch (err) {
				console.error(`[absence-alert-cron] Error mandando alerta a ${candidate.email}:`, err);
			}
		}

		return sentAny ? "sent" : "no_candidates";
	} catch (err) {
		console.error("[absence-alert-cron] Error crítico ejecutando el tick:", err);
		return "error";
	}
}

export function startAbsenceAlertCron(): void {
	console.log("[absence-alert-cron] Iniciando loop de alerta de ausentes sin justificar (chequeo cada 5 min, solo durante la ventana de Mi Cobertura)...");
	void runAbsenceAlertCronOnce();
	setInterval(() => void runAbsenceAlertCronOnce(), CHECK_INTERVAL_MS);
}
