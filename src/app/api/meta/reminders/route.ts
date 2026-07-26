import { NextResponse } from "next/server";

import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { insertMetaReminderSent, listMetaRemindersSent } from "@/lib/db";

/**
 * POST /api/meta/reminders
 * Llamado por el workflow de GitHub Actions del proyecto recordatorios-turnos
 * después de cada envío (exitoso o fallido) por WhatsApp Cloud API.
 *
 * Body: { apiKey, phone, name?, horaInicio?, etiquetaZona?, whatsappMessageId?, status?, detalle? }
 */
export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			apiKey?: string;
			phone?: string;
			name?: string;
			horaInicio?: string;
			etiquetaZona?: string;
			whatsappMessageId?: string;
			status?: string;
			detalle?: string;
		};

		const expectedKey = process.env.META_REMINDERS_API_KEY;
		if (expectedKey && body.apiKey !== expectedKey) {
			return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
		}

		if (!body.phone) {
			return NextResponse.json({ ok: false, error: "phone requerido" }, { status: 400 });
		}

		const row = await insertMetaReminderSent({
			phone: body.phone,
			name: body.name,
			horaInicio: body.horaInicio,
			etiquetaZona: body.etiquetaZona,
			whatsappMessageId: body.whatsappMessageId,
			status: body.status,
			detalle: body.detalle,
		});

		return NextResponse.json({ ok: true, row });
	} catch (error: any) {
		console.error("[api] Error en POST /api/meta/reminders:", error);
		return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
	}
}

export async function GET(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "restricted");

		const { searchParams } = new URL(req.url);
		const date = searchParams.get("date") || undefined;

		const reminders = await listMetaRemindersSent(200, date ? { date } : undefined);

		return NextResponse.json({ reminders });
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		console.error("[api] Error en GET /api/meta/reminders:", error);
		return NextResponse.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
