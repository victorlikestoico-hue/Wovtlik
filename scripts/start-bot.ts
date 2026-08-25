// scripts/env-loader.ts DEBE ser el primer import para popular process.env antes de que otros módulos lo lean
import "./env-loader.ts";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { startWASocket, shutdownWASocket, listAllGroups, sendViaGlobalSock } from "../src/lib/baileys/client.ts";
import {
	getDestructiveRestartFlagPath,
	getSoftRestartFlagPath,
	getGroupListRequestFlagPath,
	getGroupListResultPath,
	getPendingAnnouncementsDir,
} from "../src/lib/runtime-paths.ts";
import { startDashBigReportsCron } from "./dashbig-reports-cron.ts";
import { startAppointmentsCron } from "./appointments-cron.ts";
import { startFallasTemplateCron } from "./fallas-template-cron.ts";
import { startHorasCubrirCron } from "./horas-cubrir-cron.ts";
import { startFormBroadcastCron } from "./form-broadcast-cron.ts";
import { startTlCoverageCron } from "./tl-coverage-cron.ts";
import { startAbsenceAlertCron } from "./absence-alert-cron.ts";
import { startTlNoAnnouncedReportCron } from "./tl-no-announced-report-cron.ts";

const restartFlagPath = getDestructiveRestartFlagPath();
const softRestartFlagPath = getSoftRestartFlagPath();

// Detección de cuelgues del hilo principal (ver incidente 2026-08-05: el proceso quedó
// congelado ~33 min tras una desconexión, sin crashear, y Railway no lo reinició solo porque
// seguía "corriendo"). Un watchdog en el mismo hilo no sirve porque si el hilo principal se
// congela, el watchdog se congela con él. Por eso corre en un worker thread aparte (su propio
// hilo de OS), que solo confía en un contador compartido: si el hilo principal deja de
// incrementarlo por más de HEARTBEAT_TIMEOUT_MS, el worker asume el event loop colgado y manda
// SIGKILL — señal que el kernel entrega igual aunque el hilo principal esté 100% bloqueado.
const HEARTBEAT_TIMEOUT_MS = 90_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 10_000;

function startHangWatchdog(): Int32Array {
	const sharedBuffer = new SharedArrayBuffer(4);
	const heartbeat = new Int32Array(sharedBuffer);
	const worker = new Worker(new URL("./hang-watchdog-worker.mjs", import.meta.url), {
		workerData: {
			sharedBufferPtr: sharedBuffer,
			timeoutMs: HEARTBEAT_TIMEOUT_MS,
			checkIntervalMs: HEARTBEAT_CHECK_INTERVAL_MS,
		},
	});
	worker.on("error", (error) => {
		console.error("[hang-watchdog] Error en el worker de watchdog:", error);
	});
	return heartbeat;
}

