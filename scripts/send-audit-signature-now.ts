// Disparo manual puntual del recordatorio de firma de auditorías (sin esperar a la ventana
// viernes/sábado/domingo del cron). Reusa la misma lógica de audit-signature-report-cron.ts.
import "./env-loader.ts";
import {
	fetchUnsignedAgents,
	lookupAgentContacts,
	buildMessage,
} from "./audit-signature-report-cron.ts";
import { MI_COBERTURA_EMAIL } from "../src/lib/wolftls-client.ts";

const COLOMBIA_TZ = "America/Bogota";

function colombiaDateNow(): Date {
	return new Date(new Date().toLocaleString("en-US", { timeZone: COLOMBIA_TZ }));
}
function colombiaDateISO(d: Date): string {
	return d.toLocaleDateString("en-CA", { timeZone: COLOMBIA_TZ });
}
function mondayOfWeekISO(d: Date): string {
	const day = d.getDay();
	const diffToMonday = day === 0 ? 6 : day - 1;
	const monday = new Date(d);
	monday.setDate(d.getDate() - diffToMonday);
	return colombiaDateISO(monday);
}

async function main() {
	const { globalSock, sendViaGlobalSock } = await import("../src/lib/baileys/client.ts");
	if (!globalSock?.user?.id) {
		console.error("[send-audit-signature-now] Socket no autenticado, no se puede enviar.");
		process.exit(1);
	}

	const now = colombiaDateNow();
	const weekStartISO = mondayOfWeekISO(now);
	const todayISO = colombiaDateISO(now);

	const stats = await fetchUnsignedAgents(MI_COBERTURA_EMAIL, weekStartISO, todayISO);
	console.log(`[send-audit-signature-now] ${stats.length} agente(s) sin 100% de firma (${weekStartISO} a ${todayISO}).`);

	const contacts = await lookupAgentContacts(new Set(stats.map((s) => s.agent)));

	for (const stat of stats) {
		const contact = contacts.get(stat.agent);
		if (!contact) {
			console.warn(`[send-audit-signature-now] Sin teléfono para ${stat.agent}, se omite.`);
			continue;
		}
		const jid = `${contact.phone}@s.whatsapp.net`;
		try {
			await sendViaGlobalSock(jid, { text: buildMessage(contact.firstName, stat) }, { kind: "broadcast" });
			console.log(`[send-audit-signature-now] Enviado a ${stat.agent} (${contact.phone}): ${stat.signed}/${stat.total} firmadas.`);
		} catch (err) {
			console.error(`[send-audit-signature-now] Falló el envío a ${stat.agent} (${contact.phone}):`, err);
		}
	}

	process.exit(0);
}

main().catch((err) => {
	console.error("[send-audit-signature-now] Error crítico:", err);
	process.exit(1);
});
