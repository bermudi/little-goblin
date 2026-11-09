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

// A fake summary that passes the quality audit: the required headings, with
// the prompt's last operator line echoed under Pending user asks.
function passing(text: string, prompt: string): string {
	const ask = [...prompt.matchAll(/^user: ([^[].*)$/gm)].at(-1)?.[1]?.slice(0, 200) ?? "";
	return `${text}\n## Decisions\n## Open TODOs\n## Constraints/Rules\n## Pending user asks\n${ask}\n## Exact identifiers`;
}

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

// Three complete exchanges: u/a pairs with the assistant anchored to
// its user event.
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
	test("an oversized exchange past the tail budget still folds instead of noop", () => {
		// Real shape (2026-11-08): one tool-heavy turn of ~110k tokens
		// after the previous boundary, then a small exchange. The walk
		// used to swallow the giant exchange into the tail and land the
		// cut on the previous boundary.
		const detail = [
			ev(1, "user", "old".repeat(200)),
			ev(2, "assistant", "old reply".repeat(200), 1),
			ev(3, "user", "research it"),
			ev(4, "assistant", "x".repeat(400_000), 3),
			ev(5, "user", "follow up"),
			ev(6, "assistant", "short", 5),
		];
		expect(chooseBoundary(detail, { tailTokenBudget: 30_000, previousBoundary: 2 })).toBe(4);
	});

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

	test("a voice transcript rides into the serialized span — spoken words are not dropped at the cut", () => {
		const event = ev(1, "user", "here is a voice note");
		event.message.parts.push(
			attachmentPart({
				path: "/workspace/attachments/ogg-u1.oga",
				filename: "voice.oga",
				mediaType: "audio/ogg",
				size: 1024,
				speech: true,
				transcript: "water the fern before friday, and reply to Marta",
			}),
		);
		expect(serializeSpan([event])).toContain("water the fern before friday, and reply to Marta");
	});

	test("a video-note transcript rides into the serialized span too", () => {
		const event = ev(1, "user", "");
		event.message.parts.push(
			attachmentPart({
				path: "/workspace/attachments/mp4-u2.mp4",
				filename: "note.mp4",
				mediaType: "video/mp4",
				size: 4096,
				speech: true,
				transcript: "the garage code changed to 4471",
			}),
		);
		const text = serializeSpan([event]);
		expect(text).toContain("the garage code changed to 4471");
		// The path stays too — continuity of the file reference.
		expect(text).toContain("/workspace/attachments/mp4-u2.mp4");
	});

	test("an attachment with no transcript keeps the bare path reference", () => {
		const event = ev(1, "user", "please read this");
		event.message.parts.push(
			attachmentPart({
				path: "/workspace/attachments/report.pdf",
				filename: "report.pdf",
				mediaType: "application/pdf",
				size: 42,
			}),
		);
		expect(serializeSpan([event])).toContain("[attachment: /workspace/attachments/report.pdf]");
		expect(serializeSpan([event])).not.toContain("transcript");
	});
	test("the cut lands at a completed exchange — no anchored response is orphaned", () => {
		// Boundary = the assistant closing the second exchange; one earlier
		// would strand a2 from u2 while u3/a3 stay whole.
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

	test("beforeSeq keeps the active exchange out of the fold — queued input, running request", () => {
		// P1 regression (review 2026-10-25): an input queued behind a
		// non-streaming turn is durable history with no reply yet. Alone it
		// dwarfs the tail budget, so the unconstrained walk breaks with the
		// boundary AT the running turn's user event — the reply would then
		// land anchored at that boundary and drop out of the model view,
		// unseen by the summary. The ceiling folds completed history only.
		const live = ev(7, "user", "run the probe".repeat(200));
		const queued = ev(8, "user", "y".repeat(4_000));
		const detail = [...sample(), live, queued];
		// Unconstrained: the queued bulk pushes the boundary onto the live
		// exchange's user event.
		expect(chooseBoundary(detail, { tailTokenBudget: 1, previousBoundary: null })).toBe(7);
		// Constrained: the fold stops below the active exchange — the live
		// request and the queued input both stay in the tail.
		expect(
			chooseBoundary(detail, { tailTokenBudget: 1, previousBoundary: null, beforeSeq: 7 }),
		).toBe(4);
		// Nothing completed left to fold stands down entirely.
		expect(
			chooseBoundary(detail, { tailTokenBudget: 1, previousBoundary: 4, beforeSeq: 7 }),
		).toBeNull();
		// A null ceiling is the unconstrained walk — unchanged semantics.
		expect(
			chooseBoundary(detail, { tailTokenBudget: 1, previousBoundary: null, beforeSeq: null }),
		).toBe(7);
	});

	test("re-compaction stops at the previous boundary — nothing new to fold", () => {
		expect(chooseBoundary(sample(), { tailTokenBudget: 1, previousBoundary: 4 })).toBeNull();
	});

	test("an interleaved burst is atomic — the cut coarsens, never splits", () => {
		// u_b arrived mid-turn; a_a anchors to u_a — no seq between them is
		// a valid cut, so the whole burst is kept.
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
		// The floor must measure what would actually be summarized —
		// counting from index 0 would let already-folded bulk pass a tiny
		// delta through.
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
			["zai/glm-5.3"],
			async (system, prompt) => {
				prompts.push({ system, prompt });
				return passing("the folded summary", prompt);
			},
			{ tailTokenBudget: 1, inputTokenBudget: 32_000 },
			signal(),
		);
		expect(outcome.kind).toBe("compacted");
		if (outcome.kind !== "compacted") return;
		expect(outcome.boundarySeq).toBe(4);
		expect(outcome.summary).toStartWith("the folded summary");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]!.prompt).toContain("earlier era");
		expect(prompts[0]!.prompt).toContain("did it");
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			boundarySeq: 4,
			model: "zai/glm-5.3",
		});
	});

	test("beforeSeq keeps the active exchange and queued input out of the fold", async () => {
		// P1 regression (review 2026-10-25): the fold must summarize
		// completed history only. A running turn's user event and an input
		// queued behind it never enter the span, the summary, or the
		// pointer — the landing reply would otherwise anchor at or below
		// the boundary and vanish from the model view.
		const detail = [
			...sample(),
			ev(7, "user", "run the probe".repeat(200)),
			ev(8, "user", "y".repeat(4_000)),
		];
		const { store, writes } = fakeStore(detail);
		const prompts: string[] = [];
		const outcome = await runCompaction(
			"dm:1",
			store,
			["m"],
			async (_system, prompt) => {
				prompts.push(prompt);
				return passing("folded", prompt);
			},
			{ tailTokenBudget: 1, inputTokenBudget: 32_000, beforeSeq: () => 7 },
			signal(),
		);
		expect(outcome).toMatchObject({ kind: "compacted", boundarySeq: 4 });
		expect(prompts.join("\n")).not.toContain("run the probe");
		expect(prompts.join("\n")).not.toContain("yyyy");
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ boundarySeq: 4 });
	});

	test("spoken instructions survive into the summarizer prompt — the loss precedes any model judgment", async () => {
		// If serialization drops the transcript, no summarizer can
		// preserve it.
		const detail = [
			ev(1, "user", "here is a voice note".repeat(50)),
			ev(2, "assistant", "got it".repeat(200), 1),
			ev(3, "user", "do a thing".repeat(200)),
			ev(4, "assistant", "did it".repeat(200), 3),
			ev(5, "user", "and now".repeat(200)),
			ev(6, "assistant", "done".repeat(200), 5),
		];
		detail[0]!.message.parts.push(
			attachmentPart({
				path: "/workspace/attachments/ogg-u1.oga",
				filename: "voice.oga",
				mediaType: "audio/ogg",
				size: 1024,
				speech: true,
				transcript: "water the fern before friday, and reply to Marta",
			}),
		);
		const { store } = fakeStore(detail);
		const prompts: string[] = [];
		await runCompaction(
			"dm:1",
			store,
			["m"],
			async (_system, prompt) => {
				prompts.push(prompt);
				return passing("folded", prompt);
			},
			{ tailTokenBudget: 1, inputTokenBudget: 32_000 },
			signal(),
		);
		expect(prompts.join("\n")).toContain("water the fern before friday, and reply to Marta");
	});

	test("a summarizer failure propagates and writes nothing", async () => {
		const { store, writes } = fakeStore(sample());
		await expect(
			runCompaction(
				"dm:1",
				store,
				["m"],
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
				["m"],
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
		// The abort never fires — only the epoch moves, like /memory
		// mid-summary.
		const { store, writes } = fakeStore(sample());
		let revoked = false;
		await expect(
			runCompaction(
				"dm:1",
				store,
				["m"],
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
				["m"],
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
				["m"],
				async () => "  ",
				{ tailTokenBudget: 1, inputTokenBudget: 32_000 },
				signal(),
			),
		).rejects.toThrow("empty summary");
		expect(writes).toHaveLength(0);
	});

	test("re-compaction serializes only the delta, never the folded past", async () => {
		// The fold must cover only the delta — re-serializing already-folded
		// events would grow the call with total history.
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
			["m"],
			async (_system, prompt) => {
				prompts.push(prompt);
				return passing("fold two", prompt);
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
		expect(writes[0]).toMatchObject({ boundarySeq: 8 });
		expect(writes[0]!.summary).toStartWith("fold two");
	});

	test("an oversized span folds through sequential calls inside the input budget", async () => {
		// 10 exchanges; the tail keeps the last → an 18-event span,
		// several chunks at this budget.
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
			["m"],
			async (_system, prompt) => {
				prompts.push(prompt);
				return passing(`fold ${prompts.length}`, prompt);
			},
			{ tailTokenBudget: 1, inputTokenBudget },
			signal(),
		);
		expect(outcome.kind).toBe("compacted");
		// One call could never hold the span — the fold must be sequential.
		expect(prompts.length).toBeGreaterThan(1);
		// Each call honors the budget by the chunker's own estimate.
		for (const prompt of prompts) {
			expect(estimateTokens(prompt)).toBeLessThanOrEqual(inputTokenBudget);
		}
		// Each call carries the previous call's output forward — the
		// running summary is the only memory between calls.
		for (let i = 1; i < prompts.length; i++) {
			expect(prompts[i]).toContain(`fold ${i}`);
			expect(prompts[i]).toContain("running summary of the earlier part of this span");
		}
		// The final call's output is the stored summary.
		expect(writes[0]!.summary).toStartWith(`fold ${prompts.length}\n`);
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
			["m"],
			async (_system, prompt) => {
				prompts.push(prompt);
				return passing("folded", prompt);
			},
			{ tailTokenBudget: 1, inputTokenBudget: 1_200 },
			signal(),
		);
		const all = prompts.join("\n");
		expect(all).toContain("chars truncated for summarization");
		// The truncated event still shows its head.
		expect(all).toContain("zzz");
		// Its tail beyond the kept window must not leak into a prompt.
		expect(all).not.toContain("z".repeat(5_000));
	});

	test("a wedged summarizer still settles — the call timeout is an ordinary failure", async () => {
		const { store, writes } = fakeStore(sample());
		await expect(
			runCompaction(
				"dm:1",
				store,
				["m"],
				// Ignores its abort — the race, not the model's good
				// behavior, bounds the call.
				() => new Promise<string>(() => {}),
				{ tailTokenBudget: 1, inputTokenBudget: 32_000, callTimeoutMs: 50 },
				signal(),
			),
		).rejects.toThrow(/timed out/);
		expect(writes).toHaveLength(0);
	});
});

