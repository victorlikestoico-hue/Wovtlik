// Pausa aleatoria entre envíos salientes consecutivos a destinatarios distintos.
// Sin esto, los loops de outbox/recordatorios mandan ráfagas de mensajes en milisegundos,
// que es la firma de comportamiento que los sistemas anti-abuso de WhatsApp detectan como bot/spam.
const MIN_SEND_DELAY_MS = 3000;
const MAX_SEND_DELAY_MS = 8000;

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomSendDelayMs(): number {
	return MIN_SEND_DELAY_MS + Math.floor(Math.random() * (MAX_SEND_DELAY_MS - MIN_SEND_DELAY_MS));
}

export async function waitBetweenSends(): Promise<void> {
	await sleep(randomSendDelayMs());
}
