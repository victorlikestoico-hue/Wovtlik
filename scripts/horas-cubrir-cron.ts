import "./env-loader.ts";
import { Redis } from "ioredis";
import { getSettings } from "../src/lib/db.ts";
import { getHorasCubrir, type HoraCubrirEntry } from "../src/lib/sheets-client.ts";
import { generateCreativeText } from "../src/lib/ai-providers.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

const HORAS_CUBRIR_INTERVAL_MS = 60 * 60 * 1000; // 1 hora
const HORAS_CUBRIR_COOLDOWN_KEY = "bot:horas_cubrir_last_sent";
// Traba para no duplicar el envío si el bot se reinicia varias veces dentro de la
// ventana de 1h (deploys, crashes, etc.), igual que fallas-template-cron.
const HORAS_CUBRIR_COOLDOWN_SECONDS = 60 * 60;

const ANUNCIOS_HORAS_GROUP_JID = "120363048382543444@g.us";

// Reintento corto cuando el socket todavía no terminó de autenticarse (recién arrancado el proceso).
const HORAS_CUBRIR_NOT_READY_RETRY_MS = 30_000;

function buildPrompt(entries: HoraCubrirEntry[]): string {
	const byLob = new Map<string, HoraCubrirEntry[]>();
	for (const e of entries) {
		const lob = e.lob || "Sin LOB especificado";
		if (!byLob.has(lob)) byLob.set(lob, []);
		byLob.get(lob)!.push(e);
	}

	const resumen = [...byLob.entries()]
		.map(([lob, slots]) => {
			const detalle = slots.map((s) => `${s.fecha} ${s.horario}`).join(", ");
			return `- ${lob}: ${slots.length} hora(s) sin cubrir (${detalle})`;
		})
		.join("\n");

	return [
		"Sos el asistente que anuncia horas extra (HHEE) disponibles para cubrir, en un grupo de WhatsApp de agentes de Customer Success.",
		"Con la siguiente información de LOBs (líneas de negocio) con horas pendientes de cubrir, escribí UN solo mensaje para WhatsApp.",
		"El mensaje debe ser creativo, ingenioso y breve, con emojis, y debe motivar a los agentes a anotarse para cubrir esas horas.",
		"Nombrá explícitamente TODOS los LOBs con horas disponibles de la lista. No inventes datos que no estén en la lista.",
		"Usá formato de WhatsApp para negrita (un asterisco de cada lado, ej: *texto*), nunca markdown tipo ** o ##.",
		"No agregues instrucciones de cómo anotarse (eso ya lo sabe el equipo). Devolvé solo el texto final del mensaje, sin comillas ni bloques de código.",
		"",
		"LOBs con horas sin cubrir:",
		resumen,
	].join("\n");
}

export async function runHorasCubrirCronOnce(): Promise<"sent" | "skipped" | "empty" | "not_ready" | "error"> {
	try {
		const alreadySent = await redisClient.get(HORAS_CUBRIR_COOLDOWN_KEY);
		if (alreadySent) return "skipped";

		const { globalSock } = await import("../src/lib/baileys/client.ts");
		// sock.user.id solo existe una vez que la conexión terminó de autenticarse;
		// globalSock por sí solo ya existe apenas se crea el socket, antes de eso.
		if (!globalSock?.user?.id) {
			console.warn("[horas-cubrir-cron] Socket todavía no autenticado, reintento en breve.");
			return "not_ready";
		}

		const settings = await getSettings();
		const id1 = (settings.programacion_1_id as string) || "";
		const id2 = (settings.programacion_2_id as string) || "";
		const ids = [...new Set([id1, id2].filter(Boolean))];
		if (!ids.length) {
			console.warn("[horas-cubrir-cron] Programaciones no configuradas, se omite el ciclo.");
			return "error";
		}

		const entries = await getHorasCubrir(ids);
		if (!entries.length) return "empty";

		const message = await generateCreativeText(buildPrompt(entries), settings);

		await globalSock.sendMessage(ANUNCIOS_HORAS_GROUP_JID, { text: message });
		await redisClient.set(HORAS_CUBRIR_COOLDOWN_KEY, Date.now().toString(), "EX", HORAS_CUBRIR_COOLDOWN_SECONDS);
		return "sent";
	} catch (err) {
		console.error("[horas-cubrir-cron] Error crítico ejecutando el tick:", err);
		return "error";
	}
}

export function startHorasCubrirCron(): void {
	console.log("[horas-cubrir-cron] Iniciando loop de anuncio de horas a cubrir (cada 1h)...");
	const tick = async () => {
		const result = await runHorasCubrirCronOnce();
		const delay = result === "not_ready" ? HORAS_CUBRIR_NOT_READY_RETRY_MS : HORAS_CUBRIR_INTERVAL_MS;
		setTimeout(tick, delay);
	};
	tick();
}
