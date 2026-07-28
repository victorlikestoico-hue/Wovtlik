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
export function normalizeFecha(fecha: string): string {
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

async function readNamedSheetRaw(spreadsheetId: string, sheetName: string): Promise<RawSheet> {
	const token = await getAccessToken();
	const range = encodeURIComponent(sheetName);
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

async function readSheetRaw(spreadsheetId: string): Promise<RawSheet> {
	return readNamedSheetRaw(spreadsheetId, SHEET_NAME);
}

/** Lee una hoja por su GID (sheetId numérico) resolviendo primero el nombre via metadata. */
export async function readSheetByGid(spreadsheetId: string, gid: string): Promise<RawSheet> {
	const token = await getAccessToken();
	const metaRes = await fetch(
		`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
		{ headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
	);
	if (!metaRes.ok) throw new Error(`[sheets] Metadata error ${metaRes.status}: ${(await metaRes.text()).substring(0, 200)}`);
	const meta = await metaRes.json() as { sheets: Array<{ properties: { sheetId: number; title: string } }> };
	const sheet = meta.sheets.find((s) => String(s.properties.sheetId) === gid);
	if (!sheet) throw new Error(`[sheets] No se encontró una hoja con GID ${gid}`);
	return readNamedSheetRaw(spreadsheetId, sheet.properties.title);
}

// ─── Sheet write ──────────────────────────────────────────────────────────────

async function updateNamedCell(
	spreadsheetId: string,
	sheetName: string,
	rowNumber: number,
	colIndex: number,
	// Las columnas tipo checkbox (ej. "Asistencia") necesitan un booleano real —
	// si se manda el texto "TRUE" se ve como texto superpuesto al cuadrito, no como
	// el cuadrito tildado.
	value: string | boolean,
): Promise<void> {
	const token = await getAccessToken();
	const col   = colIndexToLetter(colIndex);
	const range = encodeURIComponent(`'${sheetName}'!${col}${rowNumber}`);
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

async function updateCell(
	spreadsheetId: string,
	rowNumber: number,
	colIndex: number,
	value: string | boolean,
): Promise<void> {
	return updateNamedCell(spreadsheetId, SHEET_NAME, rowNumber, colIndex, value);
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

export type AbsenceEntry = { fecha: string; horario: string };

export type AbsenceClearResult =
	| { success: true;  fecha: string; horario: string }
	| { success: false; reason: "no_sa" | "not_found" | "error"; message: string }
	| { success: false; reason: "multiple"; absences: AbsenceEntry[] }
	| { success: false; reason: "ctt_ceded"; fecha: string; horario: string };

/**
 * Clear an "Ausente" entry for an agent.
 *
 * - targetDate (YYYY-MM-DD): filter to a specific date; required when the agent
 *   has absences on more than one day.
 * - When targetDate is provided and the agent has multiple shifts that day,
 *   the one whose start time is closest to the current Argentina time is used.
 * - When targetDate is omitted and only one absence exists across all sheets,
 *   it is removed immediately.
 * - When targetDate is omitted and multiple dates have absences, returns
 *   reason "multiple" with the list so the caller can ask the agent to pick.
 */
export async function clearAgentAbsence(
	agentEmail:     string,
	spreadsheetIds: string[],
	targetDate?:    string, // YYYY-MM-DD
): Promise<AbsenceClearResult> {
	if (!SA_EMAIL || !SA_KEY) return { success: false, reason: "no_sa", message: "Service account not configured" };

	const emailNorm = agentEmail.trim().toLowerCase();
	const nowMin    = currentMinutesAR();

	type Candidate = {
		sheetId:       string;
		rowIndex:      number;
		estadoCol:     number;
		asistenciaCol: number; // -1 si la planilla no tiene esa columna
		fecha:         string; // raw from sheet
		horario:       string;
		fechaNorm:     string; // YYYY-MM-DD
		cedida:        boolean; // Novedades contiene "ctt" → el agente cedió el turno completo
	};

	const all: Candidate[] = [];

	for (const id of spreadsheetIds) {
		if (!id) continue;
		try {
			const { headers, rows } = await readSheetRaw(id);
			const emailCol       = headers.findIndex(h => /^email$/i.test(h));
			const fechaCol       = headers.findIndex(h => /^fecha$/i.test(h));
			const horarioCol     = headers.findIndex(h => /^horario\s*roster$/i.test(h));
			const estadoCol      = headers.findIndex(h => /^estado$/i.test(h));
			const asistenciaCol  = headers.findIndex(h => /^asistencia$/i.test(h));
			const novedCol       = headers.findIndex(h => /^novedades$/i.test(h));
			if (emailCol < 0 || fechaCol < 0 || estadoCol < 0) continue;

			for (const { rowIndex, cells } of rows) {
				const rowEmail  = (cells[emailCol]  ?? "").toLowerCase();
				const rowEstado = (cells[estadoCol] ?? "").toLowerCase();
				if (rowEmail !== emailNorm) continue;
				if (!rowEstado.includes("ausente")) continue;
				const rawFecha = cells[fechaCol] ?? "";
				const rowNoved = novedCol >= 0 ? (cells[novedCol] ?? "").toLowerCase() : "";
				all.push({
					sheetId:   id,
					rowIndex,
					estadoCol,
					asistenciaCol,
					fecha:     rawFecha,
					horario:   horarioCol >= 0 ? (cells[horarioCol] ?? "") : "",
					fechaNorm: normalizeFecha(rawFecha),
					cedida:    rowNoved.includes("ctt"),
				});
			}
		} catch (err) {
			console.error(`[sheets] Error reading sheet ${id}:`, err);
			return { success: false, reason: "error", message: String(err) };
		}
	}

	if (all.length === 0) {
		return { success: false, reason: "not_found", message: "No se encontraron ausentes registrados" };
	}

	// Filter by targetDate if provided
	let candidates = targetDate
		? all.filter(c => c.fechaNorm === targetDate)
		: all;

	if (candidates.length === 0) {
		return { success: false, reason: "not_found", message: "No se encontró ausente para esa fecha" };
	}

	// Las ausencias marcadas con "ctt" en Novedades corresponden a un turno cedido por completo
	// por el agente — no son un error del sistema, así que nunca se auto-eliminan.
	const cedidas = candidates.filter(c => c.cedida);
	candidates = candidates.filter(c => !c.cedida);
	if (candidates.length === 0) {
		const c = cedidas[0];
		return c
			? { success: false, reason: "ctt_ceded", fecha: c.fecha, horario: c.horario }
			: { success: false, reason: "not_found", message: "No se encontró ausente para esa fecha" };
	}

	// If no date was specified and there are absences on more than one distinct day → ask
	if (!targetDate) {
		const uniqueDays = new Set(candidates.map(c => c.fechaNorm));
		if (uniqueDays.size > 1) {
			return {
				success: false,
				reason:  "multiple",
				absences: candidates.map(c => ({ fecha: c.fecha, horario: c.horario })),
			};
		}
	}

	// Single date → pick by closest horario start time when there are ties
	let target = candidates[0];
	if (candidates.length > 1) {
		target = candidates.reduce((best, row) => {
			const parsed     = parseHorario(row.horario);
			const bestParsed = parseHorario(best.horario);
			if (!parsed) return best;
			if (!bestParsed) return row;
			return Math.abs(parsed.start - nowMin) < Math.abs(bestParsed.start - nowMin) ? row : best;
		});
	}

	try {
		await updateCell(target.sheetId, target.rowIndex, target.estadoCol, "");
		// Al corregir la ausencia también se marca el check de Asistencia (booleano real,
		// la columna es un checkbox en la planilla — no escribir el texto "TRUE").
		if (target.asistenciaCol >= 0) {
			await updateCell(target.sheetId, target.rowIndex, target.asistenciaCol, true);
		}
	} catch (err) {
		console.error(`[sheets] Error clearing absence:`, err);
		return { success: false, reason: "error", message: String(err) };
	}

	return { success: true, fecha: target.fecha, horario: target.horario };
}

const ABSENCE_REMOVAL_LOG_TAB = "eliminacion de ausencia";
const ABSENCE_REMOVAL_LOG_HEADERS = ["timestamp", "email", "fecha", "horario", "motivo"];

/**
 * Registra en la planilla del Monitor (la misma de offline_queue_sheet_id, tab "pending_offline")
 * quién, qué día y por qué se le eliminó una ausencia — casi siempre porque se conectó tarde,
 * no por un error real de la programación. La pestaña "eliminacion de ausencia" debe existir
 * de antemano ahí; esta función solo escribe el encabezado si está vacía (igual que queueAgentOffline).
 */
export async function logAbsenceRemoval(
	spreadsheetId: string,
	email:         string,
	fecha:         string,
	horario:       string,
	motivo:        string,
): Promise<void> {
	if (!SA_EMAIL || !SA_KEY || !spreadsheetId) return;
	try {
		const token = await getAccessToken();

		const checkRange = encodeURIComponent(`'${ABSENCE_REMOVAL_LOG_TAB}'!A1:E1`);
		const checkRes = await fetch(
			`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${checkRange}`,
			{ headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
		);
		if (checkRes.ok) {
			const checkData = await checkRes.json() as { values?: string[][] };
			if (!checkData.values?.length) {
				await fetch(
					`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${checkRange}?valueInputOption=RAW`,
					{
						method:  "PUT",
						headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
						body:    JSON.stringify({ values: [ABSENCE_REMOVAL_LOG_HEADERS] }),
						signal:  AbortSignal.timeout(10_000),
					},
				);
			}
		}

		const appendRange = encodeURIComponent(`'${ABSENCE_REMOVAL_LOG_TAB}'!A:E`);
		const res = await fetch(
			`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
			{
				method:  "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body:    JSON.stringify({ values: [[new Date().toISOString(), email, fecha, horario, motivo]] }),
				signal:  AbortSignal.timeout(10_000),
			},
		);
		if (!res.ok) {
			console.error(`[sheets] logAbsenceRemoval error ${res.status}:`, await res.text());
		}
	} catch (err) {
		console.error("[sheets] Error registrando la eliminación de ausencia:", err);
	}
}

const OFFLINE_QUEUE_TAB = "pending_offline";
// lob y tl_reaction_seconds van al final (columnas F/G) para no romper el layout A-E que
// el Monitor externo (fuera de este repo) lee por posición.
const OFFLINE_QUEUE_HEADERS = ["timestamp", "email", "reason", "status", "result", "lob", "tl_reaction_seconds"];
const TL_REACTION_SECONDS_COL = 6; // columna G — mantener sincronizado con OFFLINE_QUEUE_HEADERS

async function ensurePendingOfflineHeader(token: string, spreadsheetId: string): Promise<void> {
	const checkRange = encodeURIComponent(`'${OFFLINE_QUEUE_TAB}'!A1:G1`);
	const checkRes = await fetch(
		`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${checkRange}`,
		{ headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
	);
	if (!checkRes.ok) return;
	const checkData = await checkRes.json() as { values?: string[][] };
	if (checkData.values?.length) return;
	await fetch(
		`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${checkRange}?valueInputOption=RAW`,
		{
			method:  "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body:    JSON.stringify({ values: [OFFLINE_QUEUE_HEADERS] }),
			signal:  AbortSignal.timeout(10_000),
		},
	);
}

/** Extrae el número de fila 1-based de un `updatedRange` tipo "'pending_offline'!A15:G15". */
function parseRowFromUpdatedRange(updatedRange: string | undefined): number | null {
	if (!updatedRange) return null;
	const m = updatedRange.match(/![A-Z]+(\d+)/);
	return m ? parseInt(m[1], 10) : null;
}

async function appendPendingOfflineRow(
	spreadsheetId: string,
	row:           [string, string, string, string, string, string, string],
): Promise<{ ok: boolean; row: number | null }> {
	const token = await getAccessToken();
	await ensurePendingOfflineHeader(token, spreadsheetId);

	const appendRange = encodeURIComponent(`'${OFFLINE_QUEUE_TAB}'!A:G`);
	const res = await fetch(
		`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
		{
			method:  "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body:    JSON.stringify({ values: [row] }),
			signal:  AbortSignal.timeout(10_000),
		},
	);
	if (!res.ok) {
		console.error(`[sheets] appendPendingOfflineRow error ${res.status}:`, await res.text());
		return { ok: false, row: null };
	}
	const data = await res.json() as { updates?: { updatedRange?: string } };
	return { ok: true, row: parseRowFromUpdatedRange(data.updates?.updatedRange) };
}

/**
 * Encola una solicitud de cambio a OFFLINE en la planilla del Monitor.
 * La fila queda en status="pending" y el Monitor la procesa en el próximo ciclo (~1-3 min).
 */
export async function queueAgentOffline(
	email:         string,
	reason:        string,
	spreadsheetId: string,
	lob?:          string,
): Promise<{ ok: boolean; row: number | null }> {
	if (!SA_EMAIL || !SA_KEY || !spreadsheetId) return { ok: false, row: null };
	try {
		return await appendPendingOfflineRow(spreadsheetId, [new Date().toISOString(), email, reason, "pending", "", lob ?? "", ""]);
	} catch (err) {
		console.error("[sheets] Error encolando solicitud offline:", err);
		return { ok: false, row: null };
	}
}

/**
 * Registra en la misma planilla/pestaña de "pending_offline" un reporte de un agente que avisa
 * que no puede o no pudo conectarse a tiempo a su turno. A diferencia de queueAgentOffline, la
 * fila queda con status="ok"/result="ok" (no "pending") para que el Monitor no la tome como una
 * acción a ejecutar: acá no hay nada que desconectar, el agente nunca llegó a conectarse.
 */
export async function logNoConnectionReport(
	email:         string,
	reason:        string,
	spreadsheetId: string,
	lob?:          string,
): Promise<{ ok: boolean; row: number | null }> {
	if (!SA_EMAIL || !SA_KEY || !spreadsheetId) return { ok: false, row: null };
	try {
		return await appendPendingOfflineRow(spreadsheetId, [new Date().toISOString(), email, reason, "ok", "ok", lob ?? "", ""]);
	} catch (err) {
		console.error("[sheets] Error registrando reporte de no conexión:", err);
		return { ok: false, row: null };
	}
}

/**
 * Escribe cuántos segundos tardó el TL en reaccionar a un reporte ya encolado, en la celda de
 * la columna G de su fila original en "pending_offline". Solo toca esa celda — nunca status ni
 * result (D/E) — así que no puede pisar lo que ya haya escrito el Monitor externo aunque este
 * update llegue después de que el Monitor procesó la fila.
 */
export async function updatePendingOfflineReactionSeconds(
	spreadsheetId: string,
	rowNumber:     number,
	seconds:       number,
): Promise<boolean> {
	if (!SA_EMAIL || !SA_KEY || !spreadsheetId) return false;
	try {
		await updateNamedCell(spreadsheetId, OFFLINE_QUEUE_TAB, rowNumber, TL_REACTION_SECONDS_COL, String(seconds));
		return true;
	} catch (err) {
		console.error("[sheets] Error actualizando segundos de reacción del TL:", err);
		return false;
	}
}

const MONITOR_CONFIG_TAB = "Config";

/** Lee un valor del tab Config de la planilla del Monitor. */
export async function getMonitorConfig(key: string, spreadsheetId: string): Promise<string | null> {
	if (!SA_EMAIL || !SA_KEY || !spreadsheetId) return null;
	try {
		const token = await getAccessToken();
		const range = encodeURIComponent(`'${MONITOR_CONFIG_TAB}'!A:B`);
		const res = await fetch(
			`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
			{ headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
		);
		if (!res.ok) return null;
		const data = await res.json() as { values?: string[][] };
		for (const row of (data.values ?? [])) {
			if ((row[0] ?? "").trim().toLowerCase() === key.toLowerCase()) {
				return (row[1] ?? "").trim();
			}
		}
		return null;
	} catch {
		return null;
	}
}

const HORAS_CUBRIR_TAB = "horas-cubrir";

export type HoraCubrirEntry = {
	lob:           string;
	horario:       string;
	fecha:         string;
	novedades:     string;
	observaciones: string;
	tipoGestion:   string;
	idUnico:       string;
};

// Las horas marcadas como HHEE en Novedades/Observaciones/Tipo de Gestión pagan un plus sobre
// el resto — nunca se deben sumar ni mostrar junto con las horas "normales" de cobertura.
export function isHoraCubrirHHEE(entry: HoraCubrirEntry): boolean {
	return `${entry.novedades} ${entry.observaciones} ${entry.tipoGestion}`.toLowerCase().includes("hhee");
}

/** Lee las filas pendientes de la hoja "horas-cubrir" en una o más planillas (programaciones). */
export async function getHorasCubrir(spreadsheetIds: string[]): Promise<HoraCubrirEntry[]> {
	if (!SA_EMAIL || !SA_KEY) return [];
	const seenIds = new Set<string>();
	const results: HoraCubrirEntry[] = [];

	for (const id of spreadsheetIds) {
		if (!id) continue;
		try {
			const { headers, rows } = await readNamedSheetRaw(id, HORAS_CUBRIR_TAB);
			const lobCol     = headers.findIndex(h => /^lob$/i.test(h));
			const horarioCol = headers.findIndex(h => /^horarios?$/i.test(h));
			const fechaCol   = headers.findIndex(h => /^fecha$/i.test(h));
			const novedCol   = headers.findIndex(h => /^novedades$/i.test(h));
			const obsCol     = headers.findIndex(h => /^observaciones$/i.test(h));
			const tipoCol    = headers.findIndex(h => /^tipo\s*de\s*gesti[oó]n$/i.test(h));
			const idCol      = headers.findIndex(h => /^id[_\s]?unico$/i.test(h));
			if (horarioCol < 0) continue;

			for (const { cells } of rows) {
				const horario = cells[horarioCol] ?? "";
				if (!horario) continue; // fila vacía
				// Misma fila reflejada en ambas planillas (mismo id_unico) → no duplicar el anuncio.
				const idUnico = idCol >= 0 ? (cells[idCol] ?? "") : "";
				if (idUnico && seenIds.has(idUnico)) continue;
				if (idUnico) seenIds.add(idUnico);

				results.push({
					lob:           lobCol   >= 0 ? (cells[lobCol]   ?? "") : "",
					horario,
					fecha:         fechaCol >= 0 ? (cells[fechaCol] ?? "") : "",
					novedades:     novedCol >= 0 ? (cells[novedCol] ?? "") : "",
					observaciones: obsCol   >= 0 ? (cells[obsCol]   ?? "") : "",
					tipoGestion:   tipoCol  >= 0 ? (cells[tipoCol]  ?? "") : "",
					idUnico,
				});
			}
		} catch (err) {
			console.error(`[sheets] Error leyendo horas-cubrir de ${id}:`, err);
		}
	}

	return results;
}

/** Escribe (o crea) un valor en el tab Config de la planilla del Monitor. */
export async function setMonitorConfig(key: string, value: string, spreadsheetId: string): Promise<boolean> {
	if (!SA_EMAIL || !SA_KEY || !spreadsheetId) return false;
	try {
		const token = await getAccessToken();

		// Leer filas existentes para encontrar si la key ya existe
		const range = encodeURIComponent(`'${MONITOR_CONFIG_TAB}'!A:B`);
		const readRes = await fetch(
			`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
			{ headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
		);

		let targetRow = -1;
		if (readRes.ok) {
			const data = await readRes.json() as { values?: string[][] };
			const rows = data.values ?? [];
			for (let i = 0; i < rows.length; i++) {
				if ((rows[i][0] ?? "").trim().toLowerCase() === key.toLowerCase()) {
					targetRow = i + 1; // 1-based
					break;
				}
			}
		}

		if (targetRow > 0) {
			const updateRange = encodeURIComponent(`'${MONITOR_CONFIG_TAB}'!B${targetRow}`);
			const res = await fetch(
				`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${updateRange}?valueInputOption=RAW`,
				{
					method:  "PUT",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body:    JSON.stringify({ values: [[value]] }),
					signal:  AbortSignal.timeout(10_000),
				},
			);
			return res.ok;
		} else {
			const appendRange = encodeURIComponent(`'${MONITOR_CONFIG_TAB}'!A:B`);
			const res = await fetch(
				`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
				{
					method:  "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body:    JSON.stringify({ values: [[key, value]] }),
					signal:  AbortSignal.timeout(10_000),
				},
			);
			return res.ok;
		}
	} catch (err) {
		console.error("[sheets] Error setting monitor config:", err);
		return false;
	}
}
