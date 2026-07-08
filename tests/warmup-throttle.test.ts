import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	phaseFromLinkedAt,
	warmupDelayMultiplier,
	isBroadcastBlocked,
} from "../src/lib/warmup-throttle.ts";

const HOUR_MS = 3_600_000;

describe("warmup-throttle: phaseFromLinkedAt", () => {
	it("returns normal when there is no linked-at timestamp yet", () => {
		assert.equal(phaseFromLinkedAt(null, Date.now()), "normal");
	});

	it("returns phase1 right after linking and just under 24h later", () => {
		const now = Date.now();
		assert.equal(phaseFromLinkedAt(now, now), "phase1");
		assert.equal(phaseFromLinkedAt(now, now + 23 * HOUR_MS), "phase1");
	});

	it("returns phase2 between 24h and just under 72h after linking", () => {
		const now = Date.now();
		assert.equal(phaseFromLinkedAt(now, now + 24 * HOUR_MS), "phase2");
		assert.equal(phaseFromLinkedAt(now, now + 71 * HOUR_MS), "phase2");
	});

	it("returns normal from 72h onward", () => {
		const now = Date.now();
		assert.equal(phaseFromLinkedAt(now, now + 72 * HOUR_MS), "normal");
		assert.equal(phaseFromLinkedAt(now, now + 500 * HOUR_MS), "normal");
	});
});

describe("warmup-throttle: warmupDelayMultiplier", () => {
	it("triples the delay in phase1", () => {
		assert.equal(warmupDelayMultiplier("phase1"), 3);
	});

	it("extends the delay moderately in phase2", () => {
		assert.equal(warmupDelayMultiplier("phase2"), 1.6);
	});

	it("does not alter the delay once normal", () => {
		assert.equal(warmupDelayMultiplier("normal"), 1);
	});
});

describe("warmup-throttle: isBroadcastBlocked", () => {
	it("blocks broadcasts only during phase1", () => {
		assert.equal(isBroadcastBlocked("phase1"), true);
		assert.equal(isBroadcastBlocked("phase2"), false);
		assert.equal(isBroadcastBlocked("normal"), false);
	});
});
