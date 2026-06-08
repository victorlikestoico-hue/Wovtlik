import { runBQQuery, isBigQueryConfigured, type BQParam } from "./bigquery-client.ts";

const BQ_PROJECT = "vtlik-498723";
const BQ_DATASET = "reporting_looker";
const VIEW_360   = `\`${BQ_PROJECT}.${BQ_DATASET}.vw_agent_performance_360\``;
const TABLE_GA   = `\`${BQ_PROJECT}.${BQ_DATASET}.raw_data_gestion_adecuada\``;

// ── Agent email normalization (mirrors GAS PortalEngine.gs) ──────────────────
// Strips domain, suffixes (_ndo, .ext, etc.), and non-alphanumeric chars
function normExpr(col: string): string {
	return `REGEXP_REPLACE(REGEXP_REPLACE(LOWER(SPLIT(${col}, '@')[OFFSET(0)]), r'(_ndo|\\.ext|ndoext|extndo|\\.v)$', ''), r'[^a-z0-9]', '')`;
}

function agentFilter(): string {
	return `${normExpr("Agente")} = ${normExpr("@agent")}`;
}

function agentParam(email: string): BQParam {
	return { name: "agent", parameterType: { type: "STRING" }, parameterValue: { value: email } };
}

function dateParam(name: string, value: string): BQParam {
	return { name, parameterType: { type: "DATE" }, parameterValue: { value } };
}

function strParam(name: string, value: string): BQParam {
	return { name, parameterType: { type: "STRING" }, parameterValue: { value } };
}

function toFloat(v: string | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	const n = parseFloat(v);
	return isNaN(n) ? null : n;
}

// Objectives: read from LOB_OBJECTIVES env var (JSON) or return empty.
// Set LOB_OBJECTIVES={"PDI":{"csat":{"target":0.9,"condition":">="},...}} in Railway.
function getLOBObjectives(): Record<string, Record<string, { target: number; condition: string }>> {
	try {
		const raw = process.env.LOB_OBJECTIVES ?? "";
		if (raw) return JSON.parse(raw);
	} catch {}
	return {};
}

// ── Public types ──────────────────────────────────────────────────────────────
export type DashBigCaseResult = {
	ok: true;
	cr3: string | null;
	lob: string | null;
	agentEmail: string | null;
	fecha: string | null;
};

export type DashBigAgentMetrics = {
	ok: true;
	agent: string;
	mode: string;
	period: { start: string; end: string };
	lob: string | null;
	leader: string | null;
	metrics: {
		csat: number | null;
		aht_seconds: number | null;
		ga_critica: number | null;
		apego: number | null;
		productivity: number | null;
		total_interactions: number;
		surveys_count: number;
	};
	objectives: Record<string, { target: number; condition: string }>;
};

export type DashBigTeamSnapshot = {
	ok: true;
	period?: { start: string; end: string };
	date?: string;
	lob: string;
	agents: Array<{
		Agente: string;
		lob: string | null;
		team_leader: string | null;
		csat: string | null;
		aht_seconds: string | null;
		ga_critica: string | null;
		apego: string | null;
		productivity: string | null;
		total_interactions: string | null;
	}>;
	objectives: Record<string, Record<string, { target: number; condition: string }>>;
};

// ── Aggregation columns shared by agent/team queries ─────────────────────────
const AGG_COLS = `
	ANY_VALUE(lob)          AS lob,
	ANY_VALUE(team_leader)  AS team_leader,
	SAFE_DIVIDE(SUM(ROUND(csat_pct * surveys_count)), SUM(surveys_count)) AS csat,
	SAFE_DIVIDE(SUM(aht_sum),        SUM(aht_count))        AS aht_seconds,
	SAFE_DIVIDE(SUM(ga_critica_sum), SUM(ga_critica_count)) AS ga_critica,
	AVG(apego_score)        AS apego,
	AVG(productivity_score) AS productivity,
	SUM(total_interactions) AS total_interactions,
	SUM(surveys_count)      AS surveys_count,
	CAST(MIN(Date) AS STRING) AS date_from,
	CAST(MAX(Date) AS STRING) AS date_to
`;

// ── Public API ─────────────────────────────────────────────────────────────────

export async function lookupCase(caseId: string): Promise<DashBigCaseResult | null> {
	if (!isBigQueryConfigured()) return null;
	try {
		const rows = await runBQQuery(
			`SELECT Agente AS agentEmail, BPO AS bpo, CAST(Fecha AS STRING) AS fecha,
			        Case_reason_Lvl_3 AS cr3, CRR3_SALIDA AS cr3_salida
			 FROM ${TABLE_GA}
			 WHERE Case_ID_Logios = @caseId
			 ORDER BY Fecha DESC LIMIT 1`,
			[{ name: "caseId", parameterType: { type: "STRING" }, parameterValue: { value: caseId } }],
		);
		if (!rows.length) return null;

		const row        = rows[0];
		const cr3        = (row.cr3_salida && row.cr3_salida !== "-") ? row.cr3_salida : (row.cr3 ?? null);
		const agentEmail = row.agentEmail ?? null;

		let lob: string | null = null;
		if (agentEmail) {
			try {
				const lobRows = await runBQQuery(
					`SELECT lob FROM ${VIEW_360} WHERE ${agentFilter()} AND lob IS NOT NULL LIMIT 1`,
					[agentParam(agentEmail)],
				);
				if (lobRows.length) lob = lobRows[0].lob ?? null;
			} catch {}
		}

		return { ok: true, cr3, lob, agentEmail, fecha: row.fecha ?? null };
	} catch (err) {
		console.error("[dashbig] lookupCase error:", err);
		return null;
	}
}

