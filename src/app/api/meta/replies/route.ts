import { NextResponse } from "next/server";

import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { listMetaReplies } from "@/lib/db";

export async function GET(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "restricted");

		const { searchParams } = new URL(req.url);
		const date = searchParams.get("date") || undefined;

		const replies = await listMetaReplies(200, date ? { date } : undefined);

		return NextResponse.json({ replies });
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		console.error("[api] Error en GET /api/meta/replies:", error);
		return NextResponse.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
