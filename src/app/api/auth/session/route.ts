import { NextResponse } from "next/server";

import { getSessionFromRequest } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";

export async function GET(req: Request) {
	const session = await getSessionFromRequest(req, authDeps);
	if (!session) {
		return NextResponse.json({ error: "auth_unauthorized" }, { status: 401 });
	}

	return NextResponse.json({
		email: session.user.email,
		role: session.role,
	});
}
