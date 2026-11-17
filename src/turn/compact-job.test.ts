import { describe, expect, test } from "bun:test";
import type { Message } from "../message.ts";
import type { Conversation } from "../conversation-read.ts";
import { foldSummary } from "../testkit/fake-summary.ts";
import { openTestStore } from "../testkit.ts";
import { type CompactJobDeps, type CompactionSeam, runCompactJob } from "./compact-job.ts";

function rig() {
	const { store } = openTestStore("goblin-compact-job-");
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const asked: Array<{ excluded: boolean }> = [];
	const deps: CompactJobDeps = {
		store,
		compaction: {
			modelRef: () => "m",
			contextWindow: () => null,
			summarize: async () => "unused",
			flush: (c: Conversation) => {
				asked.push({ excluded: c.memoryExcluded });
				return null;
			},
		},
		budgets: () => ({ tailTokenBudget: 1, inputTokenBudget: 32_000 }),
		checkAuthority: () => {},
		foldCeiling: () => null,
		holdController: () => {},
		releaseController: () => {},
	};
	return { store, conv, asked, deps };
}

describe("runCompactJob memory flush gate", () => {
	test("reads exclusion fresh from the store, not the queued snapshot", async () => {
		const r = rig();
		try {
			r.store.setMeta(r.conv.id, { memoryExcluded: true });
			await runCompactJob(r.conv, "threshold", undefined, undefined, r.deps);
			expect(r.asked).toEqual([{ excluded: true }]);
		} finally {
			r.store.close();
		}
	});

	test("an overflow fold never asks for a flush", async () => {
		const r = rig();
		try {
			await runCompactJob(r.conv, "overflow", undefined, undefined, r.deps);
			expect(r.asked).toEqual([]);
		} finally {
			r.store.close();
		}
	});
});

describe("runCompactJob native session compaction (#418)", () => {
	function seeded() {
		const { store } = openTestStore("goblin-compact-job-native-");
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		for (let i = 0; i < 12; i++) {
			store.append(conv.id, [
				{
					id: `u${i}`,
					role: "user",
					parts: [{ type: "text", text: `question ${i} `.repeat(200) }],
				},
				{
					id: `a${i}`,
					role: "assistant",
					parts: [{ type: "text", text: `answer ${i} `.repeat(200) }],
				},
			]);
		}
		return { store, conv };
	}

	function depsFor(
		store: ReturnType<typeof openTestStore>["store"],
		nativeCompact?: CompactionSeam["nativeCompact"],
	): CompactJobDeps {
		return {
			store,
			compaction: {
				modelRef: () => "claude/claude-sonnet-4-5",
				contextWindow: () => null,
				summarize: async (_conv, _system, prompt) => foldSummary("folded", prompt),
				...(nativeCompact !== undefined ? { nativeCompact } : {}),
			},
			budgets: () => ({ tailTokenBudget: 1, inputTokenBudget: 32_000 }),
			checkAuthority: () => {},
			foldCeiling: () => null,
			holdController: () => {},
			releaseController: () => {},
		};
	}

	test("a successful fold runs nativeCompact for the conversation's ref; a noop does not", async () => {
		const { store, conv } = seeded();
		try {
			const calls: string[] = [];
			const deps = depsFor(store, async (c, ref) => {
				calls.push(`${c.id}:${ref}`);
			});
			const outcome = await runCompactJob(conv, "manual", undefined, undefined, deps);
			expect(outcome.kind).toBe("compacted");
			expect(calls).toEqual([`${conv.id}:claude/claude-sonnet-4-5`]);

			// Nothing to fold → the native session is left alone too.
			const empty = store.resolve({ kind: "dm", chatId: 2 }, "/w");
			calls.length = 0;
			const noop = await runCompactJob(empty, "manual", undefined, undefined, deps);
			expect(noop.kind).not.toBe("compacted");
			expect(calls).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("a nativeCompact failure is logged and never fails the goblin fold", async () => {
		const { store, conv } = seeded();
		try {
			const deps = depsFor(store, async () => {
				throw new Error("native session exploded");
			});
			const outcome = await runCompactJob(conv, "manual", undefined, undefined, deps);
			expect(outcome.kind).toBe("compacted");
		} finally {
			store.close();
		}
	});
});

// PR #555 F1: after a split row, the overflow rail's halved tail moves the
// split part — that re-split must land, not throw "compaction produced no
// summary" and kill the turn ("context window full and compacting failed").
describe("runCompactJob overflow after a split row (#403)", () => {
	const reply = (): Message => ({
		id: "r1",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{ type: "text", text: "x".repeat(160_000) },
			{ type: "step-start" },
			{ type: "text", text: "y".repeat(40_000) },
			{ type: "step-start" },
			{ type: "text", text: "z".repeat(20_000) },
			{ type: "step-start" },
			{ type: "text", text: "w".repeat(16_000) },
		],
	});

	test("the halved tail re-splits the same event and returns compacted", async () => {
		const { store } = openTestStore("goblin-compact-job-");
		const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
		const deps = (tail: number): CompactJobDeps => ({
			store,
			compaction: {
				modelRef: () => "m",
				contextWindow: () => null,
				summarize: async (_c, _system, prompt) => foldSummary("fold", prompt),
			},
			budgets: () => ({ tailTokenBudget: tail, inputTokenBudget: 100_000 }),
			checkAuthority: () => {},
			foldCeiling: () => null,
			holdController: () => {},
			releaseController: () => {},
		});
		try {
			store.append(conv.id, [{ id: "q1", role: "user", parts: [{ type: "text", text: "run it" }] }]);
			store.append(conv.id, [reply()], { anchorSeq: 1 });
			const first = await runCompactJob(conv, "threshold", undefined, undefined, deps(20_000));
			expect(first.kind).toBe("compacted");
			expect(store.getCompaction(conv.id)?.split).toEqual({ seq: 2, part: 2 });
			// Overflow halves the tail to 10k: the fold re-splits the same
			// event one step further instead of erroring the recovery.
			const overflow = await runCompactJob(conv, "overflow", undefined, undefined, deps(20_000));
			expect(overflow.kind).toBe("compacted");
			expect(store.getCompaction(conv.id)?.split).toEqual({ seq: 2, part: 4 });
		} finally {
			store.close();
		}
	});
});
