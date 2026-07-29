import "./env-loader.ts";
import { Redis } from "ioredis";
import { getSettings } from "../src/lib/db.ts";
import { getHorasCubrir, isHoraCubrirHHEE, normalizeFecha, type HoraCubrirEntry } from "../src/lib/sheets-client.ts";
import { generateCreativeText } from "../src/lib/ai-providers.ts";
import { currentDateColombiaISO, isWithinColombiaSendWindow, msUntilNextTopOfHour } from "../src/lib/colombia-schedule.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

const HORAS_CUBRIR_COOLDOWN_KEY = "bot:horas_cubrir_last_sent";
// Traba para no duplicar el envío si el bot se reinicia varias veces dentro de la
// ventana de 1h (deploys, crashes, etc.), igual que fallas-template-cron.
const HORAS_CUBRIR_COOLDOWN_SECONDS = 60 * 60;

// El listado completo y formal (con cada horario exacto) solo se manda una vez por día,
// en el primer tick del día que tenga horas para anunciar. Los ticks siguientes de ese
// mismo día mandan un recordatorio corto e informal en vez de repetir la lista entera.
const HORAS_CUBRIR_FULL_SENT_DATE_KEY = "bot:horas_cubrir_full_sent_date";
const HORAS_CUBRIR_FULL_SENT_TTL_SECONDS = 25 * 60 * 60;

const ANUNCIOS_HORAS_GROUP_JID = "120363048382543444@g.us";

// Reintento corto cuando el socket todavía no terminó de autenticarse (recién arrancado el proceso).
const HORAS_CUBRIR_NOT_READY_RETRY_MS = 30_000;

// Las horas de la hoja "horas-cubrir" están en horario de Uruguay, no de Colombia — el filtro
// de turnos ya pasados y el tag "(HOY)" tienen que calcularse con esa zona horaria, aunque el
// anuncio se dispare siguiendo la ventana de envío en hora Colombia.
const URUGUAY_TZ = "America/Montevideo";

function currentDateUruguayISO(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: URUGUAY_TZ }); // en-CA => YYYY-MM-DD
}

function currentMinutesUruguay(): number {
	const d = new Date(new Date().toLocaleString("en-US", { timeZone: URUGUAY_TZ }));
	return d.getHours() * 60 + d.getMinutes();
}

/** Parsea "HH:mm - HH:mm" a minutos de inicio/fin, soportando turnos que cruzan medianoche. */
function parseHorarioRange(horario: string): { start: number; end: number } | null {
	const m = horario.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
	if (!m) return null;
	const start = parseInt(m[1]) * 60 + parseInt(m[2]);
	let end = parseInt(m[3]) * 60 + parseInt(m[4]);
	if (end <= start) end += 24 * 60;
	return { start, end };
}

function parseHorarioHours(horario: string): number | null {
	const range = parseHorarioRange(horario);
	return range ? (range.end - range.start) / 60 : null;
}

function sumHours(slots: HoraCubrirEntry[]): number {
	return slots.reduce((total, s) => total + (parseHorarioHours(s.horario) ?? 0), 0);
}

/** true si el turno todavía no terminó (hora Uruguay) — filtra los que ya pasaron para hoy. */
function isSlotStillAvailable(entry: HoraCubrirEntry, todayUY: string, nowMinUY: number): boolean {
	const fechaNorm = normalizeFecha(entry.fecha);
	if (!fechaNorm) return true; // fecha no reconocible, no filtramos por las dudas
	if (fechaNorm < todayUY) return false; // día ya pasado
	if (fechaNorm > todayUY) return true; // día futuro, todavía no llega
	const range = parseHorarioRange(entry.horario);
	if (!range) return true; // horario no parseable, no filtramos por las dudas
	return range.end > nowMinUY;
}

const DIAS_SEMANA_ES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

/**
 * Nombre del día de la semana en español a partir de una fecha ya normalizada (YYYY-MM-DD).
 * El día de la semana lo calculamos acá (determinístico) y se lo pasamos resuelto al LLM —
 * si se lo dejamos calcular a él a partir de "DD/MM/YYYY" suele equivocarse (ej. dijo
 * "Viernes 01/08" para una fecha que en realidad caía sábado).
 */
function nombreDiaSemana(fechaNorm: string): string | null {
	const m = fechaNorm.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return null;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return DIAS_SEMANA_ES[d.getUTCDay()];
}

