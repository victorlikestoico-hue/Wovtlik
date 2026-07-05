import "./env-loader.ts";
import { Redis } from "ioredis";
import { getSettings } from "../src/lib/db.ts";
import { getHorasCubrir, isHoraCubrirHHEE, normalizeFecha, type HoraCubrirEntry } from "../src/lib/sheets-client.ts";
import { generateCreativeText } from "../src/lib/ai-providers.ts";
import { isWithinColombiaSendWindow, msUntilNextTopOfHour, currentDateColombiaISO } from "../src/lib/colombia-schedule.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

const HORAS_CUBRIR_COOLDOWN_KEY = "bot:horas_cubrir_last_sent";
// Traba para no duplicar el envío si el bot se reinicia varias veces dentro de la
// ventana de 1h (deploys, crashes, etc.), igual que fallas-template-cron.
const HORAS_CUBRIR_COOLDOWN_SECONDS = 60 * 60;

const ANUNCIOS_HORAS_GROUP_JID = "120363048382543444@g.us";

// Reintento corto cuando el socket todavía no terminó de autenticarse (recién arrancado el proceso).
const HORAS_CUBRIR_NOT_READY_RETRY_MS = 30_000;

/** Parsea "HH:mm - HH:mm" a cantidad de horas, soportando turnos que cruzan medianoche. */
function parseHorarioHours(horario: string): number | null {
	const m = horario.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
	if (!m) return null;
	const start = parseInt(m[1]) * 60 + parseInt(m[2]);
	let end = parseInt(m[3]) * 60 + parseInt(m[4]);
	if (end <= start) end += 24 * 60;
	return (end - start) / 60;
}

function sumHours(slots: HoraCubrirEntry[]): number {
	return slots.reduce((total, s) => total + (parseHorarioHours(s.horario) ?? 0), 0);
}

function buildPrompt(entries: HoraCubrirEntry[]): string {
	const today = currentDateColombiaISO();
	const fmtSlot = (s: HoraCubrirEntry) => {
		const isToday = normalizeFecha(s.fecha) === today;
		return `${s.fecha} ${s.horario}${isToday ? " (HOY)" : ""}`;
	};

	const byLob = new Map<string, { hhee: HoraCubrirEntry[]; normal: HoraCubrirEntry[] }>();
	for (const e of entries) {
		const lob = e.lob || "Sin LOB especificado";
		if (!byLob.has(lob)) byLob.set(lob, { hhee: [], normal: [] });
		const bucket = byLob.get(lob)!;
		(isHoraCubrirHHEE(e) ? bucket.hhee : bucket.normal).push(e);
	}

	const resumen = [...byLob.entries()]
		.map(([lob, { hhee, normal }]) => {
			const partes: string[] = [];
			if (hhee.length) {
				partes.push(`${sumHours(hhee)}h HHEE (pagan plus) — ${hhee.map(fmtSlot).join(", ")}`);
			}
			if (normal.length) {
				partes.push(`${sumHours(normal)}h normales, NO son HHEE — ${normal.map(fmtSlot).join(", ")}`);
			}
			return `- ${lob}: ${partes.join(" | ")}`;
		})
		.join("\n");

	return [
		"Sos el asistente que anuncia horas disponibles para cubrir, en un grupo de WhatsApp de agentes de Customer Success que trabajan 100% desde casa (home office).",
		`Hoy es ${today} (hora Colombia). A continuación tenés, por LOB, las horas sin cubrir ya separadas en dos grupos: HHEE (pagan un plus) y normales (NO pagan extra). Los turnos marcados con "(HOY)" son del día de hoy.`,
		"CRÍTICO: nunca sumes, mezcles ni generalices las horas HHEE con las normales de un mismo LOB ni de LOBs distintos — son conceptos de pago distintos y deben quedar diferenciados en el mensaje.",
		"No recalcules los totales de horas: usá tal cual los números que te paso, no los reinterpretes ni los redondees.",
		"CRÍTICO: mostrá TODAS las horas de la lista (de hoy y de otros días), pero priorizá y resaltá primero, con más énfasis, las que son de HOY (son las más urgentes de cubrir). Las de otros días van después, en un tono más secundario.",
		"Con esa información, escribí UN solo mensaje para WhatsApp, creativo, ingenioso y breve, con emojis, que motive a los agentes a anotarse.",
		"El tono tiene que sonar MUY colombiano: usá expresiones, calidez y jerga típica de Colombia (ej. \"parcero\", \"qué chimba\", \"listo pues\", \"de una\", \"bacano\", \"a la orden\"), sin exagerar ni sonar forzado.",
		"Vendé el plan aprovechando que son agentes de home office: destacá que pueden cubrir estas horas sin salir de la casa, en pijama, sin transporte ni tráfico, ganando plata extra desde su propio puesto.",
		"Nombrá explícitamente TODOS los LOBs de la lista, indicando para cada uno cuántas horas HHEE y cuántas normales hay (omití el grupo que esté vacío en ese LOB). Dejá claro que las HHEE pagan más que las normales.",
		"CRÍTICO: el mensaje SIEMPRE tiene que indicar que estas horas están disponibles para anotarse en el aplicativo de cambios de turno, en la sección *Horas Disponibles*. No omitas esto en ningún mensaje.",
		"No inventes datos que no estén en la lista.",
		"Usá formato de WhatsApp para negrita (un asterisco de cada lado, ej: *texto*), nunca markdown tipo ** o ##.",
		"No agregues instrucciones de cómo anotarse (eso ya lo sabe el equipo). Devolvé solo el texto final del mensaje, sin comillas ni bloques de código.",
		"",
		"LOBs con horas sin cubrir:",
		resumen,
	].join("\n");
}

export async function runHorasCubrirCronOnce(): Promise<"sent" | "skipped" | "empty" | "not_ready" | "outside_window" | "error"> {
	try {
		// Solo se envía entre 6am y 12am (medianoche) hora Colombia.
		if (!isWithinColombiaSendWindow()) return "outside_window";

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
	console.log("[horas-cubrir-cron] Iniciando loop de anuncio de horas a cubrir (cada hora en punto, 6am-12am Colombia)...");
	const tick = async () => {
		const result = await runHorasCubrirCronOnce();
		const delay = result === "not_ready" ? HORAS_CUBRIR_NOT_READY_RETRY_MS : msUntilNextTopOfHour();
		setTimeout(tick, delay);
	};
	// Primer tick alineado al próximo HH:00 en punto, no al instante en que arrancó el proceso.
	setTimeout(tick, msUntilNextTopOfHour());
}