// A call and its result are parts of one event and the boundary is
// always an event edge — compaction cannot orphan a tool result.
// toolEvent mirrors the persisted shape stream.ts writes.
function toolEvent(
	seq: number,
	anchorSeq: number,
	text: string,
	calls: { id: string; input: Record<string, string>; output: string }[],
): CompactionEvent {
	const event = ev(seq, "assistant", text, anchorSeq);
	for (const c of calls) {
		event.message.parts.push({
			type: "tool-bash",
			toolCallId: c.id,
			state: "output-available",
			input: c.input,
			output: c.output,
		} as UIMessage["parts"][number]);
	}
	return event;
}

function toolHistory(): CompactionEvent[] {
	return [
		ev(1, "user", "run the deploy check".repeat(100)),
		toolEvent(2, 1, "checking", [
			{ id: "t1", input: { command: "bun run typecheck" }, output: "ok" },
			{ id: "t2", input: { command: "systemctl --user status goblin" }, output: "active" },
		]),
		ev(3, "user", "and the app?".repeat(100)),
		toolEvent(4, 3, "checking app", [
			{ id: "t3", input: { command: "bun run app:build" }, output: "built" },
		]),
		ev(5, "user", "pending question".repeat(100)),
	];
}

describe("tool-call atomicity across the cut", () => {
	test("every cut is an event edge — a tool-bearing message is never bisected", () => {
		const detail = toolHistory();
		const seqs = new Set(detail.map((e) => e.seq));
		for (const budget of [1, 5, 20, 100, 1_000, 100_000]) {
			const boundary = chooseBoundary(detail, {
				tailTokenBudget: budget,
				previousBoundary: null,
			});
			if (boundary === null) continue;
			expect(seqs.has(boundary), `budget ${budget}`).toBe(true);
		}
	});

	test("the summarized span keeps every tool call next to its result", async () => {
		// Input AND output must reach the prompt together — a call
		// stripped of its result would let the summary invent an outcome.
		const { store } = fakeStore(toolHistory());
		const prompts: string[] = [];
		const outcome = await runCompaction(
			"dm:1",
			store,
			["m"],
			async (_system, prompt) => {
				prompts.push(prompt);
				return passing("folded", prompt);
			},
			{ tailTokenBudget: 1, inputTokenBudget: 32_000 },
			signal(),
		);
		expect(outcome.kind).toBe("compacted");
		const span = prompts.join("\n");
		for (const [command, result] of [
			["bun run typecheck", "ok"],
			["systemctl --user status goblin", "active"],
			["bun run app:build", "built"],
		] as const) {
			expect(span).toContain(command);
			expect(span).toContain(result);
		}
	});
});

