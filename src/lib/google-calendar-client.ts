// Auth de Google Calendar vía OAuth2 (authorization code + refresh token), no service account:
// la API de Calendar no deja escribir en un calendario personal con una service account a menos
// que haya Domain-Wide Delegation (requiere Google Workspace), así que el dueño del calendario
// autoriza una vez vía /api/google-oauth/start y el refresh_token resultante vive en `settings`.

let _token: { value: string; expiresAt: number; refreshTokenUsed: string } | null = null;

async function getAccessToken(refreshToken: string): Promise<string> {
	if (
		_token &&
		_token.refreshTokenUsed === refreshToken &&
		Date.now() < _token.expiresAt - 60_000
	) {
		return _token.value;
	}

	const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
	const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";

	const res = await fetch("https://oauth2.googleapis.com/token", {
		method:  "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body:    new URLSearchParams({
			grant_type:    "refresh_token",
			client_id:     clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
		}),
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) {
		throw new Error(`[calendar] OAuth refresh error ${res.status}: ${(await res.text()).substring(0, 200)}`);
	}
	const d = await res.json() as { access_token: string; expires_in: number };
	_token = { value: d.access_token, expiresAt: Date.now() + d.expires_in * 1000, refreshTokenUsed: refreshToken };
	return _token.value;
}

function hasOAuthConfig(refreshToken: string): boolean {
	return !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET && !!refreshToken;
}

export interface CreateEventInput {
	calendarId: string;
	summary: string;
	description?: string;
	startISO: string; // "2026-06-24T15:00:00" (sin sufijo Z, se interpreta en timeZone)
	endISO: string;
	timeZone?: string;
	refreshToken: string;
}

export interface CalendarEventResult {
	id: string;
	htmlLink: string;
}

export async function createCalendarEvent(input: CreateEventInput): Promise<CalendarEventResult | null> {
	if (!input.calendarId || !hasOAuthConfig(input.refreshToken)) return null;

	try {
		const token = await getAccessToken(input.refreshToken);
		const timeZone = input.timeZone ?? "America/Argentina/Buenos_Aires";
		const body = {
			summary: input.summary,
			description: input.description ?? "",
			start: { dateTime: input.startISO, timeZone },
			end:   { dateTime: input.endISO, timeZone },
			reminders: { useDefault: false, overrides: [] as unknown[] },
		};
		const res = await fetch(
			`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events`,
			{
				method:  "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body:    JSON.stringify(body),
				signal:  AbortSignal.timeout(10_000),
			},
		);
		if (!res.ok) {
			console.error(`[calendar] Create event error ${res.status}:`, (await res.text()).substring(0, 200));
			return null;
		}
		const data = await res.json() as { id: string; htmlLink: string };
		return { id: data.id, htmlLink: data.htmlLink };
	} catch (err) {
		console.error("[calendar] createCalendarEvent error:", err);
		return null;
	}
}

export async function deleteCalendarEvent(
	calendarId: string,
	eventId: string,
	refreshToken: string,
): Promise<boolean> {
	if (!calendarId || !eventId || !hasOAuthConfig(refreshToken)) return false;

	try {
		const token = await getAccessToken(refreshToken);
		const res = await fetch(
			`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			{ method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
		);
		return res.ok || res.status === 410; // 410 Gone = ya estaba borrado
	} catch (err) {
		console.error("[calendar] deleteCalendarEvent error:", err);
		return false;
	}
}
