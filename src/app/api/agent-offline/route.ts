import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db";
import { queueAgentOffline } from "@/lib/sheets-client";

export async function POST(req: Request) {
	try {
		const { email } = await req.json() as { email: string };
		if (!email?.trim()) {
			return NextResponse.json({ ok: false, error: "Email requerido" }, { status: 400 });
		}

		const settings = await getSettings();
		const spreadsheetId = (settings.offline_queue_sheet_id as string) || "";
		if (!spreadsheetId) {
			return NextResponse.json({ ok: false, error: "offline_queue_sheet_id no configurado" }, { status: 400 });
		}

		const queued = await queueAgentOffline(
			email.trim().toLowerCase(),
			"Manual desde panel de administración",
			spreadsheetId,
		);

		return NextResponse.json({ ok: queued.ok, email: email.trim().toLowerCase() });
	} catch (err) {
		return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
	}
}
