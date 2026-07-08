import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomSendDelayMs, waitBetweenSends } from "../src/lib/send-pacing.ts";

function withMockedRandom<T>(values: number[], fn: () => T): T {
	const original = Math.random;
	let index = 0;
	Math.random = () => {
		const value = values[Math.min(index, values.length - 1)];
		index++;
		return value;
	};
	try {
		return fn();
	} finally {
		Math.random = original;
	}
}

describe("send-pacing", () => {
	it("keeps reactive delay within its base range when no long pause triggers", () => {
		// random() calls: [0] -> base offset (low end), [1] -> long-pause check (>= chance, no trigger)
		const delay = withMockedRandom([0, 0.99], () => randomSendDelayMs("reactive"));
		assert.ok(delay >= 3000 && delay < 8000, `expected 3000-7999, got ${delay}`);
	});

	it("keeps broadcast delay within its wider base range", () => {
		const delay = withMockedRandom([0, 0.99], () => randomSendDelayMs("broadcast"));
		assert.ok(delay >= 8000 && delay < 20000, `expected 8000-19999, got ${delay}`);
	});

	it("cron delay sits between reactive and broadcast ranges", () => {
		const delay = withMockedRandom([0, 0.99], () => randomSendDelayMs("cron"));
		assert.ok(delay >= 4000 && delay < 10000, `expected 4000-9999, got ${delay}`);
	});

	it("adds a long pause when the low-probability branch triggers", () => {
		// [0] -> base offset (low end = 3000), [1] -> long-pause check (0 < chance, triggers),
		// [2] -> long-pause range offset (low end = 20000)
		const delay = withMockedRandom([0, 0, 0], () => randomSendDelayMs("reactive"));
		assert.ok(delay >= 3000 + 20000, `expected a long pause added, got ${delay}`);
	});

	it("does not add a long pause when the roll is above the threshold", () => {
		const delay = withMockedRandom([0, 0.5], () => randomSendDelayMs("reactive"));
		assert.ok(delay < 3000 + 20000, `expected no long pause, got ${delay}`);
	});

	it("waitBetweenSends scales the resolved delay by the multiplier", async () => {
		const start = Date.now();
		await withMockedRandom([0, 0.99], () => waitBetweenSends("reactive", 0));
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 200, `expected near-instant resolution with multiplier 0, took ${elapsed}ms`);
	});
});
