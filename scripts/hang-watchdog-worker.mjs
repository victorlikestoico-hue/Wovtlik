// Worker thread separado del hilo principal a propósito: si el event loop principal se
// congela (el escenario que causó el incidente de 2026-08-05, donde ni siquiera los cron
// de setInterval volvían a correr), un watchdog corriendo en ESE MISMO hilo nunca llegaría
// a dispararse — está congelado junto con todo lo demás. Al vivir en su propio hilo de OS,
// este worker sigue corriendo aunque el hilo principal quede bloqueado.
//
// Primero se intenta SIGTERM (dispara el handleShutdown ya registrado en start-bot.ts, que
// cierra el socket de Baileys prolijamente) y solo se escala a SIGKILL si el proceso sigue
// vivo pasado GRACE_MS. Si el hilo principal está realmente congelado, el handler de SIGTERM
// nunca llega a correr y este mismo worker manda el SIGKILL igual — el kernel lo entrega sin
// pasar por V8/libuv, así que garantiza la muerte del proceso pase lo que pase. La diferencia
// con mandar SIGKILL directo (como antes) es que ahora un cuelgue "blando" — el hilo muy
// ocupado pero no 100% trabado, ej. una ráfaga de logs saturando stdout, visto en el incidente
// de 2026-08-12 — tiene chance de cerrar el socket y terminar cualquier escritura de sesión de
// Signal en curso antes de morir, en vez de cortarse a mitad de una escritura al volumen de
// auth (lo que dejaba sesiones corruptas y desataba cascadas de "Bad MAC").
import { workerData } from "node:worker_threads";

const { sharedBufferPtr, timeoutMs, checkIntervalMs } = workerData;
const heartbeat = new Int32Array(sharedBufferPtr);
const GRACE_MS = 5_000;

let lastValue = Atomics.load(heartbeat, 0);
let lastChangeAt = Date.now();
let killTriggered = false;

setInterval(() => {
	if (killTriggered) return;

	const current = Atomics.load(heartbeat, 0);
	if (current !== lastValue) {
		lastValue = current;
		lastChangeAt = Date.now();
		return;
	}

	const staleMs = Date.now() - lastChangeAt;
	if (staleMs > timeoutMs) {
		killTriggered = true;
		console.error(
			`[hang-watchdog] El hilo principal no dio señal de vida en ${Math.round(staleMs / 1000)}s (límite ${Math.round(timeoutMs / 1000)}s). Asumiendo event loop congelado — mandando SIGTERM para intentar un cierre prolijo (${GRACE_MS / 1000}s de margen antes de SIGKILL).`,
		);
		process.kill(process.pid, "SIGTERM");
		setTimeout(() => {
			// Si SIGTERM funcionó, handleShutdown ya llamó process.exit() y este proceso —
			// junto con este worker thread — ya no existe, así que este callback nunca corre.
			console.error(
				`[hang-watchdog] El proceso sigue vivo ${GRACE_MS / 1000}s después del SIGTERM. Forzando SIGKILL.`,
			);
			process.kill(process.pid, "SIGKILL");
		}, GRACE_MS);
	}
}, checkIntervalMs);