async function main() {
	console.log("[bot-process] Arrancando bot-process...");

	// Iniciamos el socket de Baileys
	await startWASocket();

	// Follow-ups automáticos DESACTIVADOS: no mandar más recordatorios a los
	// agentes horas después de una conversación cuando no responden.

	// Reportes automáticos de DashBig por WhatsApp
	startDashBigReportsCron();

	// Recordatorios de citas agendadas (cliente, agente y Telegram)
	startAppointmentsCron();

	// Recordatorio cada 4hs en el grupo de fallas de qué datos enviar (correo, motivo, LOB)
	startFallasTemplateCron();

	// Anuncio cada 1h en el grupo "Anuncios Horas CS" de los LOBs con horas extra sin cubrir
	startHorasCubrirCron();

	// Formulario mensual: envía el link a todos los agentes el día 2 y el día 7 de cada mes a las 9h Colombia
	startFormBroadcastCron();

	// Recordatorio de turno por Meta API DESACTIVADO (dejó de pagarse el servicio de WhatsApp
	// Cloud API): ya no se dispara el workflow de recordatorios-turnos.

	// Anuncio diario de cobertura propia en el grupo de desconexiones, a la hora configurada en Ajustes
	startTlCoverageCron();

	// Alerta individual por WhatsApp a agentes Ausente sin justificar, solo durante la
	// misma ventana horaria configurada para "Mi Cobertura" (ver absence-alert-cron.ts)
	startAbsenceAlertCron();

	// Reporte diario a las 02:00 UY por Telegram: TL con turno (rooster) que nunca se anunciaron
	// en el grupo de desconexiones el día anterior
	startTlNoAnnouncedReportCron();

	const heartbeat = startHangWatchdog();

	// Loop de polling para la desconexión / reinicio manual controlado desde el frontend
	setInterval(async () => {
		// Latido para el watchdog: si esta línea deja de ejecutarse, el hilo principal está
		// congelado (ver comentario junto a startHangWatchdog).
		Atomics.add(heartbeat, 0, 1);

		if (fs.existsSync(softRestartFlagPath)) {
			console.log(
				"[bot-process] Bandera .restart-bot detectada. Reinicio suave solicitado.",
			);
			try {
				fs.unlinkSync(softRestartFlagPath);
				await shutdownWASocket();
				await startWASocket();
			} catch (error) {
				console.error(
					"[bot-process] Error durante el reinicio suave:",
					error,
				);
			}
		}

		const groupListRequestFlagPath = getGroupListRequestFlagPath();
		if (fs.existsSync(groupListRequestFlagPath)) {
			try {
				fs.unlinkSync(groupListRequestFlagPath);
			} catch {
				// noop
			}
			try {
				const groups = await listAllGroups();
				fs.writeFileSync(getGroupListResultPath(), JSON.stringify({ ok: true, groups }));
			} catch (error: any) {
				fs.writeFileSync(
					getGroupListResultPath(),
					JSON.stringify({ ok: false, error: error?.message || String(error) }),
				);
			}
		}

		const pendingAnnouncementsDir = getPendingAnnouncementsDir();
		if (fs.existsSync(pendingAnnouncementsDir)) {
			for (const file of fs.readdirSync(pendingAnnouncementsDir)) {
				if (!file.endsWith(".json")) continue;
				const filePath = path.join(pendingAnnouncementsDir, file);
				try {
					const { jid, text } = JSON.parse(fs.readFileSync(filePath, "utf-8"));
					await sendViaGlobalSock(jid, { text }, { kind: "cron" });
					console.log(`[bot-process] Anuncio manual enviado a ${jid}.`);
				} catch (error) {
					console.error(`[bot-process] Error enviando anuncio manual (${file}):`, error);
				} finally {
					try {
						fs.unlinkSync(filePath);
					} catch {
						// noop
					}
				}
			}
		}

		if (fs.existsSync(restartFlagPath)) {
			console.log(
				"[bot-process] Bandera .reset-auth detectada. Reset destructivo solicitado desde el panel.",
			);
			try {
				// Borramos la bandera
				fs.unlinkSync(restartFlagPath);

				// Apagamos el socket actual limpiando listeners
				await shutdownWASocket();

				// La API de desconexion ya limpia el directorio auth de la instancia activa.
				// Aqui solo reiniciamos el socket para forzar un nuevo QR.

				// Volvemos a arrancar limpio, lo cual forzará un nuevo QR
				await startWASocket();
			} catch (error) {
				console.error(
					"[bot-process] Error durante el proceso de reinicio/desconexión:",
					error,
				);
			}
		}
	}, 1000);
}

// Manejo de apagado limpio (Graceful Shutdown)
async function handleShutdown(signal: string) {
	console.log(`[bot-process] Recibido ${signal}. Cerrando de forma limpia...`);
	try {
		await shutdownWASocket();
		console.log("[bot-process] Socket de WhatsApp cerrado correctamente.");
		process.exit(0);
	} catch (error) {
		console.error("[bot-process] Error durante el cierre limpio:", error);
		process.exit(1);
	}
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

main().catch((error) => {
	console.error("[bot-process] Error crítico al arrancar main:", error);
	process.exit(1);
});
