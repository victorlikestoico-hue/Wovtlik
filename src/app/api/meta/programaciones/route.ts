import { NextResponse } from "next/server";

import { getSettings } from "@/lib/db";

/**
 * GET /api/meta/programaciones
 * Consultado por el cron de GitHub Actions del proyecto recordatorios-turnos en cada
 * corrida para obtener los IDs de programación vigentes (se editan en el panel de
 * Settings de WOpen, no hay que tocar el código de recordatorios-turnos cada semana).
 *
 * Auth: ?apiKey=... (misma API key que /api/meta/reminders).
 */
export async function GET(req: Request) {
	try {
		const { searchParams } = new URL(req.url);
		const apiKey = searchParams.get("apiKey");

		const expectedKey = process.env.META_REMINDERS_API_KEY;
		if (expectedKey && apiKey !== expectedKey) {
			return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
		}

		const settings = await getSettings();

		return NextResponse.json({
			ok: true,
			programacion_1_id: (settings.programacion_1_id as string) || "",
			programacion_2_id: (settings.programacion_2_id as string) || "",
		});
	} catch (error: any) {
		console.error("[api] Error en GET /api/meta/programaciones:", error);
		return NextResponse.json(
			{ ok: false, error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
