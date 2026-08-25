// Manda un comunicado puntual al grupo "Fraude - información" por WhatsApp.
// Pensado para correr varias veces al día, cada vez con un texto distinto, así los avisos
// llegan espaciados en vez de todos juntos.
//
// Uso:
//   npx tsx scripts/send-fraude-announcement.ts "Texto del comunicado..."
//   npx tsx scripts/send-fraude-announcement.ts --file ruta/al/mensaje.txt
//
// Por dentro pega contra /api/groups/announce, que deja el mensaje en una cola de archivos que
// el bot-process recoge en su loop de 1s y envía con el socket de WhatsApp ya conectado (nunca
// abre una sesión propia).
import fs from "node:fs";
import { callWOpenApi } from "./wopen-api-client.ts";

const FRAUDE_GROUP_JID = process.env.FRAUDE_GROUP_JID || "";

function readMessageFromArgs(): string {
	const args = process.argv.slice(2);
	const fileFlagIndex = args.indexOf("--file");
	if (fileFlagIndex !== -1) {
		const filePath = args[fileFlagIndex + 1];
		if (!filePath) throw new Error("Falta la ruta después de --file");
		return fs.readFileSync(filePath, "utf-8").trim();
	}
	const text = args.join(" ").trim();
	if (!text) {
		throw new Error(
			'Falta el texto del comunicado. Uso: npx tsx scripts/send-fraude-announcement.ts "texto..." (o --file ruta.txt)',
		);
	}
	return text;
}

async function main() {
	if (!FRAUDE_GROUP_JID) {
		throw new Error(
			"Falta FRAUDE_GROUP_JID en el .env local (el gid del grupo 'Fraude - información').",
		);
	}
	const text = readMessageFromArgs();

	await callWOpenApi("/api/groups/announce", {
		method: "POST",
		body: { jid: FRAUDE_GROUP_JID, text },
	});

	console.log("[send-fraude-announcement] Comunicado encolado, el bot lo envía en unos segundos.");
}

main().catch((err) => {
	console.error("[send-fraude-announcement] Error:", err.message);
	process.exit(1);
});
