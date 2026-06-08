import { NextResponse } from "next/server";
import { listAgentProfiles, deleteAgentProfile } from "../../../lib/db.ts";

export async function GET() {
	try {
		const profiles = await listAgentProfiles();
		return NextResponse.json(profiles);
	} catch (error: any) {
		console.error("[api] Error en GET /api/agent-profiles:", error);
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}

export async function DELETE(req: Request) {
	try {
		const { searchParams } = new URL(req.url);
		const phone = searchParams.get("phone");
		if (!phone?.trim()) {
			return NextResponse.json({ error: "phone is required" }, { status: 400 });
		}
		const deleted = await deleteAgentProfile(phone.trim());
		if (!deleted) {
			return NextResponse.json({ error: "Profile not found" }, { status: 404 });
		}
		return NextResponse.json({ ok: true });
	} catch (error: any) {
		console.error("[api] Error en DELETE /api/agent-profiles:", error);
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}