/** Arma el resumen "- LOB: Xh HHEE — horarios | Yh normales — horarios", una línea por LOB. */
function buildResumenByLob(entries: HoraCubrirEntry[], today: string): string {
	const fmtSlot = (s: HoraCubrirEntry) => {
		const fechaNorm = normalizeFecha(s.fecha);
		const isToday = fechaNorm === today;
		const dia = nombreDiaSemana(fechaNorm);
		return `${dia ? dia + " " : ""}${s.fecha} ${s.horario}${isToday ? " (HOY)" : ""}`;
	};

	const byLob = new Map<string, { hhee: HoraCubrirEntry[]; normal: HoraCubrirEntry[] }>();
	for (const e of entries) {
		const lob = e.lob || "Sin LOB especificado";
		if (!byLob.has(lob)) byLob.set(lob, { hhee: [], normal: [] });
		const bucket = byLob.get(lob)!;
		(isHoraCubrirHHEE(e) ? bucket.hhee : bucket.normal).push(e);
	}

	return [...byLob.entries()]
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
}

function buildFullPrompt(entries: HoraCubrirEntry[], today: string): string {
	const resumen = buildResumenByLob(entries, today);

	return [
		"Sos el asistente que anuncia horas disponibles para cubrir, en un grupo de WhatsApp de agentes de Customer Success que trabajan 100% desde casa (home office).",
		`Hoy es ${today} (hora Uruguay — los horarios de la lista están en esa zona horaria). A continuación tenés, por LOB, las horas sin cubrir ya separadas en dos grupos: HHEE (pagan un plus) y normales (NO pagan extra). Los turnos marcados con "(HOY)" son del día de hoy y los que ya pasaron fueron descartados de la lista.`,
		"CRÍTICO: cada turno de la lista ya viene con el nombre del día de la semana correcto delante de la fecha (ej. \"Sábado 01/08/2026\"). Usá ese nombre TAL CUAL, textual — NUNCA calcules, infieras ni corrijas vos el día de la semana a partir de la fecha, así evitamos anunciar un día equivocado.",
		"CRÍTICO: nunca sumes, mezcles ni generalices las horas HHEE con las normales de un mismo LOB ni de LOBs distintos — son conceptos de pago distintos y deben quedar diferenciados en el mensaje.",
		"No recalcules los totales de horas: usá tal cual los números que te paso, no los reinterpretes ni los redondees.",
		"CRÍTICO: mostrá TODAS las horas de la lista (de hoy y de otros días), pero priorizá y resaltá primero, con más énfasis, las que son de HOY (son las más urgentes de cubrir). Las de otros días van después, en un tono más secundario.",
		"CRÍTICO: por cada turno tenés que indicar el horario exacto (HH:mm - HH:mm) y la fecha, no solo la cantidad total de horas — a un agente no le sirve saber que \"hay 5 horas hoy\", necesita saber en qué rango horario son para decidir si puede cubrirlas. No agrupes ni resumas los horarios en un solo número.",
		"Con esa información, escribí UN solo mensaje para WhatsApp, con emojis, que convenza a los agentes de anotarse.",
		"El mensaje puede ser un poco más largo de lo habitual para poder listar cada horario exacto — priorizá que sea claro y completo antes que ultra breve, pero sin relleno ni frases de más: cada línea tiene que aportar información (un LOB, un horario, un dato útil).",
		"El tono tiene que ser profesional (es una comunicación de la operación a su equipo) pero dinámico y con onda: metele algo de gracia o picardía sutil, no un texto acartonado ni de trámite. Nada de humor forzado ni chistes largos — un guiño puntual alcanza.",
		"Elegí al azar, para esta tanda, UN acento/sabor regional latinoamericano (colombiano paisa, costeño, mexicano, rioplatense argentino-uruguayo, caribeño, chileno, etc.) e imprimile ese estilo con 2-3 expresiones típicas breves y livianas. No abuses del modismo ni uses jerga tan cerrada que el resto del equipo (de otros países) no la entienda — es sabor, no una traducción completa.",
		"Vendé el plan en UNA sola frase corta, con ese mismo tono, aprovechando que son agentes de home office (sin salir de casa, sin transporte). No te extiendas en esto.",
		"Nombrá explícitamente TODOS los LOBs de la lista, indicando para cada uno los horarios exactos disponibles (HHEE y normales por separado, omitiendo el grupo que esté vacío en ese LOB).",
		"CRÍTICO: el mensaje SIEMPRE tiene que indicar, en una sola línea corta, que estas horas están disponibles para anotarse en el aplicativo de cambios de turno, sección *Horas Disponibles*. No omitas esto ni lo expliques de más.",
		"No inventes datos que no estén en la lista.",
		"Usá formato de WhatsApp para negrita (un asterisco de cada lado, ej: *texto*), nunca markdown tipo ** o ##.",
		"No agregues instrucciones de cómo anotarse (eso ya lo sabe el equipo). Devolvé solo el texto final del mensaje, sin comillas ni bloques de código.",
		"",
		"LOBs con horas sin cubrir:",
		resumen,
	].join("\n");
}

