// Worker thread separado del hilo principal a propósito: si el event loop principal se
// congela (el escenario que causó el incidente de 2026-08-05, donde ni siquiera los cron
// de setInterval volvían a correr), un watchdog corriendo en ESE MISMO hilo nunca llegaría
// a dispararse — está congelado junto con todo lo demás. Al vivir en su propio hilo de OS,
// este worker sigue corriendo aunque el hilo principal quede bloqueado, y usa SIGKILL (que
// el kernel entrega sin pasar por V8/libuv) para garantizar que el proceso muera igual.
import { workerData } from "node:worker_threads";

const { sharedBufferPtr, timeoutMs, checkIntervalMs } = workerData;
const heartbeat = new Int32Array(sharedBufferPtr);

let lastValue = Atomics.load(heartbeat, 0);
let lastChangeAt = Date.now();

setInterval(() => {
	const current = Atomics.load(heartbeat, 0);
	if (current !== lastValue) {
		lastValue = current;
		lastChangeAt = Date.now();
		return;
	}

	const staleMs = Date.now() - lastChangeAt;
	if (staleMs > timeoutMs) {
		console.error(
			`[hang-watchdog] El hilo principal no dio señal de vida en ${Math.round(staleMs / 1000)}s (límite ${Math.round(timeoutMs / 1000)}s). Asumiendo event loop congelado — forzando SIGKILL para que Railway reinicie el proceso.`,
		);
		process.kill(process.pid, "SIGKILL");
	}
}, checkIntervalMs);
