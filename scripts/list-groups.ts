// Diagnóstico puntual: lista todos los grupos donde participa la cuenta de WhatsApp del bot,
// vía /api/groups/list (que a su vez le pregunta al bot-process, sin abrir un segundo socket).
// Uso: npx tsx scripts/list-groups.ts ["texto a buscar"]
import { callWOpenApi } from "./wopen-api-client.ts";

async function main() {
	const filter = process.argv[2]?.toLowerCase();
	const { groups } = await callWOpenApi<{ groups: Array<{ id: string; subject: string; participantsCount: number }> }>(
		"/api/groups/list",
		{ method: "POST" },
	);

	const filtered = filter ? groups.filter((g) => g.subject.toLowerCase().includes(filter)) : groups;

	if (!filtered.length) {
		console.log(filter ? `Ningún grupo coincide con "${filter}".` : "El bot no participa en ningún grupo.");
		return;
	}

	for (const g of filtered) {
		console.log(`${g.subject}  →  ${g.id}  (${g.participantsCount} participantes)`);
	}
}

main().catch((err) => {
	console.error("[list-groups] Error:", err.message);
	process.exit(1);
});
