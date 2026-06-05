import { NextResponse } from "next/server";
import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { getTeamSnapshot, getDailyReport, isDashBigConfigured } from "@/lib/dashbig-client";

export async function GET(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "viewer");

		if (!isDashBigConfigured()) {
			return NextResponse.json(
				{ error: "DashBig no está configurado. Agregá DASHBIG_WEBAPP_URL y DASHBIG_API_KEY." },
				{ status: 503 },
			);
		}

		const { searchParams } = new URL(req.url);
		const lob = searchParams.get("lob") || "all";
		const mode = searchParams.get("mode") || "snapshot"; // "snapshot" | "daily"
		const date = searchParams.get("date") || undefined;

		const data =
			mode === "daily"
				? await getDailyReport(lob, date)
				: await getTeamSnapshot(lob);

		if (!data) {
			return NextResponse.json(
				{ error: "No se pudieron obtener datos de DashBig." },
				{ status: 502 },
			);
		}

		return NextResponse.json(data);
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		console.error("[api] Error en GET /api/analytics/metrics:", error);
		return NextResponse.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
