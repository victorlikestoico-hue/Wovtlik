// Integra con el proyecto Wolftls (Google Apps Script, C:\Users\PC\Desktop\Xtend6\Wolftls) que
// calcula el rooster real de qué TL cubre la rotación "Desconexiones & Slack" (grupos Fraude y
// Across) en cada bloque horario, en base a horas trabajadas, exenciones y días OFF.
//
// WOpen lo usa como fuente de verdad ADICIONAL de "quién es TL en turno": hasta ahora solo lo
// sabía si el TL lo anunciaba a mano en el grupo de fallas ("los acompaño con..."). Con esto,
// aunque nadie anuncie nada, se puede saber quién DEBÍA estar cubriendo según el rooster — se usa
// en client.ts tanto para validar reacciones (markTlReactionAndUpdateSheet) como para el aviso de
// "TL sin responder" (checkStaleTlReactions).
//
// Cobertura: Wolftls solo programa los LOB de los grupos Fraude/Across (ver
// WOLFTLS_COVERED_LOBS más abajo) — CS, SM, PO, GO, OV no pasan por este rooster y siguen
// dependiendo únicamente del anuncio manual en el grupo.
//
// Cómo llegan los datos: se probó exponer el rooster como Web App con token, pero el Workspace de
// pedidosya.com bloquea el acceso anónimo a Apps Script a nivel organización (exige login de
// Google sin importar el manifiesto). En vez de eso, Wolftls vuelca el resultado calculado a una
// pestaña de su propia planilla ("Rotación WOpen", actualizada cada 15 min por un trigger — ver
// publicarRotacionParaWOpen en Rotacion.gs) y WOpen la lee ahí con el mismo Service Account que ya
// usa para leer/escribir la planilla de fallas (ver sheets-client.ts). Requiere
// GOOGLE_SA_EMAIL/GOOGLE_SA_PRIVATE_KEY (ya configurados) + WOLFTLS_SPREADSHEET_ID, y que esa
// planilla esté compartida como lector con el Service Account. Si algo de esto falta, todas las
// funciones acá devuelven "sin datos" en vez de romper — la integración es puramente aditiva.

import { createSign } from "crypto";

const SA_EMAIL = process.env.GOOGLE_SA_EMAIL ?? "";
const SA_KEY = (process.env.GOOGLE_SA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
const SPREADSHEET_ID = process.env.WOLFTLS_SPREADSHEET_ID ?? "";
const SHEET_TAB = "Rotación WOpen";

// Si Wolftls dejara de correr el trigger que actualiza la pestaña, preferimos no usar datos viejos
// (podrían decir que alguien cubre un LOB cuando en realidad el rooster real ya cambió) antes que
// confiar ciegamente en lo último que se leyó.
const STALE_DATA_MAX_AGE_MS = 30 * 60 * 1000;

export interface WolftlsBlock {
	dia: "L" | "M" | "X" | "J" | "V" | "S" | "D";
	start: string; // "HH:MM", hora de pared Uruguay
	end: string; // "HH:MM", hora de pared Uruguay — puede ser < start si el bloque cruza medianoche
	mail: string;
}

// Mapeo PROVISIONAL entre las siglas de LOB que usa WOpen (ver TL_ANNOUNCEMENT_EXTRA_LOBS en
// client.ts) y los grupos que reparte Wolftls (GR_FRAUDE + GR_ACROSS en Rotacion.gs):
//   GR_FRAUDE = ['Fraude', 'Invoice Missing', 'Fraude Fintech']  → fr, im  (Fraude Fintech sin sigla clara)
//   GR_ACROSS = ['Across J', 'Recovery', 'PDI / RV', 'PDI']      → aj, rv, pdi
// Confirmar con el negocio antes de confiar en esto para más LOB — un mapeo mal hecho acá
// atribuiría reacciones/alertas al TL equivocado, el mismo tipo de bug que se corrigió en
// markTlReactionAndUpdateSheet.
export const WOLFTLS_COVERED_LOBS = ["fr", "im", "aj", "rv", "pdi"] as const;

// Dueño del bot — usado por tl-coverage-cron.ts para disparar el anuncio de "Mi Cobertura" en
// automático apenas el rooster le asigna un bloque, en vez de depender de un horario cargado a
// mano (ver tl_coverage_schedule, ahora deprecado). También lo usa absence-alert-cron.ts para
// saber la ventana horaria en la que ese anuncio automático deja al TL activo.
export const MI_COBERTURA_EMAIL = "victor.garces_ndo.ext@pedidosya.com";

const DAY_ORDER = ["L", "M", "X", "J", "V", "S", "D"] as const;
export type DayLetter = (typeof DAY_ORDER)[number];

let _token: { value: string; expiresAt: number } | null = null;

function isConfigured(): boolean {
	return !!(SA_EMAIL && SA_KEY && SPREADSHEET_ID);
}

function makeJWT(): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iss: SA_EMAIL,
			scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
			aud: "https://oauth2.googleapis.com/token",
			iat: now,
			exp: now + 3600,
		}),
	).toString("base64url");
	const unsigned = `${header}.${payload}`;
	const signer = createSign("SHA256");
	signer.update(unsigned);
	return `${unsigned}.${signer.sign(SA_KEY, "base64url")}`;
}