/**
 * El listado completo ya se mandó hoy (más temprano) — este es el recordatorio de las
 * horas que siguen sin cubrirse. Tiene que sonar a alguien del equipo insistiendo por su
 * cuenta, no a la repetición del anuncio formal de la mañana.
 */
function buildReminderPrompt(entries: HoraCubrirEntry[], today: string): string {
	const resumen = buildResumenByLob(entries, today);

	return [
		"Sos parte del equipo de operación de Customer Success (agentes 100% home office) y ya se mandó, más temprano hoy, el anuncio formal y completo con el listado detallado de horas disponibles para cubrir.",
		`Hoy es ${today} (hora Uruguay). A continuación tenés, por LOB, las horas que TODAVÍA siguen sin cubrirse (ya se descartaron las que pasaron o se llenaron).`,
		"CRÍTICO: cada turno de la lista ya viene con el nombre del día de la semana correcto delante de la fecha (ej. \"Sábado 01/08/2026\"). Usá ese nombre TAL CUAL, textual — NUNCA calcules, infieras ni corrijas vos el día de la semana a partir de la fecha.",
		"Este es un recordatorio, no el anuncio completo: NO repitas el listado detallado turno por turno ni menciones todos los LOBs — elegí como máximo 1 o 2 franjas que sean las más urgentes o llamativas (priorizá las de HOY) y usalas de gancho.",
		"Escribí UN mensaje CORTO para WhatsApp (2 a 4 líneas), como si lo tipeara una persona del equipo recordando por las suyas que todavía hay horas libres — no como una comunicación oficial repetida. Tono cercano, informal, con gracia y buena onda, pero profesional (sin caer en chiste forzado ni informalidad excesiva).",
		"Elegí al azar, para esta tanda, UN acento/sabor regional latinoamericano (colombiano paisa, costeño, mexicano, rioplatense argentino-uruguayo, caribeño, chileno, etc.) e imprimile ese estilo con alguna expresión típica breve. Que sea liviano y entendible para todo el equipo, no jerga cerrada.",
		"Podés variar la forma de arrancar y el enfoque (no siempre el mismo template) para que no se sienta repetitivo entre recordatorios.",
		"Mencioná brevemente, en algún punto, que se anotan en el aplicativo de cambios de turno, sección *Horas Disponibles* — sin explicarlo de más.",
		"No inventes datos ni horarios que no estén en la lista.",
		"Usá como mucho 1 o 2 emojis, sin forzarlos.",
		"Usá formato de WhatsApp para negrita (un asterisco de cada lado, ej: *texto*), nunca markdown tipo ** o ##.",
		"Devolvé solo el texto final del mensaje, sin comillas ni bloques de código.",
		"",
		"LOBs con horas sin cubrir (para elegir el gancho, no para listar todo):",
		resumen,
	].join("\n");
}

export async function runHorasCubrirCronOnce(): Promise<"sent" | "skipped" | "empty" | "not_ready" | "outside_window" | "error"> {
	try {
		// Solo se envía entre 6am y 12am (medianoche) hora Colombia.
		if (!isWithinColombiaSendWindow()) return "outside_window";

		const alreadySent = await redisClient.get(HORAS_CUBRIR_COOLDOWN_KEY);
		if (alreadySent) return "skipped";

		const { globalSock, sendViaGlobalSock } = await import("../src/lib/baileys/client.ts");
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

		const rawEntries = await getHorasCubrir(ids);
		const todayUY = currentDateUruguayISO();
		const nowMinUY = currentMinutesUruguay();
		// Los horarios están en hora Uruguay — se descartan los turnos de hoy que ya terminaron
		// para no anunciar horas que ya no se pueden cubrir.
		const entries = rawEntries.filter((e) => isSlotStillAvailable(e, todayUY, nowMinUY));
		if (!entries.length) return "empty";

		const todayCO = currentDateColombiaISO();
		const fullSentDate = await redisClient.get(HORAS_CUBRIR_FULL_SENT_DATE_KEY);
		const isFirstOfDay = fullSentDate !== todayCO;
		const prompt = isFirstOfDay
			? buildFullPrompt(entries, todayUY)
			: buildReminderPrompt(entries, todayUY);
		const message = await generateCreativeText(prompt, settings);

		await sendViaGlobalSock(ANUNCIOS_HORAS_GROUP_JID, { text: message }, { kind: "cron" });
		await redisClient.set(HORAS_CUBRIR_COOLDOWN_KEY, Date.now().toString(), "EX", HORAS_CUBRIR_COOLDOWN_SECONDS);
		if (isFirstOfDay) {
			await redisClient.set(HORAS_CUBRIR_FULL_SENT_DATE_KEY, todayCO, "EX", HORAS_CUBRIR_FULL_SENT_TTL_SECONDS);
		}
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