describe("opaque reasoning state", () => {
	// The codex namespace's encrypted reasoning is provider state, not
	// visible content — its size must not move the cut or the span
	// estimate, or a cipher-heavy turn compact-storms on its own state.
	const ciphered = (cipher: string): CompactionEvent[] => {
		const detail = sample();
		detail[1] = {
			seq: 2,
			anchorSeq: 1,
			message: {
				id: "m2",
				role: "assistant",
				parts: [
					{
						type: "reasoning",
						text: "",
						providerMetadata: {
							codex: {
								itemId: "rs_1",
								replayScope: "s1",
								reasoningEncryptedContent: cipher,
							},
						},
					},
					{ type: "text", text: "hi there".repeat(200) },
				],
			},
		};
		return detail;
	};

	test("the cut and the span estimate are invariant to cipher size", async () => {
		const small = ciphered("");
		const huge = ciphered("x".repeat(60_000));
		expect(chooseBoundary(huge, { tailTokenBudget: 1, previousBoundary: null })).toBe(
			chooseBoundary(small, { tailTokenBudget: 1, previousBoundary: null }),
		);
		const summarize = async (_s: string, prompt: string) => passing("folded", prompt);
		const a = fakeStore(small);
		const b = fakeStore(huge);
		const opts = { tailTokenBudget: 1, inputTokenBudget: 32_000 };
		const outA = await runCompaction("dm:1", a.store, ["m"], summarize, opts, signal());
		const outB = await runCompaction("dm:1", b.store, ["m"], summarize, opts, signal());
		expect(outA.kind).toBe("compacted");
		expect(outB.kind).toBe("compacted");
		if (outA.kind !== "compacted" || outB.kind !== "compacted") return;
		expect(outA.boundarySeq).toBe(outB.boundarySeq);
		expect(outA.tokensBefore).toBe(outB.tokensBefore);
	});

	test("only the codex namespace is exempt — foreign cipher still counts", async () => {
		const foreign = ciphered("");
		(foreign[1]!.message.parts[0] as { providerMetadata: unknown }).providerMetadata = {
			otherProvider: { reasoningEncryptedContent: "x".repeat(60_000) },
		};
		// 60k chars of non-codex state is ordinary serialized bulk — it
		// lands in tokensBefore where the codex cipher did not.
		const summarize = async (_s: string, prompt: string) => passing("folded", prompt);
		const opts = { tailTokenBudget: 1, inputTokenBudget: 32_000 };
		const codexOut = await runCompaction(
			"dm:1",
			fakeStore(ciphered("x".repeat(60_000))).store,
			["m"],
			summarize,
			opts,
			signal(),
		);
		const foreignOut = await runCompaction(
			"dm:1",
			fakeStore(foreign).store,
			["m"],
			summarize,
			opts,
			signal(),
		);
		if (codexOut.kind !== "compacted" || foreignOut.kind !== "compacted") {
			throw new Error("expected both spans to fold");
		}
		expect(foreignOut.tokensBefore - codexOut.tokensBefore).toBeGreaterThan(10_000);
	});
});

