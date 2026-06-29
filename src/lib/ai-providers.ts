import {
	parseFollowUpDecision,
	parseNormalReply,
	type FollowUpDecisionParseResult,
	type NormalReplyParseResult,
} from "../domain/whatsapp-rules.ts";
import {
	createDeepSeekClient,
	type DeepSeekFetch,
	type FollowUpRequest,
	type LeadQualificationRequest,
	type NormalReplyRequest,
} from "./deepseek-client.ts";

type ProviderCapability = "chat" | "audio" | "image";
type AiProvider = "openai" | "google" | "deepseek";

export interface AiProviderSettings {
	baseUrl: string;
	apiKey: string;
	model: string;
}

const DEFAULT_PROVIDER_CONFIG: Record<
	AiProvider,
	{ baseUrl: string; chatModel: string; audioModel: string; imageModel: string }
> = {
	openai: {
		baseUrl: "https://api.openai.com/v1",
		chatModel: "gpt-4o-mini",
		audioModel: "gpt-4o-transcribe",
		imageModel: "gpt-4o-mini",
	},
	google: {
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		chatModel: "gemini-3.5-flash",
		audioModel: "gemini-3.5-flash",
		imageModel: "gemini-3.5-flash",
	},
	deepseek: {
		baseUrl: "https://api.deepseek.com",
		chatModel: "deepseek-v4-pro",
		audioModel: "",
		imageModel: "",
	},
};

function cleanBaseUrl(value: string): string {
	return value.trim().replace(/\/$/, "");
}

function settingString(
	settings: Record<string, unknown>,
	key: string,
	envKey: string,
	fallback = "",
): string {
	const value = settings[key];
	if (typeof value === "string" && value.trim()) return value.trim();
	const envValue = process.env[envKey];
	if (envValue?.trim()) return envValue.trim();
	return fallback;
}

function settingProvider(
	settings: Record<string, unknown>,
	key: string,
	envKey: string,
	fallback: AiProvider,
): AiProvider {
	const value = settingString(settings, key, envKey, fallback);
	return value === "openai" || value === "google" || value === "deepseek"
		? value
		: fallback;
}

function providerEnvApiKey(provider: AiProvider): string {
	if (provider === "openai") return process.env.OPENAI_API_KEY || "";
	if (provider === "google") return process.env.GEMINI_API_KEY || "";
	return process.env.DEEPSEEK_API_KEY || "";
}

export function providerSettingsFor(
	capability: ProviderCapability,
	settings: Record<string, unknown>,
): AiProviderSettings {
	if (capability === "chat") {
		const provider = settingProvider(
			settings,
			"chat_ai_provider",
			"CHAT_AI_PROVIDER",
			"deepseek",
		);
		const defaults = DEFAULT_PROVIDER_CONFIG[provider];
		return {
			baseUrl: cleanBaseUrl(
				process.env.CHAT_AI_BASE_URL ||
					process.env.DEEPSEEK_BASE_URL ||
					defaults.baseUrl,
			),
			apiKey: settingString(
				settings,
				"chat_ai_api_key",
				"CHAT_AI_API_KEY",
				providerEnvApiKey(provider),
			),
			model: settingString(
				settings,
				"chat_ai_model",
				"CHAT_AI_MODEL",
				process.env.DEEPSEEK_MODEL || defaults.chatModel,
			),
		};
	}

	if (capability === "audio") {
		const provider = settingProvider(
			settings,
			"audio_ai_provider",
			"AUDIO_AI_PROVIDER",
			"openai",
		);
		const defaults = DEFAULT_PROVIDER_CONFIG[provider === "deepseek" ? "openai" : provider];
		return {
			baseUrl: cleanBaseUrl(
				process.env.AUDIO_AI_BASE_URL || defaults.baseUrl,
			),
			apiKey: settingString(
				settings,
				"audio_ai_api_key",
				"AUDIO_AI_API_KEY",
				providerEnvApiKey(provider === "deepseek" ? "openai" : provider),
			),
			model: settingString(
				settings,
				"audio_ai_model",
				"AUDIO_AI_MODEL",
				defaults.audioModel,
			),
		};
	}

	const provider = settingProvider(
		settings,
		"image_ai_provider",
		"IMAGE_AI_PROVIDER",
		"openai",
	);
	const defaults = DEFAULT_PROVIDER_CONFIG[provider === "deepseek" ? "openai" : provider];
	return {
		baseUrl: cleanBaseUrl(
			process.env.IMAGE_AI_BASE_URL || defaults.baseUrl,
		),
		apiKey: settingString(
			settings,
			"image_ai_api_key",
			"IMAGE_AI_API_KEY",
			providerEnvApiKey(provider === "deepseek" ? "openai" : provider),
		),
		model: settingString(
			settings,
			"image_ai_model",
			"IMAGE_AI_MODEL",
			defaults.imageModel,
		),
	};
}

