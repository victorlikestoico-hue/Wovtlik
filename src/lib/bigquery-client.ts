import { createSign } from "crypto";

const SA_EMAIL = process.env.GOOGLE_SA_EMAIL ?? "";
// Railway stores newlines as literal \n in env vars
const SA_KEY   = (process.env.GOOGLE_SA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");

// Proyectos que rotan para facturar los jobs de query — mismo pool que
// dashbig/PortalEngine.gs y shared_bq_billing.py. Los 3 primeros son sandbox
// (cuota gratis mensual, se bloquean al agotarla); vtlik-498723 tiene
// facturación activa y va último, como red de seguridad que paga el
// excedente en vez de bloquearse. El índice se guarda en memoria del proceso
// y se resetea el 1er día de cada mes (la cuota gratis es mensual) — este
// server es long-running, así que sobrevive entre requests.
const BQ_BILLING_PROJECTS = [
	"bot-calendar-500321",
	"platinum-logic-490903-e1",
	"flowing-bonito-498823-i9",
	"vtlik-498723",
];

let _billingIdx = 0;
let _billingMonth = "";

function currentBillingProject(): string {
	const monthKey = new Date().toISOString().slice(0, 7);
	if (_billingMonth !== monthKey) {
		_billingMonth = monthKey;
		_billingIdx = 0;
	}
	return BQ_BILLING_PROJECTS[_billingIdx];
}

function billingSkipReason(msg: string): string | null {
	const m = msg.toLowerCase();
	if (m.includes("quota")) return "cuota agotada";
	if (m.includes("billing")) return "facturación no habilitada";
	if (m.includes("access denied") || m.includes("permission")) return "sin permiso para crear jobs";
	return null;
}

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
	projectId?: string,
): Promise<T[]> {
	if (!SA_EMAIL || !SA_KEY) throw new Error("[bq] GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY not set");
	// Si se pasa projectId explícito, se respeta tal cual (sin rotar). Si no, rota entre
	// BQ_BILLING_PROJECTS empezando por el índice activo.
	for (;;) {
		const activeProject = projectId ?? currentBillingProject();
		const token = await getAccessToken();
		const body: Record<string, unknown> = { query: sql, useLegacySql: false, timeoutMs: 30_000 };
		if (params.length) {
			body.parameterMode   = "NAMED";
			body.queryParameters = params;
		}
		const res = await fetch(
			`https://bigquery.googleapis.com/bigquery/v2/projects/${activeProject}/queries`,
			{
				method:  "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body:    JSON.stringify(body),
				signal:  AbortSignal.timeout(35_000),
			},
		);
		if (!res.ok) {
			const text = await res.text();
			const reason = !projectId ? billingSkipReason(text) : null;
			if (reason && _billingIdx < BQ_BILLING_PROJECTS.length - 1) {
				console.warn(`[bq] ${activeProject} no disponible (${reason}), avanzando al siguiente proyecto de facturación.`);
				_billingIdx += 1;
				continue;
			}
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
}

export function isBigQueryConfigured(): boolean {
	return Boolean(SA_EMAIL && SA_KEY);
}
