import { NextResponse } from "next/server";
import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { deleteBroadcastAgent } from "@/lib/db";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		await requireRequestRole(req, authDeps, "manager");
		const { id } = await params;
		const deleted = await deleteBroadcastAgent(Number(id));
		if (!deleted) return NextResponse.json({ error: "Agente no encontrado" }, { status: 404 });
		return NextResponse.json({ ok: true });
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
}
