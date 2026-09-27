import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLidPhonePairs, resolveGroupSender } from "../src/lib/baileys/lid-resolver.ts";

const noLookup = () => undefined;

test("resolveGroupSender usa participantPn cuando viene", () => {
	const r = resolveGroupSender(
		{ participant: "61977032413209@lid", participantPn: "573159187217@s.whatsapp.net" },
		noLookup,
	);
	assert.deepEqual(r, { phone: "573159187217", source: "pn" });
});

test("resolveGroupSender acepta participant con formato teléfono", () => {
	const r = resolveGroupSender({ participant: "573159187217@s.whatsapp.net" }, noLookup);
	assert.deepEqual(r, { phone: "573159187217", source: "jid" });
});

test("resolveGroupSender resuelve @lid con el mapa aprendido", () => {
	const r = resolveGroupSender({ participant: "219687929524307@lid" }, (lid) =>
		lid === "219687929524307@lid" ? "573001112233@s.whatsapp.net" : undefined,
	);
	assert.deepEqual(r, { phone: "573001112233", source: "map" });
});

test("resolveGroupSender NO descarta un @lid sin mapeo: cae a sus dígitos", () => {
	// Caso real 2026-09-27: reporte de lunch de un agente que llegó solo con @lid y se perdía.
	const r = resolveGroupSender({ participant: "219687929524307@lid" }, noLookup);
	assert.deepEqual(r, { phone: "219687929524307", source: "lid" });
});

test("resolveGroupSender sin participant devuelve undefined", () => {
	assert.equal(resolveGroupSender({ remoteJid: "123@g.us" }, noLookup), undefined);
	assert.equal(resolveGroupSender(undefined, noLookup), undefined);
});

test("extractLidPhonePairs aprende de 1:1 (senderPn) y de grupos (participantPn)", () => {
	assert.deepEqual(
		extractLidPhonePairs({ remoteJid: "259669847236713@lid", senderPn: "51917241748@s.whatsapp.net" }),
		[["259669847236713@lid", "51917241748@s.whatsapp.net"]],
	);
	assert.deepEqual(
		extractLidPhonePairs({
			remoteJid: "5491151522899-1587685231@g.us",
			participant: "61977032413209@lid",
			participantPn: "573159187217",
		}),
		[["61977032413209@lid", "573159187217@s.whatsapp.net"]],
	);
});

test("extractLidPhonePairs ignora mensajes propios y sin número", () => {
	assert.deepEqual(extractLidPhonePairs({ remoteJid: "1@lid", senderPn: "5@s.whatsapp.net", fromMe: true }), []);
	assert.deepEqual(extractLidPhonePairs({ remoteJid: "g@g.us", participant: "219687929524307@lid" }), []);
});