export async function getAgentMetrics(
	agentEmail: string,
	mode: "mtd" | "latest" = "mtd",
): Promise<DashBigAgentMetrics | null> {
	if (!isBigQueryConfigured()) return null;
	try {
		const filter   = agentFilter();
		const fromWhere = `FROM ${VIEW_360} WHERE ${filter}`;

		// Find latest date with data for this agent
		const maxRows = await runBQQuery(
			`SELECT CAST(MAX(Date) AS STRING) AS d ${fromWhere} AND total_interactions > 0`,
			[agentParam(agentEmail)],
		);
		if (!maxRows.length || !maxRows[0].d) return null;

		const end = maxRows[0].d as string;
		let start: string;
		if (mode === "latest") {
			start = end;
		} else {
			const d = new Date(end + "T12:00:00Z");
			start = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
		}

		const aggRows = await runBQQuery(
			`SELECT ${AGG_COLS} ${fromWhere} AND CAST(Date AS DATE) BETWEEN @start AND @end`,
			[dateParam("start", start), dateParam("end", end), agentParam(agentEmail)],
		);
		if (!aggRows.length || aggRows[0].total_interactions == null) return null;

		const r   = aggRows[0];
		const lob = r.lob ?? null;
		const allObjectives = getLOBObjectives();
		const objectives    = lob && allObjectives[lob] ? allObjectives[lob] : {};

		return {
			ok: true, agent: agentEmail, mode,
			period: { start: r.date_from ?? start, end: r.date_to ?? end },
			lob, leader: r.team_leader ?? null,
			metrics: {
				csat:               toFloat(r.csat),
				aht_seconds:        toFloat(r.aht_seconds),
				ga_critica:         toFloat(r.ga_critica),
				apego:              toFloat(r.apego),
				productivity:       toFloat(r.productivity),
				total_interactions: parseInt(r.total_interactions ?? "0") || 0,
				surveys_count:      parseInt(r.surveys_count ?? "0") || 0,
			},
			objectives,
		};
	} catch (err) {
		console.error("[dashbig] getAgentMetrics error:", err);
		return null;
	}
}

export async function getDailyReport(lob: string, date?: string): Promise<DashBigTeamSnapshot | null> {
	if (!isBigQueryConfigured()) return null;
	try {
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
		const reportDate = date || yesterday;

		let sql = `
			SELECT Agente, lob, team_leader,
				SAFE_DIVIDE(SUM(ROUND(csat_pct * surveys_count)), SUM(surveys_count)) AS csat,
				SAFE_DIVIDE(SUM(aht_sum), SUM(aht_count)) AS aht_seconds,
				SAFE_DIVIDE(SUM(ga_critica_sum), SUM(ga_critica_count)) AS ga_critica,
				AVG(apego_score) AS apego,
				SUM(total_interactions) AS total_interactions,
				SUM(surveys_count) AS surveys_count
			FROM ${VIEW_360}
			WHERE CAST(Date AS DATE) = @date
		`;
		const params: BQParam[] = [dateParam("date", reportDate)];
		if (lob !== "all") {
			sql += " AND lob = @lob";
			params.push(strParam("lob", lob));
		}
		sql += " GROUP BY Agente, lob, team_leader ORDER BY csat DESC NULLS LAST LIMIT 500";

		const agents = await runBQQuery(sql, params);
		return { ok: true, date: reportDate, lob, agents: agents as DashBigTeamSnapshot["agents"], objectives: getLOBObjectives() };
	} catch (err) {
		console.error("[dashbig] getDailyReport error:", err);
		return null;
	}
}

export async function getTeamSnapshot(lob = "all"): Promise<DashBigTeamSnapshot | null> {
	if (!isBigQueryConfigured()) return null;
	try {
		const now   = new Date();
		const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
		const end   = now.toISOString().split("T")[0];

		let sql = `
			SELECT Agente, lob, team_leader,
				SAFE_DIVIDE(SUM(ROUND(csat_pct * surveys_count)), SUM(surveys_count)) AS csat,
				SAFE_DIVIDE(SUM(aht_sum), SUM(aht_count)) AS aht_seconds,
				SAFE_DIVIDE(SUM(ga_critica_sum), SUM(ga_critica_count)) AS ga_critica,
				AVG(apego_score) AS apego,
				AVG(productivity_score) AS productivity,
				SUM(total_interactions) AS total_interactions
			FROM ${VIEW_360}
			WHERE CAST(Date AS DATE) BETWEEN @start AND @end
		`;
		const params: BQParam[] = [dateParam("start", start), dateParam("end", end)];
		if (lob !== "all") {
			sql += " AND lob = @lob";
			params.push(strParam("lob", lob));
		}
		sql += " GROUP BY Agente, lob, team_leader ORDER BY csat DESC NULLS LAST LIMIT 500";

		const agents = await runBQQuery(sql, params);
		return { ok: true, period: { start, end }, lob, agents: agents as DashBigTeamSnapshot["agents"], objectives: getLOBObjectives() };
	} catch (err) {
		console.error("[dashbig] getTeamSnapshot error:", err);
		return null;
	}
}

export { isBigQueryConfigured as isDashBigConfigured };
