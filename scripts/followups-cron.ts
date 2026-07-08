import "./env-loader";
import {
	createFollowUpScheduler,
	followUpDurationHours,
} from "../src/lib/followup-scheduler.ts";
import { createIoredisTurnState } from "../src/lib/redis-adapter.ts";
import { createConfiguredChatClient } from "../src/lib/ai-providers.ts";
import { createTelegramNotifier } from "../src/lib/telegram-notifier.ts";
import {
	getSettings,
	getPendingFollowUps,
	getConversationById,
	insertMessageAndTouchConversation,
	updateConversation,
	recordConversationEvent,
	markFollowUpBlocked,
	getRecentHistory,
} from "../src/lib/db.ts";
import { Redis } from "ioredis";

const redisClient = new Redis(process.env.REDIS_URL || "redis://redis:6379");
const turnState = createIoredisTurnState(redisClient);

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const notifier = createTelegramNotifier({
	botToken,
	chatId,
	fetch: globalThis.fetch as any,
});

const scheduler = createFollowUpScheduler({
	now: () => new Date(),
	repo: {
		getSettings,
		getPendingFollowUps,
		getConversationById,
		insertMessageAndTouchConversation,
		updateConversation,
		recordConversationEvent,
		markFollowUpBlocked,
	},
	turnState,
	getRecentHistory,
	decideFollowUp: async (history) => {
		const settings = await getSettings();
		const chatClient = createConfiguredChatClient(settings);
		const res = await chatClient.generateFollowUpDecision({ history });
		if (!res.ok) {
			return { ok: false, reason: res.reason };
		}
		return { ok: true, parsed: res.parsed };
	},
	sendWhatsAppMessage: async (jid, text) => {
		const { globalSock, sendViaGlobalSock } = await import("../src/lib/baileys/client.ts");
		// sock.user.id solo existe una vez autenticado; globalSock ya existe antes de eso
		// y llamar sendMessage en ese punto rompe dentro de Baileys (authState.creds.me undefined).
		if (globalSock?.user?.id) {
			await sendViaGlobalSock(jid, { text }, { kind: "reactive" });
		} else {
			throw new Error("[scheduler] WhatsApp socket todavía no autenticado.");
		}
	},
	notifyFollowupBlocked: async (input) => {
		return notifier.notifyFollowupBlocked({
			conversationId: input.conversationId,
			phone: input.phone,
			reason: input.reason,
		});
	},
	generateToken: () => Math.random().toString(36).substring(2, 15),
	// El pacing entre followups de una misma corrida ahora lo da la cola global de envío
	// (sendViaGlobalSock); no hace falta pacear localmente antes de cada processCandidate.
});

export async function runFollowupSchedulerOnce() {
	try {
		return await scheduler.runOnce();
	} catch (error) {
		console.error("[followup] Error ejecutando el evaluador de seguimientos:", error);
	}
}

async function getFollowupIntervalMs() {
	if (process.env.DEV_FOLLOWUP_POLL_INTERVAL_MS) {
		const parsed = parseInt(process.env.DEV_FOLLOWUP_POLL_INTERVAL_MS, 10);
		if (!isNaN(parsed) && parsed > 0) return parsed;
	}
	const settings = await getSettings();
	const configuredHours = followUpDurationHours(
		settings,
		"followup_interval_hours",
		"followup_interval_minutes",
	);
	return Math.max(Math.round(configuredHours * 3_600_000), 60_000);
}

function describeMs(ms: number) {
	const totalMinutes = Math.round(ms / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h`;
	return `${totalMinutes}m`;
}

export function startFollowupsCron() {
	console.log("[followup] Iniciando loop de seguimiento automatico...");
	const tick = async () => {
		await runFollowupSchedulerOnce();
		const intervalMs = await getFollowupIntervalMs();
		const nextAt = new Date(Date.now() + intervalMs);
		console.log(
			`[followup] Proxima evaluacion programada en ${describeMs(intervalMs)} (${nextAt.toISOString()}).`,
		);
		setTimeout(tick, intervalMs);
	};
	tick().catch((error) => {
		console.error("[followup] Error critico en el loop de seguimiento:", error);
	});
}
