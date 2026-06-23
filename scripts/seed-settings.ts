import "./env-loader.ts";
import { setSetting, getSettings, pool } from "../src/lib/db.ts";

async function main() {
	await setSetting("offline_queue_sheet_id", "1eSQRa7a-frqlWYJcAKyH6vx-1HUpqcuXnydV5VL9w0g");
	console.log("[seed] offline_queue_sheet_id guardado.");

	const s = await getSettings();
	console.log("[verify] offline_queue_sheet_id =", s["offline_queue_sheet_id"]);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
