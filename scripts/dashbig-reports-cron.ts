import "./env-loader.ts";
import { getSettings, listAgentProfiles, enqueueOutbox, getConversationByPhone } from "../src/lib/db.ts";
import { getAgentMetrics, getDailyReport, isDashBigConfigured } from "../src/lib/dashbig-client.ts";

type AgentMetrics = Awaited<ReturnType<typeof getAgentMetrics>>;

function fmtPct(v: number | null): string {
	if (v === null || v === undefined) return "N/D";
	const pct = v <= 1 ? v * 100 : v;
	return `${pct.toFixed(1)}%`;
}

function fmtAht(seconds: number | null): string {
	if (!seconds) return "N/D";
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}:${String(s).padStart(2, "0")} min`;
}

function vsObj(
	value: number | null,
	key: string,
	objectives: Record<string, { target: number; condition: string }>,
): string {
	if (value === null || !objectives[key]) return "";
	const { target, condition } = objectives[key];
	const v = value <= 1 ? value : value / 100;
	const ok = condition === ">=" ? v >= target : condition === "<=" ? v <= target : v >= target;
	return ok ? " ✅" : " ❌";
}

function buildDailyMessage(data: NonNullable<AgentMetrics>): string {
	const { metrics, objectives, period, lob } = data;
	const obj = lob && objectives[lob] ? objectives[lob] : {};
	const lines = [
		`📊 *Reporte diario — ${period.end}*`,
		lob ? `LOB: ${lob}` : "",
		`CSAT: ${fmtPct(metrics.csat)}${vsObj(metrics.csat, "csat", obj)}`,
		`AHT: ${fmtAht(metrics.aht_seconds)}`,
		`GA Crítica: ${fmtPct(metrics.ga_critica)}${vsObj(metrics.ga_critica, "gacrit", obj)}`,
		metrics.apego !== null ? `Apego: ${fmtPct(metrics.apego)}${vsObj(metrics.apego, "apego", obj)}` : "",
		`Interacciones: ${metrics.total_interactions}`,
		`Período: ${period.start} → ${period.end}`,
	].filter(Boolean);
	return lines.join("\n");
}

function msUntilNextReport(reportHour: string): number {
	const now = new Date();
	const [hh, mm] = reportHour.split(":").map(Number);
	const next = new Date(now);
	next.setHours(hh, mm, 0, 0);
	if (next.getTime() <= now.getTime()) {
		next.setDate(next.getDate() + 1);
	}
	// Skip weekends
	while (next.getDay() === 0 || next.getDay() === 6) {
		next.setDate(next.getDate() + 1);
	}
	return next.getTime() - now.getTime();
}

async function runDashBigReportsOnce(): Promise<void> {
	if (!isDashBigConfigured()) {
		console.log("[dashbig-reports] No configurado, omitiendo.");
		return;
	}

	const settings = await getSettings();
	const enabled = settings.dashbig_reports_enabled === true || settings.dashbig_reports_enabled === "true";
	if (!enabled) {
		console.log("[dashbig-reports] Reportes desactivados en settings.");
		return;
	}

	const profiles = await listAgentProfiles();
	if (!profiles.length) {
		console.log("[dashbig-reports] No hay perfiles de agentes registrados.");
		return;
	}

	// Yesterday's date
	const yesterday = new Date();
	yesterday.setDate(yesterday.getDate() - 1);
	const yDate = yesterday.toISOString().split("T")[0];

	console.log(`[dashbig-reports] Enviando reportes a ${profiles.length} agentes para ${yDate}...`);

	for (const profile of profiles) {
		try {
			const data = await getAgentMetrics(profile.email, yDate, yDate);
			if (!data) {
				console.log(`[dashbig-reports] Sin datos para ${profile.email}, omitiendo.`);
				continue;
			}

			const message = buildDailyMessage(data);
			const conv = await getConversationByPhone(profile.phone);
			if (!conv) {
				console.log(`[dashbig-reports] No hay conversación para ${profile.phone}, omitiendo.`);
				continue;
			}

			await enqueueOutbox(conv.id, profile.phone, message);
			console.log(`[dashbig-reports] Reporte encolado para ${profile.email} (${profile.phone})`);
		} catch (err) {
			console.error(`[dashbig-reports] Error procesando ${profile.email}:`, err);
		}
	}
}

export function startDashBigReportsCron(): void {
	const tick = async () => {
		try {
			const settings = await getSettings();
			const reportHour = (settings.dashbig_report_hour as string) || "09:00";

			await runDashBigReportsOnce();

			const delay = msUntilNextReport(reportHour);
			const hours = Math.round(delay / 3_600_000 * 10) / 10;
			console.log(`[dashbig-reports] Próximo envío en ${hours}h (a las ${reportHour})`);
			setTimeout(tick, delay);
		} catch (err) {
			console.error("[dashbig-reports] Error en tick:", err);
			setTimeout(tick, 60 * 60 * 1000); // retry in 1h
		}
	};

	// First run: wait until next configured hour
	(async () => {
		const settings = await getSettings();
		const reportHour = (settings.dashbig_report_hour as string) || "09:00";
		const delay = msUntilNextReport(reportHour);
		const hours = Math.round(delay / 3_600_000 * 10) / 10;
		console.log(`[dashbig-reports] Cron iniciado. Primer envío en ${hours}h (a las ${reportHour})`);
		setTimeout(tick, delay);
	})().catch(console.error);
}
