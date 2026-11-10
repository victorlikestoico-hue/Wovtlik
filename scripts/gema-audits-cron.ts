import "./env-loader.ts";
import { Redis } from "ioredis";
import { readSheetByGid } from "../src/lib/sheets-client.ts";
import { getSettings, notifyGemaAuditSent } from "../src/lib/db.ts";
import { sendGmail, GmailNotConfiguredError } from "../src/lib/gmail-client.ts";
import { lookupAgentContacts } from "./audit-signature-report-cron.ts";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");

// Hoja "Audits Foco Gema": una fila por auditoría. Columnas usadas: Agent (correo corporativo del
// agente auditado), contact_id (clave única de la auditoría) y los datos que se le envían al
// agente: CR3, Link, Auditor, Comentarios. La service account (GOOGLE_SA_EMAIL) necesita acceso
// de lectura a esta planilla.
const GEMA_SHEET_ID = "1mkEmSRXQJlF4SwFBkxLmy2ASGM8mWwxCRZTFCPD5Ybs";
// Ojo: 403349622 es "Apego Gema" (resumen por agente) en la misma planilla, no esta hoja.
const GEMA_SHEET_GID = "1414354841";

const TICK_MS = 15 * 60 * 1000;
const NOT_READY_RETRY_MS = 30_000;

// Un set de contact_id ya avisados por canal: si el correo falla (p. ej. falta re-autorizar con
// gmail.send) se reintenta en el próximo tick sin volver a mandar el WhatsApp, y viceversa.
const NOTIFIED_WA_KEY = "bot:gema_audits:notified_wa";
const NOTIFIED_MAIL_KEY = "bot:gema_audits:notified_mail";
// Primer arranque: todo lo que ya está en la hoja se marca como visto sin avisar (decisión del
// usuario, para no mandar el histórico de golpe).
const INITIALIZED_KEY = "bot:gema_audits:initialized";
// Los auditores cargan muchos tickets de antemano (con Auditor ya asignado) y auditan solo
// algunos: una fila cuenta como auditoría recién cuando "¿Se apega al SOP?" tiene valor. El
// primer arranque (versión anterior) marcó como vistas también las filas sin auditar; esta
// migración única las saca de los sets para que se avisen cuando efectivamente se auditen.
const MIGRATED_AUDITED_ONLY_KEY = "bot:gema_audits:migrated_audited_only";
// Firma (resultado + comentario) de cada fila auditada todavía sin avisar, vista en el tick
// anterior: si una fila auditada aún no tiene comentario, se espera a que no cambie entre dos
// lecturas para no mandarle al agente una auditoría a medio cargar.
const PENDING_SIG_KEY = "bot:gema_audits:pending_sig";

interface GemaAudit {
	contactId: string;
	agent: string;
	cr3: string;
	link: string;
	auditor: string;
	comentarios: string;
	audited: boolean;
	signature: string;
}

export async function fetchGemaAudits(): Promise<GemaAudit[]> {
	const { headers, rows } = await readSheetByGid(GEMA_SHEET_ID, GEMA_SHEET_GID);
	const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
	const agentCol = col(/^agent$/i);
	const contactCol = col(/^contact[_\s]?id$/i);
	const cr3Col = col(/^cr3$/i);
	const linkCol = col(/^link$/i);
	const auditorCol = col(/^auditor$/i);
	const comentCol = col(/^comentarios?$/i);
	const weekCol = col(/^week\s*audit$/i);
	const sopCol = col(/apega al sop/i);
	const gemaCol = col(/utiliza bien la gema/i);
	const wlCol = col(/realiza wl/i);
	if (agentCol < 0 || contactCol < 0 || sopCol < 0) {
		throw new Error("La hoja 'Audits Foco Gema' no tiene columnas 'Agent'/'contact_id'/'¿Se apega al SOP?'");
	}
	const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
	// En las filas más nuevas los auditores escriben el comentario en "Week audit" y dejan
	// "Comentarios" vacía; se usa ese texto salvo que sea el número de semana (ej. "40").
	const comentariosOf = (cells: string[]) => {
		const c = cell(cells, comentCol);
		if (c) return c;
		const w = cell(cells, weekCol);
		return /^\d{1,2}$/.test(w) ? "" : w;
	};

	const audits: GemaAudit[] = [];
	for (const { cells } of rows) {
		const contactId = cell(cells, contactCol);
		const agent = cell(cells, agentCol).toLowerCase();
		if (!contactId || !agent.includes("@")) continue;
		const sop = cell(cells, sopCol);
		const auditor = cell(cells, auditorCol);
		const comentarios = comentariosOf(cells);
		audits.push({
			contactId,
			agent,
			cr3: cell(cells, cr3Col),
			link: cell(cells, linkCol),
			auditor,
			comentarios,
			audited: sop !== "",
			signature: [sop, cell(cells, gemaCol), cell(cells, wlCol), auditor, comentarios].join("\u0001"),
		});
	}
	return audits;
}

