import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
	chooseBoundary,
	estimateTokens,
	runCompaction,
	serializeSpan,
	type CompactionEvent,
	type CompactionStore,
} from "./compaction.ts";
import { attachmentPart } from "./attachments.ts";

const signal = () => new AbortController().signal;

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
	test("attachment summaries retain the stored path rather than saying unnamed", () => {
		const event = ev(1, "user", "please read this");
		event.message.parts.push(
			attachmentPart({
				path: "/workspace/attachments/a.pdf",
				filename: "a.pdf",
				mediaType: "application/pdf",
				size: 42,
			}),
		);
		expect(serializeSpan([event])).toContain("[attachment: /workspace/attachments/a.pdf]");
	});

	test("tool summaries retain bounded command and result evidence", () => {
		const event = ev(2, "assistant", "");
		event.message.parts.push({
			type: "tool-bash",
			toolCallId: "t1",
			state: "output-available",
			input: { command: "pwd" },
			output: "/workspace",
		} as UIMessage["parts"][number]);
		const text = serializeSpan([event]);
		expect(text).toContain("pwd");
		expect(text).toContain("/workspace");
	});
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

	test("an interleaved burst is atomic — the cut coarsens, never splits", () => {
		// u_b arrived while u_a's turn ran; a_a anchors to u_a. No seq
		// between them is a valid cut, so with a tiny budget the whole
		// burst is kept and there is nothing to compact.
		const burst = [
			ev(1, "user", "first question".repeat(200)),
			ev(2, "user", "queued follow-up".repeat(200)),
			ev(3, "assistant", "the answer".repeat(200), 1),
		];
		expect(chooseBoundary(burst, { tailTokenBudget: 1, previousBoundary: null })).toBeNull();
	});

	test("a tiny span is not worth compacting", () => {
		const detail = [ev(1, "user", "hi"), ev(2, "assistant", "yo", 1)];
		expect(chooseBoundary(detail, { tailTokenBudget: 1, previousBoundary: null })).toBeNull();
	});

	test("the minimum-span floor gates the delta, not total history", () => {
		// Previous boundary at seq 2 folded the two huge early events; the
		// delta since (seqs 3-4) is tiny. The floor must measure what would
		// actually be summarized — counting from index 0 would let
		// already-folded bulk pass a tiny delta through.
		const detail = [
			ev(1, "user", "old bulk".repeat(400)),
			ev(2, "assistant", "older bulk".repeat(400), 1),
			ev(3, "user", "hi"),
			ev(4, "assistant", "yo", 3),
			ev(5, "user", "pending question"),
		];
		expect(chooseBoundary(detail, { tailTokenBudget: 1, previousBoundary: 2 })).toBeNull();
	});
});

