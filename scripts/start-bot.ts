// scripts/env-loader.ts DEBE ser el primer import para popular process.env antes de que otros módulos lo lean
import "./env-loader.ts";
import fs from "node:fs";
import { startWASocket, shutdownWASocket } from "../src/lib/baileys/client.ts";
import {
	getDestructiveRestartFlagPath,
	getSoftRestartFlagPath,
} from "../src/lib/runtime-paths.ts";
import { startDashBigReportsCron } from "./dashbig-reports-cron.ts";
import { startAppointmentsCron } from "./appointments-cron.ts";
import { startFallasTemplateCron } from "./fallas-template-cron.ts";
import { startHorasCubrirCron } from "./horas-cubrir-cron.ts";
import { startFormBroadcastCron } from "./form-broadcast-cron.ts";

const restartFlagPath = getDestructiveRestartFlagPath();
const softRestartFlagPath = getSoftRestartFlagPath();

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

	// Recordatorio cada 2hs en el grupo de fallas de qué datos enviar (correo, motivo, formulario)
	startFallasTemplateCron();

	// Anuncio cada 1h en el grupo "Anuncios Horas CS" de los LOBs con horas extra sin cubrir
	startHorasCubrirCron();

	// Formulario mensual: envía el link a todos los agentes el día 2 y el día 7 de cada mes a las 9h Colombia
	startFormBroadcastCron();

	// Loop de polling para la desconexión / reinicio manual controlado desde el frontend
	setInterval(async () => {
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
