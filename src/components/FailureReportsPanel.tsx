"use client";

import { useCallback, useEffect, useState } from "react";

type GroupFailureReportRow = {
	id: number;
	phone: string;
	sender_name: string;
	email: string | null;
	reason: string;
	form_status: "yes" | "no" | "unknown";
	resolved: boolean;
	confirmed: boolean;
	queued_offline: boolean;
	created_at: string;
};

type NearMissIntentRow = {
	id: number;
	conversation_id: number | null;
	phone: string;
	message: string;
	suspected_categories: string[];
	created_at: string;
};

function fmtDate(value: string): string {
	return new Date(value).toLocaleString("es-AR", {
		timeZone: "America/Argentina/Buenos_Aires",
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

export default function FailureReportsPanel() {
	const [reports, setReports] = useState<GroupFailureReportRow[]>([]);
	const [nearMisses, setNearMisses] = useState<NearMissIntentRow[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/reports/fallas", { cache: "no-store" });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			const data = await res.json();
			setReports(data.groupFailureReports || []);
			setNearMisses(data.nearMissIntents || []);
		} catch (err: any) {
			setError(err.message || "Error cargando datos");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="flex h-full flex-col gap-6 overflow-auto">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="text-lg font-semibold text-primary">Reportes de fallas</h2>
					<p className="text-xs text-muted-foreground">
						Grupo "CS reporte fallas Internet/Luz" y mensajes que casi no matchearon ningún intent.
					</p>
				</div>
				<button
					type="button"
					onClick={load}
					disabled={loading}
					className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-50"
				>
					{loading ? "Cargando…" : "Actualizar"}
				</button>
			</div>

			{error && (
				<div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
					{error}
				</div>
			)}

			<section className="flex flex-col gap-2">
				<h3 className="text-sm font-semibold text-on-surface">
					Grupo de fallas (Internet/Luz) — últimos {reports.length}
				</h3>
				<div className="overflow-x-auto rounded-xl border border-outline-variant/30 bg-surface-container-low">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-outline-variant/30 text-left text-xs text-muted-foreground">
								<th className="px-3 py-2 font-medium">Fecha</th>
								<th className="px-3 py-2 font-medium">Agente</th>
								<th className="px-3 py-2 font-medium">Correo</th>
								<th className="px-3 py-2 font-medium">Motivo</th>
								<th className="px-3 py-2 font-medium">Formulario</th>
								<th className="px-3 py-2 font-medium">Estado</th>
							</tr>
						</thead>
						<tbody>
							{reports.map((r) => (
								<tr key={r.id} className="border-b border-outline-variant/10 last:border-0">
									<td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{fmtDate(r.created_at)}</td>
									<td className="px-3 py-2">
										<div className="font-medium text-on-surface">{r.sender_name}</div>
										<div className="text-xs text-muted-foreground">{r.phone}</div>
									</td>
									<td className="px-3 py-2 text-xs">{r.email || "—"}</td>
									<td className="px-3 py-2 max-w-xs truncate text-xs" title={r.reason}>{r.reason}</td>
									<td className="px-3 py-2">
										<StatusBadge
											ok={r.form_status === "yes" ? true : r.form_status === "no" ? false : null}
											label={r.form_status === "yes" ? "Sí" : r.form_status === "no" ? "No" : "?"}
										/>
									</td>
									<td className="px-3 py-2">
										<div className="flex flex-wrap gap-1">
											{r.resolved && <StatusBadge ok={true} label="Resuelto solo" />}
											{!r.resolved && r.confirmed && r.queued_offline && <StatusBadge ok={true} label="Offline" />}
											{!r.resolved && r.confirmed && !r.queued_offline && <StatusBadge ok={false} label="Falló offline" />}
											{!r.resolved && !r.confirmed && <StatusBadge ok={null} label="Pendiente" />}
										</div>
									</td>
								</tr>
							))}
							{reports.length === 0 && !loading && (
								<tr>
									<td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground">
										Sin reportes todavía.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</section>

			<section className="flex flex-col gap-2">
				<h3 className="text-sm font-semibold text-on-surface">
					Casi-aciertos (intents no detectados) — últimos {nearMisses.length}
				</h3>
				<div className="overflow-x-auto rounded-xl border border-outline-variant/30 bg-surface-container-low">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-outline-variant/30 text-left text-xs text-muted-foreground">
								<th className="px-3 py-2 font-medium">Fecha</th>
								<th className="px-3 py-2 font-medium">Teléfono</th>
								<th className="px-3 py-2 font-medium">Mensaje</th>
								<th className="px-3 py-2 font-medium">Categoría sospechada</th>
							</tr>
						</thead>
						<tbody>
							{nearMisses.map((n) => (
								<tr key={n.id} className="border-b border-outline-variant/10 last:border-0">
									<td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{fmtDate(n.created_at)}</td>
									<td className="px-3 py-2 text-xs">{n.phone}</td>
									<td className="px-3 py-2 max-w-md truncate text-xs" title={n.message}>{n.message}</td>
									<td className="px-3 py-2">
										<div className="flex flex-wrap gap-1">
											{n.suspected_categories.map((c) => (
												<span
													key={c}
													className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
												>
													{c}
												</span>
											))}
										</div>
									</td>
								</tr>
							))}
							{nearMisses.length === 0 && !loading && (
								<tr>
									<td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground">
										Sin casi-aciertos registrados.
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