function fakeStore(
	detail: CompactionEvent[],
	previous: { boundarySeq: number; summary: string } | null = null,
) {
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
			{ tailTokenBudget: 1, inputTokenBudget: 32_000 },
			signal(),
		);
		expect(outcome.kind).toBe("compacted");
		if (outcome.kind !== "compacted") return;
		expect(outcome.boundarySeq).toBe(4);
		expect(outcome.summary).toBe("the folded summary");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]!.prompt).toContain("earlier era");
		expect(prompts[0]!.prompt).toContain("did it");
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			boundarySeq: 4,
			summary: "the folded summary",
			model: "zai/glm-5.3",
		});
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
				{ tailTokenBudget: 1, inputTokenBudget: 32_000 },
				signal(),
			),
		).rejects.toThrow("provider down");
		expect(writes).toHaveLength(0);
	});

	test("a summarizer that resolves after abort cannot publish a pointer", async () => {
		const { store, writes } = fakeStore(sample());
		const controller = new AbortController();
		await expect(
			runCompaction(
				"dm:1",
				store,
				"m",
				async () => {
					controller.abort();
					return "late summary";
				},
				{ tailTokenBudget: 1, inputTokenBudget: 32_000 },
				controller.signal,
			),
		).rejects.toThrow();
		expect(writes).toHaveLength(0);
	});

	test("a settings fence mid-summary cannot publish a pointer", async () => {
		// The abort signal never fires — only the epoch moves, exactly like
		// /memory while a summary call is in flight.
		const { store, writes } = fakeStore(sample());
		let revoked = false;
		await expect(
			runCompaction(
				"dm:1",
				store,
				"m",
				async () => {
					revoked = true; // the epoch bumps while the call is in flight
					return "late summary";
				},
				{
					tailTokenBudget: 1,
					inputTokenBudget: 32_000,
					assertAuthority: () => {
						if (revoked) throw new Error("turn fenced");
					},
				},
				signal(),
			),
		).rejects.toThrow("turn fenced");
		expect(writes).toHaveLength(0);
	});

	test("a fence that landed before the compaction starts spends nothing", async () => {
		const { store, writes } = fakeStore(sample());
		let calls = 0;
		await expect(
			runCompaction(
				"dm:1",
				store,
				"m",
				async () => {
					calls++;
					return "must not run";
				},
				{
					tailTokenBudget: 1,
					inputTokenBudget: 32_000,
					assertAuthority: () => {
						throw new Error("turn fenced");
					},
				},
				signal(),
			),
		).rejects.toThrow("turn fenced");
		expect(calls).toBe(0);
		expect(writes).toHaveLength(0);
	});

	test("an empty summary is a failure, not a silent wipe", async () => {
		const { store, writes } = fakeStore(sample());
		await expect(
			runCompaction(
				"dm:1",
				store,
				"m",
				async () => "  ",
				{ tailTokenBudget: 1, inputTokenBudget: 32_000 },
				signal(),
			),
		).rejects.toThrow("empty summary");
		expect(writes).toHaveLength(0);
	});

	test("re-compaction serializes only the delta, never the folded past", async () => {
		// The previous boundary stands at seq 4; exchanges 5-6 (seqs 7-10)
		// are new. The newest exchange always stays in the tail, so the fold
		// covers the delta 5..8 — and must NOT re-serialize events 1-4
		// already folded, or the call grows with TOTAL history and
		// eventually can't fit the window it exists to bound.
		const detail = [
			...sample(),
			ev(7, "user", "later question".repeat(200)),
			ev(8, "assistant", "later answer".repeat(200), 7),
			ev(9, "user", "newest question".repeat(200)),
			ev(10, "assistant", "newest answer".repeat(200), 9),
		];
		const { store, writes } = fakeStore(detail, { boundarySeq: 4, summary: "the early era" });
		const prompts: string[] = [];
		const outcome = await runCompaction(
			"dm:1",
			store,
			"m",
			async (_system, prompt) => {
				prompts.push(prompt);
				return "fold two";
			},
			{ tailTokenBudget: 1, inputTokenBudget: 32_000 },
			signal(),
		);
		expect(outcome.kind).toBe("compacted");
		if (outcome.kind !== "compacted") return;
		expect(outcome.boundarySeq).toBe(8);
		expect(outcome.eventsCompacted).toBe(4);
		expect(prompts[0]).toContain("the early era");
		expect(prompts[0]).toContain("later question");
		expect(prompts[0]).not.toContain("hello");
		expect(prompts[0]).not.toContain("newest question");
		expect(writes[0]).toMatchObject({ boundarySeq: 8, summary: "fold two" });
	});

	test("an oversized span folds through sequential calls inside the input budget", async () => {
		// Ten exchanges of ~200-token events; the tail keeps the last
		// exchange, so the span is 18 events — several chunks' worth at
		// the tiny input budget below.
		const detail: CompactionEvent[] = [];
		for (let i = 0; i < 10; i++) {
			const u = 2 * i + 1;
			detail.push(ev(u, "user", `question ${i} `.repeat(50)));
			detail.push(ev(u + 1, "assistant", `answer ${i} `.repeat(50), u));
		}
		const inputTokenBudget = 1_200;
		const { store, writes } = fakeStore(detail);
		const prompts: string[] = [];
		const outcome = await runCompaction(
			"dm:1",
			store,
			"m",
			async (_system, prompt) => {
				prompts.push(prompt);
				return `fold ${prompts.length}`;
			},
			{ tailTokenBudget: 1, inputTokenBudget },
			signal(),
		);
		expect(outcome.kind).toBe("compacted");
		// One call could never hold the span — the fold must be sequential.
		expect(prompts.length).toBeGreaterThan(1);
		// Every call honors the input budget by the same estimate the
		// chunker uses.
		for (const prompt of prompts) {
			expect(estimateTokens(prompt)).toBeLessThanOrEqual(inputTokenBudget);
		}
		// Each later call carries the previous call's output forward —
		// the running summary is the only memory between calls.
		for (let i = 1; i < prompts.length; i++) {
			expect(prompts[i]).toContain(`fold ${i}`);
			expect(prompts[i]).toContain("running summary of the earlier part of this span");
		}
		// The final call's output is the stored summary.
		expect(writes[0]!.summary).toBe(`fold ${prompts.length}`);
	});

	test("a single event bigger than the allowance is truncated, never dropped", async () => {
		const detail = [
			ev(1, "user", "z".repeat(20_000)),
			ev(2, "assistant", "ok", 1),
			ev(3, "user", "follow up".repeat(100)),
			ev(4, "assistant", "done".repeat(100), 3),
		];
		const { store } = fakeStore(detail);
		const prompts: string[] = [];
		await runCompaction(
			"dm:1",
			store,
			"m",
			async (_system, prompt) => {
				prompts.push(prompt);
				return "folded";
			},
			{ tailTokenBudget: 1, inputTokenBudget: 1_200 },
			signal(),
		);
		const all = prompts.join("\n");
		expect(all).toContain("chars truncated for summarization");
		// The truncated event still shows up — its head, not nothing.
		expect(all).toContain("zzz");
		// And its tail beyond the kept window did not leak into a prompt.
		expect(all).not.toContain("z".repeat(5_000));
	});

	test("a wedged summarizer still settles — the call timeout is an ordinary failure", async () => {
		const { store, writes } = fakeStore(sample());
		await expect(
			runCompaction(
				"dm:1",
				store,
				"m",
				// Ignores its abort signal entirely — the race, not the
				// model's good behavior, is what bounds the call.
				() => new Promise<string>(() => {}),
				{ tailTokenBudget: 1, inputTokenBudget: 32_000, callTimeoutMs: 50 },
				signal(),
			),
		).rejects.toThrow(/timed out/);
		expect(writes).toHaveLength(0);
	});
});
