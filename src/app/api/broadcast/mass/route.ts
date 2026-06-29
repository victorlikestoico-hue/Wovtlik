import { NextResponse } from "next/server";
import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { listBroadcastAgents, getConversationByPhone, getOrCreateConversation, enqueueOutbox } from "@/lib/db";

// Delays between sends: existing conversation → 8s, new conversation → 60s
const EXISTING_DELAY_MS = 8_000;
const NEW_CONV_DELAY_MS = 60_000;

/**
 * POST /api/broadcast/mass
 * Encola un mensaje libre a todos los agentes del masivo, con:
 *   - 8s entre conversaciones existentes
 *   - 60s cuando se abre una conversación nueva (primera vez que el bot escribe a ese número)
 * Requiere rol manager.
 *
 * Body: { message: string }
 */
export async function POST(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "manager");

		const body = await req.json().catch(() => ({})) as { message?: string };
		const message = body.message?.trim();
		if (!message) {
			return NextResponse.json({ error: "El campo message es requerido." }, { status: 400 });
		}

		const agents = await listBroadcastAgents();
		if (agents.length === 0) {
			return NextResponse.json({ error: "No hay agentes configurados en la lista de envío masivo." }, { status: 400 });
		}

		const queued: string[] = [];
		let sendAfter = new Date(); // first message goes immediately (send_after = null below)
		let firstMessage = true;

		for (const agent of agents) {
			const jid = `${agent.phone}@s.whatsapp.net`;
			const existing = await getConversationByPhone(agent.phone);
			const isNew = !existing;
			const conversation = existing ?? await getOrCreateConversation(agent.phone, jid, agent.name);

			await enqueueOutbox(
				conversation.id,
				agent.phone,
				message,
				{ send_after: firstMessage ? null : sendAfter },
			);
			queued.push(agent.phone);

			// Accumulate delay for the next recipient
			const delay = isNew ? NEW_CONV_DELAY_MS : EXISTING_DELAY_MS;
			sendAfter = new Date(sendAfter.getTime() + delay);
			firstMessage = false;
		}

		return NextResponse.json({ ok: true, queued });
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		console.error("[api] Error en POST /api/broadcast/mass:", error);
		return NextResponse.json({ ok: false, error: error.message || "Internal Server Error" }, { status: 500 });
	}
}
