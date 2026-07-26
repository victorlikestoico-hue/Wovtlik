"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type MetaReminderSentRow = {
	id: number;
	phone: string;
	name: string | null;
	hora_inicio: string | null;
	etiqueta_zona: string | null;
	whatsapp_message_id: string | null;
	status: string;
	detalle: string | null;
	sent_at: string;
};

type MetaReplyRow = {
	id: number;
	phone: string;
	contact_name: string | null;
	whatsapp_message_id: string | null;
	content: string | null;
	message_type: string;
	received_at: string;
};

function fmtDate(value: string): string {
	return new Date(value).toLocaleString("es-CO", {
		timeZone: "America/Bogota",
		dateStyle: "short",
		timeStyle: "short",
	});
}

function StatusBadge({ ok, label }: { ok: boolean | null; label: string }) {
	const color =
		ok === true
			? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
			: ok === false
				? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
				: "border-outline-variant/30 bg-surface-container-low text-muted-foreground";
	return (
		<span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${color}`}>
			{label}
		</span>
	);
}

export default function MetaPanel() {
	const [reminders, setReminders] = useState<MetaReminderSentRow[]>([]);
	const [replies, setReplies] = useState<MetaReplyRow[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [filterDate, setFilterDate] = useState("");
	const [filterHora, setFilterHora] = useState("");

	const load = useCallback(async (date: string) => {
		setLoading(true);
		setError(null);
		try {
			const qs = date ? `?date=${encodeURIComponent(date)}` : "";
			const [remindersRes, repliesRes] = await Promise.all([
				fetch(`/api/meta/reminders${qs}`, { cache: "no-store" }),
				fetch(`/api/meta/replies${qs}`, { cache: "no-store" }),
			]);
			if (!remindersRes.ok) throw new Error(`HTTP ${remindersRes.status} (recordatorios)`);
			if (!repliesRes.ok) throw new Error(`HTTP ${repliesRes.status} (respuestas)`);
			const remindersData = await remindersRes.json();
			const repliesData = await repliesRes.json();
			setReminders(remindersData.reminders || []);
			setReplies(repliesData.replies || []);
		} catch (err: any) {
			setError(err.message || "Error cargando datos");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load(filterDate);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filterDate]);

	const horaOptions = useMemo(() => {
		const set = new Set<string>();
		for (const r of reminders) {
			if (r.hora_inicio) set.add(r.hora_inicio);
		}
		return Array.from(set).sort();
	}, [reminders]);

	// Si la hora seleccionada ya no existe entre las opciones (cambió la fecha), se limpia.
	useEffect(() => {
		if (filterHora && !horaOptions.includes(filterHora)) {
			setFilterHora("");
		}
	}, [horaOptions, filterHora]);

	const filteredReminders = useMemo(
		() => (filterHora ? reminders.filter((r) => r.hora_inicio === filterHora) : reminders),
		[reminders, filterHora],
	);

	return (
		<div className="flex h-full flex-col gap-6 overflow-auto">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="text-lg font-semibold text-primary">Meta — recordatorios de turno</h2>
					<p className="text-xs text-muted-foreground">
						Envíos por WhatsApp Cloud API (proyecto recordatorios-turnos) y respuestas de los agentes.
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
						Fecha
						<input
							type="date"
							value={filterDate}
							onChange={(e) => setFilterDate(e.target.value)}
							className="rounded-md border border-outline-variant/30 bg-surface-container-low px-2 py-1 text-xs text-on-surface"
						/>
					</label>
					<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
						Hora envío
						<select
							value={filterHora}
							onChange={(e) => setFilterHora(e.target.value)}
							className="rounded-md border border-outline-variant/30 bg-surface-container-low px-2 py-1 text-xs text-on-surface"
						>
							<option value="">Todas</option>
							{horaOptions.map((h) => (
								<option key={h} value={h}>
									{h}
								</option>
							))}
						</select>
					</label>
					{(filterDate || filterHora) && (
						<button
							type="button"
							onClick={() => {
								setFilterDate("");
								setFilterHora("");
							}}
							className="text-xs text-muted-foreground underline underline-offset-2"
						>
							Limpiar filtros
						</button>
					)}
					<button
						type="button"
						onClick={() => load(filterDate)}
						disabled={loading}
						className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-50"
					>
						{loading ? "Cargando…" : "Actualizar"}
					</button>
				</div>
			</div>

			{error && (
				<div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
					{error}
				</div>
			)}

			<section className="flex flex-col gap-2">
				<h3 className="text-sm font-semibold text-on-surface">
					Recordatorios enviados — {filteredReminders.length}
					{filteredReminders.length !== reminders.length ? ` de ${reminders.length}` : ""}
				</h3>
				<div className="overflow-x-auto rounded-xl border border-outline-variant/30 bg-surface-container-low">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-outline-variant/30 text-left text-xs text-muted-foreground">
								<th className="px-3 py-2 font-medium">Fecha envío</th>
								<th className="px-3 py-2 font-medium">Agente</th>
								<th className="px-3 py-2 font-medium">Turno</th>
								<th className="px-3 py-2 font-medium">Estado</th>
								<th className="px-3 py-2 font-medium">Detalle</th>
							</tr>
						</thead>
						<tbody>
							{filteredReminders.map((r) => (
								<tr key={r.id} className="border-b border-outline-variant/10 last:border-0">
									<td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{fmtDate(r.sent_at)}</td>
									<td className="px-3 py-2">
										<div className="font-medium text-on-surface">{r.name || "—"}</div>
										<div className="text-xs text-muted-foreground">{r.phone}</div>
									</td>
									<td className="px-3 py-2 text-xs">
										{r.hora_inicio || "—"} {r.etiqueta_zona || ""}
									</td>
									<td className="px-3 py-2">
										<StatusBadge ok={r.status === "sent"} label={r.status} />
									</td>
									<td className="px-3 py-2 max-w-xs truncate text-xs" title={r.detalle || undefined}>
										{r.detalle || "—"}
									</td>
								</tr>
							))}
							{filteredReminders.length === 0 && !loading && (
								<tr>
									<td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">
										{reminders.length === 0
											? "Sin recordatorios registrados todavía."
											: "Sin recordatorios para el filtro seleccionado."}
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</section>

			<section className="flex flex-col gap-2">
				<h3 className="text-sm font-semibold text-on-surface">
					Respuestas de los agentes — últimas {replies.length}
				</h3>
				<div className="overflow-x-auto rounded-xl border border-outline-variant/30 bg-surface-container-low">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-outline-variant/30 text-left text-xs text-muted-foreground">
								<th className="px-3 py-2 font-medium">Fecha</th>
								<th className="px-3 py-2 font-medium">Agente</th>
								<th className="px-3 py-2 font-medium">Mensaje</th>
								<th className="px-3 py-2 font-medium">Tipo</th>
							</tr>
						</thead>
						<tbody>
							{replies.map((r) => (
								<tr key={r.id} className="border-b border-outline-variant/10 last:border-0">
									<td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{fmtDate(r.received_at)}</td>
									<td className="px-3 py-2">
										<div className="font-medium text-on-surface">{r.contact_name || "—"}</div>
										<div className="text-xs text-muted-foreground">{r.phone}</div>
									</td>
									<td className="px-3 py-2 max-w-md truncate text-xs" title={r.content || undefined}>
										{r.content || "—"}
									</td>
									<td className="px-3 py-2 text-xs">{r.message_type}</td>
								</tr>
							))}
							{replies.length === 0 && !loading && (
								<tr>
									<td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground">
										Sin respuestas registradas todavía.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);
}
