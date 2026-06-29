import type {
	ConversationMode,
	MessageRole,
	LeadLabel,
} from "../domain/whatsapp-rules.ts";
import type {
	CrmTaskPriority,
	CrmTaskStatus,
	CrmTaskType,
} from "./crm-tasks.ts";

export type MessageDirection = "inbound" | "outbound";
export type MessageSource =
	| "whatsapp"
	| "dashboard"
	| "bot"
	| "scheduler"
	| "system";
export type MediaType = "text" | "image" | "audio" | "unknown";
export type ModeChangedBy = "system" | "owner" | "dashboard" | "assistant";
export type ConversationEventType =
	| "bot_disabled"
	| "bot_enabled"
	| "handoff_to_human"
	| "followup_sent"
	| "followup_skipped"
	| "followup_blocked_24h"
	| "deepseek_json_invalid"
	| "turn_failed";
export type EventActorRole = MessageRole | "system";
export type UserStatus = "active" | "disabled";
export type TeamMembershipRole = "owner" | "manager" | "agent" | "viewer";
export type CrmContactMethodType =
	| "whatsapp_phone"
	| "whatsapp_jid"
	| "email"
	| "phone"
	| "other";
export type AiSuggestionStatus = "pending" | "approved" | "rejected" | "expired";
export type AiSuggestionAction =
	| "create_task"
	| "update_lead"
	| "route_to_human"
	| "create_deal"
	| "update_deal_stage"
	| "send_reply";

export type AgentProfileRow = {
	phone: string;
	email: string;
	lob: string | null;
	registered_at: string;
};

export const DEFAULT_SETTINGS = {
	bot_on_keyword: "ok.",
	keyword_match_mode: "exact",
	keyword_case_sensitive: false,
	debounce_ms: 12_000,
	processing_lock_ttl_ms: 90_000,
	dedupe_ttl_seconds: 86_400,
	conversation_queue_ttl_seconds: 300,
	followup_interval_hours: 12,
	followup_interval_minutes: 0,
	followup_min_hours_after_assistant: 12,
	followup_min_minutes_after_assistant: 0,
	followup_max_attempts: 2,
	whatsapp_freeform_window_hours: 24,
	block_outside_24h_followups: true,
	chat_ai_provider: "deepseek",
	chat_ai_base_url: "https://api.deepseek.com",
	chat_ai_api_key: "",
	chat_ai_model: "deepseek-v4-pro",
	audio_ai_provider: "openai",
	audio_ai_base_url: "https://api.openai.com/v1",
	audio_ai_api_key: "",
	audio_ai_model: "gpt-4o-transcribe",
	image_ai_provider: "openai",
	image_ai_base_url: "https://api.openai.com/v1",
	image_ai_api_key: "",
	image_ai_model: "gpt-4o-mini",
} as const;

