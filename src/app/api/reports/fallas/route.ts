import { NextResponse } from "next/server";

import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { listGroupFailureReports, listNearMissIntents } from "@/lib/db";

export async function GET(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "restricted");

		const [groupFailureReports, nearMissIntents] = await Promise.all([
			listGroupFailureReports(100),
			listNearMissIntents(100),
		]);

		return NextResponse.json({ groupFailureReports, nearMissIntents });
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		console.error("[api] Error en GET /api/reports/fallas:", error);
		return NextResponse.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
