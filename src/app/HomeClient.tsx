"use client";

import { useReducer, useEffect, useRef, useMemo } from "react";
import ConnectionGate from "../components/ConnectionGate.tsx";
import DashboardHeader from "../components/DashboardHeader.tsx";
import ConversationList from "../components/ConversationList.tsx";
import ConversationPanel from "../components/ConversationPanel.tsx";
import PromptsManager from "../components/PromptsManager.tsx";
import SettingsPanel from "../components/SettingsPanel.tsx";
import QRScreen from "../components/QRScreen.tsx";
import DashboardOverview from "../components/DashboardOverview.tsx";
import AutomationsOverview from "../components/AutomationsOverview.tsx";
import ContactsOverview from "../components/ContactsOverview.tsx";
import TasksBoard from "../components/TasksBoard.tsx";
import Sidebar from "../components/Sidebar.tsx";
import AnalyticsPanel from "../components/AnalyticsPanel.tsx";
import FailureReportsPanel from "../components/FailureReportsPanel.tsx";
import BroadcastPanel from "../components/BroadcastPanel.tsx";
import {
	MessagesIcon,
} from "../components/Icons.tsx";
import type { ConversationListRow } from "../lib/db.ts";

type Tab =
	| "dashboard"
	| "chats"
	| "deals"
	| "prompts"
	| "automations"
	| "contacts"
	| "analytics"
	| "fallas"
	| "broadcasts"
	| "settings";

const UI_STATE_STORAGE_KEY = "wopen.ui-state";
const TABS: readonly Tab[] = [
	"dashboard",
	"chats",
	"deals",
	"prompts",
	"automations",
	"contacts",
	"analytics",
	"fallas",
	"broadcasts",
	"settings",
];

interface UIState {
	activeTab: Tab;
	selectedId: number | null;
	showArchived: boolean;
}

const DEFAULT_UI_STATE: UIState = {
	activeTab: "dashboard",
	selectedId: null,
	showArchived: false,
};

function isTab(value: unknown): value is Tab {
	return typeof value === "string" && TABS.includes(value as Tab);
}

function readStoredUiState(): UIState {
	if (typeof window === "undefined") return DEFAULT_UI_STATE;

	try {
		const raw = window.localStorage.getItem(UI_STATE_STORAGE_KEY);
		if (!raw) return DEFAULT_UI_STATE;

		const parsed = JSON.parse(raw) as Partial<UIState>;
		return {
			activeTab: isTab(parsed.activeTab)
				? parsed.activeTab
				: DEFAULT_UI_STATE.activeTab,
			selectedId:
				typeof parsed.selectedId === "number" && Number.isFinite(parsed.selectedId)
					? parsed.selectedId
					: null,
			showArchived: parsed.showArchived === true,
		};
	} catch {
		return DEFAULT_UI_STATE;
	}
}

type UIAction =
	| { type: "SET_TAB"; tab: Tab }
	| { type: "SELECT_CONVO"; id: number | null }
	| { type: "TOGGLE_ARCHIVED"; archived: boolean };

function uiReducer(state: UIState, action: UIAction): UIState {
	switch (action.type) {
		case "SET_TAB":
			return { ...state, activeTab: action.tab };
		case "SELECT_CONVO":
			return { ...state, selectedId: action.id };
		case "TOGGLE_ARCHIVED":
			return { ...state, showArchived: action.archived, selectedId: null };
		default:
			return state;
	}
}

interface DataState {
	conversations: ConversationListRow[];
	quickReplies: Array<{ id: string; shortcut: string; text: string }>;
	contactsList: ConversationListRow[];
	loadingContacts: boolean;
}

type DataAction =
	| { type: "SET_CONVOS"; conversations: ConversationListRow[] }
	| { type: "SET_QUICK_REPLIES"; replies: Array<{ id: string; shortcut: string; text: string }> }
	| { type: "SET_CONTACTS"; contacts: ConversationListRow[] }
	| { type: "SET_LOADING_CONTACTS"; loading: boolean }
	| { type: "UPDATE_CONVO_MODE"; id: number; mode: "AI" | "HUMAN" }
	| { type: "UPDATE_CONVO_DATA"; updated: ConversationListRow };

