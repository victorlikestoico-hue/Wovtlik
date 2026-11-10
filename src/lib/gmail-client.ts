// Envío de correos vía Gmail API con el mismo OAuth (refresh_token en settings) que usa Google
// Calendar — el correo sale desde la cuenta que autorizó /api/google-oauth/start, que pide los
// scopes calendar + gmail.send. Un refresh_token obtenido antes de sumar gmail.send devuelve 403
// (insufficientPermissions) hasta que se vuelva a autorizar.
import { getAccessToken } from "./google-calendar-client.ts";

export interface SendMailInput {
	to: string;
	subject: string;
	html: string;
	refreshToken: string;
}

export class GmailNotConfiguredError extends Error {}

function encodeHeader(value: string): string {
	return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

export async function sendGmail(input: SendMailInput): Promise<void> {
	if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET || !input.refreshToken) {
		throw new GmailNotConfiguredError("Gmail no configurado (falta OAuth client o refresh_token)");
	}

	const body = Buffer.from(input.html, "utf-8").toString("base64").replace(/.{76}/g, "$&\r\n");
	const mime = [
		`To: ${input.to}`,
		`Subject: ${encodeHeader(input.subject)}`,
		"MIME-Version: 1.0",
		'Content-Type: text/html; charset="UTF-8"',
		"Content-Transfer-Encoding: base64",
		"",
		body,
	].join("\r\n");

	const token = await getAccessToken(input.refreshToken);
	const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ raw: Buffer.from(mime, "utf-8").toString("base64url") }),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) {
		const text = (await res.text()).substring(0, 300);
		if (res.status === 403 && /insufficient/i.test(text)) {
			throw new GmailNotConfiguredError(
				"El refresh_token no tiene el scope gmail.send — volver a autorizar en /api/google-oauth/start",
			);
		}
		throw new Error(`[gmail] Send error ${res.status}: ${text}`);
	}
}
