import pg from "pg";
import {
	DATABASE_SCHEMA_SQL,
	DEFAULT_SETTINGS,
	type ConversationRow,
	type WhatsAppInstanceRow,
	type MessageRow,
	type InsertMessageInput,
	type FollowUpQueryInput,
	type ModeChangedBy,
	type ConversationEventType,
	type EventActorRole,
	type ConversationEventRow,
	type AgentProfileRow,
} from "./db-contract.ts";
import type { ConversationMode } from "../domain/whatsapp-rules.ts";
import { createPostgresRepository, initializePostgresSchema } from "./postgres-adapter.ts";
import { createTelegramNotifier } from "./telegram-notifier.ts";
import {
	normalizeAutomationInput,
	type AutomationInput,
	type AutomationRow,
} from "./automations.ts";
import {
	normalizeCrmTaskInput,
	normalizeCrmTaskPatch,
	type CrmTaskInput,
	type CrmTaskListRow,
	type CrmTaskPatch,
	type CrmTaskRow,
} from "./crm-tasks.ts";

const { Pool } = pg;

// Inicialización del pool de conexión real de pg usando la URL de entorno
const connectionString = process.env.DATABASE_URL;

export const pool = new Pool({
	connectionString,
});

// Inicializamos el repositorio pasándole el pool de pg
const repo = createPostgresRepository(pool);

// Helper para inicializar la base de datos al arrancar
let schemaInitialized = false;
let schemaInitializationPromise: Promise<void> | null = null;

function isRetryableSchemaInitError(error: unknown) {
	const code = typeof error === "object" && error !== null ? (error as any).code : null;
	return code === "40P01" || code === "55P03";
}

