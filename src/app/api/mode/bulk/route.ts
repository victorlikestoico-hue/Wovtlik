import { NextResponse } from "next/server";
import { bulkSetMode } from "../../../../lib/db.ts";

export async function POST(req: Request) {
	try {
		const body = await req.json();
		const { mode, archived = false } = body;

		if (mode !== "AI" && mode !== "HUMAN") {
			return NextResponse.json(
				{ error: "Invalid mode. Must be 'AI' or 'HUMAN'" },
				{ status: 400 },
			);
		}

		const updated = await bulkSetMode(mode, archived);
		return NextResponse.json({ ok: true, updated, mode });
	} catch (error: any) {
		console.error("[api] Error en POST /api/mode/bulk:", error);
		return NextResponse.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
