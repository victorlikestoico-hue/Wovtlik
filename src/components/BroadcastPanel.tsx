"use client";

import { useState, useEffect, useCallback } from "react";
import { Trash2, Plus, Send, FileText, Megaphone, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Agent {
	id: number;
	name: string;
	phone: string;
	created_at: string;
}

function AgentTable({
	agents,
	onDelete,
	loading,
}: {
	agents: Agent[];
	onDelete: (id: number) => void;
	loading: boolean;
}) {
	if (loading) {
		return (
			<div className="flex items-center justify-center py-8 text-muted-foreground">
				<Loader2 className="size-4 animate-spin mr-2" />
				<span className="text-sm">Cargando...</span>
			</div>
		);
	}
	if (agents.length === 0) {
		return <p className="py-4 text-center text-sm text-muted-foreground">Sin agentes configurados.</p>;
	}
	return (
		<div className="divide-y divide-border rounded-xl border border-outline-variant/30 overflow-hidden">
			{agents.map((agent) => (
				<div key={agent.id} className="flex items-center justify-between gap-3 px-3 py-2 bg-surface hover:bg-muted/40 transition-colors">
					<div className="min-w-0">
						<span className="text-sm font-medium text-on-surface">{agent.name}</span>
						<span className="ml-2 text-xs text-muted-foreground">+{agent.phone}</span>
					</div>
					<button
						type="button"
						onClick={() => onDelete(agent.id)}
						className="shrink-0 rounded-md p-1.5 text-error hover:bg-error/10 transition-colors"
						title="Eliminar"
					>
						<Trash2 className="size-3.5" />
					</button>
				</div>
			))}
		</div>
	);
}

function AddAgentForm({ onAdd }: { onAdd: (name: string, phone: string) => Promise<void> }) {
	const [name, setName] = useState("");
	const [phone, setPhone] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !phone.trim()) return;
		setBusy(true);
		setError(null);
		try {
			await onAdd(name.trim(), phone.trim());
			setName("");
			setPhone("");
		} catch (err: any) {
			setError(err.message || "Error al agregar agente");
		} finally {
			setBusy(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2 pt-2">
			<div className="flex flex-col gap-1 min-w-[120px] flex-1">
				<label className="text-xs text-muted-foreground">Nombre</label>
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Ej: María"
					className="rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-1.5 text-xs text-on-surface outline-none focus:border-primary/50"
					disabled={busy}
				/>
			</div>
			<div className="flex flex-col gap-1 min-w-[140px] flex-1">
				<label className="text-xs text-muted-foreground">Teléfono (con código país)</label>
				<input
					value={phone}
					onChange={(e) => setPhone(e.target.value)}
					placeholder="Ej: 573001234567"
					className="rounded-lg border border-outline-variant/30 bg-surface-container-low px-3 py-1.5 text-xs text-on-surface outline-none focus:border-primary/50"
					disabled={busy}
				/>
			</div>
			<Button type="submit" size="sm" disabled={busy || !name.trim() || !phone.trim()} className="gap-1.5">
				{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
				Agregar
			</Button>
			{error && <p className="w-full text-xs text-error">{error}</p>}
		</form>
	);
}

function SendButton({
	label,
	onConfirm,
	confirmMessage,
}: {
	label: string;
	onConfirm: () => Promise<{ count: number }>;
	confirmMessage: string;
}) {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ count: number } | null>(null);
	const [error, setError] = useState<string | null>(null);

	const handleClick = async () => {
		if (!confirm(confirmMessage)) return;
		setBusy(true);
		setResult(null);
		setError(null);
		try {
			const r = await onConfirm();
			setResult(r);
		} catch (err: any) {
			setError(err.message || "Error al enviar");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex items-center gap-3 flex-wrap">
			<Button onClick={handleClick} disabled={busy} size="sm" className="gap-1.5">
				{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
				{label}
			</Button>
			{result && (
				<span className="text-xs text-emerald-600 font-medium">
					✓ {result.count} mensaje{result.count !== 1 ? "s" : ""} encolado{result.count !== 1 ? "s" : ""}
				</span>
			)}
			{error && <span className="text-xs text-error">{error}</span>}
		</div>
	);
}

// ── Form broadcast section ──────────────────────────────────────────────────

function FormBroadcastSection() {
	const [agents, setAgents] = useState<Agent[]>([]);
	const [loading, setLoading] = useState(true);
	const [sectionError, setSectionError] = useState<string | null>(null);

	const loadAgents = useCallback(async () => {
		setLoading(true);
		setSectionError(null);
		try {
			const res = await fetch("/api/broadcast/form/agents");
			if (!res.ok) throw new Error("No se pudieron cargar los agentes");
			setAgents(await res.json());
		} catch (err: any) {
			setSectionError(err.message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => { void loadAgents(); }, [loadAgents]);

	const handleDelete = async (id: number) => {
		if (!confirm("¿Eliminar este agente de la lista del formulario?")) return;
		const res = await fetch(`/api/broadcast/form/agents/${id}`, { method: "DELETE" });
		if (res.ok) setAgents((prev) => prev.filter((a) => a.id !== id));
	};

	const handleAdd = async (name: string, phone: string) => {
		const res = await fetch("/api/broadcast/form/agents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, phone }),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body.error || "Error al agregar");
		}
		const agent = await res.json();
		setAgents((prev) => [...prev, agent]);
	};

	const handleSend = async () => {
		const res = await fetch("/api/broadcast/form", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || "Error al enviar");
		return { count: (body.queued as string[]).length };
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-start justify-between gap-4 flex-wrap">
				<div>
					<p className="text-sm text-muted-foreground max-w-prose">
						Se envía automáticamente el <strong>día 2</strong> y el <strong>día 7</strong> de cada mes a las 9 AM (hora Colombia). Usa el botón para dispararlo en cualquier momento.
					</p>
				</div>
				<SendButton
					label="Enviar ahora"
					onConfirm={handleSend}
					confirmMessage={`¿Enviar el formulario a los ${agents.length} agentes configurados?`}
				/>
			</div>

			{sectionError && <p className="text-sm text-error">{sectionError}</p>}

			<div className="flex flex-col gap-2">
				<h4 className="text-sm font-semibold text-on-surface">
					Agentes ({agents.length})
				</h4>
				<AgentTable agents={agents} onDelete={handleDelete} loading={loading} />
				<AddAgentForm onAdd={handleAdd} />
			</div>
		</div>
	);
}

// ── Mass broadcast section ──────────────────────────────────────────────────

function MassBroadcastSection() {
	const [agents, setAgents] = useState<Agent[]>([]);
	const [loading, setLoading] = useState(true);
	const [sectionError, setSectionError] = useState<string | null>(null);
	const [message, setMessage] = useState("");

	const loadAgents = useCallback(async () => {
		setLoading(true);
		setSectionError(null);
		try {
			const res = await fetch("/api/broadcast/mass/agents");
			if (!res.ok) throw new Error("No se pudieron cargar los agentes");
			setAgents(await res.json());
		} catch (err: any) {
			setSectionError(err.message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => { void loadAgents(); }, [loadAgents]);

	const handleDelete = async (id: number) => {
		if (!confirm("¿Eliminar este agente de la lista de envíos masivos?")) return;
		const res = await fetch(`/api/broadcast/mass/agents/${id}`, { method: "DELETE" });
		if (res.ok) setAgents((prev) => prev.filter((a) => a.id !== id));
	};

	const handleAdd = async (name: string, phone: string) => {
		const res = await fetch("/api/broadcast/mass/agents", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, phone }),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new Error(body.error || "Error al agregar");
		}
		const agent = await res.json();
		setAgents((prev) => [...prev, agent]);
	};

	const handleSend = async () => {
		const res = await fetch("/api/broadcast/mass", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message }),
		});
		const body = await res.json();
		if (!res.ok) throw new Error(body.error || "Error al enviar");
		setMessage("");
		return { count: (body.queued as string[]).length };
	};

	const estimatedMinutes = agents.length > 0 ? Math.ceil(agents.length * 60 / 60) : 0;

	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-muted-foreground max-w-prose">
				Envía un mensaje libre a todos los agentes de esta lista. Las conversaciones nuevas esperan <strong>1 minuto</strong> entre sí para evitar bloqueos de WhatsApp.
			</p>

			{sectionError && <p className="text-sm text-error">{sectionError}</p>}

			<div className="flex flex-col gap-2">
				<label className="text-sm font-semibold text-on-surface">Mensaje</label>
				<textarea
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					placeholder="Escribe aquí el mensaje para todos los agentes..."
					rows={4}
					className="rounded-xl border border-outline-variant/30 bg-surface-container-low px-3 py-2 text-sm text-on-surface outline-none focus:border-primary/50 resize-y"
				/>
				{agents.length > 0 && message.trim() && (
					<p className="text-xs text-muted-foreground">
						Se enviará a {agents.length} agente{agents.length !== 1 ? "s" : ""}. Tiempo estimado: ~{estimatedMinutes} min.
					</p>
				)}
				<SendButton
					label="Enviar a todos"
					onConfirm={handleSend}
					confirmMessage={`¿Enviar este mensaje a los ${agents.length} agentes configurados?`}
				/>
			</div>

			<div className="flex flex-col gap-2">
				<h4 className="text-sm font-semibold text-on-surface">
					Agentes ({agents.length})
				</h4>
				<AgentTable agents={agents} onDelete={handleDelete} loading={loading} />
				<AddAgentForm onAdd={handleAdd} />
			</div>
		</div>
	);
}

// ── Main panel ──────────────────────────────────────────────────────────────

export default function BroadcastPanel() {
	const [activeSection, setActiveSection] = useState<"form" | "mass">("form");

	return (
		<div className="flex h-full flex-col gap-0 overflow-hidden">
			<div className="border-b border-outline-variant/30 bg-surface/80 px-6 py-4">
				<h2 className="text-lg font-bold text-on-surface">Envíos masivos</h2>
				<p className="text-xs text-muted-foreground">Gestiona recordatorios y notificaciones para tus agentes</p>
			</div>

			<div className="flex flex-col gap-0 overflow-auto flex-1">
				{/* Tab switcher */}
				<div className="flex border-b border-outline-variant/30 px-6">
					<button
						type="button"
						onClick={() => setActiveSection("form")}
						className={`flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
							activeSection === "form"
								? "border-primary text-primary"
								: "border-transparent text-muted-foreground hover:text-on-surface"
						}`}
					>
						<FileText className="size-4" />
						Formulario mensual
					</button>
					<button
						type="button"
						onClick={() => setActiveSection("mass")}
						className={`flex items-center gap-1.5 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
							activeSection === "mass"
								? "border-primary text-primary"
								: "border-transparent text-muted-foreground hover:text-on-surface"
						}`}
					>
						<Megaphone className="size-4" />
						Envío masivo
					</button>
				</div>

				<div className="flex-1 overflow-auto p-6">
					{activeSection === "form" ? <FormBroadcastSection /> : <MassBroadcastSection />}
				</div>
			</div>
		</div>
	);
}
