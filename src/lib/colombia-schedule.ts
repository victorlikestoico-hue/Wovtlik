const COLOMBIA_TZ = "America/Bogota";

/** Hora actual en Colombia (0-23). Colombia no tiene horario de verano (UTC-5 fijo). */
function currentHourColombia(): number {
	return new Date(
		new Date().toLocaleString("en-US", { timeZone: COLOMBIA_TZ }),
	).getHours();
}

/** true si la hora actual en Colombia cae dentro de la ventana de envío [6:00, 24:00). */
export function isWithinColombiaSendWindow(): boolean {
	return currentHourColombia() >= 6;
}

/**
 * Milisegundos hasta el próximo HH:00:00 (hora en punto). Usa UTC para el cálculo porque
 * el offset de Colombia (UTC-5) es un número entero de horas, así que el tope de hora
 * coincide sin importar la zona horaria del servidor donde corre el proceso.
 */
export function msUntilNextTopOfHour(): number {
	const now = new Date();
	const nextHourUTC = new Date(Date.UTC(
		now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, 0,
	));
	return nextHourUTC.getTime() - now.getTime();
}
