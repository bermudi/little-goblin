import { describe, expect, test } from "bun:test";
import type { Conversation } from "../conversation.ts";
import { openTestStore } from "../testkit.ts";
import { type CompactJobDeps, runCompactJob } from "./compact-job.ts";

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
			await runCompactJob(r.conv, "threshold", undefined, r.deps);
			expect(r.asked).toEqual([{ excluded: true }]);
		} finally {
			r.store.close();
		}
	});

	test("an overflow fold never asks for a flush", async () => {
		const r = rig();
		try {
			await runCompactJob(r.conv, "overflow", undefined, r.deps);
			expect(r.asked).toEqual([]);
		} finally {
			r.store.close();
		}
	});
});
