// Pausa aleatoria entre envíos salientes consecutivos a destinatarios distintos.
// Sin esto, los loops de outbox/recordatorios mandan ráfagas de mensajes en milisegundos,
// que es la firma de comportamiento que los sistemas anti-abuso de WhatsApp detectan como bot/spam.
//
// "kind" distingue el contexto del envío para calibrar el pacing:
// - reactive: respuesta a alguien que te acaba de escribir (una persona real también contesta rápido).
// - cron: notificación/recordatorio que el bot inicia por su cuenta hacia un destinatario puntual.
// - broadcast: mismo texto hacia muchos destinatarios distintos — el patrón de mayor riesgo, pacing más largo.
export type SendKind = "reactive" | "cron" | "broadcast";

const BASE_DELAY_MS: Record<SendKind, [number, number]> = {
	reactive: [3000, 8000],
	cron: [4000, 10000],
	broadcast: [8000, 20000],
};

// Probabilidad de una pausa larga adicional, tipo "se distrajo un momento" — sin esto el
// jitter es perfectamente uniforme entre MIN y MAX, lo cual es en sí mismo un patrón
// detectable (un humano no tiene una distribución de tiempos de respuesta tan pareja).
const LONG_PAUSE_CHANCE = 0.12;
const LONG_PAUSE_RANGE_MS: [number, number] = [20000, 45000];

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomSendDelayMs(kind: SendKind = "reactive"): number {
	const [min, max] = BASE_DELAY_MS[kind];
	const base = min + Math.floor(Math.random() * (max - min));
	if (Math.random() < LONG_PAUSE_CHANCE) {
		const [lMin, lMax] = LONG_PAUSE_RANGE_MS;
		return base + lMin + Math.floor(Math.random() * (lMax - lMin));
	}
	return base;
}

// "multiplier" permite alargar el pacing durante el período de calentamiento tras un
// relogin (ver warmup-throttle.ts) sin duplicar la lógica de rangos por kind.
export async function waitBetweenSends(
	kind: SendKind = "reactive",
	multiplier = 1,
): Promise<void> {
	await sleep(Math.round(randomSendDelayMs(kind) * multiplier));
}
