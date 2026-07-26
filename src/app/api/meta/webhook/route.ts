import { NextResponse } from "next/server";

import { insertMetaReply } from "@/lib/db";

/**
 * Webhook de WhatsApp Cloud API (Meta) para el número usado por recordatorios-turnos.
 * No requiere sesión: lo llama Meta directamente.
 *
 * GET  -> handshake de verificación (hub.challenge).
 * POST -> mensajes entrantes (respuestas de los agentes a los recordatorios).
 */
export async function GET(req: Request) {
	const url = new URL(req.url);
	const mode = url.searchParams.get("hub.mode");
	const token = url.searchParams.get("hub.verify_token");
	const challenge = url.searchParams.get("hub.challenge");

	const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
	if (mode === "subscribe" && expectedToken && token === expectedToken) {
		return new NextResponse(challenge ?? "", { status: 200 });
	}

	return NextResponse.json({ ok: false, error: "Verification failed" }, { status: 403 });
}

type WhatsAppMessage = {
	from?: string;
	id?: string;
	timestamp?: string;
	type?: string;
	text?: { body?: string };
	button?: { text?: string };
	interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
};

type WhatsAppWebhookPayload = {
	entry?: Array<{
		changes?: Array<{
			value?: {
				contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
				messages?: WhatsAppMessage[];
			};
		}>;
	}>;
};

function extractContent(message: WhatsAppMessage): string | null {
	return (
		message.text?.body ??
		message.button?.text ??
		message.interactive?.button_reply?.title ??
		message.interactive?.list_reply?.title ??
		null
	);
}

export async function POST(req: Request) {
	try {
		const payload = (await req.json()) as WhatsAppWebhookPayload;

		for (const entry of payload.entry ?? []) {
			for (const change of entry.changes ?? []) {
				const value = change.value;
				if (!value?.messages?.length) continue;

				const nameByWaId = new Map(
					(value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]),
				);

				for (const message of value.messages) {
					if (!message.from) continue;
					await insertMetaReply({
						phone: message.from,
						contactName: nameByWaId.get(message.from) ?? null,
						whatsappMessageId: message.id ?? null,
						content: extractContent(message),
						messageType: message.type ?? "text",
						rawPayload: message as Record<string, unknown>,
						receivedAt: message.timestamp
							? new Date(Number(message.timestamp) * 1000)
							: undefined,
					});
				}
			}
		}

		return NextResponse.json({ ok: true });
	} catch (error: any) {
		console.error("[api] Error en POST /api/meta/webhook:", error);
		return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
	}
}
