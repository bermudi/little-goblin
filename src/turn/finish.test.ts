// Finish unit tests (design/runtime-turn.md → phase 6): the durable
// landing's boundary rules — the ownership-bounded anchor, the
// defiance guard, the window signal, retentionOpt's skip table, and
// the reviewer submission (snapshot, exclusion, prior-turn chain).
// The cross-phase net — a fenced turn never gates, shutdown fencing a
// held gate — stays e2e in runtime.test.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, UIMessage } from "ai";
import type { Conversation } from "../conversation.ts";
import { setLogFile } from "../log.ts";
import type { MemoryEligibility, MemoryTurnDeps, RetentionSource } from "../memory.ts";
import type { PriorTurnContext, ReviewerDeps } from "../reviewer.ts";
import { type LandDeps, landAttempt, retentionOpt, submitTurnReview } from "./finish.ts";

let dirs: string[] = [];
function tmpdirPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-finish-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Flush the fire-and-forget gate chain (decide → catch → finally).
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const conv = (epoch = 1, id = "dm:1"): Conversation => ({
	id,
	chatId: 1,
	threadId: null,
	title: null,
	titleImplicit: false,
	model: null,
	thinking: null,
	voice: false,
	memoryExcluded: false,
	persona: "personal",
	epoch,
	createdAt: "2026-01-01T00:00:00Z",
});

const msg = (id: string, role: "user" | "assistant", ...parts: UIMessage["parts"]): UIMessage =>
	parts.length === 0 ? { id, role, parts: [] } : { id, role, parts };

const text = (t: string) => ({ type: "text", text: t }) as const;

const elig: MemoryEligibility = { eligibleSeqs: new Set([1, 2, 3, 4, 5]), summaryEligible: false };

const source = (over: Partial<RetentionSource> = {}): RetentionSource => ({
	userTexts: [],
	userIds: [],
	priorContext: "",
	program: false,
	...over,
});

