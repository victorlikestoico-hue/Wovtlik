import { getSettings, setSetting } from "./db.ts";

// Tras cualquier relogin con sesión nueva (QR recién escaneado) el número está en su momento
// de mayor riesgo de baneo — es justo cuando WhatsApp presta más atención a un "dispositivo"
// que reaparece. Este módulo alarga el pacing de envíos y bloquea broadcasts masivos durante
// un período de "calentamiento" después de cada relogin real.
const WARMUP_SETTING_KEY = "session_linked_at";
const WARMUP_HOURS_PHASE1 = 24; // primeras 24h: máximo cuidado
const WARMUP_HOURS_PHASE2 = 72; // 24-72h: cuidado moderado

let cachedLinkedAt: number | null | undefined; // undefined = todavía no se cargó del todo
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

export async function markSessionLinked(): Promise<void> {
	const now = Date.now();
	await setSetting(WARMUP_SETTING_KEY, now);
	cachedLinkedAt = now;
	cacheLoadedAt = now;
}

async function getLinkedAt(): Promise<number | null> {
	const now = Date.now();
	if (cachedLinkedAt !== undefined && now - cacheLoadedAt < CACHE_TTL_MS) {
		return cachedLinkedAt;
	}
	const settings = await getSettings();
	const raw = settings[WARMUP_SETTING_KEY];
	cachedLinkedAt = typeof raw === "number" ? raw : null;
	cacheLoadedAt = now;
	return cachedLinkedAt;
}

export type WarmupPhase = "phase1" | "phase2" | "normal";

// Lógica pura separada de la lectura a DB para que sea testeable sin mockear Postgres.
export function phaseFromLinkedAt(linkedAt: number | null, now: number): WarmupPhase {
	// Sin dato guardado (bot ya en uso desde antes de este mecanismo, o primera vez que se
	// despliega) no se penaliza — evita romper el pacing normal por falta de un valor histórico.
	if (linkedAt === null) return "normal";
	const hoursElapsed = (now - linkedAt) / 3_600_000;
	if (hoursElapsed < WARMUP_HOURS_PHASE1) return "phase1";
	if (hoursElapsed < WARMUP_HOURS_PHASE2) return "phase2";
	return "normal";
}

export async function getWarmupPhase(): Promise<WarmupPhase> {
	const linkedAt = await getLinkedAt();
	return phaseFromLinkedAt(linkedAt, Date.now());
}

export function warmupDelayMultiplier(phase: WarmupPhase): number {
	return phase === "phase1" ? 3 : phase === "phase2" ? 1.6 : 1;
}

export function isBroadcastBlocked(phase: WarmupPhase): boolean {
	return phase === "phase1";
}