export const DATABASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY, phone TEXT UNIQUE NOT NULL, jid TEXT UNIQUE, name TEXT,
  profile_picture_url TEXT, profile_picture_fetched_at TIMESTAMP WITH TIME ZONE,
  mode TEXT CHECK(mode IN ('AI','HUMAN')) NOT NULL DEFAULT 'AI', mode_reason TEXT,
  mode_changed_at TIMESTAMP WITH TIME ZONE, mode_changed_by TEXT CHECK(mode_changed_by IN ('system','owner','dashboard','assistant')),
  followup_attempts INTEGER NOT NULL DEFAULT 0, last_followup_at TIMESTAMP WITH TIME ZONE,
  followup_blocked_at TIMESTAMP WITH TIME ZONE, followup_blocked_reason TEXT, last_message_at TIMESTAMP WITH TIME ZONE,
  last_user_message_at TIMESTAMP WITH TIME ZONE, last_assistant_message_at TIMESTAMP WITH TIME ZONE,
  last_human_message_at TIMESTAMP WITH TIME ZONE, last_owner_intervention_at TIMESTAMP WITH TIME ZONE,
  last_ai_reactivated_at TIMESTAMP WITH TIME ZONE, unread_count INTEGER NOT NULL DEFAULT 0,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  lead_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  lead_score INTEGER CHECK(lead_score IS NULL OR (lead_score >= 0 AND lead_score <= 100)),
  lead_score_reason TEXT,
  lead_updated_at TIMESTAMP WITH TIME ZONE,
  lead_updated_by TEXT CHECK(lead_updated_by IS NULL OR lead_updated_by IN ('assistant','dashboard')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  whatsapp_message_id TEXT, direction TEXT CHECK(direction IN ('inbound','outbound')) NOT NULL,
  role TEXT CHECK(role IN ('user','assistant','human')) NOT NULL, content TEXT NOT NULL,
  media_type TEXT CHECK(media_type IN ('text','image','audio','unknown')) DEFAULT 'text',
  source TEXT CHECK(source IN ('whatsapp','dashboard','bot','scheduler','system')) NOT NULL DEFAULT 'whatsapp',
  from_me BOOLEAN NOT NULL DEFAULT FALSE, raw_timestamp TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(), metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_whatsapp_id ON messages(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW());
INSERT INTO settings (key, value) VALUES
  ('bot_on_keyword', '"ok."'::jsonb), ('keyword_match_mode', '"exact"'::jsonb),
  ('keyword_case_sensitive', 'false'::jsonb), ('debounce_ms', '30000'::jsonb),
  ('processing_lock_ttl_ms', '90000'::jsonb), ('dedupe_ttl_seconds', '86400'::jsonb), ('conversation_queue_ttl_seconds', '300'::jsonb),
  ('followup_interval_hours', '12'::jsonb), ('followup_interval_minutes', '0'::jsonb), ('followup_min_hours_after_assistant', '12'::jsonb), ('followup_min_minutes_after_assistant', '0'::jsonb), ('followup_max_attempts', '2'::jsonb),
  ('whatsapp_freeform_window_hours', '24'::jsonb), ('block_outside_24h_followups', 'true'::jsonb),
  ('chat_ai_provider', '"deepseek"'::jsonb), ('chat_ai_base_url', '"https://api.deepseek.com"'::jsonb), ('chat_ai_api_key', '""'::jsonb), ('chat_ai_model', '"deepseek-v4-pro"'::jsonb),
  ('audio_ai_provider', '"openai"'::jsonb), ('audio_ai_base_url', '"https://api.openai.com/v1"'::jsonb), ('audio_ai_api_key', '""'::jsonb), ('audio_ai_model', '"gpt-4o-transcribe"'::jsonb),
  ('image_ai_provider', '"openai"'::jsonb), ('image_ai_base_url', '"https://api.openai.com/v1"'::jsonb), ('image_ai_api_key', '""'::jsonb), ('image_ai_model', '"gpt-4o-mini"'::jsonb),
  ('dashbig_reports_enabled', 'false'::jsonb), ('dashbig_report_hour', '"09:00"'::jsonb),
  ('dashbig_webapp_url', '""'::jsonb), ('dashbig_api_key', '""'::jsonb),
  ('programacion_1_id', '"1NrZfcE5z0mfg_LthrAtf0wlgYbqiBQ_tlF085GElkyc"'::jsonb),
  ('programacion_2_id', '"1UqRuXwkd_NOx59eWX5oteCPRJqRHNvl894GvZyj-vGo"'::jsonb),
  ('appointments_calendar_id', '""'::jsonb),
  ('appointment_reminder_lead_minutes', '60'::jsonb),
  ('appointment_duration_minutes', '30'::jsonb),
  ('google_oauth_refresh_token', '""'::jsonb)
ON CONFLICT (key) DO NOTHING;
CREATE TABLE IF NOT EXISTS agent_profiles (
  phone TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  lob TEXT,
  registered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS conversation_events (
  id SERIAL PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, event_type TEXT NOT NULL,
  actor_role TEXT CHECK(actor_role IN ('user','assistant','human','system')) NOT NULL, reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversation_events_conv_created ON conversation_events(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  status TEXT CHECK(status IN ('active','disabled')) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS team_memberships (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT CHECK(role IN ('owner','manager','agent','viewer')) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, user_id)
);
CREATE TABLE IF NOT EXISTS user_password_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active_lookup ON user_sessions(session_token_hash, expires_at) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS audit_events (
  id SERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity_created ON audit_events(entity_type, entity_id, created_at DESC);
CREATE TABLE IF NOT EXISTS crm_accounts (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS crm_contacts (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  display_name TEXT,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS crm_contact_methods (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  method_type TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(method_type, normalized_value)
);
CREATE INDEX IF NOT EXISTS idx_crm_contact_methods_contact ON crm_contact_methods(contact_id, id);
CREATE TABLE IF NOT EXISTS crm_contact_account_links (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(contact_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_contact_account_links_account ON crm_contact_account_links(account_id, contact_id);
CREATE TABLE IF NOT EXISTS conversation_crm_links (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
  account_id INTEGER REFERENCES crm_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id),
  CHECK (contact_id IS NOT NULL OR account_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS crm_deals (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  amount NUMERIC(15, 2),
  currency TEXT NOT NULL DEFAULT 'USD',
  stage TEXT CHECK(stage IN ('lead','contacted','proposal_sent','won','lost')) NOT NULL DEFAULT 'lead',
  contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES crm_accounts(id) ON DELETE CASCADE,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expected_close_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_deal_owner CHECK (contact_id IS NOT NULL OR account_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_crm_deals_contact ON crm_deals(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_account ON crm_deals(account_id);

CREATE TABLE IF NOT EXISTS crm_ai_suggestions (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
  deal_id INTEGER REFERENCES crm_deals(id) ON DELETE SET NULL,
  action_type TEXT CHECK(action_type IN ('create_task','update_lead','route_to_human','create_deal','update_deal_stage','send_reply')) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(5, 4),
  reason TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending','approved','rejected','expired')) NOT NULL DEFAULT 'pending',
  requires_confirmation BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'lead_qualification',
  resolved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_ai_suggestions_conversation_status ON crm_ai_suggestions(conversation_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_ai_suggestions_status_created ON crm_ai_suggestions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS system_prompts (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS automations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  trigger_type TEXT CHECK(trigger_type IN ('incoming_message')) NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automations_enabled_trigger ON automations(enabled, trigger_type);

CREATE TABLE IF NOT EXISTS crm_tasks (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT CHECK(status IN ('pending','in_progress','done')) NOT NULL DEFAULT 'pending',
  task_type TEXT CHECK(task_type IN ('call_client','follow_up','evaluate_lead','set_label','custom')) NOT NULL DEFAULT 'custom',
  lead_label TEXT CHECK(lead_label IS NULL OR lead_label IN ('frio','neutro','caliente','cliente_potencial')),
  priority TEXT CHECK(priority IN ('low','medium','high')) NOT NULL DEFAULT 'medium',
  due_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_status_due ON crm_tasks(status, due_at NULLS LAST, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_conversation ON crm_tasks(conversation_id);

CREATE TABLE IF NOT EXISTS connection_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT CHECK(status IN ('disconnected','qr','connecting','connected')) NOT NULL DEFAULT 'disconnected',
  qr_string TEXT,
  phone TEXT,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO connection_state (id, status)
VALUES (1, 'disconnected')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS outbox (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  content TEXT NOT NULL,
  media_type TEXT CHECK(media_type IN ('text','image','audio','unknown')) NOT NULL DEFAULT 'text',
  media_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sent, created_at);

CREATE TABLE IF NOT EXISTS whatsapp_instances (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  phone TEXT,
  status TEXT CHECK(status IN ('disconnected','qr','connecting','connected')) NOT NULL DEFAULT 'disconnected',
  qr_string TEXT,
  profile_picture_url TEXT,
  profile_status TEXT,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_instances_one_active ON whatsapp_instances(is_active) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS near_miss_intents (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  suspected_categories TEXT[] NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_near_miss_intents_created_at ON near_miss_intents(created_at DESC);

CREATE TABLE IF NOT EXISTS group_failure_reports (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  email TEXT,
  reason TEXT NOT NULL,
  form_status TEXT CHECK(form_status IN ('yes','no','unknown')) NOT NULL DEFAULT 'unknown',
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  queued_offline BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_group_failure_reports_phone ON group_failure_reports(phone);
CREATE INDEX IF NOT EXISTS idx_group_failure_reports_created_at ON group_failure_reports(created_at DESC);

CREATE TABLE IF NOT EXISTS form_agents (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broadcast_agents (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS send_after TIMESTAMP WITH TIME ZONE DEFAULT NULL;

INSERT INTO form_agents (name, phone) VALUES
  ('Liliana',   '573107226481'),
  ('Marlon',    '573158202463'),
  ('Belcy',     '573222100253'),
  ('Juliett',   '573115248485'),
  ('Mary',      '573187912575'),
  ('Rafael',    '573021057509'),
  ('Leidy',     '573185633098'),
  ('Felipe',    '573502896859'),
  ('Yinery',    '573143806767'),
  ('Estephany', '573208434094'),
  ('Eyder',     '573142508700'),
  ('Angelica',  '573103937935'),
  ('Manuel',    '573143084870'),
  ('Ana',       '573016713921')
ON CONFLICT (phone) DO NOTHING;
`;

export interface ConversationRow {
	id: number;
	phone: string;
	jid: string | null;
	lid_jid?: string | null;
	name: string | null;
	profile_picture_url: string | null;
	profile_picture_fetched_at: Date | null;
	mode: ConversationMode;
	mode_reason: string | null;
	mode_changed_at: Date | null;
	mode_changed_by: ModeChangedBy | null;
	followup_attempts: number;
	last_followup_at: Date | null;
	followup_blocked_at: Date | null;
	followup_blocked_reason: string | null;
	last_message_at: Date | null;
	last_user_message_at: Date | null;
	last_assistant_message_at: Date | null;
	last_human_message_at: Date | null;
	last_owner_intervention_at: Date | null;
	last_ai_reactivated_at: Date | null;
	unread_count: number;
	is_archived: boolean;
	lead_labels: LeadLabel[];
	lead_score: number | null;
	lead_score_reason: string | null;
	lead_updated_at: Date | null;
	lead_updated_by: "assistant" | "dashboard" | null;
	created_at: Date;
	updated_at: Date;
}
export interface WhatsAppInstanceRow {
	id: number;
	name: string;
	phone: string | null;
	status: "disconnected" | "qr" | "connecting" | "connected";
	qr_string: string | null;
	profile_picture_url: string | null;
	profile_status: string | null;
	is_active: boolean;
	created_at: Date;
	updated_at: Date;
}
export interface CrmTaskDbRow {
	id: number;
	conversation_id: number | null;
	title: string;
	description: string | null;
	status: CrmTaskStatus;
	task_type: CrmTaskType;
	lead_label: LeadLabel | null;
	priority: CrmTaskPriority;
	due_at: Date | null;
	created_at: Date;
	updated_at: Date;
}
export interface MessageRow {
	id: number;
	conversation_id: number;
	whatsapp_message_id: string | null;
	direction: MessageDirection;
	role: MessageRole;
	content: string;
	media_type: MediaType;
	source: MessageSource;
	from_me: boolean;
	raw_timestamp: Date | null;
	created_at: Date;
	metadata: Record<string, unknown>;
}
export interface ConversationEventRow {
	id: number;
	conversation_id: number;
	event_type: ConversationEventType;
	actor_role: EventActorRole;
	reason: string | null;
	metadata: Record<string, unknown>;
	created_at: Date;
}
export interface TeamRow {
	id: number;
	name: string;
	created_at: Date;
}
export interface UserRow {
	id: number;
	email: string;
	display_name: string | null;
	status: UserStatus;
	created_at: Date;
	updated_at: Date;
}
export interface TeamMembershipRow {
	id: number;
	team_id: number;
	user_id: number;
	role: TeamMembershipRole;
	created_at: Date;
}
export interface UserPasswordCredentialRow {
	user_id: number;
	password_hash: string;
	created_at: Date;
	updated_at: Date;
}
export interface UserSessionRow {
	id: number;
	user_id: number;
	session_token_hash: string;
	expires_at: Date;
	revoked_at: Date | null;
	created_at: Date;
}
export interface AuditEventRow {
	id: number;
	actor_user_id: number | null;
	team_id: number | null;
	entity_type: string;
	entity_id: string;
	action: string;
	before_json: Record<string, unknown>;
	after_json: Record<string, unknown>;
	request_metadata: Record<string, unknown>;
	created_at: Date;
}
export interface CrmAccountRow {
	id: number;
	team_id: number | null;
	name: string;
	owner_user_id: number | null;
	created_at: Date;
	updated_at: Date;
}
export interface CrmContactRow {
	id: number;
	team_id: number | null;
	display_name: string | null;
	owner_user_id: number | null;
	created_at: Date;
	updated_at: Date;
}
export interface CrmContactMethodRow {
	id: number;
	contact_id: number;
	method_type: CrmContactMethodType | string;
	value: string;
	normalized_value: string;
	is_primary: boolean;
	created_at: Date;
}
export interface CrmContactAccountLinkRow {
	id: number;
	contact_id: number;
	account_id: number;
	created_at: Date;
}
export interface ConversationCrmLinkRow {
	id: number;
	conversation_id: number;
	contact_id: number | null;
	account_id: number | null;
	created_at: Date;
	updated_at: Date;
}
export interface CrmDealRow {
	id: number;
	team_id: number | null;
	title: string;
	description: string | null;
	amount: number | null;
	currency: string;
	stage: "lead" | "contacted" | "proposal_sent" | "won" | "lost";
	contact_id: number | null;
	account_id: number | null;
	owner_user_id: number | null;
	expected_close_date: Date | null;
	created_at: Date;
	updated_at: Date;
}
export interface AiCrmSuggestionRow {
	id: number;
	conversation_id: number;
	contact_id: number | null;
	deal_id: number | null;
	action_type: AiSuggestionAction;
	payload: Record<string, unknown>;
	confidence: number | null;
	reason: string;
	status: AiSuggestionStatus;
	requires_confirmation: boolean;
	source: string;
	resolved_by_user_id: number | null;
	resolution_note: string | null;
	resolved_at: Date | null;
	created_at: Date;
	updated_at: Date;
}
export interface InsertMessageInput {
	conversation_id: number;
	whatsapp_message_id?: string | null;
	direction: MessageDirection;
	role: MessageRole;
	content: string;
	media_type?: MediaType;
	source: MessageSource;
	from_me?: boolean;
	raw_timestamp?: Date | null;
	created_at?: Date;
	metadata?: Record<string, unknown>;
}
export interface FollowUpQueryInput {
	now: Date;
	minHoursAfterAssistant: number;
	maxAttempts: number;
	freeformWindowHours: number;
	blockOutside24h: boolean;
}

const nowDate = () => new Date();
const hoursBetween = (later: Date, earlier: Date) =>
	(later.getTime() - earlier.getTime()) / 3_600_000;
const actorFor = (changedBy: ModeChangedBy): EventActorRole =>
	changedBy === "assistant"
		? "assistant"
		: changedBy === "system"
			? "system"
			: "human";

export function createInMemoryRepository() {
	const conversations: ConversationRow[] = [],
		messages: MessageRow[] = [],
		events: ConversationEventRow[] = [];
	let nextConversationId = 1,
		nextMessageId = 1,
		nextEventId = 1;

	const repo = {
		getOrCreateConversation(input: {
			phone: string;
			jid?: string | null;
			name?: string | null;
			lidJid?: string | null;
		}): ConversationRow {
			const existing = conversations.find(
				(row) =>
					row.phone === input.phone ||
					(input.jid && row.jid === input.jid) ||
					(input.lidJid && row.lid_jid === input.lidJid),
			);
			if (existing) {
				if (
					input.phone &&
					existing.phone !== input.phone &&
					input.jid &&
					existing.jid === input.jid
				) {
					existing.phone = input.phone;
					existing.updated_at = nowDate();
				}
				if (input.jid && existing.jid !== input.jid) {
					existing.jid = input.jid;
					existing.updated_at = nowDate();
				}
				if (input.lidJid && existing.lid_jid !== input.lidJid) {
					existing.lid_jid = input.lidJid;
					existing.updated_at = nowDate();
				}
				return existing;
			}
			const created = nowDate();
			const row: ConversationRow = {
				id: nextConversationId++,
				phone: input.phone,
				jid: input.jid ?? null,
				lid_jid: input.lidJid ?? null,
				name: input.name ?? null,
				profile_picture_url: null,
				profile_picture_fetched_at: null,
				mode: "AI",
				mode_reason: null,
				mode_changed_at: null,
				mode_changed_by: null,
				followup_attempts: 0,
				last_followup_at: null,
				followup_blocked_at: null,
				followup_blocked_reason: null,
				last_message_at: null,
				last_user_message_at: null,
				last_assistant_message_at: null,
				last_human_message_at: null,
				last_owner_intervention_at: null,
				last_ai_reactivated_at: null,
				unread_count: 0,
				is_archived: false,
				lead_labels: [],
				lead_score: null,
				lead_score_reason: null,
				lead_updated_at: null,
				lead_updated_by: null,
				created_at: created,
				updated_at: created,
			};
			conversations.push(row);
			return row;
		},
		getConversationById(id: number) {
			return conversations.find((row) => row.id === id) ?? null;
		},
		updateConversation(
			id: number,
			patch: Partial<ConversationRow>,
		): ConversationRow {
			const row = repo.getConversationById(id);
			if (!row) throw new Error(`conversation_not_found:${id}`);
			Object.assign(row, patch, { updated_at: patch.updated_at ?? nowDate() });
			return row;
		},
		insertMessageAndTouchConversation(input: InsertMessageInput): MessageRow {
			const conversation = repo.getConversationById(input.conversation_id);
			if (!conversation)
				throw new Error(`conversation_not_found:${input.conversation_id}`);
			if (
				input.whatsapp_message_id &&
				messages.some(
					(row) => row.whatsapp_message_id === input.whatsapp_message_id,
				)
			)
				throw new Error(
					`duplicate_whatsapp_message_id:${input.whatsapp_message_id}`,
				);
			const createdAt = input.created_at ?? nowDate();
			const message: MessageRow = {
				id: nextMessageId++,
				conversation_id: input.conversation_id,
				whatsapp_message_id: input.whatsapp_message_id ?? null,
				direction: input.direction,
				role: input.role,
				content: input.content,
				media_type: input.media_type ?? "text",
				source: input.source,
				from_me: input.from_me ?? false,
				raw_timestamp: input.raw_timestamp ?? null,
				created_at: createdAt,
				metadata: input.metadata ?? {},
			};
			messages.push(message);
			conversation.last_message_at = createdAt;
			conversation.updated_at = createdAt;
			if (message.role === "user") {
				conversation.last_user_message_at = createdAt;
				conversation.followup_attempts = 0;
				conversation.followup_blocked_at = null;
				conversation.followup_blocked_reason = null;
			} else if (message.role === "assistant")
				conversation.last_assistant_message_at = createdAt;
			else {
				conversation.last_human_message_at = createdAt;
				if (message.from_me || message.source === "whatsapp")
					conversation.last_owner_intervention_at = createdAt;
			}
			return message;
		},
		setMode(
			id: number,
			mode: ConversationMode,
			input: {
				reason: string;
				changedBy: ModeChangedBy;
				changedAt?: Date;
				eventType?: ConversationEventType;
				metadata?: Record<string, unknown>;
			},
		) {
			const changedAt = input.changedAt ?? nowDate(),
				previous = repo.getConversationById(id);
			repo.updateConversation(id, {
				mode,
				mode_reason: input.reason,
				mode_changed_by: input.changedBy,
				mode_changed_at: changedAt,
				last_ai_reactivated_at:
					mode === "AI" && input.reason === "owner_keyword_on"
						? changedAt
						: (previous?.last_ai_reactivated_at ?? null),
				updated_at: changedAt,
			});
			return input.eventType
				? repo.recordConversationEvent({
						conversation_id: id,
						event_type: input.eventType,
						actor_role: actorFor(input.changedBy),
						reason: input.reason,
						metadata: input.metadata ?? {},
						created_at: changedAt,
					})
				: null;
		},
		recordConversationEvent(input: {
			conversation_id: number;
			event_type: ConversationEventType;
			actor_role: EventActorRole;
			reason?: string | null;
			metadata?: Record<string, unknown>;
			created_at?: Date;
		}): ConversationEventRow {
			if (!repo.getConversationById(input.conversation_id))
				throw new Error(`conversation_not_found:${input.conversation_id}`);
			const event = {
				id: nextEventId++,
				conversation_id: input.conversation_id,
				event_type: input.event_type,
				actor_role: input.actor_role,
				reason: input.reason ?? null,
				metadata: input.metadata ?? {},
				created_at: input.created_at ?? nowDate(),
			};
			events.push(event);
			return event;
		},
		markFollowUpBlocked(
			conversationId: number,
			reason: string,
			blockedAt = nowDate(),
		) {
			repo.updateConversation(conversationId, {
				followup_blocked_at: blockedAt,
				followup_blocked_reason: reason,
				updated_at: blockedAt,
			});
			return repo.recordConversationEvent({
				conversation_id: conversationId,
				event_type: "followup_blocked_24h",
				actor_role: "system",
				reason,
				metadata: { boundary: "whatsapp_freeform_window" },
				created_at: blockedAt,
			});
		},
		getPendingFollowUps(input: FollowUpQueryInput): ConversationRow[] {
			return conversations.filter((conversation) => {
				if (
					conversation.mode !== "AI" ||
					conversation.followup_attempts >= input.maxAttempts
				)
					return false;
				const rows = messages
					.filter((message) => message.conversation_id === conversation.id)
					.sort((a, b) => a.id - b.id);
				const latest = rows.at(-1);
				if (!latest || latest.role !== "assistant") return false;
				if (
					hoursBetween(input.now, latest.created_at) <
					input.minHoursAfterAssistant
				)
					return false;
				if (
					conversation.last_followup_at &&
					hoursBetween(input.now, conversation.last_followup_at) <
						input.minHoursAfterAssistant
				)
					return false;
				if (
					rows.some(
						(message) =>
							message.role === "user" && message.id > latest.id,
					)
				)
					return false;
				return true;
			});
		},
		getSettings() {
			return { ...DEFAULT_SETTINGS };
		},
		listEvents() {
			return [...events];
		},
	};
	return repo;
}
