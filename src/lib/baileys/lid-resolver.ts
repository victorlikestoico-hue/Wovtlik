// Resolución de remitentes @lid → número de teléfono.
//
// WhatsApp identifica a muchos participantes con un JID anónimo "@lid". A veces el mensaje trae
// también el número real (senderPn en chats 1:1, participantPn en grupos) y a veces no. Cuando no
// lo trae y todavía no aprendimos ese @lid de un mensaje/contacto anterior, antes el reporte del
// grupo de fallas se descartaba entero (sin ✅, sin desconexión encolada). Ahora se cae al propio
// número del @lid como identificador: el reporte se procesa igual con el correo que el agente
// escribe en el texto.
//
// Módulo sin dependencias (ni Baileys ni Redis) para poder testearlo aislado.

export interface MessageKeyLike {
	remoteJid?: string | null;
	participant?: string | null;
	participantPn?: string | null;
	senderPn?: string | null;
	fromMe?: boolean | null;
}

export type SenderSource = "pn" | "jid" | "map" | "lid";

export interface ResolvedSender {
	/** Solo dígitos. Con source "lid" son los dígitos del @lid, NO un teléfono real. */
	phone: string;
	source: SenderSource;
}

export function toPhoneJid(pn: string): string {
	return pn.endsWith("@s.whatsapp.net") ? pn : `${pn.replace(/\D/g, "")}@s.whatsapp.net`;
}

function digits(jid: string): string {
	return jid.split("@")[0].split(":")[0].replace(/\D/g, "");
}

/** Pares [lidJid, phoneJid] que un mensaje entrante permite aprender (1:1 y grupos). */
export function extractLidPhonePairs(key: MessageKeyLike | null | undefined): Array<[string, string]> {
	if (!key || key.fromMe) return [];
	const pairs: Array<[string, string]> = [];
	if (key.remoteJid?.endsWith("@lid") && key.senderPn) {
		pairs.push([key.remoteJid, toPhoneJid(key.senderPn)]);
	}
	if (key.participant?.endsWith("@lid") && key.participantPn) {
		pairs.push([key.participant, toPhoneJid(key.participantPn)]);
	}
	return pairs;
}

/**
 * Identifica al remitente de un mensaje de grupo. Orden: participantPn → participant ya en
 * formato teléfono → mapa @lid aprendido → dígitos del @lid como último recurso.
 */
export function resolveGroupSender(
	key: MessageKeyLike | null | undefined,
	lookupLid: (lidJid: string) => string | undefined,
): ResolvedSender | undefined {
	if (!key) return undefined;
	if (key.participantPn) return { phone: digits(key.participantPn), source: "pn" };
	const participant = key.participant ?? undefined;
	if (!participant) return undefined;
	if (participant.endsWith("@s.whatsapp.net")) return { phone: digits(participant), source: "jid" };
	if (participant.endsWith("@lid")) {
		const mapped = lookupLid(participant);
		if (mapped) return { phone: digits(mapped), source: "map" };
		const lidDigits = digits(participant);
		if (lidDigits) return { phone: lidDigits, source: "lid" };
	}
	return undefined;
}