function plural(n: number): string {
	return n === 1 ? "auditoría nueva" : "auditorías nuevas";
}

export function buildWhatsAppMessage(firstName: string, audits: GemaAudit[]): string {
	const lines = [
		firstName ? `Hola ${firstName}! 👋` : "Hola! 👋",
		`Tienes ${audits.length} ${plural(audits.length)} de Foco Gema:`,
	];
	audits.forEach((a, i) => {
		lines.push(
			"",
			`*${i + 1}.* contact_id: ${a.contactId}`,
			`CR3: ${a.cr3 || "-"}`,
			`Auditor: ${a.auditor || "-"}`,
			`Comentarios: ${a.comentarios || "-"}`,
			`Link: ${a.link || "-"}`,
		);
	});
	return lines.join("\n");
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildEmailHtml(firstName: string, audits: GemaAudit[]): string {
	const td = 'style="border:1px solid #ddd;padding:6px 8px;vertical-align:top"';
	const th = 'style="border:1px solid #ddd;padding:6px 8px;background:#f3f3f3;text-align:left"';
	const rows = audits
		.map((a) => {
			const link = a.link
				? `<a href="${escapeHtml(a.link)}">Ver caso</a>`
				: "-";
			return `<tr><td ${td}>${escapeHtml(a.contactId)}</td><td ${td}>${escapeHtml(a.cr3 || "-")}</td><td ${td}>${link}</td><td ${td}>${escapeHtml(a.auditor || "-")}</td><td ${td}>${escapeHtml(a.comentarios || "-")}</td></tr>`;
		})
		.join("");
	return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>${firstName ? `Hola ${escapeHtml(firstName)},` : "Hola,"}</p>
<p>Tienes ${audits.length} ${plural(audits.length)} de <b>Foco Gema</b>:</p>
<table style="border-collapse:collapse">
<tr><th ${th}>contact_id</th><th ${th}>CR3</th><th ${th}>Link</th><th ${th}>Auditor</th><th ${th}>Comentarios</th></tr>
${rows}
</table>
</div>`;
}

export async function runGemaAuditsOnce(): Promise<"initialized" | "no_new" | "sent" | "not_ready" | "error"> {
	try {
		const allRows = await fetchGemaAudits();
		// Solo filas efectivamente auditadas; si un contact_id aparece repetido, gana la primera
		// fila auditada (las filas sin auditar del mismo ticket se ignoran).
		const auditedIds = new Set<string>();
		const audits = allRows.filter((a) => {
			if (!a.audited || auditedIds.has(a.contactId)) return false;
			auditedIds.add(a.contactId);
			return true;
		});

		if (!(await redisClient.get(INITIALIZED_KEY))) {
			const ids = [...auditedIds];
			if (ids.length > 0) {
				await redisClient.sadd(NOTIFIED_WA_KEY, ...ids);
				await redisClient.sadd(NOTIFIED_MAIL_KEY, ...ids);
			}
			await redisClient.set(INITIALIZED_KEY, Date.now().toString());
			await redisClient.set(MIGRATED_AUDITED_ONLY_KEY, Date.now().toString());
			console.log(`[gema-audits] Primer arranque: ${ids.length} auditoría(s) existentes marcadas como vistas.`);
			return "initialized";
		}

		if (!(await redisClient.get(MIGRATED_AUDITED_ONLY_KEY))) {
			const notAudited = [...new Set(allRows.map((a) => a.contactId))].filter((id) => !auditedIds.has(id));
			if (notAudited.length > 0) {
				await redisClient.srem(NOTIFIED_WA_KEY, ...notAudited);
				await redisClient.srem(NOTIFIED_MAIL_KEY, ...notAudited);
			}
			await redisClient.set(MIGRATED_AUDITED_ONLY_KEY, Date.now().toString());
			console.log(`[gema-audits] Migración: ${notAudited.length} ticket(s) sin auditar quitados de "ya avisados".`);
		}

		const [notifiedWa, notifiedMail, prevSigs] = await Promise.all([
			redisClient.smembers(NOTIFIED_WA_KEY).then((m) => new Set(m)),
			redisClient.smembers(NOTIFIED_MAIL_KEY).then((m) => new Set(m)),
			redisClient.hgetall(PENDING_SIG_KEY),
		]);

		const unnotified = audits.filter((a) => !notifiedWa.has(a.contactId) || !notifiedMail.has(a.contactId));
		// Lista para avisar si ya tiene comentario o si no cambió desde la lectura anterior (el
		// auditor terminó de cargarla). Las demás se anotan y se reevalúan en el próximo tick.
		const pending = unnotified.filter((a) => a.comentarios !== "" || prevSigs[a.contactId] === a.signature);
		const waiting = unnotified.filter((a) => !pending.includes(a));
		const sigUpdate: Record<string, string> = {};
		for (const a of waiting) sigUpdate[a.contactId] = a.signature;
		// Firmas de contact_id que ya no esperan (avisados o que dejaron de estar auditados).
		const staleSigs = Object.keys(prevSigs).filter((id) => !waiting.some((a) => a.contactId === id));
		if (staleSigs.length > 0) await redisClient.hdel(PENDING_SIG_KEY, ...staleSigs);
		if (waiting.length > 0) {
			await redisClient.hset(PENDING_SIG_KEY, sigUpdate);
			console.log(`[gema-audits] ${waiting.length} auditoría(s) sin comentario, esperando a que no cambien: ${waiting.map((a) => a.contactId).join(", ")}`);
		}
		if (pending.length === 0) return "no_new";

		const { globalSock, sendViaGlobalSock } = await import("../src/lib/baileys/client.ts");
		const waReady = !!globalSock?.user?.id;
		const needsWa = pending.some((a) => !notifiedWa.has(a.contactId));
		if (needsWa && !waReady) {
			console.warn("[gema-audits] Socket todavía no autenticado, reintento en breve.");
			return "not_ready";
		}

		const byAgent = new Map<string, GemaAudit[]>();
		for (const a of pending) {
			const list = byAgent.get(a.agent) ?? [];
			list.push(a);
			byAgent.set(a.agent, list);
		}

		const contacts = await lookupAgentContacts(new Set(byAgent.keys()));
		const settings = await getSettings().catch(() => ({} as Record<string, unknown>));
		const refreshToken = (settings.google_oauth_refresh_token as string) || "";
		let mailDisabledReason: string | null = null;

		console.log(`[gema-audits] ${pending.length} auditoría(s) nueva(s) para ${byAgent.size} agente(s).`);

		for (const [agent, list] of byAgent) {
			const contact = contacts.get(agent);
			const firstName = contact?.firstName ?? "";
			// Resultado de cada canal en este tick, para el resumen por Telegram. Si un canal ya
			// había salido en un tick anterior (reintento solo del otro canal) se indica así.
			let waStatus = "Ya enviado antes";
			let mailStatus = "Ya enviado antes";

			const waList = list.filter((a) => !notifiedWa.has(a.contactId));
			if (waList.length > 0) {
				const waIds = waList.map((a) => a.contactId);
				if (!contact) {
					// Sin teléfono en la planilla Base no hay a quién mandar: se marca igual para no
					// repetir el warning cada 15 min (el correo sigue su propio curso).
					console.warn(`[gema-audits] Sin teléfono para ${agent} en la planilla Base, se omite el WhatsApp.`);
					await redisClient.sadd(NOTIFIED_WA_KEY, ...waIds);
					waStatus = "⚠️ No enviado: el agente no tiene teléfono en la planilla Base";
				} else {
					try {
						await sendViaGlobalSock(
							`${contact.phone}@s.whatsapp.net`,
							{ text: buildWhatsAppMessage(firstName, waList) },
							{ kind: "broadcast" },
						);
						await redisClient.sadd(NOTIFIED_WA_KEY, ...waIds);
						console.log(`[gema-audits] WhatsApp enviado a ${agent} (${contact.phone}): ${waIds.join(", ")}`);
						waStatus = "✅ Enviado";
					} catch (err) {
						console.error(`[gema-audits] Falló el WhatsApp a ${agent} (${contact.phone}):`, err);
						waStatus = `❌ Falló (se reintenta en 15 min): ${String((err as Error)?.message ?? err).slice(0, 150)}`;
					}
				}
			}

			const mailList = list.filter((a) => !notifiedMail.has(a.contactId));
			if (mailList.length > 0) {
				if (mailDisabledReason) {
					mailStatus = `⏳ Pendiente: ${mailDisabledReason}`;
				} else {
					try {
						await sendGmail({
							to: agent,
							subject: `Tienes ${mailList.length} ${plural(mailList.length)} de Foco Gema`,
							html: buildEmailHtml(firstName, mailList),
							refreshToken,
						});
						await redisClient.sadd(NOTIFIED_MAIL_KEY, ...mailList.map((a) => a.contactId));
						console.log(`[gema-audits] Correo enviado a ${agent}: ${mailList.map((a) => a.contactId).join(", ")}`);
						mailStatus = "✅ Enviado";
					} catch (err) {
						if (err instanceof GmailNotConfiguredError) {
							// No se marcan como enviados: cuando se autorice Gmail salen en el próximo tick.
							mailDisabledReason = err.message;
							mailStatus = `⏳ Pendiente: ${err.message}`;
						} else {
							console.error(`[gema-audits] Falló el correo a ${agent}:`, err);
							mailStatus = `❌ Falló (se reintenta en 15 min): ${String((err as Error)?.message ?? err).slice(0, 150)}`;
						}
					}
				}
			}

			// Un aviso a Telegram por agente con todo lo que se le mandó y el resultado de cada canal.
			// Si en este tick solo quedaba el correo pendiente y siguió pendiente (Gmail sin autorizar),
			// no se repite el aviso cada 15 min: ya se avisó en el tick en que salió el WhatsApp.
			if (waStatus === "Ya enviado antes" && mailStatus.startsWith("⏳")) continue;
			await notifyGemaAuditSent({
				agentEmail: agent,
				agentPhone: contact?.phone ?? null,
				audits: list,
				whatsappStatus: waStatus,
				emailStatus: mailStatus,
			}).catch((err) => console.error(`[gema-audits] Falló el aviso a Telegram para ${agent}:`, err));
		}

		if (mailDisabledReason) {
			console.warn(`[gema-audits] Correos pendientes sin enviar: ${mailDisabledReason}`);
		}
		return "sent";
	} catch (err) {
		console.error("[gema-audits] Error crítico ejecutando el tick:", err);
		return "error";
	}
}

export function startGemaAuditsCron(): void {
	console.log("[gema-audits] Iniciando aviso de auditorías nuevas de Foco Gema (cada 15 min)...");
	const tick = async () => {
		const result = await runGemaAuditsOnce();
		if (result !== "no_new") console.log(`[gema-audits] tick: ${result}`);
		setTimeout(tick, result === "not_ready" ? NOT_READY_RETRY_MS : TICK_MS);
	};
	setTimeout(tick, 60_000);
}
