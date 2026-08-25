import { NextResponse } from "next/server";
import fs from "node:fs";
import {
	getGroupListRequestFlagPath,
	getGroupListResultPath,
	runtimePaths,
} from "../../../../lib/runtime-paths.ts";

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 15_000;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Diagnóstico puntual: le pide al bot-process (único dueño del socket vivo de Baileys) el
// listado de grupos donde participa, vía bandera de archivo compartida (mismo patrón que
// /api/connection/disconnect), y espera el resultado en vez de abrir un segundo socket.
export async function POST() {
	try {
		const dataDir = runtimePaths.dataDir;
		if (!fs.existsSync(dataDir)) {
			fs.mkdirSync(dataDir, { recursive: true });
		}

		const resultPath = getGroupListResultPath();
		if (fs.existsSync(resultPath)) {
			fs.unlinkSync(resultPath);
		}

		fs.writeFileSync(getGroupListRequestFlagPath(), "");

		const deadline = Date.now() + POLL_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (fs.existsSync(resultPath)) {
				const raw = fs.readFileSync(resultPath, "utf-8");
				fs.unlinkSync(resultPath);
				const parsed = JSON.parse(raw);
				if (!parsed.ok) {
					return NextResponse.json({ error: parsed.error }, { status: 503 });
				}
				return NextResponse.json({ groups: parsed.groups });
			}
			await sleep(POLL_INTERVAL_MS);
		}

		return NextResponse.json({ error: "Timeout esperando respuesta del bot-process" }, { status: 504 });
	} catch (error: any) {
		console.error("[api] Error en POST /api/groups/list:", error);
		return NextResponse.json(
			{ error: "Internal Server Error", message: error.message },
			{ status: 500 },
		);
	}
}
