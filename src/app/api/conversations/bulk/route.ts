import { NextResponse } from "next/server";
import { bulkDeleteConversations } from "../../../../lib/db.ts";

export async function DELETE(req: Request) {
	try {
		const { searchParams } = new URL(req.url);
		const archived = searchParams.get("archived") === "true";
		const deleted = await bulkDeleteConversations(archived);
		return NextResponse.json({ ok: true, deleted });
	} catch (error: any) {
		console.error("[api] Error en DELETE /api/conversations/bulk:", error);
		return NextResponse.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
