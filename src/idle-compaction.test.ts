import { describe, expect, test } from "bun:test";
import type { IdleCacheCall } from "./cache-observation.ts";
import {
	createIdleCompactor,
	IDLE_FOLD_LEAD_MS,
	idleFoldPlan,
} from "./idle-compaction.ts";

const call = (over: Partial<IdleCacheCall> = {}): IdleCacheCall => ({
	callId: "c1",
	routeKey: "route",
	startedMs: 1_000_000,
	inputTokens: 100_000,
	ttlMs: 3_600_000,
	...over,
});

describe("idleFoldPlan", () => {
	test("arms two minutes before expiry, but not before now", () => {
		expect(
			idleFoldPlan({
				conversationId: "app/chat-01",
				call: call(),
				lastFoldMs: null,
				nowMs: 1_600_000,
			}),
		).toEqual({
			kind: "arm",
			callId: "c1",
			fireAtMs: 1_000_000 + 3_600_000 - IDLE_FOLD_LEAD_MS,
			expiresAtMs: 1_000_000 + 3_600_000,
		});
		expect(
			idleFoldPlan({
				conversationId: "app/chat-01",
				call: call(),
				lastFoldMs: null,
				nowMs: 1_000_000 + 3_600_000 - 60_000,
			}),
		).toMatchObject({ kind: "arm", fireAtMs: 1_000_000 + 3_600_000 - 60_000 });
		expect(
			idleFoldPlan({
				conversationId: "app/chat-01",
				call: call(),
				lastFoldMs: null,
				nowMs: 1_000_000 + 3_600_000 + 1,
			}),
		).toEqual({ kind: "skip", reason: "cache already expired" });
	});

	test("applies app, lifetime, token-floor and fold-mark gates", () => {
		const plan = (conversationId: string, c: IdleCacheCall | null, lastFoldMs: number | null = null) =>
			idleFoldPlan({ conversationId, call: c, lastFoldMs, nowMs: 1_000_000 });
		expect(plan("telegram:1", call())).toMatchObject({ kind: "skip" });
		expect(plan("app/chat-01", call({ ttlMs: null }))).toEqual({
			kind: "skip",
			reason: "no cache lifetime reported",
		});
		expect(plan("app/chat-01", call({ inputTokens: 99_999 }))).toMatchObject({ kind: "skip" });
		expect(plan("app/chat-01", call({ inputTokens: 100_000 })).kind).toBe("arm");
		expect(plan("app/chat-01", call(), 1_000_000)).toMatchObject({ kind: "skip" });
		expect(plan("app/chat-01", null)).toMatchObject({ kind: "skip" });
	});
});

describe("createIdleCompactor", () => {
	test("replaces timers and rechecks call identity before folding", async () => {
		let now = 1_600_000;
		let current = call();
		let next = 0;
		const callbacks = new Map<number, () => void>();
		let folded = 0;
		const compactor = createIdleCompactor({
			call: () => current,
			lastFoldMs: () => null,
			recentConversations: () => [],
			fold: async () => {
				folded += 1;
				return "compacted";
			},
			now: () => now,
			setTimer: (callback) => {
				const id = ++next;
				callbacks.set(id, callback);
				return id as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: (timer) => {
				callbacks.delete(timer as unknown as number);
			},
		});
		compactor.arm("app/chat-01");
		current = call({ callId: "c2", startedMs: 1_100_000 });
		compactor.arm("app/chat-01");
		expect(callbacks.size).toBe(1);
		current = call({ callId: "c3", startedMs: 1_200_000 });
		const [callback] = callbacks.values();
		callback?.();
		await Promise.resolve();
		expect(folded).toBe(0);
		current = call({ callId: "c4", startedMs: 1_300_000 });
		compactor.arm("app/chat-01");
		now = 1_600_000;
		const [last] = callbacks.values();
		last?.();
		await Promise.resolve();
		expect(folded).toBe(0);
		compactor.stop();
	});

	test("fold failures are contained by the timer", async () => {
		const callbacks: Array<() => void> = [];
		const compactor = createIdleCompactor({
			call: () => call(),
			lastFoldMs: () => null,
			recentConversations: () => [],
			fold: async () => {
				throw new Error("fold fail");
			},
			now: () => 1_600_000,
			setTimer: (callback) => {
				callbacks.push(callback);
				return callbacks.length as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: () => {},
		});
		compactor.arm("app/chat-01");
		callbacks[0]?.();
		await Promise.resolve();
		compactor.stop();
	});

	test("armAll uses the recent window and fires valid timers", async () => {
		const ids = ["app/a", "app/b", "app/c"];
		const calls = new Map(ids.map((id, i) => [id, call({ callId: id, startedMs: 1_000_000 + i })]));
		calls.set("app/c", call({ callId: "expired", startedMs: 1_000 }));
		const callbacks: Array<() => void> = [];
		let count = 0;
		const compactor = createIdleCompactor({
			call: (id) => calls.get(id) ?? null,
			lastFoldMs: () => null,
			recentConversations: (sinceMs) => {
				expect(sinceMs).toBe(400_000);
				return ids;
			},
			fold: async () => {
				count += 1;
				return "compacted";
			},
			now: () => 4_000_000,
			setTimer: (callback) => {
				callbacks.push(callback);
				return callbacks.length as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer: () => {},
		});
		compactor.armAll();
		expect(callbacks).toHaveLength(2);
		for (const callback of callbacks) callback();
		await Promise.resolve();
		expect(count).toBe(2);
		compactor.stop();
	});
});
