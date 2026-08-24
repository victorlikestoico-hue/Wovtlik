const TL_SHEET_ID  = "1ibitR7_af77BIlRMevmCkWdcNCLWji5yiPBOwXlbE0s";
const TL_SHEET_GID = "176485234";

// Sheet has 7 day-blocks of 6 columns each:
// [CS Live-SM] [PO & GO] [FR-IV-ATO/DDC] [AJ-RV-PDI] [Inicio] [Fin]
// Day order in sheet: Lunes Mon=1, Martes=2, Miércoles=3, Jueves=4, Viernes=5, Sábado=6, Domingo=0
const COLS_PER_DAY = 6;
const COL_CS_SM  = 0;
const COL_PO_GO  = 1;
const COL_INICIO = 4;
const COL_FIN    = 5;

// JS getDay(): 0=Sun, 1=Mon, ..., 6=Sat → sheet block index (0-based)
const DAY_BLOCK: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 };

// Normalized LOB name → column within day block (null = no assigned TL column)
const LOB_COL: Record<string, number | null> = {
	cs:                COL_CS_SM,
	"cs live":         COL_CS_SM,
	sm:                COL_CS_SM,
	"social media":    COL_CS_SM,
	po:                COL_PO_GO,
	"pago online":     COL_PO_GO,
	go:                COL_PO_GO,
	"gestion offline": COL_PO_GO,
	"gestión offline": COL_PO_GO,
	ov:                null,
	overnight:         null,
};

export type TLResult =
	| { found: true;  name: string; finUY: string; finCOL: string; isRotacion: boolean }
	| { found: false; reason: "no_column" | "no_data" | "error" };

export type TLDayBlock = {
	group: "cs_sm" | "po_go";
	/** Email en minúsculas tal cual figura en la celda del sheet, o null si es "Rotación" (nadie
	 * puntual a quien atribuirle el turno). */
	email: string | null;
	name: string;
	isRotacion: boolean;
	inicioUY: string;
	finUY: string;
};

export function normalizeLOB(raw: string): string | null {
	const n = raw.trim().toLowerCase().replace(/\s+/g, " ");
	return n in LOB_COL ? n : null;
}

function nameFromEmail(email: string): string {
	const local = email.split("@")[0] ?? "";
	const name  = local.split("_")[0] ?? local;
	return name.split(".").map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}

function parseHourDecimal(t: string): number {
	const [h, m] = t.split(":").map(Number);
	return isNaN(h) ? -1 : h + (m ?? 0) / 60;
}

function subtractTwoHours(uyTime: string): string {
	const [h, m] = uyTime.split(":").map(Number);
	if (isNaN(h)) return uyTime;
	let col = h - 2;
	if (col < 0) col += 24;
	return `${col}:${String(m ?? 0).padStart(2, "0")}`;
}

function parseCSV(text: string): string[][] {
	return text.split("\n").map(line => {
		const cols: string[] = [];
		let cur = "";
		let inQ = false;
		for (const ch of line) {
			if (ch === '"')      { inQ = !inQ; }
			else if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
			else                 { cur += ch; }
		}
		cols.push(cur.trim());
		return cols;
	});
}

export async function getTLEnTurno(lob: string): Promise<TLResult> {
	const lobKey = lob.trim().toLowerCase().replace(/\s+/g, " ");

	if (!(lobKey in LOB_COL)) return { found: false, reason: "no_column" };

	const lobCol = LOB_COL[lobKey];
	if (lobCol === null) return { found: false, reason: "no_column" };

	try {
		// Current time in Uruguay (UTC-3, no DST)
		const nowUY = new Date(
			new Date().toLocaleString("en-US", { timeZone: "America/Montevideo" }),
		);
		const blockIdx   = DAY_BLOCK[nowUY.getDay()] ?? 0;
		const dayOffset  = blockIdx * COLS_PER_DAY;
		const currentH   = nowUY.getHours() + nowUY.getMinutes() / 60;

		const url = `https://docs.google.com/spreadsheets/d/${TL_SHEET_ID}/export?format=csv&gid=${TL_SHEET_GID}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
		if (!res.ok) return { found: false, reason: "error" };

		const rows = parseCSV(await res.text()).slice(2); // skip 2 header rows

		for (const row of rows) {
			const inicioStr = row[dayOffset + COL_INICIO] ?? "";
			const finStr    = row[dayOffset + COL_FIN]    ?? "";
			if (!inicioStr || !finStr) continue;

			const inicio = parseHourDecimal(inicioStr);
			let fin      = parseHourDecimal(finStr);
			if (inicio < 0 || fin < 0) continue;
			if (fin === 0) fin = 24; // "0:00" fin means next midnight

			if (currentH >= inicio && currentH < fin) {
				const cell = (row[dayOffset + lobCol] ?? "").trim();
				const isRotacion = /rotac/i.test(cell);
				const name = isRotacion ? "Rotación" : nameFromEmail(cell);
				return {
					found: true,
					name,
					finUY:  finStr,
					finCOL: subtractTwoHours(finStr),
					isRotacion,
				};
			}
		}

		return { found: false, reason: "no_data" };
	} catch (err) {
		console.error("[tl-guardia] Error consultando sheet:", err);
		return { found: false, reason: "error" };
	}
}

/**
 * Todos los bloques de turno (CS/SM y PO/GO) programados para un día de la semana dado —a
 * diferencia de getTLEnTurno, que solo devuelve el bloque vigente en el instante actual. Se usa
 * para el reporte de fin de día de qué TL con turno nunca se anunciaron en el grupo de
 * desconexiones (ver tl-no-announced-report-cron.ts).
 *
 * `dayOfWeek` sigue la convención de Date.getDay() (0=domingo). Celdas vacías se omiten (sin TL
 * asignado = sin turno, no corresponde reportarlas); celdas "Rotación" se incluyen con email null.
 */
export async function getTLDaySchedule(dayOfWeek: number): Promise<TLDayBlock[]> {
	const blockIdx = DAY_BLOCK[dayOfWeek] ?? 0;
	const dayOffset = blockIdx * COLS_PER_DAY;

	try {
		const url = `https://docs.google.com/spreadsheets/d/${TL_SHEET_ID}/export?format=csv&gid=${TL_SHEET_GID}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
		if (!res.ok) return [];

		const rows = parseCSV(await res.text()).slice(2); // skip 2 header rows
		const out: TLDayBlock[] = [];

		for (const row of rows) {
			const inicioStr = row[dayOffset + COL_INICIO] ?? "";
			const finStr    = row[dayOffset + COL_FIN]    ?? "";
			if (!inicioStr || !finStr) continue;

			for (const [group, col] of [["cs_sm", COL_CS_SM], ["po_go", COL_PO_GO]] as const) {
				const cell = (row[dayOffset + col] ?? "").trim();
				if (!cell) continue; // sin TL asignado ese bloque = sin turno, no se reporta

				const isRotacion = /rotac/i.test(cell);
				out.push({
					group,
					email: isRotacion ? null : cell.toLowerCase(),
					name: isRotacion ? "Rotación" : nameFromEmail(cell),
					isRotacion,
					inicioUY: inicioStr,
					finUY: finStr,
				});
			}
		}

		return out;
	} catch (err) {
		console.error("[tl-guardia] Error consultando sheet (getTLDaySchedule):", err);
		return [];
	}
}
