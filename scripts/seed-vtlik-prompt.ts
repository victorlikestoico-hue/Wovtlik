import "./env-loader.ts";
import { SYSTEM_PROMPT } from "../src/lib/system-prompt.ts";
import { saveSystemPrompt, setActiveSystemPrompt, pool } from "../src/lib/db.ts";

async function main() {
	try {
		const saved = await saveSystemPrompt("Asistente Vtlik — Principal", SYSTEM_PROMPT);
		await setActiveSystemPrompt(saved.id);
		console.log(`[seed] Prompt guardado y activado. ID: ${saved.id}`);
	} catch (error) {
		console.error("[seed] Error:", error);
		process.exit(1);
	} finally {
		await pool.end();
	}
}

main();
