"use client";

import { useState, useEffect, useMemo } from "react";
import { KeyIcon, MailIcon, BellIcon } from "./Icons.tsx";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";


interface CustomSelectProps<T> {
	value: T;
	onChange: (value: T) => void;
	options: Array<{ value: T; label: string }>;
	placeholder?: string;
	disabled?: boolean;
	id?: string;
}

function CustomSelect<T extends string | number>({
	value,
	onChange,
	options,
	placeholder = "Seleccionar...",
	disabled,
	id,
}: CustomSelectProps<T>) {
	const selected = options.find((opt) => opt.value === value);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={disabled}>
				<Button
					id={id}
					type="button"
					variant="outline"
					disabled={disabled}
					className={cn(
						"w-full justify-between text-left font-normal h-9 px-4 text-xs bg-surface-container-low border border-outline-variant/30 text-on-surface rounded-xl hover:bg-surface-bright/20 focus:ring-1 focus:ring-primary/20",
						selected && "font-medium",
					)}
				>
					<span className="truncate">{selected ? selected.label : placeholder}</span>
					<ChevronDown className="size-3.5 opacity-50 shrink-0 ml-1" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				className="max-h-60 overflow-y-auto min-w-[200px] bg-popover border border-border text-popover-foreground shadow-md"
				align="start"
			>
				{options.map((opt) => (
					<DropdownMenuItem
						key={String(opt.value)}
						onClick={() => onChange(opt.value)}
						className={cn(
							"text-xs cursor-pointer focus:bg-accent focus:text-accent-foreground",
							opt.value === value && "bg-accent/40 text-foreground font-semibold",
						)}
					>
						{opt.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function CapabilityProviderFields({
	title,
	description,
	prefix,
	providers,
	settings,
	models,
	connecting,
	onChange,
	onConnect,
}: {
	title: string;
	description: string;
	prefix: "chat_ai" | "audio_ai" | "image_ai";
	providers: Array<{ value: string; label: string }>;
	settings: Record<string, any>;
	models: string[];
	connecting: boolean;
	onChange: (key: string, value: any) => void;
	onConnect: (prefix: "chat_ai" | "audio_ai" | "image_ai") => void;
}) {
	const providerKey = `${prefix}_provider`;
	const apiKeyKey = `${prefix}_api_key`;
	const modelKey = `${prefix}_model`;
	const availableModels = models.length > 0 ? models : settings[modelKey] ? [settings[modelKey]] : [];

	const modelOptions = useMemo(() => {
		if (availableModels.length === 0) {
			return [{ value: "", label: "Conecta el proveedor para cargar modelos" }];
		}
		return availableModels.map((m) => ({ value: m, label: m }));
	}, [availableModels]);

	return (
		<div className="rounded-2xl border border-outline-variant/20 bg-surface-container-low/60 p-4 space-y-3">
			<div>
				<h4 className="text-[10px] font-bold uppercase tracking-wider text-on-surface">{title}</h4>
				<p className="text-[9px] text-on-surface-variant/80">{description}</p>
			</div>
			<div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
				<div className="flex flex-col gap-1.5">
					<label htmlFor={providerKey} className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">Proveedor</label>
					<CustomSelect
						id={providerKey}
						value={settings[providerKey] || providers[0]?.value || ""}
						onChange={(val) => {
							onChange(providerKey, val);
							onChange(modelKey, "");
						}}
						options={providers}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<label htmlFor={apiKeyKey} className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">API Key</label>
					<input
						id={apiKeyKey}
						type="password"
						value={settings[apiKeyKey] || ""}
						onChange={(e) => onChange(apiKeyKey, e.target.value)}
						placeholder="Usa .env si lo dejas vacio"
						autoComplete="off"
						className="px-4 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
					/>
				</div>
				<button
					type="button"
					disabled={connecting}
					onClick={() => onConnect(prefix)}
					className="px-5 py-2 bg-primary/90 text-on-primary rounded-xl font-display text-[10px] font-bold uppercase tracking-wider transition-all duration-200 active:scale-95 disabled:opacity-50"
				>
					{connecting ? "Conectando..." : "Conectar"}
				</button>
			</div>
			<div className="flex flex-col gap-1.5">
				<label htmlFor={modelKey} className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">Modelo</label>
				<CustomSelect
					id={modelKey}
					value={settings[modelKey] || ""}
					onChange={(val) => onChange(modelKey, val)}
					disabled={availableModels.length === 0}
					options={modelOptions}
				/>
			</div>
		</div>
	);
}

interface AgentProfileRow {
	phone: string;
	email: string;
}

function AgentProfilesSection() {
	const [profiles, setProfiles] = useState<AgentProfileRow[]>([]);
	const [loadingProfiles, setLoadingProfiles] = useState(false);
	const [unlinking, setUnlinking] = useState<string | null>(null);

	const loadProfiles = async () => {
		setLoadingProfiles(true);
		try {
			const res = await fetch("/api/agent-profiles");
			if (res.ok) setProfiles(await res.json());
		} catch {
			// silent
		} finally {
			setLoadingProfiles(false);
		}
	};

	useEffect(() => {
		loadProfiles();
	}, []);

	const handleUnlink = async (phone: string) => {
		if (!confirm(`¿Desvincular el número ${phone}? El agente podrá registrar un nuevo correo desde ese número.`)) return;
		setUnlinking(phone);
		try {
			const res = await fetch(`/api/agent-profiles?phone=${encodeURIComponent(phone)}`, { method: "DELETE" });
			if (res.ok) setProfiles((prev) => prev.filter((p) => p.phone !== phone));
			else alert("Error al desvincular. Intentá de nuevo.");
		} finally {
			setUnlinking(null);
		}
	};

	return (
		<div className="bg-surface/80 border border-outline-variant/20 p-5 rounded-2xl space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-xs font-bold text-on-surface uppercase tracking-wider flex items-center gap-2">
					<span>🔐</span> Agentes Registrados (Número → Correo)
				</h3>
				<button
					type="button"
					onClick={loadProfiles}
					disabled={loadingProfiles}
					className="text-[9px] font-bold uppercase tracking-wider text-primary hover:underline disabled:opacity-50"
				>
					{loadingProfiles ? "Cargando..." : "Actualizar"}
				</button>
			</div>
			<p className="text-[9px] text-on-surface-variant/80">
				Cada número de WhatsApp solo puede estar vinculado a un correo corporativo. Si un agente cambia de número, desvinculá el anterior para que pueda registrarse de nuevo.
			</p>
			{profiles.length === 0 ? (
				<p className="text-[10px] text-on-surface-variant/60 italic">Sin agentes registrados todavía.</p>
			) : (
				<div className="divide-y divide-outline-variant/15 rounded-xl border border-outline-variant/20 overflow-hidden">
					{profiles.map((p) => (
						<div key={p.phone} className="flex items-center justify-between px-4 py-2.5 bg-surface-container-low/50">
							<div className="flex flex-col gap-0.5 min-w-0">
								<span className="text-[10px] font-bold text-on-surface font-mono truncate">+{p.phone}</span>
								<span className="text-[9px] text-on-surface-variant truncate">{p.email}</span>
							</div>
							<button
								type="button"
								onClick={() => handleUnlink(p.phone)}
								disabled={unlinking === p.phone}
								className="ml-4 shrink-0 rounded-lg border border-error/40 bg-error/10 px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wider text-error transition-all hover:bg-error/20 disabled:opacity-50"
							>
								{unlinking === p.phone ? "..." : "Desvincular"}
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export default function SettingsPanel() {
	const [settings, setSettings] = useState<Record<string, any>>({});
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
	const [connecting, setConnecting] = useState<Record<string, boolean>>({});

	const loadSettings = async () => {
		setLoading(true);
		try {
			const res = await fetch("/api/settings");
			if (res.ok) {
				const data = await res.json();
				setSettings(data);
			}
		} catch (error) {
			console.error("[settings] Error cargando configuraciones:", error);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadSettings();
	}, []);

	const handleSave = async (e: { preventDefault: () => void }) => {
		e.preventDefault();
		setSaving(true);
		try {
			const res = await fetch("/api/settings", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(settings),
			});
			if (res.ok) {
				const data = await res.json();
				setSettings(data.settings);
				alert("Ajustes guardados correctamente.");
			} else {
				alert("Error al guardar los ajustes.");
			}
		} catch (error) {
			console.error("[settings] Error de red guardando ajustes:", error);
		} finally {
			setSaving(false);
		}
	};

	const handleChange = (key: string, value: any) => {
		setSettings((prev) => ({
			...prev,
			[key]: value,
		}));
	};

	const handleConnectProvider = async (prefix: "chat_ai" | "audio_ai" | "image_ai") => {
		const capability = prefix === "chat_ai" ? "chat" : prefix === "audio_ai" ? "audio" : "image";
		const provider = settings[`${prefix}_provider`];
		setConnecting((prev) => ({ ...prev, [prefix]: true }));
		try {
			const res = await fetch("/api/ai-models", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					provider,
					capability,
					apiKey: settings[`${prefix}_api_key`] || "",
				}),
			});
			const data = await res.json();
			if (!res.ok || !Array.isArray(data.models)) {
				alert(data.message || data.error || "No se pudo conectar con el proveedor.");
				return;
			}
			setModelOptions((prev) => ({ ...prev, [prefix]: data.models }));
			if (!settings[`${prefix}_model`] && data.models[0]) {
				handleChange(`${prefix}_model`, data.models[0]);
			}
		} catch (error) {
			console.error("[settings] Error conectando proveedor IA:", error);
			alert("Error conectando proveedor IA.");
		} finally {
			setConnecting((prev) => ({ ...prev, [prefix]: false }));
		}
	};

	if (loading && Object.keys(settings).length === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-xs text-on-surface-variant/70 font-semibold">
				Cargando ajuste…
			</div>
		);
	}

	return (
		<div className="glass-panel rounded-3xl p-6 max-w-3xl mx-auto w-full shadow-2xl flex flex-col max-h-full overflow-hidden">
			{/* Encabezado */}
			<div className="border-b border-outline-variant/10 pb-4 mb-6 shrink-0">
				<h2 className="font-display text-sm font-bold text-on-surface uppercase tracking-wider">
					Ajustes del Sistema
				</h2>
				<span className="text-[10px] text-on-surface-variant/80 font-medium">
					Configurá la palabra de activación y las políticas de seguimiento
				</span>
			</div>

			{/* Formulario */}
			<form
				onSubmit={handleSave}
				className="flex-1 overflow-y-auto pr-1 space-y-6"
			>
				{/* Grupo 1: Palabras Clave */}
				<div className="bg-surface/80 border border-outline-variant/20 p-5 rounded-2xl space-y-4">
					<h3 className="text-xs font-bold text-on-surface uppercase tracking-wider flex items-center gap-2">
						<KeyIcon className="text-primary" size={14} /> Palabras Clave
						(Control del Dueño)
					</h3>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div className="flex flex-col gap-1.5">
							<label htmlFor="bot_on_keyword" className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">
								Prender Bot (Keyword)
							</label>
							<input
								id="bot_on_keyword"
								type="text"
								value={settings.bot_on_keyword || ""}
								onChange={(e) => handleChange("bot_on_keyword", e.target.value)}
								placeholder="Ej: ok."
								className="px-4 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
								required
							/>
						</div>
					</div>

					<div className="flex items-center gap-3 mt-4 border-t border-outline-variant/10 pt-4">
						<input
							type="checkbox"
							id="keyword_case_sensitive"
							checked={!!settings.keyword_case_sensitive}
							onChange={(e) =>
								handleChange("keyword_case_sensitive", e.target.checked)
							}
							className="size-4 rounded bg-surface-container-low border border-outline-variant/30 text-primary focus:ring-0"
						/>
						<label
							htmlFor="keyword_case_sensitive"
							className="text-xs text-on-surface-variant font-semibold select-none cursor-pointer"
						>
							Sensible a mayúsculas/minúsculas para coincidencia exacta
						</label>
					</div>
				</div>


				{/* Grupo 2: Proveedores de IA */}
				<div className="bg-surface/80 border border-outline-variant/20 p-5 rounded-2xl space-y-4">
					<h3 className="text-xs font-bold text-on-surface uppercase tracking-wider flex items-center gap-2">
						<KeyIcon className="text-primary" size={14} /> Proveedores de IA
					</h3>
					<p className="text-[9px] text-on-surface-variant/80">
						Elegir el proveedor correcto para cada capacidad. DeepSeek queda fuera de audio e imagenes porque su documentacion actual muestra chat/completions, no transcripcion ni vision general.
					</p>
					<CapabilityProviderFields
						title="Responder mensajes"
						description="Modelo conversacional para chats y follow-ups."
						prefix="chat_ai"
						models={modelOptions.chat_ai || []}
						connecting={!!connecting.chat_ai}
						providers={[
							{ value: "openai", label: "ChatGPT / OpenAI" },
							{ value: "google", label: "Google Gemini" },
							{ value: "deepseek", label: "DeepSeek" },
						]}
						settings={settings}
						onChange={handleChange}
						onConnect={handleConnectProvider}
					/>
					<CapabilityProviderFields
						title="Transcribir audios"
						description="Convierte notas de voz en texto antes de responder."
						prefix="audio_ai"
						models={modelOptions.audio_ai || []}
						connecting={!!connecting.audio_ai}
						providers={[
							{ value: "openai", label: "ChatGPT / OpenAI" },
							{ value: "google", label: "Google Gemini" },
						]}
						settings={settings}
						onChange={handleChange}
						onConnect={handleConnectProvider}
					/>
					<CapabilityProviderFields
						title="Describir imagenes"
						description="Interpreta imagenes recibidas por WhatsApp para darle contexto al bot."
						prefix="image_ai"
						models={modelOptions.image_ai || []}
						connecting={!!connecting.image_ai}
						providers={[
							{ value: "openai", label: "ChatGPT / OpenAI" },
							{ value: "google", label: "Google Gemini" },
						]}
						settings={settings}
						onChange={handleChange}
						onConnect={handleConnectProvider}
					/>
				</div>

				{/* Grupo 3: Seguimientos Automáticos */}
				<div className="bg-surface/80 border border-outline-variant/20 p-5 rounded-2xl space-y-4">
					<h3 className="text-xs font-bold text-on-surface uppercase tracking-wider flex items-center gap-2">
						<MailIcon className="text-primary" size={14} /> Seguimientos
						Automáticos (Follow-Ups)
					</h3>
					<div className="grid grid-cols-1 md:grid-cols-4 gap-4">
						<div className="flex flex-col gap-1.5">
							<label htmlFor="followup_interval_hours" className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">
								Evaluacion (horas)
							</label>
							<input
								id="followup_interval_hours"
								type="number"
								min="0"
								value={settings.followup_interval_hours ?? 12}
								onChange={(e) =>
									handleChange(
										"followup_interval_hours",
										Number(e.target.value),
									)
								}
								className="px-4 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary"
								required
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="followup_interval_minutes" className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">
								Evaluacion (minutos)
							</label>
							<input
								id="followup_interval_minutes"
								type="number"
								min="0"
								max="59"
								value={settings.followup_interval_minutes ?? 0}
								onChange={(e) =>
									handleChange(
										"followup_interval_minutes",
										Number(e.target.value),
									)
								}
								className="px-4 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary"
								required
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="followup_min_hours_after_assistant" className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">
								Espera IA (horas)
							</label>
							<input
								id="followup_min_hours_after_assistant"
								type="number"
								min="0"
								value={settings.followup_min_hours_after_assistant ?? 12}
								onChange={(e) =>
									handleChange(
										"followup_min_hours_after_assistant",
										Number(e.target.value),
									)
								}
								className="px-4 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary"
								required
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="followup_min_minutes_after_assistant" className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">
								Espera IA (minutos)
							</label>
							<input
								id="followup_min_minutes_after_assistant"
								type="number"
								min="0"
								max="59"
								value={settings.followup_min_minutes_after_assistant ?? 0}
								onChange={(e) =>
									handleChange(
										"followup_min_minutes_after_assistant",
										Number(e.target.value),
									)
								}
								className="px-4 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary"
								required
							/>
						</div>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 border-t border-outline-variant/10 pt-4">
						<div className="flex flex-col gap-1.5">
							<label htmlFor="followup_max_attempts" className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">
								Intentos máximos de seguimiento
							</label>
							<input
								id="followup_max_attempts"
								type="number"
								min="1"
								max="5"
								value={settings.followup_max_attempts || 2}
								onChange={(e) =>
									handleChange("followup_max_attempts", Number(e.target.value))
								}
								className="px-4 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary"
								required
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="whatsapp_freeform_window_hours" className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">
								Ventana libre de WhatsApp (horas)
							</label>
							<input
								id="whatsapp_freeform_window_hours"
								type="number"
								min="1"
								value={settings.whatsapp_freeform_window_hours || 24}
								onChange={(e) =>
									handleChange(
										"whatsapp_freeform_window_hours",
										Number(e.target.value),
									)
								}
								className="px-4 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary"
								required
							/>
						</div>
					</div>

					<div className="flex items-center gap-3 mt-4 border-t border-outline-variant/10 pt-4">
						<input
							type="checkbox"
							id="block_outside_24h_followups"
							checked={!!settings.block_outside_24h_followups}
							onChange={(e) =>
								handleChange("block_outside_24h_followups", e.target.checked)
							}
							className="size-4 rounded bg-surface-container-low border border-outline-variant/30 text-primary focus:ring-0"
						/>
						<label
							htmlFor="block_outside_24h_followups"
							className="text-xs text-on-surface-variant font-semibold select-none cursor-pointer"
						>
							Bloquear seguimientos fuera de la ventana de 24 horas (Anti-Spam)
						</label>
					</div>
				</div>

				{/* Grupo: Programaciones de Turnos */}
				<div className="bg-surface/80 border border-outline-variant/20 p-5 rounded-2xl space-y-4">
					<h3 className="text-xs font-bold text-on-surface uppercase tracking-wider flex items-center gap-2">
						<span>📅</span> Programaciones de Turnos
					</h3>
					<p className="text-[9px] text-on-surface-variant/80">
						IDs de los Google Sheets con las planillas de turnos. Se actualizan cada semana. El agente puede escribir "mis turnos" en WhatsApp para consultarlos.
					</p>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div className="flex flex-col gap-1.5">
							<label htmlFor="programacion_1_id" className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">
								Programación 1 — ID del Spreadsheet
							</label>
							<input
								id="programacion_1_id"
								type="text"
								value={settings.programacion_1_id || ""}
								onChange={(e) => handleChange("programacion_1_id", e.target.value)}
								placeholder="1NrZfcE5z0mfg_LthrAtf0wlg..."
								className="px-4 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-mono"
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="programacion_2_id" className="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">
								Programación 2 — ID del Spreadsheet
							</label>
							<input
								id="programacion_2_id"
								type="text"
								value={settings.programacion_2_id || ""}
								onChange={(e) => handleChange("programacion_2_id", e.target.value)}
								placeholder="1UqRuXwkd_NOx59eWX5oteCPR..."
								className="px-4 py-2 bg-surface-container-low border border-outline-variant/30 rounded-xl text-xs text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-mono"
							/>
						</div>
					</div>
					<p className="text-[9px] text-on-surface-variant/60">
						El ID está en la URL del sheet: docs.google.com/spreadsheets/d/<b>ID_ACÁ</b>/edit
					</p>
				</div>

				{/* Grupo: Perfiles de Agentes */}
				<AgentProfilesSection />

				{/* Grupo 4: Telegram */}
				<div className="bg-surface/80 border border-outline-variant/20 p-5 rounded-2xl space-y-3">
					<h3 className="text-xs font-bold text-on-surface uppercase tracking-wider flex items-center gap-2">
						<BellIcon className="text-primary" size={14} /> Canal de Alertas
						(Telegram)
					</h3>
					<p className="text-[9px] text-on-surface-variant/80">
						Las credenciales se administran de manera segura desde las variables
						de entorno de tu servidor (.env.local)
					</p>

					<div className="flex items-center gap-2.5 bg-primary/10 border border-primary/20 text-primary text-xs p-3 rounded-xl">
						<BellIcon size={14} className="animate-bounce" />
						<span>
							<b>Estado de Alertas:</b> Integración de notificaciones de
							Telegram activa en el backend.
						</span>
					</div>
				</div>

				{/* Botón Guardar */}
				<div className="flex justify-end gap-3 border-t border-outline-variant/10 pt-4 shrink-0">
					<button
						type="submit"
						disabled={saving}
						className="px-8 py-2.5 bg-primary text-on-primary rounded-xl font-display text-[10px] font-bold uppercase tracking-wider transition-all duration-200 active:scale-95 disabled:opacity-50 glow-active"
					>
						{saving ? "Guardand…" : "Guardar Cambios"}
					</button>
				</div>
			</form>
		</div>
	);
}
