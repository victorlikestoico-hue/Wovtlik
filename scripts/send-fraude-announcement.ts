// Manda (o programa) un comunicado puntual al grupo "Fraude - información" por WhatsApp.
// Pensado para correr varias veces al día, cada vez con un texto distinto, así los avisos
// llegan espaciados en vez de todos juntos.
//
// Uso:
//   npx tsx scripts/send-fraude-announcement.ts "Texto del comunicado..."
//   npx tsx scripts/send-fraude-announcement.ts --file ruta/al/mensaje.txt
//   npx tsx scripts/send-fraude-announcement.ts "texto" --attach ruta/archivo.zip
//   npx tsx scripts/send-fraude-announcement.ts "texto" --at "14:00"   (hora Uruguay, hoy)
//
// Por dentro pega contra /api/groups/announce, que deja el mensaje en una cola de archivos que
// el bot-process recoge en su loop de 1s y envía con el socket de WhatsApp ya conectado (nunca
// abre una sesión propia). Con --at, el mensaje queda encolado pero el bot-process no lo manda
// hasta que llegue esa hora.
import fs from "node:fs";
import path from "node:path";
import { callWOpenApi } from "./wopen-api-client.ts";

const FRAUDE_GROUP_JID = process.env.FRAUDE_GROUP_JID || "";
const URUGUAY_TZ = "America/Montevideo"; // UTC-3 todo el año, sin horario de verano

function mimetypeFor(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	const map: Record<string, string> = {
		".zip": "application/zip",
		".pdf": "application/pdf",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
	};
	return map[ext] || "application/octet-stream";
}

/** Próxima ocurrencia de "HH:mm" hora Uruguay (hoy, o mañana si ya pasó). */
function nextUruguayOccurrence(hhmm: string): string {
	const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
	if (!m) throw new Error(`Formato de --at inválido: "${hhmm}" (usar HH:mm, ej. "14:00")`);
	const [, hh, mm] = m;

	const todayUY = new Date().toLocaleDateString("en-CA", { timeZone: URUGUAY_TZ }); // YYYY-MM-DD
	let target = new Date(`${todayUY}T${hh.padStart(2, "0")}:${mm}:00-03:00`);
	if (target.getTime() < Date.now()) {
		target = new Date(target.getTime() + 24 * 60 * 60 * 1000); // ya pasó hoy, programar para mañana
	}
	return target.toISOString();
}

function parseArgs() {
	const args = process.argv.slice(2);
	let attachPath: string | undefined;
	let at: string | undefined;
	let filePath: string | undefined;
	const rest: string[] = [];

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--attach") {
			attachPath = args[++i];
		} else if (args[i] === "--at") {
			at = args[++i];
		} else if (args[i] === "--file") {
			filePath = args[++i];
		} else {
			rest.push(args[i]);
		}
	}

	const text = filePath ? fs.readFileSync(filePath, "utf-8").trim() : rest.join(" ").trim();
	if (!text) {
		throw new Error(
			'Falta el texto del comunicado. Uso: npx tsx scripts/send-fraude-announcement.ts "texto..." [--file ruta.txt] [--attach ruta] [--at "HH:mm"]',
		);
	}

	return { text, attachPath, at };
}

async function main() {
	if (!FRAUDE_GROUP_JID) {
		throw new Error(
			"Falta FRAUDE_GROUP_JID en el .env local (el gid del grupo 'Fraude - información').",
		);
	}
	const { text, attachPath, at } = parseArgs();

	const attachment = attachPath
		? {
				fileName: path.basename(attachPath),
				mimetype: mimetypeFor(attachPath),
				base64: fs.readFileSync(attachPath).toString("base64"),
			}
		: undefined;

	const sendAfter = at ? nextUruguayOccurrence(at) : undefined;

	await callWOpenApi("/api/groups/announce", {
		method: "POST",
		body: { jid: FRAUDE_GROUP_JID, text, attachment, sendAfter },
	});

	console.log(
		sendAfter
			? `[send-fraude-announcement] Comunicado programado para ${sendAfter} (hora Uruguay).`
			: "[send-fraude-announcement] Comunicado encolado, el bot lo envía en unos segundos.",
	);
}

main().catch((err) => {
	console.error("[send-fraude-announcement] Error:", err.message);
	process.exit(1);
});