// The summarizer's fallback walk (design/model.md → Model fallback list
// → Compaction): each candidate gets its own call timeout, the walk is
// sticky within a pass, and the pointer names who wrote it.
describe("runCompaction — fallback walk", () => {
	const longSpan = (): CompactionEvent[] => {
		const detail: CompactionEvent[] = [];
		for (let i = 0; i < 10; i++) {
			const u = 2 * i + 1;
			detail.push(ev(u, "user", `question ${i} `.repeat(50)));
			detail.push(ev(u + 1, "assistant", `answer ${i} `.repeat(50), u));
		}
		return detail;
	};

	test("a wedged primary times out alone — the fallback gets a live signal and writes the pointer", async () => {
		const { store, writes } = fakeStore(sample());
		const signals: Array<{ model: string; abortedAtStart: boolean }> = [];
		const outcome = await runCompaction(
			"dm:1",
			store,
			["zai/glm-5.3", "codex/gpt-6.1-terra"],
			(_system, prompt, callSignal, model) => {
				signals.push({ model, abortedAtStart: callSignal.aborted });
				// The primary ignores its abort — only the attempt's own
				// timeout can end it.
				if (model === "zai/glm-5.3") return new Promise<string>(() => {});
				return Promise.resolve(passing("folded by the fallback", prompt));
			},
			{ tailTokenBudget: 1, inputTokenBudget: 32_000, callTimeoutMs: 50 },
			signal(),
		);
		expect(outcome).toMatchObject({ kind: "compacted" });
		if (outcome.kind === "compacted") expect(outcome.summary).toStartWith("folded by the fallback");
		expect(signals).toEqual([
			{ model: "zai/glm-5.3", abortedAtStart: false },
			{ model: "codex/gpt-6.1-terra", abortedAtStart: false },
		]);
		// Provenance is the serving ref, not the conversation's model.
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ model: "codex/gpt-6.1-terra" });
	});

	test("a candidate that failed a chunk is not retried on later chunks", async () => {
		const { store, writes } = fakeStore(longSpan());
		const asked: string[] = [];
		const outcome = await runCompaction(
			"dm:1",
			store,
			["a/primary", "b/backup"],
			async (_system, prompt, _signal, model) => {
				asked.push(model);
				if (model === "a/primary") throw new Error("server_is_overloaded");
				return passing(`fold ${asked.length}`, prompt);
			},
			{ tailTokenBudget: 1, inputTokenBudget: 1_200 },
			signal(),
		);
		expect(outcome.kind).toBe("compacted");
		// Several chunks, one primary attempt.
		expect(asked.length).toBeGreaterThan(2);
		expect(asked.filter((m) => m === "a/primary")).toEqual(["a/primary"]);
		expect(asked[0]).toBe("a/primary");
		expect(writes[0]).toMatchObject({ model: "b/backup" });
	});

	test("every candidate failing names each miss once, and nothing is written", async () => {
		const { store, writes } = fakeStore(sample());
		await expect(
			runCompaction(
				"dm:1",
				store,
				["a/primary", "b/backup"],
				async (_system, _prompt, _signal, model) => {
					throw new Error(`down: ${model}`);
				},
				{ tailTokenBudget: 1, inputTokenBudget: 32_000 },
				signal(),
			),
		).rejects.toThrow("every model failed — a/primary: down: a/primary; b/backup: down: b/backup");
		expect(writes).toHaveLength(0);
	});

	test("a parent abort never advances the walk", async () => {
		const { store, writes } = fakeStore(sample());
		const controller = new AbortController();
		const asked: string[] = [];
		await expect(
			runCompaction(
				"dm:1",
				store,
				["a/primary", "b/backup"],
				(_system, _prompt, _signal, model) => {
					asked.push(model);
					controller.abort(new Error("stopped"));
					return new Promise<string>(() => {});
				},
				{ tailTokenBudget: 1, inputTokenBudget: 32_000, callTimeoutMs: 5_000 },
				controller.signal,
			),
		).rejects.toThrow("stopped");
		expect(asked).toEqual(["a/primary"]);
		expect(writes).toHaveLength(0);
	});
});

