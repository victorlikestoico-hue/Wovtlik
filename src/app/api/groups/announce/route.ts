import { NextResponse } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getPendingAnnouncementsDir } from "../../../../lib/runtime-paths.ts";

// Encola un mensaje para un grupo de WhatsApp dejando un archivo en pending-announcements/,
// que el bot-process (único dueño del socket vivo) recoge en su loop de 1s y envía vía
// sendViaGlobalSock — mismo patrón de bandera de archivo que /api/connection/disconnect,
// evita abrir un segundo socket de Baileys para este envío puntual.
export async function POST(req: Request) {
	try {
		const body = await req.json().catch(() => ({}));
		const jid = typeof body.jid === "string" ? body.jid.trim() : "";
		const text = typeof body.text === "string" ? body.text.trim() : "";

		if (!jid.endsWith("@g.us")) {
			return NextResponse.json({ error: "jid debe ser un grupo (@g.us)" }, { status: 400 });
		}
		if (!text) {
			return NextResponse.json({ error: "text es requerido" }, { status: 400 });
		}

		const dir = getPendingAnnouncementsDir();
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		const filePath = path.join(dir, `${Date.now()}-${crypto.randomUUID()}.json`);
		fs.writeFileSync(filePath, JSON.stringify({ jid, text }));

		return NextResponse.json({ ok: true });
	} catch (error: any) {
		console.error("[api] Error en POST /api/groups/announce:", error);
		return NextResponse.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