const logLines = (root: string): Record<string, unknown>[] =>
	readFileSync(join(root, "goblin.log"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);

// ---------- landAttempt ----------

interface LandHarness {
	landed: ReturnType<typeof landAttempt>;
	appended: { messages: UIMessage[]; opts: Parameters<LandDeps["append"]>[1] }[];
	deltas: string[];
}

function land(over: Partial<LandDeps> = {}): LandHarness {
	const appended: LandHarness["appended"] = [];
	const deltas: string[] = [];
	const deps: LandDeps = {
		convId: "dm:1",
		epoch: 2,
		conv: conv(),
		modelEntries: () => [
			{ seq: 1, message: msg("u1", "user", text("first")) },
			{ seq: 2, message: msg("a1", "assistant", text("earlier answer")) },
			{ seq: 3, message: msg("u2", "user", text("run it")) },
		],
		memoryEligibility: () => elig,
		append: (messages, opts) => {
			appended.push({ messages, opts });
		},
		memory: undefined,
		steerMark: 3,
		responseMessage: msg("a2", "assistant", text("done")),
		finishReason: "stop",
		usage: null,
		lastStepInputTokens: null,
		contextWindow: undefined,
		forcedKind: null,
		sink: {
			onTextDelta: (d) => {
				deltas.push(d);
			},
			onReasoningDelta() {},
			onToolCall() {},
		},
		...over,
	};
	return { landed: landAttempt(deps), appended, deltas };
}

describe("landAttempt", () => {
	test("anchors the reply to the newest owned user message and appends it", () => {
		const h = land({
			// Queued input above the ownership mark: durable, but this
			// turn never read it — it must not anchor the reply nor enter
			// the retention burst.
			modelEntries: () => [
				{ seq: 1, message: msg("u1", "user", text("first")) },
				{ seq: 2, message: msg("a1", "assistant", text("earlier")) },
				{ seq: 3, message: msg("u2", "user", text("run it")) },
				{ seq: 5, message: msg("u9", "user", text("arrived mid-turn, unsteered")) },
			],
			steerMark: 3,
		});
		expect(h.appended).toHaveLength(1);
		expect(h.appended[0]!.opts).toEqual({ anchorSeq: 3 });
		expect(h.appended[0]!.messages[0]!.parts).toEqual([text("done")]);
		expect(h.landed.done).toEqual({ kind: "completed" });
		expect(h.landed.reply?.id).toBe("a2");
		// The retention source reads the exchange as it ended, bounded
		// by the same mark.
		expect(h.landed.source.userTexts).toEqual(["run it"]);
	});

	test("no owned user message anchors null but still appends", () => {
		const h = land({
			modelEntries: () => [{ seq: 4, message: msg("a1", "assistant", text("carried")) }],
			steerMark: 4,
		});
		expect(h.appended[0]!.opts).toEqual({ anchorSeq: null });
	});

	test("no response message means no append — the done still lands", () => {
		const h = land({ responseMessage: null, forcedKind: "context" });
		expect(h.appended).toHaveLength(0);
		expect(h.deltas).toEqual([]);
		expect(h.landed.done).toEqual({ kind: "completed", forced: "context" });
	});

	test("window signal: last step input against the catalog limit, null when either is absent", () => {
		const h = land({ contextWindow: 1000, lastStepInputTokens: 250 });
		expect(h.landed.window).toEqual({ input: 250, limit: 1000, pct: 25 });
		expect(land({ contextWindow: 1000 }).landed.window).toBeNull();
		expect(land({ lastStepInputTokens: 250 }).landed.window).toBeNull();
	});

	test("the completion line and the ≥80% alarm ride the log", () => {
		const root = tmpdirPath();
		setLogFile(join(root, "goblin.log"));
		land({ contextWindow: 1000, lastStepInputTokens: 850, finishReason: "stop" });
		const lines = logLines(root);
		const done = lines.find((e) => e.msg === "turn completed");
		expect(done).toMatchObject({
			conversation: "dm:1",
			epoch: 2,
			finish: "stop",
			window: { input: 850, limit: 1000, pct: 85 },
		});
		expect(
			lines.some((e) => e.msg === "context window ≥80% — history is approaching the limit"),
		).toBe(true);
	});

	describe("the defiance guard", () => {
		test("a forced step that still ends in tool calls gets synthetic prose — stored, on the delta wire, stamped", () => {
			const h = land({
				forcedKind: "context",
				finishReason: "tool-calls",
				responseMessage: msg("a2", "assistant", { type: "step-start" }),
			});
			const parts = h.appended[0]!.messages[0]!.parts;
			const note = parts.at(-1);
			expect(note).toMatchObject({ type: "text" });
			expect((note as { text: string }).text).toContain(
				"My context window filled up before I wrote my answer",
			);
			// Telegram delivers text only through deltas — the note rides
			// the live path too, behind a block separator.
			expect(h.deltas).toHaveLength(1);
			expect(h.deltas[0]).toContain("My context window filled up");
			expect(h.landed.done).toEqual({ kind: "completed", forced: "context" });
		});

		test("a forced step with no prose gets the note too — worded for its landing", () => {
			const h = land({
				forcedKind: "repeat",
				finishReason: "stop",
				responseMessage: msg("a2", "assistant", text("   ")),
			});
			const parts = h.appended[0]!.messages[0]!.parts;
			expect((parts.at(-1) as { text: string }).text).toContain(
				"I got stuck repeating the same tool call",
			);
			expect(h.landed.done).toEqual({ kind: "completed", forced: "repeat" });
		});

		test("an unforced turn never gets the note", () => {
			const h = land({ forcedKind: null, finishReason: "tool-calls" });
			expect(h.appended[0]!.messages[0]!.parts).toEqual([text("done")]);
			expect(h.deltas).toEqual([]);
			expect(h.landed.done).toEqual({ kind: "completed" });
		});
	});
});

// ---------- retentionOpt ----------

const memDeps = (over: { suppressed?: boolean; unreadable?: boolean } = {}): MemoryTurnDeps =>
	({
		client: { target: "mem-target" },
		contexts: {
			isSuppressed: () => {
				if (over.unreadable) throw new Error("store unreadable");
				return over.suppressed ?? false;
			},
		},
		noteRecall: () => {},
	}) as unknown as MemoryTurnDeps;

describe("retentionOpt", () => {
	const reply = msg("a2", "assistant", text("done"));
	const src = source({ userTexts: ["run it"], userIds: ["u2"] });

	test("no memory deps, no anchor, or an excluded conversation → history alone", () => {
		expect(retentionOpt(conv(), undefined, 3, src, reply)).toBeNull();
		expect(retentionOpt(conv(), memDeps(), null, src, reply)).toBeNull();
		const excluded = conv();
		excluded.memoryExcluded = true;
		expect(retentionOpt(excluded, memDeps(), 3, src, reply)).toBeNull();
	});

	test("program housekeeping is never retained", () => {
		expect(retentionOpt(conv(), memDeps(), 3, source({ program: true }), reply)).toBeNull();
	});

	test("a blank assistant id fails open — no forged identity", () => {
		expect(retentionOpt(conv(), memDeps(), 3, src, msg("  ", "assistant", text("x")))).toBeNull();
	});

	test("an exchange with no text retains nothing", () => {
		const noText = retentionOpt(
			conv(),
			memDeps(),
			3,
			source(),
			msg("a2", "assistant", { type: "step-start" }),
		);
		expect(noText).toBeNull();
	});

	test("a suppressed document is skipped; an unreadable suppression store skips too", () => {
		expect(retentionOpt(conv(), memDeps({ suppressed: true }), 3, src, reply)).toBeNull();
		expect(retentionOpt(conv(), memDeps({ unreadable: true }), 3, src, reply)).toBeNull();
	});

	test("a text exchange schedules its document under the memory target", () => {
		const opt = retentionOpt(conv(), memDeps(), 3, src, reply);
		expect(opt?.target).toBe("mem-target");
		expect(opt?.document.id).toBe("exchange/dm:1/3/a2");
		expect(opt?.document.content).toContain("Operator: run it");
		expect(opt?.document.content).toContain("Goblin: done");
	});
});

// ---------- submitTurnReview ----------

const digest = { tool: "bash", args: "{}", result: "listed", ok: true };

function reviewerStub(decide?: ReviewerDeps["gate"]["decide"]): ReviewerDeps {
	return {
		gate: { decide: decide ?? (async () => ({ answers: {}, inputTokens: null, cost: null })) },
		thresholds: { correction: 0.8, procedure: 0.8 },
		queueCap: 3,
		evidence: { calls: 8, argChars: 300, outChars: 300 },
		reviewModel: async () => {
			throw new Error("must not review");
		},
		store: { append() {} },
		skillsDir: "/none",
		workspaceDir: "/none",
		notify: async () => {},
	};
}

interface ReviewHarness {
	// The reviewer rides each submit — undefined is itself the case
	// under test (the feature off), so it cannot default through ??.
	submit(reviewer?: ReviewerDeps): void;
	submitWithReviewer(reviewer: ReviewerDeps | undefined): void;
	state: {
		excluded: boolean;
		seq: number;
		prior: PriorTurnContext | undefined;
		forgotten: number;
		remembered: PriorTurnContext[];
	};
}

function reviewHarness(over: { reviewer?: ReviewerDeps } = {}): ReviewHarness {
	const state: ReviewHarness["state"] = {
		excluded: false,
		seq: 0,
		prior: undefined,
		forgotten: 0,
		remembered: [],
	};
	const submitWithReviewer = (reviewer: ReviewerDeps | undefined) => {
		submitTurnReview({
			convId: "dm:1",
			reviewer,
			memoryExcluded: () => state.excluded,
			nextTurnSeq: () => ++state.seq,
			priorTurn: () => state.prior,
			rememberTurn: (prior) => {
				state.prior = prior;
				state.remembered.push(prior);
			},
			forgetTurn: () => {
				state.prior = undefined;
				state.forgotten++;
			},
			source: source({ userTexts: ["run it"] }),
			reply: msg("a2", "assistant", text("done")),
			toolCalls: ["bash"],
			digestRing: [{ id: "c1", entry: digest }],
		});
	};
	const submit = (reviewer?: ReviewerDeps) =>
		submitWithReviewer(reviewer ?? over.reviewer ?? reviewerStub());
	return { submit, submitWithReviewer, state };
}

describe("submitTurnReview", () => {
	test("a completed turn gates its snapshot — operator burst, reply, tool names", async () => {
		const states: unknown[] = [];
		const h = reviewHarness({
			reviewer: reviewerStub(async (state) => {
				states.push(state);
				return { answers: {}, inputTokens: null, cost: null };
			}),
		});
		h.submit();
		await tick();
		expect(states).toHaveLength(1);
		expect(states[0] as string).toContain("run it");
		expect(states[0] as string).toContain("done");
		expect(states[0] as string).toContain("tools: bash (1 total)");
		expect(h.state.remembered).toEqual([
			{ operatorTexts: ["run it"], replyText: "done", toolDigest: [digest] },
		]);
	});

	test("fire-and-forget: the chain advances before the gate resolves", async () => {
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		const h = reviewHarness({
			reviewer: reviewerStub(async () => {
				await held;
				return { answers: {}, inputTokens: null, cost: null };
			}),
		});
		h.submit();
		// Off-lane by shape: the submission returns and the prior-turn
		// chain is already updated while the gate is still deciding.
		expect(h.state.remembered).toHaveLength(1);
		expect(h.state.seq).toBe(1);
		release();
		await tick();
	});

	test("a memory-excluded turn never gates — the chain breaks and the skip logs", async () => {
		const root = tmpdirPath();
		setLogFile(join(root, "goblin.log"));
		const h = reviewHarness({
			reviewer: reviewerStub(async () => {
				throw new Error("memory-excluded turns must never gate");
			}),
		});
		h.state.excluded = true;
		h.submit();
		await tick();
		expect(h.state.seq).toBe(0); // no counter spent
		expect(h.state.forgotten).toBe(1);
		const skipped = logLines(root).find((e) => e.msg === "reviewer skipped — memory excluded");
		expect(skipped).toMatchObject({ conversation: "dm:1" });
	});

	test("exclusion is read at completion — flipping it between turns skips the next review", async () => {
		let gated = 0;
		const h = reviewHarness({
			reviewer: reviewerStub(async () => {
				gated++;
				return { answers: {}, inputTokens: null, cost: null };
			}),
		});
		h.submit();
		await tick();
		expect(gated).toBe(1);
		h.state.excluded = true;
		h.submit();
		await tick();
		expect(gated).toBe(1);
		expect(h.state.forgotten).toBe(1);
	});

	test("reviewer absent touches nothing", () => {
		const h = reviewHarness();
		h.submitWithReviewer(undefined);
		expect(h.state.seq).toBe(0);
		expect(h.state.remembered).toHaveLength(0);
	});

	test("a throwing gate reaches the backstop line, not the caller", async () => {
		const root = tmpdirPath();
		setLogFile(join(root, "goblin.log"));
		const h = reviewHarness({
			reviewer: reviewerStub(async () => {
				throw new Error("gate exploded");
			}),
		});
		h.submit();
		await tick();
		const failed = logLines(root).find((e) => e.msg === "reviewer failed");
		expect(failed).toMatchObject({ conversation: "dm:1" });
	});

	// The full review path, faked only at the model provider: a fired
	// gate runs a real review over the staging workspace, so the
	// snapshot's digest and the prior-turn chain are asserted where
	// they land — the review model's prompt.
	function reviewCaptureHarness() {
		const root = tmpdirPath();
		const workspace = join(root, "ws");
		const skills = join(workspace, "skills");
		mkdirSync(skills, { recursive: true });
		const prompts: string[] = [];
		const reviewModel = {
			specificationVersion: "v4",
			provider: "fake",
			modelId: "fake-review",
			supportedUrls: {},
			doGenerate: async (options: unknown) => {
				prompts.push(JSON.stringify((options as { prompt?: unknown }).prompt ?? null));
				return {
					content: [{ type: "text", text: "nothing worth saving" }],
					finishReason: { unified: "stop", raw: undefined },
					usage: {
						inputTokens: {
							total: 1,
							noCache: undefined,
							cacheRead: undefined,
							cacheWrite: undefined,
						},
						outputTokens: { total: 1, text: undefined, reasoning: undefined },
					},
					warnings: [],
				};
			},
			doStream: () => {
				throw new Error("unimplemented");
			},
		} as unknown as LanguageModel;
		return { root, workspace, skills, prompts, reviewModel };
	}

	async function awaitPrompt(prompts: string[]): Promise<void> {
		for (let i = 0; i < 500 && prompts.length === 0; i++) await sleep(2);
	}

	test("the turn's tool digest reaches the review payload", async () => {
		const cap = reviewCaptureHarness();
		const h = reviewHarness({
			reviewer: {
				...reviewerStub(),
				gate: {
					decide: async () => ({
						answers: { correction: 0, procedure: 0.99 },
						inputTokens: 1,
						cost: 0,
					}),
				},
				reviewModel: async () => ({ ref: "fake/review", model: cap.reviewModel }),
				store: { append() {} },
				skillsDir: cap.skills,
				workspaceDir: cap.workspace,
				skillsRefBin: join(cap.root, "nonexistent-skills-ref"),
			},
		});
		h.submit();
		await awaitPrompt(cap.prompts);
		expect(cap.prompts).toHaveLength(1);
		expect(cap.prompts[0]).toContain("- bash — ok");
		expect(cap.prompts[0]).toContain("listed");
		expect(cap.prompts[0]).toContain("run it");
	});

	test("the prior turn rides as the correction's evidence", async () => {
		const cap = reviewCaptureHarness();
		let decide: ReviewerDeps["gate"]["decide"] = async () => ({
			answers: {},
			inputTokens: null,
			cost: null,
		});
		const reviewer: ReviewerDeps = {
			...reviewerStub(),
			gate: { decide: (state, questions) => decide(state, questions) },
			reviewModel: async () => ({ ref: "fake/review", model: cap.reviewModel }),
			store: { append() {} },
			skillsDir: cap.skills,
			workspaceDir: cap.workspace,
			skillsRefBin: join(cap.root, "nonexistent-skills-ref"),
		};
		const h = reviewHarness({ reviewer });
		// Turn 1: quiet answer, remembered as the chain's head.
		h.submit();
		await tick();
		expect(cap.prompts).toHaveLength(0);
		// Turn 2: a correction — the remembered turn is the evidence.
		decide = async () => ({ answers: { correction: 0.9, procedure: 0 }, inputTokens: 1, cost: 0 });
		h.submit();
		await awaitPrompt(cap.prompts);
		expect(cap.prompts).toHaveLength(1);
		expect(cap.prompts[0]).toContain("The turn this correction refers back to:");
		expect(cap.prompts[0]).toContain("done");
	});
});
