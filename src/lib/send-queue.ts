import { waitBetweenSends, type SendKind } from "./send-pacing.ts";

// Cola global de envíos salientes por WhatsApp. Sin esto, si varios subsistemas (respuestas
// reactivas de IA, outbox de citas/broadcasts, crons, grupo de fallas) mandan mensajes casi al
// mismo tiempo, el bot le contesta/escribe a muchos contactos distintos en paralelo — ese patrón
// es la señal de bot/spam más fuerte que detectan los sistemas anti-abuso de WhatsApp.
// Serializamos todas las tareas de envío en una sola cadena y espaciamos con pacing tipo humano.
let sendChainPromise: Promise<void> = Promise.resolve();
let queuedSendCount = 0;

// Multiplicador opcional aplicado al delay entre envíos (usado por el throttle de warm-up
// post-relogin). Se inyecta desde afuera para evitar un ciclo de imports con warmup-throttle.ts,
// que a su vez depende de la capa de settings/DB.
let delayMultiplierProvider: (() => Promise<number>) | null = null;

export function setSendDelayMultiplierProvider(
	provider: (() => Promise<number>) | null,
): void {
	delayMultiplierProvider = provider;
}

export function enqueueSocketSend<T>(
	task: () => Promise<T>,
	opts?: { kind?: SendKind },
): Promise<T> {
	queuedSendCount++;
	const shouldWait = queuedSendCount > 1;
	const chained = sendChainPromise.then(async () => {
		if (shouldWait) {
			const multiplier = delayMultiplierProvider
				? await delayMultiplierProvider().catch(() => 1)
				: 1;
			await waitBetweenSends(opts?.kind, multiplier);
		}
		return task();
	});
	sendChainPromise = chained.then(
		() => undefined,
		() => undefined,
	);
	chained
		.finally(() => {
			queuedSendCount--;
		})
		// El propio `chained` ya se devuelve al llamador para que maneje el rechazo;
		// esta rama derivada de `.finally()` solo existe para el efecto secundario del
		// contador, así que se descarta silenciosamente para no generar un
		// unhandledRejection duplicado cuando la tarea falla.
		.catch(() => {});
	return chained;
}

export function getQueuedSendCount(): number {
	return queuedSendCount;
}
