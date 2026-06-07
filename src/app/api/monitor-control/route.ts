import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db";
import { getMonitorConfig, setMonitorConfig } from "@/lib/sheets-client";

export async function GET() {
	try {
		const settings = await getSettings();
		const spreadsheetId = (settings.offline_queue_sheet_id as string) || "";
		if (!spreadsheetId) {
			return NextResponse.json({ enabled: false });
		}
		const val = await getMonitorConfig("whisper_monitoring", spreadsheetId);
		return NextResponse.json({ enabled: val === "true" });
	} catch (err) {
		return NextResponse.json({ enabled: false, error: String(err) }, { status: 500 });
	}
}

export async function POST(req: Request) {
	try {
		const { enabled } = await req.json() as { enabled: boolean };
		const settings = await getSettings();
		const spreadsheetId = (settings.offline_queue_sheet_id as string) || "";
		if (!spreadsheetId) {
			return NextResponse.json({ ok: false, error: "offline_queue_sheet_id no configurado" }, { status: 400 });
		}
		const ok = await setMonitorConfig("whisper_monitoring", enabled ? "true" : "false", spreadsheetId);
		return NextResponse.json({ ok, enabled });
	} catch (err) {
		return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
	}
}