function dataReducer(state: DataState, action: DataAction): DataState {
	switch (action.type) {
		case "SET_CONVOS":
			return { ...state, conversations: action.conversations };
		case "SET_QUICK_REPLIES":
			return { ...state, quickReplies: action.replies };
		case "SET_CONTACTS":
			return { ...state, contactsList: action.contacts };
		case "SET_LOADING_CONTACTS":
			return { ...state, loadingContacts: action.loading };
		case "UPDATE_CONVO_MODE":
			return {
				...state,
				conversations: state.conversations.map((c) =>
					c.id === action.id ? { ...c, mode: action.mode } : c
				),
			};
		case "UPDATE_CONVO_DATA":
			return {
				...state,
				conversations: state.conversations.map((c) =>
					c.id === action.updated.id ? { ...c, ...action.updated } : c
				),
			};
		default:
			return state;
	}
}

export default function HomeClient() {
	const [uiState, uiDispatch] = useReducer(
		uiReducer,
		DEFAULT_UI_STATE,
		readStoredUiState,
	);

	const [dataState, dataDispatch] = useReducer(dataReducer, {
		conversations: [],
		quickReplies: [],
		contactsList: [],
		loadingContacts: false,
	});

	const { activeTab, selectedId, showArchived } = uiState;
	const { conversations, quickReplies, contactsList, loadingContacts } = dataState;

	const prevConversationsRef = useRef<ConversationListRow[]>([]);

	// Intercepta peticiones fetch para manejar sesiones expiradas/inválidas en la DB (error 401)
	useEffect(() => {
		const originalFetch = window.fetch;
		window.fetch = async (...args) => {
			const res = await originalFetch(...args);
			if (res.status === 401) {
				const url = typeof args[0] === "string" ? args[0] : (args[0] as Request).url;
				// Evitar recursión infinita con rutas de autenticación
				if (!url.includes("/api/auth/logout") && !url.includes("/api/auth/login")) {
					try {
						await originalFetch("/api/auth/logout", { method: "POST" });
					} catch (e) {
						console.error("[auth] Error al cerrar sesión en el servidor:", e);
					}
					// Borrar cookie local para asegurar que el middleware de Next.js bloquee reentradas
					document.cookie = "bot_session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
					window.location.href = "/login";
				}
			}
			return res;
		};

		return () => {
			window.fetch = originalFetch;
		};
	}, []);

	useEffect(() => {
		window.localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(uiState));
	}, [uiState]);

	// Cargar respuestas rápidas
	const loadQuickReplies = async () => {
		try {
			const res = await fetch("/api/settings");
			if (res.ok) {
				const settings = await res.json();
				dataDispatch({ type: "SET_QUICK_REPLIES", replies: settings.quick_replies || [] });
			}
		} catch (error) {
			console.error("[home] Error cargando respuestas rápidas:", error);
		}
	};

	useEffect(() => {
		loadQuickReplies();
	}, []);

	// Pedir permiso de notificaciones en el navegador
	useEffect(() => {
		if (typeof window !== "undefined" && "Notification" in window) {
			if (Notification.permission === "default") {
				Notification.requestPermission().catch(() => {});
			}
		}
	}, []);

	// Función para cargar conversaciones desde el endpoint
	const loadConversations = async (archived = showArchived) => {
		try {
			const res = await fetch(`/api/conversations?archived=${archived}&hasMessages=true`);
			if (res.ok) {
				const data = await res.json();
				dataDispatch({ type: "SET_CONVOS", conversations: data });
			}
		} catch (error) {
			console.error("[home] Error cargando conversaciones:", error);
		}
	};

	const loadAllContacts = async () => {
		dataDispatch({ type: "SET_LOADING_CONTACTS", loading: true });
		try {
			const res = await fetch(`/api/conversations?archived=false`);
			if (res.ok) {
				const data = await res.json();
				dataDispatch({ type: "SET_CONTACTS", contacts: data });
			}
		} catch (error) {
			console.error("[home] Error cargando contactos crm:", error);
		} finally {
			dataDispatch({ type: "SET_LOADING_CONTACTS", loading: false });
		}
	};

	useEffect(() => {
		if (activeTab === "contacts") {
			loadAllContacts();
		}
	}, [activeTab]);

	// Polling continuo cada 2s para mantener la lista actualizada
	useEffect(() => {
		loadConversations(showArchived);
		const interval = setInterval(() => loadConversations(showArchived), 2000);
		return () => clearInterval(interval);
	}, [showArchived]);

	// Comparar para enviar notificaciones de navegador si llega un mensaje nuevo en segundo plano
	useEffect(() => {
		const prev = prevConversationsRef.current;
		if (prev.length > 0) {
			for (const currentConvo of conversations) {
				const oldConvo = prev.find((c) => c.id === currentConvo.id);
				const hasNewMessages = oldConvo
					? currentConvo.unread_count > oldConvo.unread_count
					: currentConvo.unread_count > 0;

				if (hasNewMessages && currentConvo.id !== selectedId) {
					if (
						typeof window !== "undefined" &&
						"Notification" in window &&
						Notification.permission === "granted"
					) {
						new Notification(currentConvo.name?.trim() || `+${currentConvo.phone}`, {
							body: currentConvo.last_message_content || "Nuevo mensaje de WhatsApp",
						});
					}
				}
			}
		}
		prevConversationsRef.current = conversations;
	}, [conversations, selectedId]);

	// Ordenamiento de conversaciones:
	// - La conversación seleccionada (abierta) se mantiene al tope (index 0).
	// - Las demás se ordenan por last_message_at descendente (más recientes primero) por debajo.
	// - Si no hay ninguna seleccionada, todas se ordenan por last_message_at descendente.
	const sortedConversations = useMemo(() => {
		const list = [...conversations];
		if (selectedId === null) {
			return list.sort((a, b) => {
				const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
				const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
				return timeB - timeA || b.id - a.id;
			});
		}

		const active = list.find((c) => c.id === selectedId);
		const others = list.filter((c) => c.id !== selectedId).sort((a, b) => {
			const timeA = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
			const timeB = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
			return timeB - timeA || b.id - a.id;
		});

		return active ? [active, ...others] : others;
	}, [conversations, selectedId]);

	// Sincronizar el objeto seleccionado de la lista actualizada
	const selectedConversation =
		conversations.find((c) => c.id === selectedId) || null;

	const handleModeChangeLocal = (newMode: "AI" | "HUMAN") => {
		if (selectedId) {
			dataDispatch({ type: "UPDATE_CONVO_MODE", id: selectedId, mode: newMode });
		}
	};

	const handleDeleteLocal = () => {
		uiDispatch({ type: "SELECT_CONVO", id: null });
		loadConversations();
	};

	const handleConversationUpdated = (updated: ConversationListRow) => {
		dataDispatch({ type: "UPDATE_CONVO_DATA", updated });
	};

	const handleBulkDelete = async () => {
		const res = await fetch(`/api/conversations/bulk?archived=${showArchived}`, { method: "DELETE" });
		if (res.ok) {
			uiDispatch({ type: "SELECT_CONVO", id: null });
			await loadConversations(showArchived);
		}
	};

	const handleBulkModeAll = async (mode: "AI" | "HUMAN") => {
		await fetch("/api/mode/bulk", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode, archived: showArchived }),
		});
		await loadConversations(showArchived);
	};

	return (
		<ConnectionGate>
			{(phone, onDisconnect, botProfile, connection) => (
				<div className="h-screen w-full flex bg-background text-on-surface antialiased font-sans overflow-hidden">
					<Sidebar
						activeTab={activeTab}
						setActiveTab={(tab) => uiDispatch({ type: "SET_TAB", tab })}
						phone={phone}
						botProfile={botProfile}
						onDisconnect={onDisconnect}
					/>

					{/* Contenedor Principal de Contenido (pl-[3.05rem] para respetar el sidebar colapsado) */}
					<div className="pl-[3.05rem] flex-1 h-screen w-full flex flex-col relative overflow-hidden bg-background">
						{/* Encabezado Superior */}
						<DashboardHeader
							phone={connection.status === "connected" ? phone : null}
							onDisconnect={onDisconnect}
							botProfile={connection.status === "connected" ? botProfile : null}
							quickReplies={quickReplies}
							onQuickRepliesUpdated={loadQuickReplies}
						/>

						{/* Contenido Dinámico de Pestañas */}
						<main className="flex-1 p-6 overflow-hidden flex flex-col min-h-0 relative z-10">
							{connection.status !== "connected" ? (
								<div className="flex min-h-0 flex-1 items-center justify-center">
									<QRScreen status={connection.status} qrPng={connection.qrPng} updatedAt={connection.updatedAt} />
								</div>
							) : (
								<>
									{activeTab === "dashboard" && <DashboardOverview conversations={conversations} />}

							{activeTab === "chats" && (
								<div className="flex-1 glass-panel rounded-2xl overflow-hidden flex min-h-[500px] shadow-2xl">
									{/* Columna Izquierda: Lista de Chats */}
									<div className="w-80 flex-shrink-0 border-r border-outline-variant/10">
										<ConversationList
											conversations={sortedConversations}
											selectedId={selectedId}
											onSelectConversation={(id) => uiDispatch({ type: "SELECT_CONVO", id })}
											showArchived={showArchived}
											onToggleArchived={(archived) => uiDispatch({ type: "TOGGLE_ARCHIVED", archived })}
											onBulkDelete={handleBulkDelete}
											onBulkModeAll={handleBulkModeAll}
										/>
									</div>

									{/* Columna Derecha: Panel de Conversación Activa */}
									<div className="flex-1 min-w-0 bg-surface-container-lowest/10">
										{selectedConversation ? (
											<ConversationPanel
												conversation={selectedConversation}
												onModeChanged={handleModeChangeLocal}
												onDeleted={handleDeleteLocal}
												onConversationUpdated={handleConversationUpdated}
												quickReplies={quickReplies}
											/>
										) : (
											<div className="h-full flex flex-col items-center justify-center text-on-surface-variant p-8 text-center bg-surface-container-lowest/5">
												<MessagesIcon
													className="text-on-surface-variant/30 animate-pulse mb-4"
													size={48}
												/>
												<h3 className="font-display text-sm font-bold text-on-surface mb-1">
													Tu bandeja de entrada
												</h3>
												<p className="text-xs max-w-xs text-on-surface-variant/80">
													Seleccioná una conversación del panel izquierdo para
													empezar a gestionar la automatización o responder
													manualmente.
												</p>
											</div>
										)}
									</div>
								</div>
							)}

							{activeTab === "prompts" && <PromptsManager />}

							{activeTab === "automations" && <AutomationsOverview />}

							{activeTab === "contacts" && (
								<ContactsOverview conversations={contactsList} />
							)}

							{activeTab === "deals" && (
								<TasksBoard
									conversations={conversations}
									onConversationUpdated={handleConversationUpdated}
								/>
							)}

									{activeTab === "analytics" && <AnalyticsPanel />}

									{activeTab === "fallas" && <FailureReportsPanel />}

									{activeTab === "broadcasts" && <BroadcastPanel />}

								{activeTab === "settings" && <SettingsPanel />}
								</>
							)}
						</main>
					</div>
				</div>
			)}
		</ConnectionGate>
	);
}
