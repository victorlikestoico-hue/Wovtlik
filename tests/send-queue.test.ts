import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
	enqueueSocketSend,
	getQueuedSendCount,
	setSendDelayMultiplierProvider,
} from "../src/lib/send-queue.ts";

describe("send-queue", () => {
	beforeEach(() => {
		// Colapsa el pacing a ~0ms para que los tests corran rápido sin mockear timers,
		// preservando el comportamiento real de serialización de la cola.
		setSendDelayMultiplierProvider(async () => 0);
	});

	afterEach(() => {
		setSendDelayMultiplierProvider(null);
	});

	it("runs a single enqueued task and resolves with its result", async () => {
		const result = await enqueueSocketSend(async () => "ok");
		assert.equal(result, "ok");
		assert.equal(getQueuedSendCount(), 0);
	});

	it("serializes concurrently enqueued tasks and preserves submission order", async () => {
		const order: number[] = [];
		const tasks = [1, 2, 3].map((n) =>
			enqueueSocketSend(async () => {
				order.push(n);
				return n;
			}),
		);
		const results = await Promise.all(tasks);
		assert.deepEqual(order, [1, 2, 3]);
		assert.deepEqual(results, [1, 2, 3]);
		assert.equal(getQueuedSendCount(), 0);
	});

	it("propagates a rejected task without breaking the chain for later tasks", async () => {
		const first = enqueueSocketSend(async () => {
			throw new Error("boom");
		});
		const second = enqueueSocketSend(async () => "still works");

		await assert.rejects(first, /boom/);
		assert.equal(await second, "still works");
	});

	it("queries the delay multiplier provider only when more than one task is in flight", async () => {
		let providerCalls = 0;
		setSendDelayMultiplierProvider(async () => {
			providerCalls++;
			return 0;
		});

		await enqueueSocketSend(async () => "solo");
		assert.equal(providerCalls, 0, "first task in an empty queue should not wait/query pacing");

		const tasks = [enqueueSocketSend(async () => "a"), enqueueSocketSend(async () => "b")];
		await Promise.all(tasks);
		assert.ok(providerCalls >= 1, "second task queued behind another should query the multiplier");
	});
});
