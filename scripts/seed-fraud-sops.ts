import "./env-loader.ts";
import fs from "fs";
import path from "path";
import { pool, ensureSchemaInitialized, saveKnowledgeDocument, updateKnowledgeDocument } from "../src/lib/db.ts";

/**
 * Carga (o actualiza) los 7 SOPs de Fraude Operacional transcritos en
 * Monitor/kb_pdfs/sop_text/ como knowledge_documents, para que
 * resolveSopInjection() (src/lib/baileys/inbound-handler.ts) los pueda
 * encontrar por búsqueda full-text cuando un agente pregunta por WhatsApp.
 *
 * Re-ejecutable: si ya existe un documento con el mismo título, lo actualiza
 * en vez de duplicarlo.
 */

const SOP_TEXT_DIR = path.resolve(process.cwd(), "..", "Monitor", "kb_pdfs", "sop_text");

const SOPS: Array<{ file: string; title: string; tags: string[] }> = [
	{
		file: "1 - Validaciones de cuentas.md",
		title: "Validaciones de cuentas",
		tags: ["validaciones de cuentas", "activar cuenta", "reactivar cuenta", "fraude no reactivar", "fraude"],
	},
	{
		file: "2 - Gestion OMAD Team Fraude.md",
		title: "Gestión OMAD - Team Fraude",
		tags: ["omad", "forense", "whitelist", "cruces de device", "fraude"],
	},
	{
		file: "3 - Gestion de consultas desde Legales CS.md",
		title: "Gestión de consultas desde Legales CS",
		tags: ["legales", "consultas legales", "planilla", "fraude"],
	},
	{
		file: "4 - Forense Courier.md",
		title: "Forense Courier - C2C",
		tags: ["courier", "forense", "c2c", "whitelist", "fraude"],
	},
	{
		file: "5 - Bloqueo de cupones MKT.md",
		title: "Bloqueo de cupones MKT",
		tags: ["cupon", "cupones", "mkt", "bloqueo", "alerta roja", "fraude"],
	},
	{
		file: "6 - SOP IV Risk Contact.md",
		title: "SOP IV Risk Contact",
		tags: ["iv_risk", "iv risk contact", "omad", "control de devolucion", "fraude"],
	},
	{
		file: "7 - Usuarios fraudes Business y PeYa.md",
		title: "Usuarios Fraudes - Business & PeYa",
		tags: ["business", "peya", "corporate", "reactivar cuenta", "beneficio corporativo", "fraude"],
	},
];

async function upsertByTitle(title: string, content: string, tags: string[], category: string) {
	const existing = await pool.query<{ id: number }>(
		"SELECT id FROM knowledge_documents WHERE title = $1 LIMIT 1",
		[title],
	);
	if (existing.rows[0]) {
		await updateKnowledgeDocument(existing.rows[0].id, { content, tags, category, is_active: true });
		return { id: existing.rows[0].id, action: "updated" as const };
	}
	const saved = await saveKnowledgeDocument({ title, content, tags, category });
	return { id: saved.id, action: "created" as const };
}

async function main() {
	if (!fs.existsSync(SOP_TEXT_DIR)) {
		console.error(`[seed] No se encontró la carpeta de SOPs: ${SOP_TEXT_DIR}`);
		process.exit(1);
	}

	try {
		await ensureSchemaInitialized();
		for (const sop of SOPS) {
			const filePath = path.join(SOP_TEXT_DIR, sop.file);
			if (!fs.existsSync(filePath)) {
				console.warn(`[seed] Archivo no encontrado, se omite: ${filePath}`);
				continue;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			const result = await upsertByTitle(sop.title, content, sop.tags, "fraude_operacional");
			console.log(`[seed] ${result.action.toUpperCase()} — ID ${result.id} — "${sop.title}"`);
		}
		console.log("[seed] Listo.");
	} catch (error) {
		console.error("[seed] Error:", error);
		process.exit(1);
	} finally {
		await pool.end();
	}
}

main();
