import { createSign } from "crypto";

const SA_EMAIL = process.env.GOOGLE_SA_EMAIL ?? "";
const SA_KEY   = (process.env.GOOGLE_SA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");

let _token: { value: string; expiresAt: number } | null = null;

const SHEET_NAME = "Presentismo Equipo1";

function makeJWT(): string {
	const now = Math.floor(Date.now() / 1000);
	const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({
		iss:   SA_EMAIL,
		scope: "https://www.googleapis.com/auth/spreadsheets",
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function colIndexToLetter(index: number): string {
	let letter = "";
	let n = index;
	do {
		letter = String.fromCharCode(65 + (n % 26)) + letter;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return letter;
}

/** Normalize any date string to YYYY-MM-DD for comparison */
function normalizeFecha(fecha: string): string {
	// DD/MM/YYYY
	let m = fecha.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
	// DD-MM-YYYY
	m = fecha.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
	if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
	return fecha; // already YYYY-MM-DD or unknown
}

/** Parse "HH:mm - HH:mm" or "HH:mm-HH:mm" → minutes from midnight */
function parseHorario(horario: string): { start: number; end: number } | null {
	const m = horario.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
	if (!m) return null;
	return {
		start: parseInt(m[1]) * 60 + parseInt(m[2]),
		end:   parseInt(m[3]) * 60 + parseInt(m[4]),
	};
}

/** Today's date in YYYY-MM-DD using Argentina timezone (UTC-3) */
function todayAR(): string {
	return new Date(
		new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }),
	).toISOString().slice(0, 10);
}

/** Current time in minutes from midnight, Argentina timezone */
function currentMinutesAR(): number {
	const d = new Date(
		new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }),
	);
	return d.getHours() * 60 + d.getMinutes();
}

// ─── Sheet read (with row indices) ────────────────────────────────────────────

type RawSheet = {
	headers: string[];
	rows: Array<{ rowIndex: number; cells: string[] }>; // rowIndex is 1-based spreadsheet row
};

async function readSheetRaw(spreadsheetId: string): Promise<RawSheet> {
	const token = await getAccessToken();
	const range = encodeURIComponent(SHEET_NAME);
	const res   = await fetch(
		`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
		{ headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
	);
	if (!res.ok) throw new Error(`[sheets] Read error ${res.status}: ${(await res.text()).substring(0, 200)}`);
	const data = await res.json() as { values?: string[][] };
	if (!data.values || data.values.length < 2) return { headers: [], rows: [] };
	const [rawHeaders, ...dataRows] = data.values;
	return {
		headers: rawHeaders.map(h => h.trim()),
		rows: dataRows.map((cells, i) => ({
			rowIndex: i + 2, // +1 for header row + 1 for 1-based index
			cells:    cells.map(c => (c ?? "").trim()),
		})),
	};
}

// ─── Sheet write ──────────────────────────────────────────────────────────────

async function updateCell(
	spreadsheetId: string,
	rowNumber: number,
	colIndex: number,
	value: string,
): Promise<void> {
	const token = await getAccessToken();
	const col   = colIndexToLetter(colIndex);
	const range = encodeURIComponent(`'${SHEET_NAME}'!${col}${rowNumber}`);
	const res   = await fetch(
		`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
		{
			method:  "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body:    JSON.stringify({ values: [[value]] }),
			signal:  AbortSignal.timeout(10_000),
		},
	);
	if (!res.ok) throw new Error(`[sheets] Write error ${res.status}: ${(await res.text()).substring(0, 200)}`);
}

// ─── Public API ───────────────────────────────────────────────────────────────

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
			const { headers, rows } = await readSheetRaw(id);
			const emailCol   = headers.findIndex(h => /^email$/i.test(h));
			const fechaCol   = headers.findIndex(h => /^fecha$/i.test(h));
			const horarioCol = headers.findIndex(h => /^horario\s*roster$/i.test(h));
			const estadoCol  = headers.findIndex(h => /^estado$/i.test(h));
			const novedCol   = headers.findIndex(h => /^novedades$/i.test(h));
			if (emailCol < 0 || fechaCol < 0) continue;
			for (const { cells } of rows) {
				if ((cells[emailCol] ?? "").toLowerCase() !== emailNorm) continue;
				results.push({
					fecha:     cells[fechaCol]   ?? "",
					horario:   horarioCol >= 0 ? (cells[horarioCol] ?? "") : "",
					estado:    estadoCol  >= 0 ? (cells[estadoCol]  ?? "") : "",
					novedades: novedCol   >= 0 ? (cells[novedCol]   ?? "") : "",
				});
			}
		} catch (err) {
			console.error(`[sheets] Error reading sheet ${id}:`, err);
		}
	}

	results.sort((a, b) => normalizeFecha(a.fecha).localeCompare(normalizeFecha(b.fecha)));
	return results;
}

export type AbsenceClearResult =
	| { success: true;  fecha: string; horario: string }
	| { success: false; reason: "no_sa" | "not_found" | "error"; message: string };

export async function clearAgentAbsence(
	agentEmail:     string,
	spreadsheetIds: string[],
): Promise<AbsenceClearResult> {
	if (!SA_EMAIL || !SA_KEY) return { success: false, reason: "no_sa", message: "Service account not configured" };

	const emailNorm = agentEmail.trim().toLowerCase();
	const today     = todayAR();
	const nowMin    = currentMinutesAR();

	for (const id of spreadsheetIds) {
		if (!id) continue;
		try {
			const { headers, rows } = await readSheetRaw(id);
			const emailCol   = headers.findIndex(h => /^email$/i.test(h));
			const fechaCol   = headers.findIndex(h => /^fecha$/i.test(h));
			const horarioCol = headers.findIndex(h => /^horario\s*roster$/i.test(h));
			const estadoCol  = headers.findIndex(h => /^estado$/i.test(h));
			if (emailCol < 0 || fechaCol < 0 || estadoCol < 0) continue;

			// Find rows: same agent, same date (today), marked as absent
			const candidates = rows.filter(({ cells }) => {
				const rowEmail  = (cells[emailCol]  ?? "").toLowerCase();
				const rowFecha  = normalizeFecha(cells[fechaCol] ?? "");
				const rowEstado = (cells[estadoCol] ?? "").toLowerCase();
				return rowEmail === emailNorm && rowFecha === today && rowEstado.includes("ausente");
			});

			if (candidates.length === 0) continue;

			// Multiple shifts on same day → pick closest start time to now
			let target = candidates[0];
			if (candidates.length > 1 && horarioCol >= 0) {
				target = candidates.reduce((best, row) => {
					const parsed    = parseHorario(row.cells[horarioCol] ?? "");
					const bestParsed = parseHorario(best.cells[horarioCol] ?? "");
					if (!parsed) return best;
					if (!bestParsed) return row;
					return Math.abs(parsed.start - nowMin) < Math.abs(bestParsed.start - nowMin) ? row : best;
				});
			}

			await updateCell(id, target.rowIndex, estadoCol, "");

			return {
				success: true,
				fecha:   target.cells[fechaCol]                      ?? today,
				horario: horarioCol >= 0 ? (target.cells[horarioCol] ?? "") : "",
			};
		} catch (err) {
			console.error(`[sheets] Error clearing absence in sheet ${id}:`, err);
			return { success: false, reason: "error", message: String(err) };
		}
	}

	return { success: false, reason: "not_found", message: "No se encontró ausente para hoy" };
}