async function getAccessToken(): Promise<string> {
	if (_token && Date.now() < _token.expiresAt - 60_000) return _token.value;
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: makeJWT(),
		}),
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`[wolftls] SA token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const d = (await res.json()) as { access_token: string; expires_in: number };
	_token = { value: d.access_token, expiresAt: Date.now() + d.expires_in * 1000 };
	return _token.value;
}

async function fetchBlocks(): Promise<WolftlsBlock[]> {
	const token = await getAccessToken();
	const range = `'${SHEET_TAB}'!A1:G500`;
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}`;
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`[wolftls] Sheets API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as { values?: string[][] };
	const rows = data.values ?? [];

	// G1 trae la hora (UTC, ISO) de la última corrida del trigger de Wolftls — ver
	// publicarRotacionParaWOpen en Rotacion.gs.
	const updatedAtIso = rows[0]?.[6];
	if (updatedAtIso) {
		const ageMs = Date.now() - new Date(updatedAtIso).getTime();
		if (Number.isFinite(ageMs) && ageMs > STALE_DATA_MAX_AGE_MS) {
			throw new Error(
				`[wolftls] Datos desactualizados (última corrida hace ${Math.round(ageMs / 60000)} min) — el trigger de Wolftls puede haberse detenido.`,
			);
		}
	}

	return rows
		.slice(1)
		.filter((r) => r[0] && r[1] && r[2] && r[3])
		.map((r) => ({ dia: r[0] as DayLetter, start: r[1], end: r[2], mail: r[3] }));
}

/** Cachea en memoria del proceso — el bot corre como un único proceso de larga duración (ver
 * arquitectura Baileys de WOpen). Si falla la consulta, se sigue sirviendo la última copia
 * conocida en vez de romper la validación de reacciones. */
let cache: { blocks: WolftlsBlock[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getBlocks(): Promise<WolftlsBlock[]> {
	if (!isConfigured()) return [];
	if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.blocks;
	try {
		const blocks = await fetchBlocks();
		cache = { blocks, fetchedAt: Date.now() };
		return blocks;
	} catch (err) {
		console.error("[wolftls] Error consultando el rooster:", err);
		return cache?.blocks ?? [];
	}
}

function timeToMinutes(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + m;
}

/** Mismo patrón que el resto del bot para resolver día/hora en huso Uruguay (ver
 * computeTlAnnouncementTtlSeconds / getWeekOffDays_ en client.ts). */
function dayLetterUY(date: Date): DayLetter {
	const nowUY = new Date(date.toLocaleString("en-US", { timeZone: "America/Montevideo" }));
	return DAY_ORDER[(nowUY.getDay() + 6) % 7]; // getDay(): 0=domingo → reindexado a L=0
}

function minutesOfDayUY(date: Date): number {
	const nowUY = new Date(date.toLocaleString("en-US", { timeZone: "America/Montevideo" }));
	return nowUY.getHours() * 60 + nowUY.getMinutes();
}

/** Busca el bloque vigente en `at`, considerando que un bloque que cruza medianoche (end <= start)
 * puede seguir vigente ya entrada la madrugada del día siguiente aunque esté etiquetado con el
 * día anterior (así arma los bloques Rotacion.gs, ver END='02:00'). */
function findCurrentBlock(blocks: WolftlsBlock[], day: DayLetter, nowMin: number): WolftlsBlock | null {
	const prevDay = DAY_ORDER[(DAY_ORDER.indexOf(day) + 6) % 7];
	for (const b of blocks) {
		const startMin = timeToMinutes(b.start);
		let endMin = timeToMinutes(b.end);
		if (endMin <= startMin) endMin += 24 * 60;
		if (b.dia === day && nowMin >= startMin && nowMin < endMin) return b;
		if (b.dia === prevDay && nowMin + 24 * 60 >= startMin && nowMin + 24 * 60 < endMin) return b;
	}
	return null;
}

/**
 * Bloque del rooster de Wolftls vigente en el momento `at` (ahora por default), sin filtrar por
 * LOB — un solo bloque cubre en conjunto todos los WOLFTLS_COVERED_LOBS (ver comentario de la
 * interfaz WolftlsBlock). null si Wolftls no está configurado, la consulta falló sin caché
 * previa, o hay un hueco real en el rooster para ese instante.
 */
export async function getCurrentCoverageBlock(at: Date = new Date()): Promise<WolftlsBlock | null> {
	const blocks = await getBlocks();
	if (blocks.length === 0) return null;
	return findCurrentBlock(blocks, dayLetterUY(at), minutesOfDayUY(at));
}

/**
 * TL que el rooster de Wolftls dice que debería estar cubriendo `lob` en el momento `at` (ahora
 * por default), o null si: el LOB no está en WOLFTLS_COVERED_LOBS, Wolftls no está configurado
 * (env vars ausentes o planilla no compartida), la consulta falló sin caché previa, o no hay
 * ningún bloque que cubra ese instante (hueco real en el rooster).
 */
export async function getScheduledTlForLob(
	lob: string,
	at: Date = new Date(),
): Promise<{ email: string; until: string } | null> {
	if (!(WOLFTLS_COVERED_LOBS as readonly string[]).includes(lob)) return null;
	const match = await getCurrentCoverageBlock(at);
	if (!match) return null;
	return { email: match.mail.toLowerCase().trim(), until: match.end };
}

/**
 * Bloque vigente en `at` SI Y SOLO SI está asignado a `email` — usado por tl-coverage-cron.ts y
 * absence-alert-cron.ts para saber si el dueño del bot (MI_COBERTURA_EMAIL) está cubriendo ahora
 * mismo, reusando la misma resolución de bloque (con soporte de cruce de medianoche) que
 * getScheduledTlForLob.
 */
export async function getCurrentBlockForEmail(email: string, at: Date = new Date()): Promise<WolftlsBlock | null> {
	const block = await getCurrentCoverageBlock(at);
	if (!block) return null;
	return block.mail.toLowerCase().trim() === email.toLowerCase().trim() ? block : null;
}

/**
 * Todos los bloques programados del rooster de Wolftls para un día de la semana dado (una sola
 * franja horaria cubre en conjunto los LOB de WOLFTLS_COVERED_LOBS — el rooster no distingue por
 * LOB individual dentro de ese grupo). Se usa para el reporte de fin de día de qué TL con turno
 * nunca se anunciaron en el grupo de desconexiones.
 */
export async function getScheduledBlocksForDay(day: DayLetter): Promise<WolftlsBlock[]> {
	const blocks = await getBlocks();
	return blocks.filter((b) => b.dia === day);
}
