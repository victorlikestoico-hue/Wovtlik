import { NextResponse } from "next/server";

import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { setSetting } from "@/lib/db";

export async function GET(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "owner");

		const url = new URL(req.url);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const oauthError = url.searchParams.get("error");

		if (oauthError) {
			return NextResponse.json({ error: `Google denegó la autorización: ${oauthError}` }, { status: 400 });
		}
		if (!code) {
			return NextResponse.json({ error: "Falta el parámetro 'code' en la respuesta de Google." }, { status: 400 });
		}

		const cookieState = req.headers.get("cookie")?.match(/google_oauth_state=([^;]+)/)?.[1];
		if (!state || !cookieState || state !== cookieState) {
			return NextResponse.json(
				{ error: "Estado OAuth inválido o expirado. Iniciá el flujo de nuevo desde /api/google-oauth/start." },
				{ status: 400 },
			);
		}

		const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
		const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
		const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
		if (!clientId || !clientSecret || !redirectUri) {
			return NextResponse.json(
				{ error: "Falta configurar GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI." },
				{ status: 500 },
			);
		}

		const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
			method:  "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body:    new URLSearchParams({
				code,
				client_id:     clientId,
				client_secret: clientSecret,
				redirect_uri:  redirectUri,
				grant_type:    "authorization_code",
			}),
			signal: AbortSignal.timeout(10_000),
		});
		if (!tokenRes.ok) {
			console.error("[google-oauth] Token exchange failed:", (await tokenRes.text()).substring(0, 300));
			return NextResponse.json({ error: "No se pudo intercambiar el código por un token con Google." }, { status: 502 });
		}

		const data = (await tokenRes.json()) as { refresh_token?: string; access_token: string };
		if (!data.refresh_token) {
			return NextResponse.json(
				{
					error:
						"Google no devolvió un refresh_token (probablemente ya habías autorizado antes). " +
						"Revocá el acceso en https://myaccount.google.com/permissions y volvé a intentar.",
				},
				{ status: 400 },
			);
		}

		await setSetting("google_oauth_refresh_token", data.refresh_token);

		const response = NextResponse.json({
			ok: true,
			message: "Google Calendar conectado correctamente. Ya podés cerrar esta pestaña.",
		});
		response.cookies.set("google_oauth_state", "", { path: "/", maxAge: 0 });
		return response;
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		console.error("[api] Error en GET /api/google-oauth/callback:", error);
		return NextResponse.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
