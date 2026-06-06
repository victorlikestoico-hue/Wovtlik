import { createSign } from "crypto";

const SA_EMAIL = process.env.GOOGLE_SA_EMAIL ?? "";
const SA_KEY   = (process.env.GOOGLE_SA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");

let _token: { value: string; expiresAt: number } | null = null;

function makeJWT(): string {
	const now = Math.floor(Date.now() / 1000);
	const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({
		iss:   SA_EMAIL,
		scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
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
	if (!res.ok) throw new Error(`[sheets] SA token error ${res.status}: ${(await res.text()).substring(0, 200)}`);
	const d = await res.json() as { access_token: string; expires_in: number };
	_token = { value: d.access_token, expiresAt: Date.now() + d.expires_in * 1000 };
	return _token.value;
}

type SheetRow = Record<string, string>;

async function readSheet(spreadsheetId: string, sheetName = "Presentismo Equipo1"): Promise<SheetRow[]> {
	const token = await getAccessToken();
	const range = encodeURIComponent(sheetName);
	const res   = await fetch(
		`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
		{
			headers: { Authorization: `Bearer ${token}` },
			signal:  AbortSignal.timeout(15_000),
		},
	);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`[sheets] Read error ${res.status}: ${text.substring(0, 200)}`);
	}
	const data = await res.json() as { values?: string[][] };
	if (!data.values || data.values.length < 2) return [];
	const [headers, ...rows] = data.values;
	return rows.map(row =>
		Object.fromEntries(headers.map((h, i) => [h.trim(), (row[i] ?? "").trim()])),
	);
}

export type AgentShift = {
	fecha: string;
	horario: string;
	estado: string;
	novedades: string;
};

export async function getAgentSchedule(
	agentEmail:     string,
	spreadsheetIds: string[],
): Promise<AgentShift[]> {
	if (!SA_EMAIL || !SA_KEY) return [];
	const emailNorm = agentEmail.trim().toLowerCase();
	const results: AgentShift[] = [];

	for (const id of spreadsheetIds) {
		if (!id) continue;
		try {
			const rows = await readSheet(id);
			for (const row of rows) {
				const rowEmail = (row["Email"] ?? row["email"] ?? "").toLowerCase();
				if (rowEmail !== emailNorm) continue;
				results.push({
					fecha:    row["Fecha"]          ?? "",
					horario:  row["Horario Roster"] ?? row["Horario"] ?? "",
					estado:   row["Estado"]         ?? "",
					novedades: row["Novedades"]     ?? "",
				});
			}
		} catch (err) {
			console.error(`[sheets] Error reading sheet ${id}:`, err);
		}
	}

	// Sort by fecha ascending
	results.sort((a, b) => a.fecha.localeCompare(b.fecha));
	return results;
}
