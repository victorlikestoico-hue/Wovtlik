import "./env-loader";
import { saveSystemPrompt, setActiveSystemPrompt } from "../src/lib/db.ts";
import { SYSTEM_PROMPT } from "../src/lib/system-prompt.ts";

// Inserta y activa el prompt de Vtlik (solo clientes Vtlik, sin agentes/TL/supervisor).
async function main() {
	try {
		const saved = await saveSystemPrompt("Asistente Vtlik — solo clientes", SYSTEM_PROMPT);
		await setActiveSystemPrompt(saved.id);
		console.log(`[script] Prompt insertado y activado. ID: ${saved.id}, Titulo: ${saved.title}`);
		process.exit(0);
	} catch (error) {
		console.error("[script] Error insertando prompt:", error);
		process.exit(1);
	}
}

main();
