import type { Redis } from "ioredis";

const TTL_SECONDS = 48 * 60 * 60;
const MAX_KEY_LENGTH = 200;
const MIN_QUESTION_LENGTH = 8;

// Consultas personales o de acción → no cachear
const NON_CACHEABLE_PATTERNS = [
	/\b(mi|mis)\b/,
	/\bcorreo\b/,
	/\bemail\b/,
	/\beliminar?\b/,
	/\bborrar?\b/,
	/\bquitar\b/,
	/\bponme\b/,
	/\binactivame\b/,
];

function normalizeQuestion(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^\w\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_KEY_LENGTH);
}

export function isCacheable(text: string): boolean {
	if (text.trim().length < MIN_QUESTION_LENGTH) return false;
	const n = normalizeQuestion(text);
	return !NON_CACHEABLE_PATTERNS.some((p) => p.test(n));
}

export async function getCachedResponse(redis: Redis, question: string): Promise<string | null> {
	try {
		return await redis.get(`bot:qa_cache:${normalizeQuestion(question)}`);
	} catch {
		return null;
	}
}

export async function setCachedResponse(redis: Redis, question: string, response: string): Promise<void> {
	try {
		await redis.set(
			`bot:qa_cache:${normalizeQuestion(question)}`,
			response,
			"EX",
			TTL_SECONDS,
		);
	} catch {
		// no interrumpir el flujo por errores de caché
	}
}
