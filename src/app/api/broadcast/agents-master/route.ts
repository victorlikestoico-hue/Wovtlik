import { NextResponse } from "next/server";
import { authErrorToResponse, requireRequestRole } from "@/lib/auth/session";
import { runtimeSessionDeps as authDeps } from "@/lib/auth/runtime";
import { listAgentsMaster, syncAgentsMaster } from "@/lib/db";
import { readSheetByGid } from "@/lib/sheets-client";

const AGENTS_SHEET_ID  = "14EHBTNksNanil6pxmcbjkjTispLA6Fjn6dPzRzXmaQc";
const AGENTS_SHEET_GID = "390261573";

async function fetchAgentsFromSheet() {
	const { headers, rows } = await readSheetByGid(AGENTS_SHEET_ID, AGENTS_SHEET_GID);

	const nameCol  = headers.findIndex((h) => /^agentes$/i.test(h));
	const tlCol    = headers.findIndex((h) => /^tl$/i.test(h));
	const smCol    = headers.findIndex((h) => /^sm$/i.test(h));
	const egCol    = headers.findIndex((h) => /^eg$/i.test(h));
	const waveCol  = headers.findIndex((h) => /^wave$/i.test(h));
	const phoneCol = headers.findIndex((h) => /^tel[eé]fono$/i.test(h));

	if (nameCol < 0 || phoneCol < 0) {
		throw new Error("La planilla no tiene columnas 'Agentes' o 'Telefono'");
	}

	const agents = [];
	for (const { cells } of rows) {
		const name  = (cells[nameCol]  ?? "").trim();
		const phone = (cells[phoneCol] ?? "").replace(/\D/g, "");
		if (!name || !phone) continue;
		agents.push({
			name,
			phone,
			tl:   tlCol   >= 0 ? (cells[tlCol]   ?? "").trim() : "",
			sm:   smCol   >= 0 ? (cells[smCol]   ?? "").trim() : "",
			eg:   egCol   >= 0 ? (cells[egCol]   ?? "").trim() : "",
			wave: waveCol >= 0 ? (cells[waveCol] ?? "").trim() : "",
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
