import { NextResponse } from "next/server";
import { getOrCreateConversation, enqueueOutbox } from "@/lib/db";

/**
 * POST /api/agent-offline/confirm
 * Llamado por el Monitor externo cuando completa el cambio de estado a Fuera de línea.
 * Encola un mensaje de WhatsApp al agente confirmando que el cambio fue aplicado.
 *
 * Body: { phone: string, email: string, apiKey?: string }
 */
export async function POST(req: Request) {
	try {
		const body = await req.json() as { phone?: string; email?: string; apiKey?: string };

		const monitorKey = process.env.MONITOR_API_KEY;
		if (monitorKey && body.apiKey !== monitorKey) {
			return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
		}

		const phone = body.phone?.replace(/\D/g, "");
		if (!phone) {
			return NextResponse.json({ ok: false, error: "phone requerido" }, { status: 400 });
		}

		const jid = `${phone}@s.whatsapp.net`;
		const conversation = await getOrCreateConversation(phone, jid, null);

		await enqueueOutbox(
			conversation.id,
			phone,
			"✅ Listo — ya estás en *Fuera de línea*. Cuando vuelvas escribime para que te ponga online 👋",
		);

		return NextResponse.json({ ok: true, phone });
	} catch (err) {
		console.error("[agent-offline/confirm] Error:", err);
		return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
	}
}
