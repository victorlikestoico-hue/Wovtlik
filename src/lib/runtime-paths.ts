import path from "node:path";
import fs from "node:fs";

function resolveRuntimePath(
	value: string | undefined,
	fallbackName: string,
): string {
	if (value) return path.resolve(value);
	if (path.isAbsolute(fallbackName)) return fallbackName;
	return path.join(/* turbopackIgnore: true */ process.cwd(), fallbackName);
}

export const runtimePaths = {
	authDir: resolveRuntimePath(process.env.WHATSAPP_AUTH_DIR, "auth"),
	dataDir: resolveRuntimePath(process.env.BOT_DATA_DIR, "data"),
	mediaDir: resolveRuntimePath(
		process.env.BOT_MEDIA_DIR,
		path.join(resolveRuntimePath(process.env.BOT_DATA_DIR, "data"), "media"),
	),
};

export const destructiveRestartFlagName = ".reset-auth";
export const softRestartFlagName = ".restart-bot";
const groupListRequestFlagName = ".list-groups-request";
const groupListResultFileName = ".list-groups-result.json";

export function getDestructiveRestartFlagPath(): string {
	return path.join(runtimePaths.dataDir, destructiveRestartFlagName);
}

export function getSoftRestartFlagPath(): string {
	return path.join(runtimePaths.dataDir, softRestartFlagName);
}

// Bandera de diagnóstico puntual: el proceso web la crea para pedirle al bot-process (único
// dueño del socket vivo) el listado de grupos donde participa, y lee el resultado del archivo
// de abajo — mismo patrón que .restart-bot/.reset-auth, evita abrir un segundo socket de Baileys.
export function getGroupListRequestFlagPath(): string {
	return path.join(runtimePaths.dataDir, groupListRequestFlagName);
}

export function getGroupListResultPath(): string {
	return path.join(runtimePaths.dataDir, groupListResultFileName);
}

export function getPendingAnnouncementsDir(): string {
	return path.join(runtimePaths.dataDir, "pending-announcements");
}

export function getInstanceAuthDir(instanceId: number | string): string {
	return path.join(runtimePaths.authDir, "instances", String(instanceId));
}

/**
 * Safely clears all files and directories inside a target directory,
 * without deleting the target directory itself (crucial for Docker mounted volumes).
 */
export function clearDirectoryContents(dirPath: string): void {
	if (!fs.existsSync(dirPath)) return;
	const items = fs.readdirSync(dirPath);
	for (const item of items) {
		const itemPath = path.join(dirPath, item);
		try {
			fs.rmSync(itemPath, { recursive: true, force: true });
		} catch (error) {
			console.warn(`[runtime-paths] No se pudo eliminar ${itemPath}:`, error);
		}
	}
}
