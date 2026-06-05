const DASHBIG_URL = process.env.DASHBIG_WEBAPP_URL ?? "";
const DASHBIG_KEY = process.env.DASHBIG_API_KEY ?? "";

function isDashBigConfigured(): boolean {
	return Boolean(DASHBIG_URL && DASHBIG_KEY);
}

async function callDashBig(
	action: string,
	params: Record<string, string>,
): Promise<unknown | null> {
	if (!isDashBigConfigured()) return null;
	try {
		const url = new URL(DASHBIG_URL);
		url.searchParams.set("action", action);
		url.searchParams.set("apiKey", DASHBIG_KEY);
		for (const [k, v] of Object.entries(params)) {
			if (v) url.searchParams.set(k, v);
		}
		const res = await fetch(url.toString(), { signal: AbortSignal.timeout(20_000) });
		if (!res.ok) return null;
		return res.json();
	} catch (err) {
		console.error(`[dashbig] Error calling action=${action}:`, err);
		return null;
	}
}

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
	period: { start: string; end: string };
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

export async function lookupCase(caseId: string): Promise<DashBigCaseResult | null> {
	const data = (await callDashBig("issueLookup", { caseId })) as any;
	if (!data?.ok) return null;
	return data as DashBigCaseResult;
}

export async function getAgentMetrics(
	agentEmail: string,
	startDate?: string,
	endDate?: string,
): Promise<DashBigAgentMetrics | null> {
	const params: Record<string, string> = { agent: agentEmail };
	if (startDate) params.startDate = startDate;
	if (endDate) params.endDate = endDate;
	const data = (await callDashBig("getAgentMetrics", params)) as any;
	if (!data?.ok) return null;
	return data as DashBigAgentMetrics;
}

export async function getDailyReport(
	lob: string,
	date?: string,
): Promise<DashBigTeamSnapshot | null> {
	const params: Record<string, string> = { lob };
	if (date) params.date = date;
	const data = (await callDashBig("getDailyReport", params)) as any;
	if (!data?.ok) return null;
	return data as DashBigTeamSnapshot;
}

export async function getTeamSnapshot(lob = "all"): Promise<DashBigTeamSnapshot | null> {
	const data = (await callDashBig("getTeamSnapshot", { lob })) as any;
	if (!data?.ok) return null;
	return data as DashBigTeamSnapshot;
}

export { isDashBigConfigured };
