import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { listAgentsMaster, getConversationByPhone, getOrCreateConversation, enqueueOutbox } from "@/lib/db";
import { getWarmupPhase, isBroadcastBlocked } from "@/lib/warmup-throttle";

// Mínimos más conservadores que el pacing base de la cola: un broadcast idéntico a toda la
// planta de agentes es, aislado del resto de medidas anti-baneo, el patrón de mayor riesgo.
const MIN_DELAY_S = 45;
const MAX_DELAY_S = 600;
const DEFAULT_DELAY_S = 90;

/**
 * POST /api/broadcast/mass
 * Encola un mensaje libre a los agentes seleccionados (o todos si no se especifica).
 * Body: { message: string; selectedPhones?: string[] }
 */
export async function POST(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "manager");

		if (isBroadcastBlocked(await getWarmupPhase())) {
			return NextResponse.json(
				{ error: "El número está en período de calentamiento tras un relogin reciente. Reintentá más tarde." },
				{ status: 400 },
			);
		}

		const body = await req.json().catch(() => ({})) as { message?: string; selectedPhones?: string[]; delaySecs?: number };
		const message = body.message?.trim();
		if (!message) {
			return NextResponse.json({ error: "El campo message es requerido." }, { status: 400 });
		}

		const allAgents = await listAgentsMaster();
		if (allAgents.length === 0) {
			return NextResponse.json({ error: "No hay agentes en la lista maestra. Sincroniza desde Sheets primero." }, { status: 400 });
		}

		const selectedSet = body.selectedPhones && body.selectedPhones.length > 0
			? new Set(body.selectedPhones.map((p) => p.replace(/\D/g, "")))
			: null;

		const agents = selectedSet
			? allAgents.filter((a) => selectedSet.has(a.phone))
			: allAgents;

		if (agents.length === 0) {
			return NextResponse.json({ error: "Ningún agente seleccionado." }, { status: 400 });
		}

		const rawDelay = Number(body.delaySecs ?? DEFAULT_DELAY_S);
		const delayMs = Math.max(MIN_DELAY_S, Math.min(MAX_DELAY_S, isNaN(rawDelay) ? DEFAULT_DELAY_S : rawDelay)) * 1000;

		const batchId = randomUUID();
		const queued: string[] = [];
		let sendAfter = new Date();
		let firstMessage = true;

		for (const agent of agents) {
			const jid = `${agent.phone}@s.whatsapp.net`;
			const existing = await getConversationByPhone(agent.phone);
			const conversation = existing ?? await getOrCreateConversation(agent.phone, jid, agent.name);

			await enqueueOutbox(
				conversation.id,
				agent.phone,
				message,
				{ send_after: firstMessage ? null : sendAfter, broadcast_batch_id: batchId },
			);
			queued.push(agent.phone);

			sendAfter = new Date(sendAfter.getTime() + delayMs);
			firstMessage = false;
		}

		return NextResponse.json({ ok: true, queued, batchId });
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		console.error("[api] Error en POST /api/broadcast/mass:", error);
		return NextResponse.json({ ok: false, error: error.message || "Internal Server Error" }, { status: 500 });
	}
}
