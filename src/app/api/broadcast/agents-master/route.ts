import { NextResponse } from "next/server";
import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { listAgentsMaster, syncAgentsMaster } from "@/lib/db";

const AGENTS_SHEET_ID  = "14EHBTNksNanil6pxmcbjkjTispLA6Fjn6dPzRzXmaQc";
const AGENTS_SHEET_GID = "390261573";

function parseCSV(text: string): string[][] {
	return text.split("\n").map((line) => {
		const cols: string[] = [];
		let cur = "";
		let inQ = false;
		for (const ch of line) {
			if (ch === '"')           { inQ = !inQ; }
			else if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; }
			else                       { cur += ch; }
		}
		cols.push(cur.trim().replace(/\r$/, ""));
		return cols;
	});
}

async function fetchAgentsFromSheet() {
	const url = `https://docs.google.com/spreadsheets/d/${AGENTS_SHEET_ID}/export?format=csv&gid=${AGENTS_SHEET_GID}`;
	const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`Error al leer la planilla: ${res.status}`);

	const rows = parseCSV(await res.text());
	if (rows.length < 2) return [];

	const headers = rows[0].map((h) => h.toLowerCase().trim());
	const nameCol  = headers.findIndex((h) => h === "agentes");
	const tlCol    = headers.findIndex((h) => h === "tl");
	const smCol    = headers.findIndex((h) => h === "sm");
	const egCol    = headers.findIndex((h) => h === "eg");
	const waveCol  = headers.findIndex((h) => h === "wave");
	const phoneCol = headers.findIndex((h) => h === "telefono");

	if (nameCol < 0 || phoneCol < 0) {
		throw new Error("La planilla no tiene columnas 'Agentes' o 'Telefono'");
	}

	const agents = [];
	for (const row of rows.slice(1)) {
		const name  = (row[nameCol]  ?? "").trim();
		const phone = (row[phoneCol] ?? "").replace(/\D/g, "");
		if (!name || !phone) continue;
		agents.push({
			name,
			phone,
			tl:   tlCol   >= 0 ? (row[tlCol]   ?? "").trim() : "",
			sm:   smCol   >= 0 ? (row[smCol]   ?? "").trim() : "",
			eg:   egCol   >= 0 ? (row[egCol]   ?? "").trim() : "",
			wave: waveCol >= 0 ? (row[waveCol] ?? "").trim() : "",
		});
	}
	return agents;
}

export async function GET(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "viewer");
		const agents = await listAgentsMaster();
		return NextResponse.json(agents);
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
}

export async function POST(req: Request) {
	try {
		await requireRequestRole(req, authDeps, "manager");
		const agents = await fetchAgentsFromSheet();
		if (agents.length === 0) {
			return NextResponse.json({ error: "La planilla no tiene agentes válidos" }, { status: 400 });
		}
		const count = await syncAgentsMaster(agents);
		const updated = await listAgentsMaster();
		return NextResponse.json({ ok: true, synced: count, total: updated.length, agents: updated });
	} catch (error: any) {
		const authResponse = authErrorToResponse(error);
		if (authResponse) return authResponse;
		console.error("[api] Error en POST /api/broadcast/agents-master:", error);
		return NextResponse.json({ error: error.message }, { status: 500 });
	}
}
