import "./env-loader.ts";
import { Redis } from "ioredis";
import { msUntilNextTopOfHour } from "../src/lib/colombia-schedule.ts";
import { runBQQuery } from "../src/lib/bigquery-client.ts";
import { readSheetByGid } from "../src/lib/sheets-client.ts";
import { MI_COBERTURA_EMAIL } from "../src/lib/wolftls-client.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

const COLOMBIA_TZ = "America/Bogota";
// Auditorías (auditorias_pedidosya.consolidado/signatures) viven en un proyecto de BigQuery
// aparte del que se usa para facturar los jobs (ver bigquery-client.ts) — mismo dataset que
// usa el Monitor de Auditorías (apps_script/Code.js).
const AUDIT_DATASET = "web-dinamica-429617.auditorias_pedidosya";

// Misma planilla "Base" que alimenta agents_master (envíos masivos): columna "Agentes" trae
// el correo corporativo del agente (no el nombre, a pesar del encabezado) y "Telefono" su
// WhatsApp — es el cruce que pidió el usuario entre Monitor (correo) y Masivos (teléfono).
const AGENTS_SHEET_ID = "14EHBTNksNanil6pxmcbjkjTispLA6Fjn6dPzRzXmaQc";
const AGENTS_SHEET_GID = "390261573";

// Se envía viernes, sábado y domingo (getDay(): 0=domingo … 6=sábado), a las 9h Colombia,
// con margen de recuperación hasta las 11h si el bot estaba caído — mismo patrón que
// form-broadcast-cron.ts.
const SEND_WEEKDAYS = [5, 6, 0];
const SEND_HOUR_START = 9;
const SEND_HOUR_END = 11;

const NOT_READY_RETRY_MS = 30_000;

function colombiaDateNow(): Date {
	return new Date(new Date().toLocaleString("en-US", { timeZone: COLOMBIA_TZ }));
}

function colombiaDateISO(d: Date): string {
	return d.toLocaleDateString("en-CA", { timeZone: COLOMBIA_TZ });
}

// getDay() ya está calculado sobre la hora de Colombia (colombiaDateNow reconstruye el Date
// a partir de ese string) — no hace falta reconvertir zona horaria acá.
function mondayOfWeekISO(d: Date): string {
	const day = d.getDay();
	const diffToMonday = day === 0 ? 6 : day - 1;
	const monday = new Date(d);
	monday.setDate(d.getDate() - diffToMonday);
	return colombiaDateISO(monday);
}

function cooldownKey(dateISO: string): string {
	return `bot:audit_signature_report:${dateISO}`;
}

export interface AgentSignatureStat {
	agent: string;
	total: number;
	signed: number;
}

export async function fetchUnsignedAgents(
	auditorEmail: string,
	weekStartISO: string,
	todayISO: string,
): Promise<AgentSignatureStat[]> {
	const rows = await runBQQuery<{ agent: string; total: string; signed: string }>(
		`
		SELECT
			LOWER(TRIM(c.agent_email)) AS agent,
			COUNT(*) AS total,
			COUNTIF(s.ticket_id IS NOT NULL) AS signed
		FROM \`${AUDIT_DATASET}.consolidado\` c
		LEFT JOIN \`${AUDIT_DATASET}.signatures\` s ON s.ticket_id = c.ticket_id
		WHERE c.rol_auditor = 'TL'
			AND LOWER(TRIM(c.auditor_email)) = @auditorEmail
			AND DATE(c.fecha, '${COLOMBIA_TZ}') BETWEEN @weekStart AND @today
		GROUP BY agent
		`,
		[
			{ name: "auditorEmail", parameterType: { type: "STRING" }, parameterValue: { value: auditorEmail.toLowerCase().trim() } },
			{ name: "weekStart", parameterType: { type: "DATE" }, parameterValue: { value: weekStartISO } },
			{ name: "today", parameterType: { type: "DATE" }, parameterValue: { value: todayISO } },
		],
	);
	return rows
		.map((r) => ({ agent: r.agent, total: parseInt(r.total, 10) || 0, signed: parseInt(r.signed, 10) || 0 }))
		.filter((r) => r.total > 0 && r.signed < r.total);
}

interface AgentContact {
	phone: string;
	firstName: string;
}

