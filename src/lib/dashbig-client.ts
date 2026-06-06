const DASHBIG_URL = process.env.DASHBIG_WEBAPP_URL ?? "";
const DASHBIG_KEY = process.env.DASHBIG_API_KEY ?? "";

const G_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     ?? "";
const G_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const G_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN ?? "";

function isDashBigConfigured(): boolean {
	return Boolean(DASHBIG_URL && DASHBIG_KEY);
}

// ── Google OAuth2 access token cache ─────────────────────────────────────────
let _cachedToken: { value: string; expiresAt: number } | null = null;

async function getGoogleAccessToken(): Promise<string | null> {
	if (!G_CLIENT_ID || !G_CLIENT_SECRET || !G_REFRESH_TOKEN) return null;
	if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
		return _cachedToken.value;
	}
	try {
		const res = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id:     G_CLIENT_ID,
				client_secret: G_CLIENT_SECRET,
				refresh_token: G_REFRESH_TOKEN,
				grant_type:    "refresh_token",
			}),
			signal: AbortSignal.timeout(10_000),
		});
		const text = await res.text();
		if (!res.ok) {
			console.error("[dashbig] Google token refresh failed:", res.status, text.substring(0, 200));
			return null;
		}
		const data = JSON.parse(text) as { access_token: string; expires_in: number };
		_cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
		console.log("[dashbig] Google access token refreshed OK");
		return _cachedToken.value;
	} catch (err) {
		console.error("[dashbig] Google token refresh error:", err);
		return null;
	}
}

// ── Core HTTP caller ──────────────────────────────────────────────────────────
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

		const headers: Record<string, string> = {};
		const accessToken = await getGoogleAccessToken();
		if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

		const res = await fetch(url.toString(), {
			headers,
			signal: AbortSignal.timeout(30_000),
		});
		const text = await res.text();
		if (!res.ok || text.trimStart().startsWith("<")) {
			console.error(`[dashbig] action=${action} returned non-JSON (status=${res.status}):`, text.substring(0, 300));
			return null;
		}
		return JSON.parse(text);
	} catch (err) {
		console.error(`[dashbig] Error calling action=${action}:`, err);
		return null;
	}
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

// ── Public API functions ──────────────────────────────────────────────────────
export async function lookupCase(caseId: string): Promise<DashBigCaseResult | null> {
	const data = (await callDashBig("issueLookup", { caseId })) as any;
	if (!data?.ok) return null;
	return data as DashBigCaseResult;
}

export async function getAgentMetrics(
	agentEmail: string,
	mode: "mtd" | "latest" = "mtd",
	startDate?: string,
	endDate?: string,
): Promise<DashBigAgentMetrics | null> {
	const params: Record<string, string> = { agent: agentEmail, mode };
	if (startDate) params.startDate = startDate;
	if (endDate) params.endDate = endDate;
	const data = (await callDashBig("getAgentMetrics", params)) as any;
	if (!data?.ok) return null;
	return data as DashBigAgentMetrics;
}

export async function getDailyReport(lob: string, date?: string): Promise<DashBigTeamSnapshot | null> {
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
