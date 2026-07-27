import "./env-loader.ts";

// El schedule nativo de GitHub Actions del repo "recordatorios" (cron cada 30 min)
// no corre con esa frecuencia bajo carga -- se confirmó que en la práctica corre
// ~1 vez por hora, lo que hace que se pierdan recordatorios de turno (la ventana
// de envío se cierra cuando arranca el turno, sin reintento). Como WOpen ya corre
// 24/7 en Railway, este loop dispara el workflow por API cada 5 min para
// complementar el cron nativo y acortar la demora real entre corridas.

const GITHUB_OWNER = "victorlikestoico-hue";
const GITHUB_REPO = "recordatorios";
const GITHUB_WORKFLOW_FILE = "recordatorios.yml";
const GITHUB_REF = "main";

const DISPATCH_INTERVAL_MS = 5 * 60 * 1000;

async function dispatchOnce(): Promise<void> {
	const token = process.env.GITHUB_RECORDATORIOS_TOKEN;
	if (!token) return;

	try {
		const res = await fetch(
			`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}/dispatches`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "wopen-recordatorios-dispatch-cron",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ ref: GITHUB_REF }),
			},
		);

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.error(`[recordatorios-dispatch-cron] GitHub respondió ${res.status}: ${body}`);
			return;
		}

		console.log("[recordatorios-dispatch-cron] Workflow disparado correctamente.");
	} catch (error) {
		console.error("[recordatorios-dispatch-cron] Error disparando el workflow:", error);
	}
}

export function startRecordatoriosDispatchCron(): void {
	if (!process.env.GITHUB_RECORDATORIOS_TOKEN) {
		console.warn(
			"[recordatorios-dispatch-cron] GITHUB_RECORDATORIOS_TOKEN no configurado, el loop no se inicia.",
		);
		return;
	}

	console.log("[recordatorios-dispatch-cron] Iniciando loop de disparo del workflow (cada 5 min)...");
	void dispatchOnce();
	setInterval(() => void dispatchOnce(), DISPATCH_INTERVAL_MS);
}
