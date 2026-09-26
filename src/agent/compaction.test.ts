import { describe, expect, test } from "bun:test";
import {
	chooseBoundary,
	runCompaction,
	type CompactionEvent,
	type CompactionStore,
} from "./compaction.ts";

function ev(
	seq: number,
	role: "user" | "assistant",
	text: string,
	anchorSeq: number | null = null,
): CompactionEvent {
	return {
		seq,
		anchorSeq,
		message: { id: `m${seq}`, role, parts: [{ type: "text", text }] },
	};
}

// Three complete exchanges: u/a pairs with the assistant anchored to its
// user event, plus a trailing user whose turn hasn't answered yet.
function sample(): CompactionEvent[] {
	return [
		ev(1, "user", "hello".repeat(200)),
		ev(2, "assistant", "hi there".repeat(200), 1),
		ev(3, "user", "do a thing".repeat(200)),
		ev(4, "assistant", "did it".repeat(200), 3),
		ev(5, "user", "and now".repeat(200)),
		ev(6, "assistant", "done".repeat(200), 5),
	];
}

describe("chooseBoundary", () => {
	test("the cut lands at a completed exchange — no anchored response is orphaned", () => {
		// Tiny budget: keep only the last exchange. The boundary must be the
		// seq of the assistant response that closes the second exchange —
		// cutting one earlier would strand u3 from its anchored a3... rather,
		// strand a2 from u2 in the compacted span while u3/a3 stay whole.
		const boundary = chooseBoundary(sample(), { tailTokenBudget: 1, previousBoundary: null });
		expect(boundary).toBe(4);
	});

	test("a huge budget keeps everything — nothing to compact", () => {
		expect(
			chooseBoundary(sample(), { tailTokenBudget: 1_000_000, previousBoundary: null }),
		).toBeNull();
	});

	test("a trailing unanswered user message is never compacted", () => {
		const detail = [...sample(), ev(7, "user", "pending question".repeat(200))];
		const boundary = chooseBoundary(detail, { tailTokenBudget: 1, previousBoundary: null });
		expect(boundary).toBe(6);
	});

	test("re-compaction stops at the previous boundary — nothing new to fold", () => {
		expect(chooseBoundary(sample(), { tailTokenBudget: 1, previousBoundary: 4 })).toBeNull();
	});

	test("a tiny span is not worth compacting", () => {
		const detail = [ev(1, "user", "hi"), ev(2, "assistant", "yo", 1)];
		expect(chooseBoundary(detail, { tailTokenBudget: 1, previousBoundary: null })).toBeNull();
	});
});

function fakeStore(detail: CompactionEvent[], previous: { boundarySeq: number; summary: string } | null = null) {
	const writes: Parameters<CompactionStore["setCompaction"]>[1][] = [];
	const store: CompactionStore = {
		historyDetail: () => detail,
		getCompaction: () => previous,
		setCompaction: (_id, compaction) => {
			writes.push(compaction);
		},
	};
	return { store, writes };
}

describe("runCompaction", () => {
	test("summarizes the span, folds the previous summary, writes the pointer", async () => {
		const { store, writes } = fakeStore(sample(), { boundarySeq: 2, summary: "earlier era" });
		const prompts: Array<{ system: string; prompt: string }> = [];
		const outcome = await runCompaction(
			"dm:1",
			store,
			"zai/glm-5.3",
			async (system, prompt) => {
				prompts.push({ system, prompt });
				return "the folded summary";
			},
			{ tailTokenBudget: 1 },
		);
		expect(outcome.kind).toBe("compacted");
		if (outcome.kind !== "compacted") return;
		expect(outcome.boundarySeq).toBe(4);
		expect(outcome.summary).toBe("the folded summary");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]!.prompt).toContain("earlier era");
		expect(prompts[0]!.prompt).toContain("did it");
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ boundarySeq: 4, summary: "the folded summary", model: "zai/glm-5.3" });
	});

	test("a summarizer failure propagates and writes nothing", async () => {
		const { store, writes } = fakeStore(sample());
		await expect(
			runCompaction(
				"dm:1",
				store,
				"m",
				async () => {
					throw new Error("provider down");
				},
				{ tailTokenBudget: 1 },
			),
		).rejects.toThrow("provider down");
		expect(writes).toHaveLength(0);
	});

	test("an empty summary is a failure, not a silent wipe", async () => {
		const { store, writes } = fakeStore(sample());
		await expect(
			runCompaction("dm:1", store, "m", async () => "  ", { tailTokenBudget: 1 }),
		).rejects.toThrow("empty summary");
		expect(writes).toHaveLength(0);
	});
});
