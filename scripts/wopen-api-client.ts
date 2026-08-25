import "./env-loader.ts";

const BASE_URL = process.env.WOPEN_BASE_URL || "https://wovtlik-production.up.railway.app";

async function login(): Promise<string> {
	const email = process.env.ADMIN_EMAIL;
	const password = process.env.ADMIN_PASSWORD;
	if (!email || !password) {
		throw new Error("Faltan ADMIN_EMAIL / ADMIN_PASSWORD en el .env local.");
	}
	const res = await fetch(`${BASE_URL}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	if (!res.ok) {
		throw new Error(`Login falló (${res.status}): ${await res.text()}`);
	}
	const setCookie = res.headers.get("set-cookie");
	const match = setCookie?.match(/bot_session=[^;]+/);
	if (!match) {
		throw new Error("Login OK pero no se recibió la cookie bot_session.");
	}
	return match[0];
}

export async function callWOpenApi<T = any>(
	pathname: string,
	options: { method?: string; body?: unknown } = {},
): Promise<T> {
	const cookie = await login();
	const res = await fetch(`${BASE_URL}${pathname}`, {
		method: options.method ?? "GET",
		headers: {
			"content-type": "application/json",
			cookie,
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const text = await res.text();
	const data = text ? JSON.parse(text) : null;
	if (!res.ok) {
		throw new Error(`API ${pathname} respondió ${res.status}: ${text}`);
	}
	return data;
}
