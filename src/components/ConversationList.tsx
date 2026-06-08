"use client";

import { useMemo, useState } from "react";
import type { ConversationListRow } from "../lib/db.ts";
import { RobotIcon, UserIcon } from "./Icons.tsx";

interface ConversationListProps {
	conversations: ConversationListRow[];
	selectedId: number | null;
	onSelectConversation: (id: number) => void;
	showArchived: boolean;
	onToggleArchived: (val: boolean) => void;
	onBulkDelete?: () => Promise<void>;
	onBulkModeAll?: (mode: "AI" | "HUMAN") => Promise<void>;
}

type FilterType = "ALL" | "PENDING" | "UNREAD" | "READ";

function getRelativeTime(dateInput: string | Date | null | undefined): string {
	if (!dateInput) return "";
	const date = new Date(dateInput);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHrs = Math.floor(diffMin / 60);
	const diffDays = Math.floor(diffHrs / 24);

	if (diffSec < 60) return "ahora";
	if (diffMin < 60) return `hace ${diffMin} min`;
	if (diffHrs < 24) return `hace ${diffHrs} h`;
	if (diffDays === 1) return "ayer";
	return date.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

function formatConversationPreview(convo: ConversationListRow): string {
	const content = convo.last_message_content?.trim();
	if (!content) return "Sin mensajes todavía";

	const mediaLabel =
		content === "Nota de voz" || content === "[Audio: Nota de voz]"
			? "Nota de voz"
			: content === "[Imagen]"
				? "Imagen recibida"
				: content;

	if (convo.last_message_role === "user") return mediaLabel;
	if (convo.last_message_role === "assistant") return `IA: ${mediaLabel}`;
	if (convo.last_message_role === "human") return `Tú: ${mediaLabel}`;
	return mediaLabel;
}

export default function ConversationList({
	conversations,
	selectedId,
	onSelectConversation,
	showArchived,
	onToggleArchived,
	onBulkDelete,
	onBulkModeAll,
}: ConversationListProps) {
	const [activeFilter, setActiveFilter] = useState<FilterType>("ALL");
	const [searchQuery, setSearchQuery] = useState("");
	const [bulkLoading, setBulkLoading] = useState<string | null>(null);

	const handleBulkDelete = async () => {
		if (bulkLoading) return;
		if (!confirm(`¿Eliminar TODOS los ${showArchived ? "chats archivados" : "chats activos"}? Esta acción no se puede deshacer.`)) return;
		setBulkLoading("delete");
		try {
			await onBulkDelete?.();
		} finally {
			setBulkLoading(null);
		}
	};

	const handleBulkMode = async (mode: "AI" | "HUMAN") => {
		if (bulkLoading) return;
		setBulkLoading(mode);
		try {
			await onBulkModeAll?.(mode);
		} finally {
			setBulkLoading(null);
		}
	};

	const filteredConversations = useMemo(() => {
		const normalizedSearch = searchQuery.trim().toLowerCase();
		return conversations.filter((convo) => {
			if (normalizedSearch) {
				const nameMatch = convo.name?.toLowerCase().includes(normalizedSearch);
				const phoneMatch = convo.phone.toLowerCase().includes(normalizedSearch);
				if (!nameMatch && !phoneMatch) return false;
			}

			if (activeFilter === "PENDING") return convo.last_message_role === "user";
			if (activeFilter === "UNREAD") return convo.unread_count > 0;
			if (activeFilter === "READ") return convo.unread_count === 0;
			return true;
		});
	}, [conversations, activeFilter, searchQuery]);

	return (
		<div className="flex h-full flex-col bg-surface">
			<div className="flex shrink-0 items-center justify-between p-4">
				<h2 className="font-display text-sm font-bold uppercase tracking-wider text-on-surface">
					{showArchived ? "Chats archivados" : "Chats activos"}
				</h2>
				<div className="flex items-center gap-1.5">
					<button
						type="button"
						onClick={() => onToggleArchived(!showArchived)}
						className="rounded border border-primary/35 bg-primary/10 px-2 py-1 text-[10px] font-extrabold uppercase tracking-wider text-primary transition-all hover:bg-primary/20"
					>
						{showArchived ? "Ver activos" : "Ver archivados"}
					</button>
					<span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
						{filteredConversations.length}
					</span>
				</div>
			</div>

			<div className="shrink-0 px-4 pb-3">
				<div className="relative">
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Buscar por nombre o teléfono..."
						aria-label="Buscar chats"
						className="w-full rounded-xl border border-outline-variant/40 bg-surface-container-lowest py-1.5 pl-8 pr-8 text-[11px] text-on-surface transition-all placeholder:text-on-surface-variant/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50"
					/>
					<span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[10px] text-on-surface-variant/60">
						⌕
					</span>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-on-surface-variant/70 hover:text-on-surface"
						>
							×
						</button>
					)}
				</div>
			</div>

			{(onBulkDelete || onBulkModeAll) && conversations.length > 0 && (
				<div className="flex shrink-0 flex-wrap gap-1.5 px-4 pb-3">
					{onBulkModeAll && (
						<>
							<button
								type="button"
								onClick={() => handleBulkMode("AI")}
								disabled={bulkLoading !== null}
								className="flex items-center gap-1 rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wider text-primary transition-all hover:bg-primary/20 disabled:opacity-50"
								title="Activar modo IA en todos los chats visibles"
							>
								<RobotIcon size={8} />
								{bulkLoading === "AI" ? "..." : "Activar IA"}
							</button>
							<button
								type="button"
								onClick={() => handleBulkMode("HUMAN")}
								disabled={bulkLoading !== null}
								className="flex items-center gap-1 rounded-lg border border-outline-variant/50 bg-surface-container-high px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wider text-on-surface-variant transition-all hover:border-outline-variant hover:text-on-surface disabled:opacity-50"
								title="Desactivar modo IA en todos los chats visibles"
							>
								<UserIcon size={8} />
								{bulkLoading === "HUMAN" ? "..." : "Desactivar IA"}
							</button>
						</>
					)}
					{onBulkDelete && (
						<button
							type="button"
							onClick={handleBulkDelete}
							disabled={bulkLoading !== null}
							className="ml-auto flex items-center gap-1 rounded-lg border border-error/40 bg-error/10 px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wider text-error transition-all hover:bg-error/20 disabled:opacity-50"
							title="Eliminar todos los chats visibles"
						>
							{bulkLoading === "delete" ? "..." : "Eliminar todos"}
						</button>
					)}
				</div>
			)}

			<div className="flex shrink-0 flex-wrap gap-1.5 border-b border-outline-variant/20 px-4 pb-3">
				{[
					{ id: "ALL", label: "Todos" },
					{ id: "PENDING", label: "Pendientes" },
					{ id: "UNREAD", label: "Por leer" },
					{ id: "READ", label: "Leídos" },
				].map((tab) => (
					<button
						key={tab.id}
						type="button"
						onClick={() => setActiveFilter(tab.id as FilterType)}
						className={`rounded-lg border px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wider transition-all duration-200 ${
							activeFilter === tab.id
								? "border-primary/50 bg-primary/15 text-primary"
								: "border-outline-variant/25 bg-surface-container-lowest/70 text-on-surface-variant hover:border-outline-variant/60 hover:text-on-surface"
						}`}
					>
						{tab.label}
					</button>
				))}
			</div>

			<div className="flex-1 space-y-1 overflow-y-auto p-2">
				{filteredConversations.length === 0 ? (
					<div className="flex flex-col items-center justify-center p-8 text-center text-xs text-on-surface-variant">
						<span className="mb-3 text-3xl">💬</span>
						<p>No hay conversaciones bajo este filtro.</p>
					</div>
				) : (
					filteredConversations.map((convo) => {
						const isSelected = convo.id === selectedId;
						const displayName = convo.name?.trim() || `+${convo.phone}`;
						const relativeTime = getRelativeTime(convo.last_message_at);
						const preview = formatConversationPreview(convo);

						return (
							<button
								key={convo.id}
								type="button"
								onClick={() => onSelectConversation(convo.id)}
								className={`flex w-full flex-col gap-2 rounded-xl border p-4 text-left transition-all duration-200 ${
									isSelected
										? "border-primary/80 bg-primary/12 shadow-[0_0_0_1px_rgba(0,168,132,0.2)]"
										: "border-transparent hover:bg-surface-bright/35"
								}`}
							>
								<div className="flex w-full items-center justify-between">
									<div className="flex max-w-[170px] items-center gap-2 truncate">
										<span className={`truncate text-xs font-semibold ${isSelected ? "text-primary" : "text-on-surface"}`}>
											{displayName}
										</span>
										{convo.unread_count > 0 && (
											<span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-extrabold text-on-primary">
												{convo.unread_count}
											</span>
										)}
									</div>
									<span className="text-[9px] font-medium text-on-surface-variant/70">
										{relativeTime}
									</span>
								</div>

								<div className="flex w-full items-center justify-between gap-3">
									<p className={`truncate text-[11px] leading-5 ${isSelected ? "max-w-[160px] text-on-surface" : "max-w-[155px] text-on-surface-variant"}`}>
										{preview}
									</p>

									<span
										className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[8px] font-extrabold uppercase tracking-widest ${
											convo.mode === "AI"
												? "border-primary/30 bg-primary/15 text-primary"
												: "border-outline-variant/50 bg-surface-container-high text-on-surface-variant"
										}`}
										title={convo.mode === "AI" ? "Modo IA activo" : "Modo humano activo"}
									>
										{convo.mode === "AI" ? (
											<>
												<RobotIcon size={8} /> Modo IA
											</>
										) : (
											<>
												<UserIcon size={8} /> Humano
											</>
										)}
									</span>
								</div>
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}