describe("summary contents (design/compaction.md → The summary)", () => {
	const opts = { tailTokenBudget: 1, inputTokenBudget: 32_000 };
	// Clears the fold's 500-token minimum span.
	const pad = " filler".repeat(400);

	test("a summary missing its headings retries with a correction, then lands", async () => {
		const { store, writes } = fakeStore(sample());
		const prompts: string[] = [];
		const outcome = await runCompaction(
			"dm:1",
			store,
			["m"],
			async (_s, prompt) => {
				prompts.push(prompt);
				return prompts.length === 1 ? "free prose" : passing("fixed", prompt);
			},
			opts,
			signal(),
		);
		expect(outcome.kind).toBe("compacted");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("failed the quality check");
		expect(prompts[1]).toContain("missing section ## Pending user asks");
		expect(writes[0]!.summary).toStartWith("fixed");
	});

	test("a summary still failing after two retries writes nothing", async () => {
		const { store, writes } = fakeStore(sample());
		let calls = 0;
		await expect(
			runCompaction(
				"dm:1",
				store,
				["m"],
				async () => {
					calls++;
					return "free prose";
				},
				opts,
				signal(),
			),
		).rejects.toThrow("quality audit");
		expect(calls).toBe(3);
		expect(writes).toHaveLength(0);
	});

	test("a summary that drops the latest operator request fails the audit", async () => {
		const detail = [
			ev(1, "user", "rename the backup bucket to herbert-archive"),
			ev(2, "assistant", `on it${pad}`, 1),
			ev(3, "user", "next"),
			ev(4, "assistant", "ok", 3),
		];
		const { store, writes } = fakeStore(detail);
		const headingsOnly =
			"## Decisions\n## Open TODOs\n## Constraints/Rules\n## Pending user asks\nnothing\n## Exact identifiers";
		await expect(
			runCompaction("dm:1", store, ["m"], async () => headingsOnly, opts, signal()),
		).rejects.toThrow("latest operator request");
		expect(writes).toHaveLength(0);
	});

	test("operator words and identifiers survive a later fold verbatim, machinery and resumes do not count", async () => {
		const first = [
			ev(1, "user", "don't drop Herbert from the invite list, ever"),
			ev(2, "assistant", "noted — see https://example.test/invites and /srv/lists/invite.txt", 1),
			ev(3, "user", "[program: digest · trigger: daily]"),
			ev(4, "assistant", `digest sent${pad}`, 3),
			{
				seq: 5,
				anchorSeq: null,
				message: {
					id: "r",
					role: "user",
					metadata: { goblinResume: { sourceRunId: "run-1" } },
					parts: [{ type: "text", text: "[operator resumed interrupted run run-1]" }],
				},
			} satisfies CompactionEvent,
			ev(6, "assistant", "resumed", 5),
			ev(7, "user", "thanks"),
			ev(8, "assistant", "sure", 7),
		];
		const a = fakeStore(first);
		const summarizer = async (_s: string, prompt: string) => passing("model text", prompt);
		await runCompaction("dm:1", a.store, ["m"], summarizer, opts, signal());
		const stored = a.writes[0]!.summary;
		expect(stored).toContain(JSON.stringify("don't drop Herbert from the invite list, ever"));
		expect(stored).toContain("https://example.test/invites");
		expect(stored).toContain("/srv/lists/invite.txt");
		expect(stored).not.toContain(JSON.stringify("[program: digest · trigger: daily]"));
		expect(stored).not.toContain(JSON.stringify("[operator resumed interrupted run run-1]"));

		// Second fold: the model only ever sees the model text; the code
		// carries the quote and identifiers forward untouched.
		const second = [
			...first,
			ev(9, "user", "now book the room"),
			ev(10, "assistant", `booked${pad}`, 9),
			ev(11, "user", "bye"),
			ev(12, "assistant", "bye", 11),
		];
		const b = fakeStore(second, { boundarySeq: a.writes[0]!.boundarySeq, summary: stored });
		const prompts: string[] = [];
		await runCompaction(
			"dm:1",
			b.store,
			["m"],
			async (_s, prompt) => {
				prompts.push(prompt);
				return passing("model text two", prompt);
			},
			opts,
			signal(),
		);
		expect(prompts[0]).not.toContain("code-made");
		const restored = b.writes[0]!.summary;
		expect(restored).toContain(JSON.stringify("don't drop Herbert from the invite list, ever"));
		expect(restored).toContain("/srv/lists/invite.txt");
		// Newest first.
		expect(restored.indexOf("now book the room")).toBeLessThan(restored.indexOf("Herbert"));
	});
});
