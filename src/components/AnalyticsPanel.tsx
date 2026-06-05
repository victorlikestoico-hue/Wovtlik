"use client";

import { useEffect, useState, useCallback } from "react";

type AgentRow = {
	Agente: string;
	lob: string | null;
	team_leader: string | null;
	csat: string | null;
	aht_seconds: string | null;
	ga_critica: string | null;
	apego: string | null;
	productivity: string | null;
	total_interactions: string | null;
};

type Objective = { target: number; condition: string };
type LobObjectives = Record<string, Objective>;
type AllObjectives = Record<string, LobObjectives>;

type SnapshotData = {
	period?: { start: string; end: string };
	date?: string;
	lob: string;
	agents: AgentRow[];
	objectives: AllObjectives;
};

function fmtPct(v: string | null): string {
	if (v === null || v === undefined) return "—";
	const n = parseFloat(v);
	if (Number.isNaN(n)) return "—";
	const pct = n <= 1 ? n * 100 : n;
	return `${pct.toFixed(1)}%`;
}

function fmtAht(v: string | null): string {
	if (v === null || v === undefined) return "—";
	const seconds = parseFloat(v);
	if (Number.isNaN(seconds) || seconds === 0) return "—";
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

function meetsObjective(
	value: string | null,
	key: string,
	objectives: AllObjectives,
	lob: string | null,
): boolean | null {
	if (!value || !lob || !objectives[lob]?.[key]) return null;
	const n = parseFloat(value);
	if (Number.isNaN(n)) return null;
	const v = n <= 1 ? n : n / 100;
	const { target, condition } = objectives[lob][key];
	return condition === ">=" ? v >= target : condition === "<=" ? v <= target : v >= target;
}

function KpiCell({
	value,
	fmt,
	ok,
}: {
	value: string | null;
	fmt: string;
	ok: boolean | null;
}) {
	const color =
		ok === true
			? "text-emerald-600 dark:text-emerald-400"
			: ok === false
				? "text-red-500 dark:text-red-400"
				: "text-muted-foreground";
	return (
		<td className={`px-3 py-2 text-right text-sm font-medium tabular-nums ${color}`}>
			{fmt}
		</td>
	);
}

export default function AnalyticsPanel() {
	const [data, setData] = useState<SnapshotData | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [lob, setLob] = useState("all");
	const [mode, setMode] = useState<"snapshot" | "daily">("snapshot");
	const [date, setDate] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const params = new URLSearchParams({ lob, mode });
			if (mode === "daily" && date) params.set("date", date);
			const res = await fetch(`/api/analytics/metrics?${params}`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			setData(await res.json());
		} catch (err: any) {
			setError(err.message || "Error cargando datos");
		} finally {
			setLoading(false);
		}
	}, [lob, mode, date]);

	useEffect(() => {
		void load();
	}, [load]);

	const lobs = data
		? [...new Set(data.agents.map((a) => a.lob).filter(Boolean) as string[])].sort()
		: [];

	return (
		<div className="flex h-full flex-col gap-4 overflow-auto">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="text-lg font-semibold text-primary">Analytics — DashBig</h2>
					{data?.period && (
						<p className="text-xs text-muted-foreground">
							{data.period.start} → {data.period.end}
						</p>
					)}
					{data?.date && (
						<p className="text-xs text-muted-foreground">Fecha: {data.date}</p>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<select
						value={mode}
						onChange={(e) => setMode(e.target.value as "snapshot" | "daily")}
						className="rounded-md border border-outline-variant/50 bg-surface px-2 py-1.5 text-sm text-primary outline-none focus:border-primary/60"
					>
						<option value="snapshot">MTD (mes actual)</option>
						<option value="daily">Diario</option>
					</select>

					{mode === "daily" && (
						<input
							type="date"
							value={date}
							onChange={(e) => setDate(e.target.value)}
							className="rounded-md border border-outline-variant/50 bg-surface px-2 py-1.5 text-sm text-primary outline-none focus:border-primary/60"
						/>
					)}

					<select
						value={lob}
						onChange={(e) => setLob(e.target.value)}
						className="rounded-md border border-outline-variant/50 bg-surface px-2 py-1.5 text-sm text-primary outline-none focus:border-primary/60"
					>
						<option value="all">Todos los LOBs</option>
						{lobs.map((l) => (
							<option key={l} value={l}>
								{l}
							</option>
						))}
					</select>

					<button
						type="button"
						onClick={load}
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

			{!error && data && (
				<div className="overflow-x-auto rounded-lg border border-outline-variant/30">
					<table className="w-full border-collapse text-left">
						<thead className="bg-muted/50">
							<tr>
								<th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Agente
								</th>
								<th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									LOB
								</th>
								<th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									CSAT
								</th>
								<th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									AHT
								</th>
								<th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									GA Crítica
								</th>
								<th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Apego
								</th>
								<th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
									Interacciones
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-outline-variant/20">
							{data.agents.length === 0 && (
								<tr>
									<td
										colSpan={7}
										className="px-3 py-8 text-center text-sm text-muted-foreground"
									>
										Sin datos para los filtros seleccionados.
									</td>
								</tr>
							)}
							{data.agents.map((agent) => (
								<tr
									key={agent.Agente}
									className="transition-colors hover:bg-muted/30"
								>
									<td className="max-w-[180px] truncate px-3 py-2 text-sm font-medium text-primary">
										{agent.Agente.split("@")[0]}
									</td>
									<td className="px-3 py-2 text-xs text-muted-foreground">
										{agent.lob || "—"}
									</td>
									<KpiCell
										value={agent.csat}
										fmt={fmtPct(agent.csat)}
										ok={meetsObjective(agent.csat, "csat", data.objectives, agent.lob)}
									/>
									<td className="px-3 py-2 text-right text-sm tabular-nums text-muted-foreground">
										{fmtAht(agent.aht_seconds)}
									</td>
									<KpiCell
										value={agent.ga_critica}
										fmt={fmtPct(agent.ga_critica)}
										ok={meetsObjective(
											agent.ga_critica,
											"gacrit",
											data.objectives,
											agent.lob,
										)}
									/>
									<KpiCell
										value={agent.apego}
										fmt={fmtPct(agent.apego)}
										ok={meetsObjective(agent.apego, "apego", data.objectives, agent.lob)}
									/>
									<td className="px-3 py-2 text-right text-sm tabular-nums text-muted-foreground">
										{agent.total_interactions ?? "—"}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{loading && !data && (
				<div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
					Cargando datos de BigQuery…
				</div>
			)}
		</div>
	);
}