function providerFor(
	capability: ProviderCapability,
	settings: Record<string, unknown>,
): AiProvider {
	const fallback: AiProvider = capability === "chat" ? "deepseek" : "openai";
	const provider = settingProvider(
		settings,
		`${capability}_ai_provider`,
		`${capability.toUpperCase()}_AI_PROVIDER`,
		fallback,
	);
	if ((capability === "audio" || capability === "image") && provider === "deepseek") {
		throw new Error(`${capability}_ai_provider_not_supported`);
	}
	return provider;
}

export function createConfiguredChatClient(settings: Record<string, unknown>) {
	const providerName = providerFor("chat", settings);
	const provider = providerSettingsFor("chat", settings);
	if (providerName === "google") return createGoogleChatClient(provider);

	return createDeepSeekClient({
		apiKey: provider.apiKey,
		model: provider.model,
		baseUrl: provider.baseUrl,
		fetch: globalThis.fetch as DeepSeekFetch,
	});
}

function normalPrompt(input: NormalReplyRequest): string {
	return [
		`Sistema: ${input.systemPrompt}`,
		"Historial:",
		...input.history.map((item) => `${item.role}: ${item.content}`),
		"Responde usando JSON estricto sin markdown.",
		'Formato obligatorio: {"response":{"part_1":"...","part_2":"...","part_3":"..."},"handoff":{"required":false,"reason":""}}.',
		"Usa handoff.required=true si necesita humano.",
		`Mensajes del turno: ${input.queuedMessages.map((m) => m.text).join("\n")}`,
	].join("\n");
}

function followUpPrompt(input: FollowUpRequest): string {
	return [
		"Eres un asistente virtual de ventas. Analiza el historial y decide si amerita enviar un follow-up.",
		"Si el último mensaje es del cliente, devuelve respuesta='NO'.",
		"No repitas seguimientos anteriores. No respondas tus propias preguntas. No escribas análisis.",
		"Devuelve exclusivamente JSON estricto sin markdown:",
		'{"respuesta":"SI"|"NO","mensaje":"..."}',
		"Historial:",
		...input.history.map((item) => `${item.role}: ${item.content}`),
	].join("\n");
}

function qualificationPrompt(input: LeadQualificationRequest): string {
	return [
		"You are a lead qualification analyst for a WhatsApp CRM.",
		"Return strict JSON only with keys: intent, urgency, budget, fit, objections, next_step, qualification_status, confidence, reason.",
		"Historial:",
		...input.history.map((item) => `${item.role}: ${item.content}`),
	].join("\n");
}

function parseProviderQualification(raw: string) {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { ok: false as const, reason: "qualification_not_object" };
		}
		return { ok: true as const, ...(parsed as Record<string, unknown>) };
	} catch {
		return { ok: false as const, reason: "qualification_invalid_json" };
	}
}

