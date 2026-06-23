import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";

export async function GET(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "owner");

		const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
		const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
		if (!clientId || !redirectUri) {
			return NextResponse.json(
				{ error: "Falta configurar GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_REDIRECT_URI." },
				{ status: 500 },
			);
		}

		const state = randomBytes(16).toString("hex");
		const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		authUrl.searchParams.set("client_id", clientId);
		authUrl.searchParams.set("redirect_uri", redirectUri);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar");
		authUrl.searchParams.set("access_type", "offline");
		authUrl.searchParams.set("prompt", "consent");
		authUrl.searchParams.set("state", state);

		const response = NextResponse.redirect(authUrl.toString());
		response.cookies.set("google_oauth_state", state, {
			httpOnly: true,
			secure: process.env.NODE_ENV === "production",
			sameSite: "lax",
			path: "/",
			maxAge: 600,
		});
		return response;
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		console.error("[api] Error en GET /api/google-oauth/start:", error);
		return NextResponse.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
