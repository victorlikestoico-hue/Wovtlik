import { NextResponse } from "next/server";
import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { cancelBroadcastBatch } from "@/lib/db";

export async function POST(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "manager");
		const { batchId } = await req.json() as { batchId?: string };
		if (!batchId?.trim()) {
			return NextResponse.json({ error: "batchId requerido" }, { status: 400 });
		}
		const cancelled = await cancelBroadcastBatch(batchId);
		return NextResponse.json({ ok: true, cancelled });
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
}