export async function lookupAgentContacts(emails: Set<string>): Promise<Map<string, AgentContact>> {
	const { headers, rows } = await readSheetByGid(AGENTS_SHEET_ID, AGENTS_SHEET_GID);
	const emailCol = headers.findIndex((h) => /^agentes$/i.test(h));
	const phoneCol = headers.findIndex((h) => /^tel[eé]fono$/i.test(h));
	const firstNameCol = headers.findIndex((h) => /^primer nombre$/i.test(h));
	if (emailCol < 0 || phoneCol < 0) {
		throw new Error("La planilla de agentes no tiene columnas 'Agentes'/'Telefono'");
	}

	const map = new Map<string, AgentContact>();
	for (const { cells } of rows) {
		const email = (cells[emailCol] || "").toLowerCase().trim();
		if (!email || !emails.has(email)) continue;
		const phone = (cells[phoneCol] || "").replace(/\D/g, "");
		if (phone.length < 10) continue;
		const firstName = firstNameCol >= 0 ? (cells[firstNameCol] || "").trim() : "";
		map.set(email, { phone, firstName });
	}
	return map;
}

export function buildMessage(firstName: string, stat: AgentSignatureStat): string {
	const greeting = firstName ? `Hola ${firstName}! 👋` : "Hola! 👋";
	return [
		greeting,
		`Esta semana tenés ${stat.total} auditoría${stat.total === 1 ? "" : "s"} y firmaste ${stat.signed}.`,
		"Recordá firmar el feedback pendiente para llegar al 100% 🙏",
	].join("\n");
}

export async function runAuditSignatureReportOnce(): Promise<
	"sent" | "no_pending" | "skipped" | "not_ready" | "outside_window" | "error"
> {
	try {
		const now = colombiaDateNow();
		const isTargetDay = SEND_WEEKDAYS.includes(now.getDay());
		const hour = now.getHours();
		const isWithinWindow = hour >= SEND_HOUR_START && hour <= SEND_HOUR_END;
		if (!isTargetDay || !isWithinWindow) return "outside_window";

		const todayISO = colombiaDateISO(now);
		const key = cooldownKey(todayISO);
		if (await redisClient.get(key)) return "skipped";

		const { globalSock, sendViaGlobalSock } = await import("../src/lib/baileys/client.ts");
		if (!globalSock?.user?.id) {
			console.warn("[audit-signature-report] Socket todavía no autenticado, reintento en breve.");
			return "not_ready";
		}

		const weekStartISO = mondayOfWeekISO(now);
		const stats = await fetchUnsignedAgents(MI_COBERTURA_EMAIL, weekStartISO, todayISO);

		// Marcar antes de mandar nada para que un reinicio a mitad no duplique el envío
		// (mismo criterio que form-broadcast-cron.ts).
		await redisClient.set(key, Date.now().toString(), "EX", 60 * 60 * 24);

		if (stats.length === 0) {
			console.log(`[audit-signature-report] Sin pendientes de firma esta semana (${weekStartISO} a ${todayISO}).`);
			return "no_pending";
		}

		const contacts = await lookupAgentContacts(new Set(stats.map((s) => s.agent)));
		console.log(`[audit-signature-report] ${stats.length} agente(s) sin 100% de firma esta semana (${weekStartISO} a ${todayISO}).`);

		for (const stat of stats) {
			const contact = contacts.get(stat.agent);
			if (!contact) {
				console.warn(`[audit-signature-report] No se encontró teléfono para ${stat.agent}, se omite.`);
				continue;
			}
			const jid = `${contact.phone}@s.whatsapp.net`;
			try {
				await sendViaGlobalSock(jid, { text: buildMessage(contact.firstName, stat) }, { kind: "broadcast" });
				console.log(`[audit-signature-report] Enviado a ${stat.agent} (${contact.phone}): ${stat.signed}/${stat.total} firmadas.`);
			} catch (err) {
				console.error(`[audit-signature-report] Falló el envío a ${stat.agent} (${contact.phone}):`, err);
			}
		}

		return "sent";
	} catch (err) {
		console.error("[audit-signature-report] Error crítico ejecutando el tick:", err);
		return "error";
	}
}

export function startAuditSignatureReportCron(): void {
	console.log("[audit-signature-report] Iniciando recordatorio de firma de auditorías (viernes, sábado y domingo, 9h Colombia)...");
	const tick = async () => {
		const result = await runAuditSignatureReportOnce();
		if (result !== "outside_window") {
			console.log(`[audit-signature-report] tick: ${result}`);
		}
		const delay = result === "not_ready" ? NOT_READY_RETRY_MS : msUntilNextTopOfHour();
		setTimeout(tick, delay);
	};
	setTimeout(tick, msUntilNextTopOfHour());
}
