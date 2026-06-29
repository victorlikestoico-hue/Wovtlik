import { NextResponse } from "next/server";
import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { listFormAgents, getOrCreateConversation, enqueueOutbox } from "@/lib/db";

const FORM_URL =
	"https://docs.google.com/forms/d/e/1FAIpQLSfAhKXTXOHL6ftaFhaXjy8QTRLxBgVM4MY885iA74-PQdB0qw/viewform";

function buildFormMessage(name: string): string {
	return `Hola ${name}! 👋 Recuerda diligenciar el formulario mensual antes del día 10:\n${FORM_URL}`;
}

/**
 * POST /api/broadcast/form
 * Encola el formulario mensual en el outbox para todos los agentes del formulario.
 * El bot lo enviará con el espaciado anti-spam habitual (3-8 s entre mensajes).
 * Requiere rol manager.
 *
 * Body opcional: { phone?: string }  — si se pasa, solo envía a ese número (prueba unitaria).
 */
export async function POST(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "manager");

		const body = await req.json().catch(() => ({})) as { phone?: string };
		const testPhone = body.phone?.replace(/\D/g, "") || null;

		const allAgents = await listFormAgents();
		const targets = testPhone
			? allAgents.filter((a) => a.phone === testPhone)
			: allAgents;

		if (targets.length === 0) {
			return NextResponse.json(
				{ ok: false, error: testPhone ? "El número indicado no está en la lista de agentes." : "No hay agentes configurados." },
				{ status: 400 },
			);
		}

		const queued: string[] = [];
		for (const agent of targets) {
			const jid = `${agent.phone}@s.whatsapp.net`;
			const conversation = await getOrCreateConversation(agent.phone, jid, agent.name);
			await enqueueOutbox(conversation.id, agent.phone, buildFormMessage(agent.name));
			queued.push(agent.phone);
		}

		return NextResponse.json({ ok: true, queued });
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		console.error("[api] Error en POST /api/broadcast/form:", error);
		return NextResponse.json(
			{ ok: false, error: error.message || "Internal Server Error" },
			{ status: 500 },
		);
	}
}