async function initializeSchemaWithRetry(maxAttempts = 3) {
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			await initializePostgresSchema(pool);
			return;
		} catch (error) {
			if (!isRetryableSchemaInitError(error) || attempt === maxAttempts) {
				throw error;
			}
			const delayMs = 100 * attempt;
			console.warn(
				`[db] Inicialización de schema bloqueada por concurrencia (${(error as any).code}). Reintentando en ${delayMs}ms...`,
			);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

export async function ensureSchemaInitialized() {
	if (schemaInitialized) return;
	if (!schemaInitializationPromise) {
		schemaInitializationPromise = initializeSchemaWithRetry()
			.then(() => {
				schemaInitialized = true;
				console.log("[db] Esquema de PostgreSQL inicializado correctamente.");
			})
			.catch((error) => {
				schemaInitializationPromise = null;
				console.error("[db] Error al inicializar el esquema de PostgreSQL:", error);
				throw error;
			});
	}
	await schemaInitializationPromise;
}

// Ejecutamos la inicialización del esquema asincrónicamente al importar
// (Desactivado para no fallar durante el build de Next.js. Se llama lazily en cada función).
// ensureSchemaInitialized().catch(() => {});

// 1. getOrCreateConversation(phone, jid?, name?, lidJid?)
export async function getOrCreateConversation(
	phone: string,
	jid?: string | null,
	name?: string | null,
	lidJid?: string | null,
): Promise<ConversationRow> {
	await ensureSchemaInitialized();
	return repo.getOrCreateConversation({ phone, jid, name, lidJid });
}

// 2. getConversationById(id)
export async function getConversationById(id: number): Promise<ConversationRow | null> {
	await ensureSchemaInitialized();
	return repo.getConversationById(id);
}

export async function getConversationByPhone(phone: string): Promise<ConversationRow | null> {
	await ensureSchemaInitialized();
	const res = await pool.query<ConversationRow>(
		"SELECT * FROM conversations WHERE phone = $1 LIMIT 1",
		[phone],
	);
	return res.rows[0] ?? null;
}

// 3. insertMessageAndTouchConversation(input)
export async function insertMessageAndTouchConversation(input: InsertMessageInput): Promise<MessageRow> {
	await ensureSchemaInitialized();
	return repo.insertMessageAndTouchConversation(input);
}

// 4. messageExistsByWhatsappId(whatsappMessageId)
export async function messageExistsByWhatsappId(whatsappMessageId: string): Promise<boolean> {
	await ensureSchemaInitialized();
	const res = await pool.query("SELECT 1 FROM messages WHERE whatsapp_message_id = $1 LIMIT 1", [
		whatsappMessageId,
	]);
	return res.rows.length > 0;
}

export async function getMessageContentByWhatsappId(whatsappMessageId: string): Promise<string | null> {
	await ensureSchemaInitialized();
	const res = await pool.query<{ content: string }>(
		"SELECT content FROM messages WHERE whatsapp_message_id = $1 LIMIT 1",
		[whatsappMessageId],
	);
	return res.rows[0]?.content ?? null;
}

// 5. getPendingFollowUps(...)
export async function getPendingFollowUps(input: FollowUpQueryInput): Promise<ConversationRow[]> {
	await ensureSchemaInitialized();
	return repo.getPendingFollowUps(input);
}

// 6. incrementFollowUpAttempt(conversationId)
export async function incrementFollowUpAttempt(conversationId: number): Promise<ConversationRow> {
	await ensureSchemaInitialized();
	return repo.incrementFollowUpAttempt(conversationId);
}

// 7. markFollowUpBlocked(conversationId, reason)
export async function markFollowUpBlocked(conversationId: number, reason: string): Promise<ConversationEventRow> {
	await ensureSchemaInitialized();
	return repo.markFollowUpBlocked(conversationId, reason);
}

// 8. getMessages(conversationId, limit = 50)
export async function getMessages(conversationId: number, limit = 50): Promise<MessageRow[]> {
	await ensureSchemaInitialized();
	const res = await pool.query<MessageRow>(
		"SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id ASC LIMIT $2",
		[conversationId, limit],
	);
	return res.rows;
}

// 9. getRecentHistory(conversationId, limit = 20)
export async function getRecentHistory(conversationId: number, limit = 20): Promise<MessageRow[]> {
	await ensureSchemaInitialized();
	return repo.getRecentMessages(conversationId, limit);
}

// 10. setMode(conversationId, mode, { reason, changedBy })
export async function setMode(
	conversationId: number,
	mode: ConversationMode,
	input: {
		reason: string;
		changedBy: ModeChangedBy;
		eventType?: ConversationEventType;
		metadata?: Record<string, unknown>;
	},
): Promise<ConversationEventRow | null> {
	await ensureSchemaInitialized();
	return repo.setMode(conversationId, mode, input);
}

// 11. recordConversationEvent(conversationId, eventType, actorRole, reason?, metadata?)
export async function recordConversationEvent(input: {
	conversation_id: number;
	event_type: ConversationEventType;
	actor_role: EventActorRole;
	reason?: string | null;
	metadata?: Record<string, unknown>;
}): Promise<ConversationEventRow> {
	await ensureSchemaInitialized();
	return repo.recordConversationEvent(input);
}

// 12. getSettings()
export async function getSettings(): Promise<Record<string, unknown>> {
	await ensureSchemaInitialized();
	return repo.getSettings();
}

// 13. setSetting(key, value)
export async function setSetting(key: string, value: unknown): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query(
		`INSERT INTO settings (key, value, updated_at)
		 VALUES ($1, $2, NOW())
		 ON CONFLICT (key)
		 DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
		[key, JSON.stringify(value)],
	);
}

// 14. listConversations()
export interface ConversationListRow extends ConversationRow {
	last_message_content?: string | null;
	last_message_role?: string | null;
	contact_id?: number | null;
	contact_name?: string | null;
	contact_phone?: string | null;
	contact_jid?: string | null;
	account_id?: number | null;
	account_name?: string | null;
	owner_user_id?: number | null;
}
export async function listConversations(options: { archived?: boolean; hasMessages?: boolean } = {}): Promise<ConversationListRow[]> {
	await ensureSchemaInitialized();
	const isArchived = options.archived === true;
	
	let sql = `SELECT c.*, 
		        m.content AS last_message_content, 
		        m.role AS last_message_role
		 FROM conversations c
		 LEFT JOIN connection_state cs ON cs.id = 1
		 LEFT JOIN LATERAL (
		   SELECT content, role
		   FROM messages
		   WHERE conversation_id = c.id
		   ORDER BY created_at DESC, id DESC
		   LIMIT 1
		 ) m ON TRUE
		 WHERE (c.phone <> cs.phone OR cs.phone IS NULL) AND c.is_archived = $1`;
		 
	if (options.hasMessages === true) {
		sql += ` AND (c.last_message_at IS NOT NULL OR c.unread_count > 0)`;
	}
	
	sql += ` ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC`;

	const res = await pool.query<ConversationListRow>(sql, [isArchived]);
	return res.rows;
}

// 15. getConnectionState()
export interface ConnectionStateRow {
	id: number;
	status: "disconnected" | "qr" | "connecting" | "connected";
	qr_string?: string | null;
	phone?: string | null;
	updated_at: Date;
	instance_id?: number | null;
	instance_name?: string | null;
}

export async function listWhatsAppInstances(): Promise<WhatsAppInstanceRow[]> {
	await ensureSchemaInitialized();
	const res = await pool.query<WhatsAppInstanceRow>(
		"SELECT * FROM whatsapp_instances ORDER BY is_active DESC, updated_at DESC, id ASC",
	);
	return res.rows;
}

export async function getActiveWhatsAppInstance(): Promise<WhatsAppInstanceRow> {
	await ensureSchemaInitialized();
	const existing = await pool.query<WhatsAppInstanceRow>(
		"SELECT * FROM whatsapp_instances WHERE is_active = TRUE ORDER BY id ASC LIMIT 1",
	);
	if (existing.rows[0]) return existing.rows[0];

	const fallback = await pool.query<WhatsAppInstanceRow>(
		"SELECT * FROM whatsapp_instances ORDER BY id ASC LIMIT 1",
	);
	if (fallback.rows[0]) {
		await setActiveWhatsAppInstance(fallback.rows[0].id);
		return { ...fallback.rows[0], is_active: true };
	}

	const created = await createWhatsAppInstance("Principal");
	await setActiveWhatsAppInstance(created.id);
	return { ...created, is_active: true };
}

export async function createWhatsAppInstance(name: string): Promise<WhatsAppInstanceRow> {
	await ensureSchemaInitialized();
	const normalizedName = name.trim();
	if (!normalizedName) throw new Error("instance_name_required");
	const res = await pool.query<WhatsAppInstanceRow>(
		`INSERT INTO whatsapp_instances (name, status, is_active, created_at, updated_at)
		 VALUES ($1, 'disconnected', NOT EXISTS (SELECT 1 FROM whatsapp_instances WHERE is_active = TRUE), NOW(), NOW())
		 RETURNING *`,
		[normalizedName],
	);
	return res.rows[0];
}

export async function setActiveWhatsAppInstance(id: number): Promise<WhatsAppInstanceRow> {
	await ensureSchemaInitialized();
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const existing = await client.query<WhatsAppInstanceRow>(
			"SELECT * FROM whatsapp_instances WHERE id = $1 FOR UPDATE",
			[id],
		);
		if (!existing.rows[0]) throw new Error(`whatsapp_instance_not_found:${id}`);
		await client.query("UPDATE whatsapp_instances SET is_active = FALSE WHERE is_active = TRUE");
		const activated = await client.query<WhatsAppInstanceRow>(
			`UPDATE whatsapp_instances
			 SET is_active = TRUE, updated_at = NOW()
			 WHERE id = $1
			 RETURNING *`,
			[id],
		);
		await client.query("COMMIT");
		return activated.rows[0];
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

export async function updateWhatsAppInstanceState(
	id: number,
	patch: Partial<Pick<WhatsAppInstanceRow, "phone" | "status" | "qr_string" | "profile_picture_url" | "profile_status">>,
): Promise<WhatsAppInstanceRow> {
	await ensureSchemaInitialized();
	const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
	if (entries.length === 0) return getActiveWhatsAppInstance();
	const assignments = entries.map(([key], index) => `${key} = $${index + 2}`);
	const values = entries.map(([, value]) => value);
	const res = await pool.query<WhatsAppInstanceRow>(
		`UPDATE whatsapp_instances
		 SET ${assignments.join(", ")}, updated_at = NOW()
		 WHERE id = $1
		 RETURNING *`,
		[id, ...values],
	);
	if (!res.rows[0]) throw new Error(`whatsapp_instance_not_found:${id}`);
	return res.rows[0];
}

export async function deleteWhatsAppInstance(id: number): Promise<void> {
	await ensureSchemaInitialized();
	const instances = await listWhatsAppInstances();
	if (instances.length <= 1) throw new Error("cannot_delete_last_instance");
	const deleting = instances.find((instance) => instance.id === id);
	if (!deleting) throw new Error(`whatsapp_instance_not_found:${id}`);
	await pool.query("DELETE FROM whatsapp_instances WHERE id = $1", [id]);
	if (deleting.is_active) {
		const next = (await listWhatsAppInstances())[0];
		if (next) await setActiveWhatsAppInstance(next.id);
	}
}

export async function getConnectionState(): Promise<ConnectionStateRow> {
	await ensureSchemaInitialized();
	const active = await getActiveWhatsAppInstance();
	if (active) {
		return {
			id: 1,
			status: active.status,
			qr_string: active.qr_string,
			phone: active.phone,
			updated_at: active.updated_at,
			instance_id: active.id,
			instance_name: active.name,
		};
	}
	const res = await pool.query<ConnectionStateRow>(
		"SELECT * FROM connection_state WHERE id = 1 LIMIT 1"
	);
	if (res.rows[0]) return res.rows[0];

	// Si no existe, insertamos el estado inicial por defecto
	const created = await pool.query<ConnectionStateRow>(
		`INSERT INTO connection_state (id, status, updated_at)
		 VALUES (1, 'disconnected', NOW())
		 RETURNING *`
	);
	return created.rows[0];
}

// 16. setConnectionState({status, qr_string?, phone?})
export async function setConnectionState(input: {
	status: "disconnected" | "qr" | "connecting" | "connected";
	qr_string?: string | null;
	phone?: string | null;
}): Promise<ConnectionStateRow> {
	await ensureSchemaInitialized();
	const active = await getActiveWhatsAppInstance();
	await updateWhatsAppInstanceState(active.id, {
		status: input.status,
		qr_string: input.qr_string ?? null,
		phone: input.phone ?? null,
	});
	const res = await pool.query<ConnectionStateRow>(
		`INSERT INTO connection_state (id, status, qr_string, phone, updated_at)
		 VALUES (1, $1, $2, $3, NOW())
		 ON CONFLICT (id)
		 DO UPDATE SET status = EXCLUDED.status,
		               qr_string = EXCLUDED.qr_string,
		               phone = EXCLUDED.phone,
		               updated_at = NOW()
		 RETURNING *`,
		[input.status, input.qr_string ?? null, input.phone ?? null]
	);
	return {
		...res.rows[0],
		instance_id: active.id,
		instance_name: active.name,
	};
}

// 17. enqueueOutbox(conversationId, phone, content)
export async function enqueueOutbox(
	conversationId: number,
	phone: string,
	content: string,
	options: {
		media_type?: "text" | "image" | "audio" | "unknown";
		media_url?: string | null;
		metadata?: Record<string, unknown>;
		send_after?: Date | null;
		broadcast_batch_id?: string | null;
	} = {},
): Promise<any> {
	await ensureSchemaInitialized();
	const res = await pool.query(
		`INSERT INTO outbox (conversation_id, phone, content, media_type, media_url, metadata, send_after, broadcast_batch_id, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW())
		 RETURNING *`,
		[
			conversationId,
			phone,
			content,
			options.media_type ?? "text",
			options.media_url ?? null,
			JSON.stringify(options.metadata ?? {}),
			options.send_after ?? null,
			options.broadcast_batch_id ?? null,
		],
	);
	return res.rows[0];
}

export async function cancelBroadcastBatch(batchId: string): Promise<number> {
	await ensureSchemaInitialized();
	const res = await pool.query(
		"DELETE FROM outbox WHERE broadcast_batch_id = $1 AND sent = 0",
		[batchId],
	);
	return res.rowCount ?? 0;
}

// 18. getPendingOutbox(limit = 20)
export async function getPendingOutbox(limit = 20): Promise<any[]> {
	await ensureSchemaInitialized();
	const res = await pool.query(
		`SELECT o.*, c.jid AS conversation_jid, c.phone AS conversation_phone
		 FROM outbox o
		 LEFT JOIN conversations c ON c.id = o.conversation_id
		 WHERE o.sent = 0 AND (o.send_after IS NULL OR o.send_after <= NOW())
		 ORDER BY o.created_at ASC
		 LIMIT $1`,
		[limit]
	);
	return res.rows;
}

// Broadcast agent management
export async function listFormAgents(): Promise<Array<{ id: number; name: string; phone: string; created_at: Date }>> {
	await ensureSchemaInitialized();
	const res = await pool.query("SELECT * FROM form_agents ORDER BY created_at ASC");
	return res.rows;
}

export async function addFormAgent(name: string, phone: string): Promise<{ id: number; name: string; phone: string; created_at: Date }> {
	await ensureSchemaInitialized();
	const res = await pool.query(
		"INSERT INTO form_agents (name, phone) VALUES ($1, $2) RETURNING *",
		[name.trim(), phone.replace(/\D/g, "")],
	);
	return res.rows[0];
}

export async function deleteFormAgent(id: number): Promise<boolean> {
	await ensureSchemaInitialized();
	const res = await pool.query("DELETE FROM form_agents WHERE id = $1", [id]);
	return (res.rowCount ?? 0) > 0;
}

export async function listBroadcastAgents(): Promise<Array<{ id: number; name: string; phone: string; created_at: Date }>> {
	await ensureSchemaInitialized();
	const res = await pool.query("SELECT * FROM broadcast_agents ORDER BY created_at ASC");
	return res.rows;
}

export async function addBroadcastAgent(name: string, phone: string): Promise<{ id: number; name: string; phone: string; created_at: Date }> {
	await ensureSchemaInitialized();
	const res = await pool.query(
		"INSERT INTO broadcast_agents (name, phone) VALUES ($1, $2) RETURNING *",
		[name.trim(), phone.replace(/\D/g, "")],
	);
	return res.rows[0];
}

export async function deleteBroadcastAgent(id: number): Promise<boolean> {
	await ensureSchemaInitialized();
	const res = await pool.query("DELETE FROM broadcast_agents WHERE id = $1", [id]);
	return (res.rowCount ?? 0) > 0;
}

export interface AgentMasterRow {
	id: number;
	name: string;
	phone: string;
	tl: string;
	sm: string;
	eg: string;
	wave: string;
	synced_at: Date;
}

export async function listAgentsMaster(): Promise<AgentMasterRow[]> {
	await ensureSchemaInitialized();
	const res = await pool.query<AgentMasterRow>("SELECT * FROM agents_master ORDER BY name ASC");
	return res.rows;
}

export async function syncAgentsMaster(
	rows: Array<{ name: string; phone: string; tl: string; sm: string; eg: string; wave: string }>,
): Promise<number> {
	await ensureSchemaInitialized();
	if (rows.length === 0) return 0;
	let count = 0;
	for (const r of rows) {
		const res = await pool.query(
			`INSERT INTO agents_master (name, phone, tl, sm, eg, wave, synced_at)
			 VALUES ($1, $2, $3, $4, $5, $6, NOW())
			 ON CONFLICT (phone) DO UPDATE SET
			   name = EXCLUDED.name,
			   tl   = EXCLUDED.tl,
			   sm   = EXCLUDED.sm,
			   eg   = EXCLUDED.eg,
			   wave = EXCLUDED.wave,
			   synced_at = NOW()`,
			[r.name, r.phone, r.tl, r.sm, r.eg, r.wave],
		);
		if ((res.rowCount ?? 0) > 0) count++;
	}
	// Espejo real de la planilla: cualquier agente que ya no aparece en esta sincronización
	// (cambió de LOB, se fue, etc.) se elimina para que no quede colgado bajo un TL viejo.
	await pool.query("DELETE FROM agents_master WHERE phone <> ALL($1::text[])", [
		rows.map((r) => r.phone),
	]);
	return count;
}

// 19. markOutboxSent(id)
export async function markOutboxSent(id: number): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query("UPDATE outbox SET sent = 1 WHERE id = $1", [id]);
}

// 19b. markOutboxFailed(id)
export async function markOutboxFailed(id: number): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query("UPDATE outbox SET sent = 2 WHERE id = $1", [id]);
}

// 20. deleteConversation(id)
export async function deleteConversation(id: number): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query("DELETE FROM conversations WHERE id = $1", [id]);
}

// 20b. bulkDeleteConversations(archived)
export async function bulkDeleteConversations(archived: boolean): Promise<number> {
	await ensureSchemaInitialized();
	const res = await pool.query<{ count: string }>(
		"WITH deleted AS (DELETE FROM conversations WHERE is_archived = $1 RETURNING id) SELECT COUNT(*)::text AS count FROM deleted",
		[archived],
	);
	return Number(res.rows[0]?.count ?? 0);
}

// 20c. bulkSetMode(mode, archived)
export async function bulkSetMode(
	mode: "AI" | "HUMAN",
	archived: boolean,
): Promise<number> {
	await ensureSchemaInitialized();
	const res = await pool.query<{ count: string }>(
		`WITH updated AS (
			UPDATE conversations
			SET mode = $1, mode_reason = 'bulk_dashboard', mode_changed_by = 'dashboard', mode_changed_at = NOW(), updated_at = NOW()
			WHERE is_archived = $2
			RETURNING id
		) SELECT COUNT(*)::text AS count FROM updated`,
		[mode, archived],
	);
	return Number(res.rows[0]?.count ?? 0);
}

// 21. getActiveSystemPrompt()
export async function getActiveSystemPrompt(): Promise<string> {
	await ensureSchemaInitialized();
	const res = await pool.query<{ content: string }>(
		"SELECT content FROM system_prompts WHERE is_active = TRUE LIMIT 1"
	);
	if (res.rows[0]) return res.rows[0].content;

	// Si no hay ninguno activo, insertamos el por defecto y lo devolvemos
	const fallbackContent = `Eres un asistente virtual amable. Responde en español neutro, en mensajes breves de 2 a 4 líneas. No uses emojis.

Siempre responde con JSON válido:
{
  "response": {
    "part_1": "mensaje breve obligatorio",
    "part_2": "mensaje opcional o string vacío",
    "part_3": "mensaje opcional o string vacío"
  },
  "handoff": {
    "required": false,
    "reason": ""
  }
}

Usa handoff.required=true como herramienta Humano cuando el cliente pida una persona/asesor, esté listo para cerrar, esté molesto, haga una objeción crítica, pida algo que no debes inventar o necesite intervención humana. En ese caso, incluye reason claro y una respuesta breve para avisar que será derivado.`;

	await pool.query(
		`INSERT INTO system_prompts (title, content, is_active, created_at)
		 VALUES ('Asistente Default', $1, TRUE, NOW())
		 ON CONFLICT DO NOTHING`,
		[fallbackContent]
	);
	return fallbackContent;
}

// 22. CRUD Adicional para system_prompts
export interface SystemPromptRow {
	id: number;
	title: string;
	content: string;
	is_active: boolean;
	created_at: Date;
}

export async function getAllSystemPrompts(): Promise<SystemPromptRow[]> {
	await ensureSchemaInitialized();
	const res = await pool.query<SystemPromptRow>(
		"SELECT * FROM system_prompts ORDER BY is_active DESC, id ASC"
	);
	return res.rows;
}

export async function saveSystemPrompt(title: string, content: string): Promise<SystemPromptRow> {
	await ensureSchemaInitialized();
	const res = await pool.query<SystemPromptRow>(
		`INSERT INTO system_prompts (title, content, is_active, created_at)
		 VALUES ($1, $2, FALSE, NOW())
		 RETURNING *`,
		[title, content]
	);
	return res.rows[0];
}

export async function setActiveSystemPrompt(id: number): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query("BEGIN");
	try {
		await pool.query("UPDATE system_prompts SET is_active = FALSE");
		await pool.query("UPDATE system_prompts SET is_active = TRUE WHERE id = $1", [id]);
		await pool.query("COMMIT");
	} catch (error) {
		await pool.query("ROLLBACK");
		throw error;
	}
}

// 23. notifyTelegramHumanNeeded
export async function notifyTelegramHumanNeeded(input: {
	conversation: { id: number; phone: string; jid?: string | null };
	reason: string;
	lastMessage: string;
}): Promise<void> {
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_CHAT_ID;

	const notifier = createTelegramNotifier({
		botToken,
		chatId,
		fetch: globalThis.fetch as any,
	});

	await notifier.notifyHumanoHandoff({
		conversationId: input.conversation.id,
		phone: input.conversation.phone,
		jid: input.conversation.jid || "",
		reason: input.reason,
		lastMessage: input.lastMessage,
	});
}

// notifyGroupFailureReport
export async function notifyGroupFailureReport(input: {
	phone: string;
	senderName: string;
	email?: string;
	reason: string;
	formStatus: "yes" | "no" | "unknown";
	resolved: boolean;
	lob?: string;
	failureType?: string;
}): Promise<void> {
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_CHAT_ID;

	const notifier = createTelegramNotifier({
		botToken,
		chatId,
		fetch: globalThis.fetch as any,
	});

	await notifier.notifyGroupFailureReport(input);
}

export async function notifyBotDisconnected(minutesDisconnected: number): Promise<void> {
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_CHAT_ID;
	const notifier = createTelegramNotifier({
		botToken,
		chatId,
		fetch: globalThis.fetch as any,
	});
	await notifier.notifyBotDisconnected({ minutesDisconnected });
}

// 24. updateConversation(id, patch)
export async function updateConversation(
	id: number,
	patch: Partial<ConversationRow>,
): Promise<ConversationRow> {
	await ensureSchemaInitialized();
	return repo.updateConversation(id, patch);
}

// 25. updateConversationNameIfExists(jid, name)
export async function updateConversationNameIfExists(jid: string, name: string): Promise<void> {
	await ensureSchemaInitialized();
	const phone = jid.replace(/@.*/, "");
	
	const normalized = name.trim();
	if (
		normalized === "WOpen" ||
		normalized === "Azokia" ||
		normalized === "Azokiallc" ||
		normalized === ""
	)
		return;

	await pool.query(
		`UPDATE conversations
		 SET name = $1, updated_at = NOW()
		 WHERE (phone = $2 OR jid = $3)
		   AND (name IS NULL OR TRIM(name) = '' OR (name <> $1 AND name <> 'WOpen' AND name <> 'Azokia' AND name <> 'Azokiallc'))`,
		[normalized, phone, jid]
	);
}

// 26. Automations CRUD
export async function listAutomations(): Promise<AutomationRow[]> {
	await ensureSchemaInitialized();
	const res = await pool.query<AutomationRow>(
		`SELECT * FROM automations
		 ORDER BY enabled DESC, updated_at DESC, id DESC`,
	);
	return res.rows;
}

export async function saveAutomation(input: AutomationInput): Promise<AutomationRow> {
	await ensureSchemaInitialized();
	const normalized = normalizeAutomationInput(input);
	const res = await pool.query<AutomationRow>(
		`INSERT INTO automations (name, enabled, trigger_type, definition, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, NOW(), NOW())
		 RETURNING *`,
		[
			normalized.name,
			normalized.enabled,
			normalized.definition.trigger.type,
			normalized.definition,
		],
	);
	return res.rows[0];
}

export async function updateAutomation(
	id: number,
	input: AutomationInput,
): Promise<AutomationRow | null> {
	await ensureSchemaInitialized();
	const normalized = normalizeAutomationInput(input);
	const res = await pool.query<AutomationRow>(
		`UPDATE automations
		 SET name = $2, enabled = $3, trigger_type = $4, definition = $5, updated_at = NOW()
		 WHERE id = $1
		 RETURNING *`,
		[
			id,
			normalized.name,
			normalized.enabled,
			normalized.definition.trigger.type,
			normalized.definition,
		],
	);
	return res.rows[0] ?? null;
}

export async function setAutomationEnabled(
	id: number,
	enabled: boolean,
): Promise<AutomationRow | null> {
	await ensureSchemaInitialized();
	const res = await pool.query<AutomationRow>(
		`UPDATE automations
		 SET enabled = $2, updated_at = NOW()
		 WHERE id = $1
		 RETURNING *`,
		[id, enabled],
	);
	return res.rows[0] ?? null;
}

export async function deleteAutomation(id: number): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query("DELETE FROM automations WHERE id = $1", [id]);
}

// 27. CRM Tasks CRUD
export async function listCrmTasks(): Promise<CrmTaskListRow[]> {
	await ensureSchemaInitialized();
	const res = await pool.query<CrmTaskListRow>(
		`SELECT t.*,
		        c.name AS conversation_name,
		        c.phone AS conversation_phone,
		        c.lead_labels AS conversation_lead_labels
		 FROM crm_tasks t
		 LEFT JOIN conversations c ON c.id = t.conversation_id
		 ORDER BY
		   CASE t.status
		     WHEN 'pending' THEN 1
		     WHEN 'in_progress' THEN 2
		     ELSE 3
		   END ASC,
		   t.due_at ASC NULLS LAST,
		   t.updated_at DESC,
		   t.id DESC`,
	);
	return res.rows;
}

export async function saveCrmTask(input: Record<string, unknown>): Promise<CrmTaskRow> {
	await ensureSchemaInitialized();
	const normalized: CrmTaskInput = normalizeCrmTaskInput(input);
	const res = await pool.query<CrmTaskRow>(
		`INSERT INTO crm_tasks (
		   conversation_id, title, description, status, task_type,
		   lead_label, priority, due_at, agent_phone, calendar_event_id, appointment_at,
		   created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
		 RETURNING *`,
		[
			normalized.conversation_id,
			normalized.title,
			normalized.description,
			normalized.status,
			normalized.task_type,
			normalized.lead_label,
			normalized.priority,
			normalized.due_at,
			normalized.agent_phone,
			normalized.calendar_event_id,
			normalized.appointment_at,
		],
	);
	return res.rows[0];
}

export async function markCrmTaskReminderSent(id: number): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query("UPDATE crm_tasks SET reminder_sent_at = NOW() WHERE id = $1", [id]);
}

/** Silences reminders for appointments whose time already passed without being notified (e.g. bot was down). */
export async function markMissedAppointmentReminders(): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query(
		`UPDATE crm_tasks
		 SET reminder_sent_at = NOW()
		 WHERE task_type = 'appointment'
		   AND reminder_sent_at IS NULL
		   AND appointment_at IS NOT NULL
		   AND appointment_at <= NOW()`,
	);
}

export interface PendingAppointmentReminderRow {
	id: number;
	title: string;
	description: string | null;
	appointment_at: Date;
	agent_phone: string | null;
	conversation_id: number | null;
	client_phone: string | null;
	client_name: string | null;
}

export async function getPendingAppointmentReminders(
	leadMinutes: number,
): Promise<PendingAppointmentReminderRow[]> {
	await ensureSchemaInitialized();
	const res = await pool.query<PendingAppointmentReminderRow>(
		`SELECT t.id, t.title, t.description, t.appointment_at, t.agent_phone,
		        c.id AS conversation_id, c.phone AS client_phone, c.name AS client_name
		 FROM crm_tasks t
		 LEFT JOIN conversations c ON c.id = t.conversation_id
		 WHERE t.task_type = 'appointment'
		   AND t.reminder_sent_at IS NULL
		   AND t.appointment_at IS NOT NULL
		   AND t.appointment_at <= NOW() + ($1 * INTERVAL '1 minute')
		   AND t.appointment_at > NOW()
		 ORDER BY t.appointment_at ASC
		 LIMIT 50`,
		[leadMinutes],
	);
	return res.rows;
}

export async function updateCrmTask(
	id: number,
	input: Record<string, unknown>,
): Promise<CrmTaskRow | null> {
	await ensureSchemaInitialized();
	const patch: CrmTaskPatch = normalizeCrmTaskPatch(input);
	const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
	if (entries.length === 0) {
		const existing = await pool.query<CrmTaskRow>(
			"SELECT * FROM crm_tasks WHERE id = $1 LIMIT 1",
			[id],
		);
		return existing.rows[0] ?? null;
	}

	const assignments = entries.map(([key], index) => `${key} = $${index + 2}`);
	const values = entries.map(([, value]) => value);
	const res = await pool.query<CrmTaskRow>(
		`UPDATE crm_tasks
		 SET ${assignments.join(", ")}, updated_at = NOW()
		 WHERE id = $1
		 RETURNING *`,
		[id, ...values],
	);
	return res.rows[0] ?? null;
}

export async function deleteCrmTask(id: number): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query("DELETE FROM crm_tasks WHERE id = $1", [id]);
}

// ── Agent Profiles (phone → email mapping for DashBig integration) ──────────

export async function getAgentProfile(phone: string): Promise<AgentProfileRow | null> {
	await ensureSchemaInitialized();
	const res = await pool.query<AgentProfileRow>(
		"SELECT * FROM agent_profiles WHERE phone = $1 LIMIT 1",
		[phone],
	);
	return res.rows[0] ?? null;
}

export async function getAgentProfileByEmail(email: string): Promise<AgentProfileRow | null> {
	await ensureSchemaInitialized();
	const res = await pool.query<AgentProfileRow>(
		"SELECT * FROM agent_profiles WHERE LOWER(email) = LOWER($1) LIMIT 1",
		[email],
	);
	return res.rows[0] ?? null;
}

export async function deleteAgentProfile(phone: string): Promise<boolean> {
	await ensureSchemaInitialized();
	const res = await pool.query(
		"DELETE FROM agent_profiles WHERE phone = $1",
		[phone],
	);
	return (res.rowCount ?? 0) > 0;
}

export async function saveAgentProfile(
	phone: string,
	email: string,
	lob: string | null = null,
): Promise<AgentProfileRow> {
	await ensureSchemaInitialized();
	const res = await pool.query<AgentProfileRow>(
		`INSERT INTO agent_profiles (phone, email, lob, registered_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (phone) DO UPDATE SET email = EXCLUDED.email, lob = EXCLUDED.lob
		 RETURNING *`,
		[phone, email, lob],
	);
	return res.rows[0];
}

export async function listAgentProfiles(): Promise<AgentProfileRow[]> {
	await ensureSchemaInitialized();
	const res = await pool.query<AgentProfileRow>(
		"SELECT * FROM agent_profiles ORDER BY registered_at ASC",
	);
	return res.rows;
}

// ── Near-miss intents (mensajes que cayeron al chat genérico pero mencionaban algo
// relacionado a una capacidad conocida — sirve para detectar palabras clave faltantes) ──

export interface NearMissIntentRow {
	id: number;
	conversation_id: number | null;
	phone: string;
	message: string;
	suspected_categories: string[];
	created_at: Date;
}

export async function logNearMissIntent(input: {
	conversationId: number | null;
	phone: string;
	message: string;
	categories: string[];
}): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query(
		`INSERT INTO near_miss_intents (conversation_id, phone, message, suspected_categories)
		 VALUES ($1, $2, $3, $4)`,
		[input.conversationId, input.phone, input.message, input.categories],
	);
}

export async function listNearMissIntents(limit = 100): Promise<NearMissIntentRow[]> {
	await ensureSchemaInitialized();
	const res = await pool.query<NearMissIntentRow>(
		"SELECT * FROM near_miss_intents ORDER BY created_at DESC LIMIT $1",
		[limit],
	);
	return res.rows;
}

// ── Reportes del grupo de fallas (Internet/Luz) — historial persistente para el TL ──

export interface GroupFailureReportRow {
	id: number;
	phone: string;
	sender_name: string;
	email: string | null;
	reason: string;
	form_status: "yes" | "no" | "unknown";
	resolved: boolean;
	confirmed: boolean;
	queued_offline: boolean;
	tl_reacted_at: Date | null;
	tl_reacted_by: string | null;
	lob: string | null;
	sheet_row: number | null;
	sheet_spreadsheet_id: string | null;
	created_at: Date;
}

export async function insertGroupFailureReport(input: {
	phone: string;
	senderName: string;
	email?: string | null;
	reason: string;
	formStatus: "yes" | "no" | "unknown";
	lob?: string | null;
}): Promise<GroupFailureReportRow> {
	await ensureSchemaInitialized();
	const res = await pool.query<GroupFailureReportRow>(
		`INSERT INTO group_failure_reports (phone, sender_name, email, reason, form_status, lob)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING *`,
		[input.phone, input.senderName, input.email ?? null, input.reason, input.formStatus, input.lob ?? null],
	);
	return res.rows[0];
}

export interface ConfirmedGroupFailureReportRow {
	id: number;
	tl_reacted_at: Date | null;
	tl_reacted_by: string | null;
	created_at: Date;
}

/**
 * Marca el reporte como confirmado/encolado y guarda dónde quedó su fila en el sheet. Devuelve
 * tl_reacted_at/tl_reacted_by tal como quedaron después de este UPDATE — si el TL ya había
 * reaccionado ANTES de que esta fila terminara de escribirse en el sheet (carrera entre
 * markTlReactionForOthers y este confirm), acá vienen ya seteados y el caller es responsable de
 * completar recién ahora la columna de reacción en el sheet, porque markTlReactionForOthers no
 * pudo hacerlo en su momento (sheet_row todavía era NULL).
 */
export async function markGroupFailureReportConfirmed(
	id: number,
	queuedOffline: boolean,
	sheetLocation?: { spreadsheetId: string; row: number } | null,
): Promise<ConfirmedGroupFailureReportRow> {
	await ensureSchemaInitialized();
	const res = await pool.query<ConfirmedGroupFailureReportRow>(
		`UPDATE group_failure_reports
		 SET confirmed = TRUE, queued_offline = $2, sheet_row = $3, sheet_spreadsheet_id = $4
		 WHERE id = $1
		 RETURNING id, tl_reacted_at, tl_reacted_by, created_at`,
		[id, queuedOffline, sheetLocation?.row ?? null, sheetLocation?.spreadsheetId ?? null],
	);
	return res.rows[0];
}

/** Marca como resuelto el último reporte sin resolver de ese teléfono (ej. "ya llegó la luz"). */
export async function markLatestGroupFailureReportResolved(phone: string): Promise<void> {
	await ensureSchemaInitialized();
	await pool.query(
		`UPDATE group_failure_reports SET resolved = TRUE
		 WHERE id = (
		   SELECT id FROM group_failure_reports
		   WHERE phone = $1 AND resolved = FALSE
		   ORDER BY created_at DESC
		   LIMIT 1
		 )`,
		[phone],
	);
}

/**
 * Marca tl_reacted_at en el reporte sin reaccionar más reciente de cada agente distinto a
 * `phone` — se llama con cada mensaje del grupo de fallas. En la práctica el único que le
 * contesta a un reporte de desconexión ahí es el TL en turno, así que "el primer mensaje de
 * alguien más" funciona como proxy de "cuánto tardó el TL en reaccionar" sin necesidad de saber
 * de antemano quién es TL. Los mensajes que manda el propio bot nunca llegan a llamar esta
 * función (el listener los filtra por fromMe antes), así que no hace falta excluirlos acá.
 * Se acota a las últimas horas para no marcar de golpe reportes viejos al agregar la columna.
 */
export interface TlReactionUpdateRow {
	id: number;
	phone: string;
	sheet_row: number | null;
	sheet_spreadsheet_id: string | null;
	created_at: Date;
}

export async function markTlReactionForOthers(
	phone: string,
	reactedAt: Date,
	reactedByName: string,
): Promise<TlReactionUpdateRow[]> {
	await ensureSchemaInitialized();
	const cutoff = new Date(reactedAt.getTime() - 6 * 60 * 60 * 1000);
	const res = await pool.query<TlReactionUpdateRow>(
		`UPDATE group_failure_reports
		 SET tl_reacted_at = $2, tl_reacted_by = $4
		 WHERE phone != $1 AND tl_reacted_at IS NULL AND created_at > $3
		 RETURNING id, phone, sheet_row, sheet_spreadsheet_id, created_at`,
		[phone, reactedAt, cutoff, reactedByName],
	);
	return res.rows;
}

export async function listGroupFailureReports(limit = 100): Promise<GroupFailureReportRow[]> {
	await ensureSchemaInitialized();
	const res = await pool.query<GroupFailureReportRow>(
		"SELECT * FROM group_failure_reports ORDER BY created_at DESC LIMIT $1",
		[limit],
	);
	return res.rows;
}

// ─── Meta Cloud API — recordatorios de turno (proyecto recordatorios-turnos) ──

export interface MetaReminderSentRow {
	id: number;
	phone: string;
	name: string | null;
	hora_inicio: string | null;
	etiqueta_zona: string | null;
	whatsapp_message_id: string | null;
	status: string;
	detalle: string | null;
	sent_at: Date;
}

export interface MetaReplyRow {
	id: number;
	phone: string;
	contact_name: string | null;
	whatsapp_message_id: string | null;
	content: string | null;
	message_type: string;
	raw_payload: Record<string, unknown>;
	received_at: Date;
}

export async function insertMetaReminderSent(input: {
	phone: string;
	name?: string | null;
	horaInicio?: string | null;
	etiquetaZona?: string | null;
	whatsappMessageId?: string | null;
	status?: string;
	detalle?: string | null;
}): Promise<MetaReminderSentRow> {
	await ensureSchemaInitialized();
	const res = await pool.query<MetaReminderSentRow>(
		`INSERT INTO meta_reminders_sent (phone, name, hora_inicio, etiqueta_zona, whatsapp_message_id, status, detalle)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING *`,
		[
			input.phone,
			input.name ?? null,
			input.horaInicio ?? null,
			input.etiquetaZona ?? null,
			input.whatsappMessageId ?? null,
			input.status ?? "sent",
			input.detalle ?? null,
		],
	);
	return res.rows[0];
}

export async function listMetaRemindersSent(
	limit = 200,
	filters?: { date?: string },
): Promise<MetaReminderSentRow[]> {
	await ensureSchemaInitialized();
	if (filters?.date) {
		const res = await pool.query<MetaReminderSentRow>(
			`SELECT * FROM meta_reminders_sent
			 WHERE (sent_at AT TIME ZONE 'America/Bogota')::date = $1::date
			 ORDER BY sent_at DESC LIMIT $2`,
			[filters.date, limit],
		);
		return res.rows;
	}
	const res = await pool.query<MetaReminderSentRow>(
		"SELECT * FROM meta_reminders_sent ORDER BY sent_at DESC LIMIT $1",
		[limit],
	);
	return res.rows;
}

export async function insertMetaReply(input: {
	phone: string;
	contactName?: string | null;
	whatsappMessageId?: string | null;
	content?: string | null;
	messageType?: string;
	rawPayload?: Record<string, unknown>;
	receivedAt?: Date;
}): Promise<MetaReplyRow | null> {
	await ensureSchemaInitialized();
	const res = await pool.query<MetaReplyRow>(
		`INSERT INTO meta_replies (phone, contact_name, whatsapp_message_id, content, message_type, raw_payload, received_at)
		 VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
		 ON CONFLICT (whatsapp_message_id) DO NOTHING
		 RETURNING *`,
		[
			input.phone,
			input.contactName ?? null,
			input.whatsappMessageId ?? null,
			input.content ?? null,
			input.messageType ?? "text",
			JSON.stringify(input.rawPayload ?? {}),
			input.receivedAt ?? null,
		],
	);
	return res.rows[0] ?? null;
}

export async function listMetaReplies(
	limit = 200,
	filters?: { date?: string },
): Promise<MetaReplyRow[]> {
	await ensureSchemaInitialized();
	if (filters?.date) {
		const res = await pool.query<MetaReplyRow>(
			`SELECT * FROM meta_replies
			 WHERE (received_at AT TIME ZONE 'America/Bogota')::date = $1::date
			 ORDER BY received_at DESC LIMIT $2`,
			[filters.date, limit],
		);
		return res.rows;
	}
	const res = await pool.query<MetaReplyRow>(
		"SELECT * FROM meta_replies ORDER BY received_at DESC LIMIT $1",
		[limit],
	);
	return res.rows;
}

