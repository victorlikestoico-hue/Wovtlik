import { createSign } from "crypto";

const SA_EMAIL = process.env.GOOGLE_SA_EMAIL ?? "";
// Railway stores newlines as literal \n in env vars
const SA_KEY   = (process.env.GOOGLE_SA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");

let _token: { value: string; expiresAt: number } | null = null;

function makeJWT(): string {
	const now = Math.floor(Date.now() / 1000);
	const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({
		iss:   SA_EMAIL,
		scope: "https://www.googleapis.com/auth/bigquery.readonly",
		aud:   "https://oauth2.googleapis.com/token",
		iat:   now,
		exp:   now + 3600,
	})).toString("base64url");
	const unsigned = `${header}.${payload}`;
	const signer   = createSign("SHA256");
	signer.update(unsigned);
	return `${unsigned}.${signer.sign(SA_KEY, "base64url")}`;
}

async function getAccessToken(): Promise<string> {
	if (_token && Date.now() < _token.expiresAt - 60_000) return _token.value;
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method:  "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body:    new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion:  makeJWT(),
		}),
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`[bq] SA token error ${res.status}: ${text.substring(0, 200)}`);
	}
	const d = await res.json() as { access_token: string; expires_in: number };
	_token = { value: d.access_token, expiresAt: Date.now() + d.expires_in * 1000 };
	console.log("[bq] Access token refreshed OK");
	return _token.value;
}

export type BQParam = {
	name:           string;
	parameterType:  { type: string };
	parameterValue: { value: string };
};

export async function runBQQuery<T extends Record<string, string | null> = Record<string, string | null>>(
	sql:       string,
	params:    BQParam[] = [],
	projectId  = "vtlik-498723",
): Promise<T[]> {
	if (!SA_EMAIL || !SA_KEY) throw new Error("[bq] GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY not set");
	const token = await getAccessToken();
	const body: Record<string, unknown> = { query: sql, useLegacySql: false, timeoutMs: 30_000 };
	if (params.length) {
		body.parameterMode   = "NAMED";
		body.queryParameters = params;
	}
	const res = await fetch(
		`https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`,
		{
			method:  "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body:    JSON.stringify(body),
			signal:  AbortSignal.timeout(35_000),
		},
	);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`[bq] Query error ${res.status}: ${text.substring(0, 300)}`);
	}
	const data = await res.json() as {
		jobComplete: boolean;
		schema?:     { fields: Array<{ name: string }> };
		rows?:       Array<{ f: Array<{ v: string | null }> }>;
	};
	if (!data.jobComplete) throw new Error("[bq] Query timed out (jobComplete=false)");
	if (!data.schema?.fields || !data.rows?.length) return [];
	const cols = data.schema.fields.map(f => f.name);
	return data.rows.map(row =>
		Object.fromEntries(cols.map((col, i) => [col, row.f[i]?.v ?? null])),
	) as T[];
}

export function isBigQueryConfigured(): boolean {
	return Boolean(SA_EMAIL && SA_KEY);
}
