import {
	isLeadLabel,
	type LeadLabel,
} from "../domain/whatsapp-rules.ts";

export const CRM_TASK_STATUSES = ["pending", "in_progress", "done"] as const;
export const CRM_TASK_TYPES = [
	"call_client",
	"follow_up",
	"evaluate_lead",
	"set_label",
	"custom",
	"appointment",
] as const;
export const CRM_TASK_PRIORITIES = ["low", "medium", "high"] as const;

export type CrmTaskStatus = (typeof CRM_TASK_STATUSES)[number];
export type CrmTaskType = (typeof CRM_TASK_TYPES)[number];
export type CrmTaskPriority = (typeof CRM_TASK_PRIORITIES)[number];

export interface CrmTaskInput {
	conversation_id: number | null;
	title: string;
	description: string | null;
	status: CrmTaskStatus;
	task_type: CrmTaskType;
	lead_label: LeadLabel | null;
	priority: CrmTaskPriority;
	due_at: Date | null;
	agent_phone: string | null;
	calendar_event_id: string | null;
	appointment_at: Date | null;
}

export interface CrmTaskPatch {
	conversation_id?: number | null;
	title?: string;
	description?: string | null;
	status?: CrmTaskStatus;
	task_type?: CrmTaskType;
	lead_label?: LeadLabel | null;
	priority?: CrmTaskPriority;
	due_at?: Date | null;
	agent_phone?: string | null;
	calendar_event_id?: string | null;
	appointment_at?: Date | null;
}

export interface CrmTaskRow {
	id: number;
	conversation_id: number | null;
	title: string;
	description: string | null;
	status: CrmTaskStatus;
	task_type: CrmTaskType;
	lead_label: LeadLabel | null;
	priority: CrmTaskPriority;
	due_at: Date | null;
	agent_phone: string | null;
	calendar_event_id: string | null;
	appointment_at: Date | null;
	reminder_sent_at: Date | null;
	created_at: Date;
	updated_at: Date;
}

export interface CrmTaskListRow extends CrmTaskRow {
	conversation_name: string | null;
	conversation_phone: string | null;
	conversation_lead_labels: LeadLabel[] | null;
}

function isOneOf<const T extends readonly string[]>(
	value: unknown,
	options: T,
): value is T[number] {
	return typeof value === "string" && options.includes(value as T[number]);
}

function normalizeText(value: unknown, maxLength: number) {
	return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeNullableText(value: unknown, maxLength: number) {
	const text = normalizeText(value, maxLength);
	return text.length > 0 ? text : null;
}

function normalizeConversationId(value: unknown) {
	if (value === null || value === undefined || value === "") return null;
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(numeric) || numeric <= 0) {
		throw new Error("Invalid conversation ID");
	}
	return numeric;
}

function normalizeDueAt(value: unknown) {
	if (value === null || value === undefined || value === "") return null;
	const date = value instanceof Date ? value : new Date(String(value));
	if (Number.isNaN(date.getTime())) throw new Error("Invalid due date");
	return date;
}

function normalizeLeadLabel(value: unknown) {
	if (value === null || value === undefined || value === "") return null;
	if (!isLeadLabel(value)) throw new Error("Invalid lead label");
	return value;
}

function normalizePhone(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const digits = value.replace(/\D/g, "");
	return digits.length > 0 ? digits : null;
}

function normalizeAppointmentAt(value: unknown) {
	if (value === null || value === undefined || value === "") return null;
	const date = value instanceof Date ? value : new Date(String(value));
	if (Number.isNaN(date.getTime())) throw new Error("Invalid appointment date");
	return date;
}

export function normalizeCrmTaskInput(input: Record<string, unknown>): CrmTaskInput {
	const title = normalizeText(input.title, 140);
	if (!title) throw new Error("Task title is required");

	return {
		conversation_id: normalizeConversationId(input.conversation_id),
		title,
		description: normalizeNullableText(input.description, 500),
		status: isOneOf(input.status, CRM_TASK_STATUSES) ? input.status : "pending",
		task_type: isOneOf(input.task_type, CRM_TASK_TYPES) ? input.task_type : "custom",
		lead_label: normalizeLeadLabel(input.lead_label),
		priority: isOneOf(input.priority, CRM_TASK_PRIORITIES)
			? input.priority
			: "medium",
		due_at: normalizeDueAt(input.due_at),
		agent_phone: normalizePhone(input.agent_phone),
		calendar_event_id: normalizeNullableText(input.calendar_event_id, 200),
		appointment_at: normalizeAppointmentAt(input.appointment_at),
	};
}

export function normalizeCrmTaskPatch(input: Record<string, unknown>): CrmTaskPatch {
	const patch: CrmTaskPatch = {};

	if ("conversation_id" in input) {
		patch.conversation_id = normalizeConversationId(input.conversation_id);
	}
	if ("title" in input) {
		const title = normalizeText(input.title, 140);
		if (!title) throw new Error("Task title is required");
		patch.title = title;
	}
	if ("description" in input) {
		patch.description = normalizeNullableText(input.description, 500);
	}
	if ("status" in input) {
		if (!isOneOf(input.status, CRM_TASK_STATUSES)) throw new Error("Invalid task status");
		patch.status = input.status;
	}
	if ("task_type" in input) {
		if (!isOneOf(input.task_type, CRM_TASK_TYPES)) throw new Error("Invalid task type");
		patch.task_type = input.task_type;
	}
	if ("lead_label" in input) {
		patch.lead_label = normalizeLeadLabel(input.lead_label);
	}
	if ("priority" in input) {
		if (!isOneOf(input.priority, CRM_TASK_PRIORITIES)) throw new Error("Invalid task priority");
		patch.priority = input.priority;
	}
	if ("due_at" in input) {
		patch.due_at = normalizeDueAt(input.due_at);
	}
	if ("agent_phone" in input) {
		patch.agent_phone = normalizePhone(input.agent_phone);
	}
	if ("calendar_event_id" in input) {
		patch.calendar_event_id = normalizeNullableText(input.calendar_event_id, 200);
	}
	if ("appointment_at" in input) {
		patch.appointment_at = normalizeAppointmentAt(input.appointment_at);
	}

	return patch;
}