function createGoogleChatClient(provider: AiProviderSettings) {
	async function generateContent(prompt: string) {
		requireProvider(provider, "chat");
		const response = await fetch(
			`${provider.baseUrl}/models/${provider.model}:generateContent?key=${encodeURIComponent(provider.apiKey)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: {
						temperature: 0.3,
						responseMimeType: "application/json",
					},
				}),
			},
		);
		if (!response.ok) return { ok: false as const, reason: `google_http_${response.status}` };
		const payload = await response.json();
		const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (typeof text !== "string") {
			return { ok: false as const, reason: "invalid_response_shape" };
		}
		return { ok: true as const, content: text };
	}

	async function request<T extends { ok: boolean }>(
		prompt: string,
		parse: (raw: string) => T,
	) {
		const first = await generateContent(prompt);
		if (!first.ok) {
			return {
				ok: false as const,
				reason: first.reason,
				sendRaw: false as const,
				attempts: 1,
				userMessage: "Google request failed safely; no raw model text is sendable.",
			};
		}
		const parsed = parse(first.content);
		if (parsed.ok) {
			return {
				ok: true as const,
				parsed,
				rawContent: first.content,
				attempts: 1,
			};
		}
		return {
			ok: false as const,
			reason: "google_json_invalid",
			sendRaw: false as const,
			attempts: 1,
			userMessage: "Google response was invalid JSON; no raw model text is sendable.",
		};
	}

	return {
		generateNormalReply(input: NormalReplyRequest) {
			return request<NormalReplyParseResult>(normalPrompt(input), parseNormalReply);
		},
		generateFollowUpDecision(input: FollowUpRequest) {
			return request<FollowUpDecisionParseResult>(
				followUpPrompt(input),
				parseFollowUpDecision,
			);
		},
		qualifyLead(input: LeadQualificationRequest) {
			return request<ReturnType<typeof parseProviderQualification>>(
				qualificationPrompt(input),
				parseProviderQualification,
			);
		},
	};
}

function requireProvider(provider: AiProviderSettings, capability: ProviderCapability) {
	if (!provider.apiKey) {
		throw new Error(`${capability}_ai_api_key_missing`);
	}
}

/** Pide al proveedor de chat configurado un texto libre (sin esquema JSON), para mensajes creativos. */
export async function generateCreativeText(
	prompt: string,
	settings: Record<string, unknown>,
): Promise<string> {
	const providerName = providerFor("chat", settings);
	const provider = providerSettingsFor("chat", settings);
	requireProvider(provider, "chat");

	if (providerName === "google") {
		const response = await fetch(
			`${provider.baseUrl}/models/${provider.model}:generateContent?key=${encodeURIComponent(provider.apiKey)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: { temperature: 0.9 },
				}),
			},
		);
		if (!response.ok) throw new Error(`chat_ai_http_${response.status}`);
		const payload = await response.json();
		const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (typeof text !== "string" || !text.trim()) throw new Error("chat_ai_invalid_response");
		return text.trim();
	}

	const response = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${provider.apiKey}`,
		},
		body: JSON.stringify({
			model: provider.model,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.9,
		}),
	});
	if (!response.ok) throw new Error(`chat_ai_http_${response.status}`);
	const payload = await response.json();
	const text = payload?.choices?.[0]?.message?.content;
	if (typeof text !== "string" || !text.trim()) throw new Error("chat_ai_invalid_response");
	return text.trim();
}

export async function transcribeAudio(input: {
	buffer: Buffer;
	mimeType?: string;
	settings: Record<string, unknown>;
}): Promise<string> {
	const providerName = providerFor("audio", input.settings);
	const provider = providerSettingsFor("audio", input.settings);
	requireProvider(provider, "audio");

	if (providerName === "google") {
		// Gemini no acepta audio/ogg — remapear al formato compatible más cercano
		const rawMime = input.mimeType || "audio/ogg";
		const geminiMime = rawMime.startsWith("audio/ogg") ? "audio/webm" : rawMime;
		const response = await fetch(
			`${provider.baseUrl}/models/${provider.model}:generateContent?key=${encodeURIComponent(provider.apiKey)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					contents: [
						{
							parts: [
								{
									inline_data: {
										mime_type: geminiMime,
										data: input.buffer.toString("base64"),
									},
								},
								{ text: "Transcribe este audio. Devuelve solo el texto hablado." },
							],
						},
					],
				}),
			},
		);
		if (!response.ok) {
			const errBody = await response.text().catch(() => "");
			throw new Error(`audio_ai_http_${response.status}: ${errBody.slice(0, 300)}`);
		}
		const payload = await response.json();
		const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (typeof text === "string" && text.trim()) return text.trim();
		throw new Error("audio_ai_invalid_response");
	}

	const form = new FormData();
	form.append("model", provider.model);
	form.append(
		"file",
		new Blob([new Uint8Array(input.buffer)], {
			type: input.mimeType || "audio/ogg",
		}),
		"audio.ogg",
	);

	const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
		method: "POST",
		headers: { authorization: `Bearer ${provider.apiKey}` },
		body: form,
	});
	if (!response.ok) throw new Error(`audio_ai_http_${response.status}`);

	const payload = await response.json();
	if (
		typeof payload === "object" &&
		payload !== null &&
		"text" in payload &&
		typeof payload.text === "string"
	) {
		return payload.text.trim();
	}
	throw new Error("audio_ai_invalid_response");
}

export async function describeImage(input: {
	buffer: Buffer;
	mimeType?: string;
	settings: Record<string, unknown>;
}): Promise<string> {
	const providerName = providerFor("image", input.settings);
	const provider = providerSettingsFor("image", input.settings);
	requireProvider(provider, "image");

	const mimeType = input.mimeType || "image/jpeg";
	if (providerName === "google") {
		const response = await fetch(
			`${provider.baseUrl}/models/${provider.model}:generateContent?key=${encodeURIComponent(provider.apiKey)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					contents: [
						{
							parts: [
								{
									inline_data: {
										mime_type: mimeType,
										data: input.buffer.toString("base64"),
									},
								},
								{
									text: "Describe esta imagen de WhatsApp de forma breve y útil para que un asistente pueda responder al cliente.",
								},
							],
						},
					],
				}),
			},
		);
		if (!response.ok) throw new Error(`image_ai_http_${response.status}`);
		const payload = await response.json();
		const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (typeof text === "string" && text.trim()) return text.trim();
		throw new Error("image_ai_invalid_response");
	}

	const imageUrl = `data:${mimeType};base64,${input.buffer.toString("base64")}`;
	const response = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${provider.apiKey}`,
		},
		body: JSON.stringify({
			model: provider.model,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Describe esta imagen de WhatsApp de forma breve y útil para que un asistente pueda responder al cliente.",
						},
						{ type: "image_url", image_url: { url: imageUrl } },
					],
				},
			],
			temperature: 0.2,
		}),
	});
	if (!response.ok) throw new Error(`image_ai_http_${response.status}`);

	const payload = await response.json();
	const first = payload?.choices?.[0]?.message?.content;
	if (typeof first === "string" && first.trim()) return first.trim();
	throw new Error("image_ai_invalid_response");
}
