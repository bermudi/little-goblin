import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { Conversation } from "../conversation-read.ts";
import {
	ContextOverflowError,
	compactTriggerTokens,
	failureFromStream,
	type OverflowDeps,
	overflowHoldable,
	PreemptCompactError,
	preemptArm,
	recoverFromOverflow,
	type StreamFailure,
	type TurnRecovery,
	terminalFailureMessage,
} from "./overflow.ts";
import type { LoopTurnState } from "./state.ts";
import type { LiveChunks } from "./stream.ts";

const conv = (epoch: number, id = "dm:1"): Conversation => ({
	id,
	chatId: 1,
	threadId: null,
	title: null,
	titleImplicit: false,
	model: null,
	thinking: null,
	voice: false,
	memoryExcluded: false,
	projectId: null,
	persona: "personal",
	archivedAt: null,
	pinnedAt: null,
	epoch,
	createdAt: "2026-01-01T00:00:00Z",
});

const loop: LoopTurnState = {
	detector: { records: [], warned: [] },
	watchdogRing: [],
	watchdogStrikes: 0,
	completedCalls: 0,
	modelCalls: 0,
	warnings: [],
	cutKind: null,
	forcedKind: null,
};

const partialWith = (...parts: UIMessage["parts"]): UIMessage => ({
	id: "a1",
	role: "assistant",
	parts,
});

const failureOf = (partial: UIMessage | null): ContextOverflowError =>
	new ContextOverflowError(
		partial,
		true,
		["probe"],
		[
			{
				id: "c1",
				entry: {
					tool: "probe",
					args: "{}",
					result: "r",
					ok: true,
				},
			},
		],
		loop,
	);

const preemptOf = (partial: UIMessage | null): PreemptCompactError =>
	new PreemptCompactError(
		partial,
		true,
		["probe"],
		[
			{
				id: "c1",
				entry: {
					tool: "probe",
					args: "{}",
					result: "r",
					ok: true,
				},
			},
		],
		loop,
		"pressure",
		4,
	);

interface Harness {
	deps: OverflowDeps<string>;
	compacted: () => unknown;
}

function harness(
	over: {
		failure?: ContextOverflowError;
		compact?: () => Promise<unknown>;
		holdsAuthority?: boolean;
		assertAuthority?: () => void;
		aborted?: boolean;
		recallVersion?: number | null;
	} = {},
): Harness {
	const live: LiveChunks = { chunks: [], subscribers: new Set(), ended: false };
	let compactCalls = 0;
	const deps: OverflowDeps<string> = {
		convId: "dm:1",
		epoch: 3,
		failure: over.failure ?? failureOf(partialWith({ type: "text", text: "half an answer" })),
		conversation: conv(3),
		memory: { prior: [], current: null },
		startedAt: 1234,
		live,
		filterRetryUsed: true,
		recallVersion: "recallVersion" in over ? over.recallVersion : 7,
		sourceInputSeq: 42,
		members: ["m1"],
		compact: async () => {
			compactCalls++;
			const r = over.compact?.();
			if (r === undefined)
				return {
					kind: "compacted",
					boundarySeq: 2,
					eventsCompacted: 2,
					tokensBefore: 10,
					tailEvents: 1,
					summary: "s",
				};
			return (await r) as never;
		},
		assertAuthority: over.assertAuthority ?? (() => {}),
		holdsAuthority: () => over.holdsAuthority ?? true,
		signal: new AbortController().signal,
	};
	if (over.aborted === true) {
		const c = new AbortController();
		c.abort();
		deps.signal = c.signal;
	}
	const h: Harness = {
		deps,
		compacted: () => compactCalls,
	};
	return h;
}

describe("compactTriggerTokens — design/compaction.md → Triggers", () => {
	test("the lower of half the window and the 128k cap; unknown window fires at the cap", () => {
		expect(compactTriggerTokens(1_000_000)).toBe(128_000);
		expect(compactTriggerTokens(200_000)).toBe(100_000);
		expect(compactTriggerTokens(64_000)).toBe(32_000);
		expect(compactTriggerTokens(undefined)).toBe(128_000);
		expect(compactTriggerTokens(null)).toBe(128_000);
	});
});

describe("preemptArm", () => {
	test("fires at the trigger, stands down below it and without a projection", () => {
		expect(preemptArm({ projectedInputTokens: null, contextWindow: 200_000 })).toBeNull();
		expect(preemptArm({ projectedInputTokens: 99_999, contextWindow: 200_000 })).toBeNull();
		expect(preemptArm({ projectedInputTokens: 100_000, contextWindow: 200_000 })).toBe("pressure");
		expect(preemptArm({ projectedInputTokens: 128_000, contextWindow: 1_000_000 })).toBe(
			"pressure",
		);
		expect(preemptArm({ projectedInputTokens: 127_999, contextWindow: 1_000_000 })).toBeNull();
		// An unknown window fires at the cap alone.
		expect(preemptArm({ projectedInputTokens: 128_000, contextWindow: undefined })).toBe(
			"pressure",
		);
		expect(preemptArm({ projectedInputTokens: 127_999, contextWindow: undefined })).toBeNull();
	});
});

describe("failureFromStream", () => {
	const base: StreamFailure = {
		kind: "failed",
		errorText: "boom",
		rawError: new Error("provider body"),
		holdForRecovery: false,
		partial: null,
		seenText: false,
		toolCalls: [],
		digestRing: [],
		loop,
		steerMark: 4,
		filterRetryUsed: false,
		window: null,
		model: "test/model",
		steps: 0,
	};

	test("a held failure becomes the overflow error carrying the resume payload", () => {
		const partial = partialWith({ type: "text", text: "half" });
		const err = failureFromStream({
			...base,
			holdForRecovery: true,
			partial,
			seenText: true,
			toolCalls: ["probe"],
			digestRing: [{ id: "c1", entry: { tool: "probe", args: "{}", result: "r", ok: true } }],
		});
		expect(err).toBeInstanceOf(ContextOverflowError);
		const o = err as ContextOverflowError;
		expect(o.partial).toBe(partial);
		expect(o.seenText).toBe(true);
		expect(o.toolCalls).toEqual(["probe"]);
		expect(o.digest).toHaveLength(1);
		expect(o.loop).toBe(loop);
	});

	test("an unheld failure becomes a plain error with the provider cause", () => {
		const cause = new Error("provider body");
		const err = failureFromStream({ ...base, rawError: cause });
		expect(err).not.toBeInstanceOf(ContextOverflowError);
		expect(err.message).toBe("boom");
		expect(err.cause).toBe(cause);
	});
});

describe("overflowHoldable — the one-recovery budget", () => {
	test("a recovery the rail produced has spent the budget; an operator seed has not", () => {
		expect(overflowHoldable(undefined, true)).toBe(true);
		const recovery: TurnRecovery = {
			conversation: conv(3),
			partial: null,
			memory: { prior: [], current: null },
			seenText: false,
			toolCalls: [],
			digest: [],
			loop,
			startedAt: 1,
			live: { chunks: [], subscribers: new Set(), ended: false },
			filterRetryUsed: false,
			overflowed: true,
		};
		expect(overflowHoldable(recovery, true)).toBe(false);
		const seed: TurnRecovery = { ...recovery, overflowed: undefined, resumedFrom: "src" };
		expect(overflowHoldable(seed, true)).toBe(true);
		expect(overflowHoldable(undefined, false)).toBe(false);
	});
});

describe("terminalFailureMessage", () => {
	test("a second overflow on the resumed attempt gets the still-full wording", () => {
		const msg = terminalFailureMessage(new Error("maximum context length is 4096 tokens"), true);
		expect(msg).toContain("still full after compacting");
		expect(msg.length).toBeLessThan(200);
	});

	test("a first-attempt overflow and any other failure read their own text", () => {
		expect(terminalFailureMessage(new Error("maximum context length"), false)).toBe(
			"maximum context length",
		);
		expect(terminalFailureMessage(new Error("Authentication Failed"), true)).toBe(
			"Authentication Failed",
		);
		expect(terminalFailureMessage("plain string", false)).toBe("plain string");
	});
});

describe("recoverFromOverflow", () => {
	test("a compacted overflow resumes with the whole recovery package", async () => {
		const failure = failureOf(partialWith({ type: "text", text: "half an answer" }));
		const h = harness({ failure });
		const outcome = await recoverFromOverflow(h.deps);
		expect(outcome.kind).toBe("resume");
		if (outcome.kind !== "resume") return;
		expect(outcome.recovery.conversation).toBe(h.deps.conversation);
		expect(outcome.recovery.partial).toBe(failure.partial);
		expect(outcome.recovery.memory).toBe(h.deps.memory);
		expect(outcome.recovery.seenText).toBe(failure.seenText);
		expect(outcome.recovery.toolCalls).toBe(failure.toolCalls);
		expect(outcome.recovery.digest).toBe(failure.digest);
		expect(outcome.recovery.loop).toBe(failure.loop);
		expect(outcome.recovery.startedAt).toBe(h.deps.startedAt);
		expect(outcome.recovery.live).toBe(h.deps.live);
		expect(outcome.recovery.filterRetryUsed).toBe(h.deps.filterRetryUsed);
		expect(outcome.recovery.recallVersion).toBe(h.deps.recallVersion);
		expect(outcome.recovery.sourceInputSeq).toBe(h.deps.sourceInputSeq);
		expect(outcome.members).toBe(h.deps.members);
		expect(h.compacted()).toBe(1);
	});

	test("a disabled capture token carries through as null, never a fresh read", async () => {
		const h = harness({ recallVersion: null });
		const outcome = await recoverFromOverflow(h.deps);
		expect(outcome.kind).toBe("resume");
		if (outcome.kind !== "resume") return;
		expect(outcome.recovery.recallVersion).toBeNull();
	});

	test("a partial of step-start markers alone packages as null", async () => {
		const failure = failureOf(partialWith({ type: "step-start" }, { type: "step-start" }));
		const h = harness({ failure });
		const outcome = await recoverFromOverflow(h.deps);
		expect(outcome.kind).toBe("resume");
		if (outcome.kind !== "resume") return;
		expect(outcome.recovery.partial).toBeNull();
	});

	test("a compaction that dies fenced fences the turn", async () => {
		const h = harness({
			compact: () => Promise.reject(new Error("summarize aborted")),
			holdsAuthority: false,
		});
		expect(await recoverFromOverflow(h.deps)).toEqual({ kind: "fenced" });
	});

	test("a stop during the compaction window fences the turn", async () => {
		const h = harness({
			compact: () => Promise.reject(new Error("summarize aborted")),
			aborted: true,
		});
		expect(await recoverFromOverflow(h.deps)).toEqual({ kind: "fenced" });
	});

	test("a compaction failure under held authority ends with the give-up message", async () => {
		const h = harness({
			compact: () => Promise.reject(new Error("x".repeat(300))),
		});
		const outcome = await recoverFromOverflow(h.deps);
		expect(outcome.kind).toBe("error");
		if (outcome.kind !== "error") return;
		const prefix = "context window full and compacting failed: ";
		expect(outcome.message.startsWith(prefix)).toBe(true);
		expect(outcome.message.length).toBe(prefix.length + 120);
	});

	test("a noop compaction ends with the nothing-left message", async () => {
		const h = harness({ compact: async () => ({ kind: "noop", reason: "too few events" }) });
		const outcome = await recoverFromOverflow(h.deps);
		expect(outcome.kind).toBe("error");
		if (outcome.kind !== "error") return;
		expect(outcome.message).toContain("nothing left to compact");
		expect(outcome.message.length).toBeLessThan(200);
	});

	test("a fence landing between compaction and packaging fences the turn", async () => {
		const h = harness({
			assertAuthority: () => {
				throw new Error("fenced");
			},
		});
		expect(await recoverFromOverflow(h.deps)).toEqual({ kind: "fenced" });
	});

	test("a failed pre-empt fold resumes the turn unfolded — it never overflowed", async () => {
		// The arm fired before the window was full; a summarizer outage
		// must not end the turn with a "window full" story. The recovery
		// is the same package on the uncompacted view, budget spent so
		// the arm cannot re-fire.
		const failure = preemptOf(partialWith({ type: "text", text: "half an answer" }));
		const h = harness({
			failure,
			compact: () => Promise.reject(new Error("summarizer down")),
		});
		const outcome = await recoverFromOverflow(h.deps);
		expect(outcome.kind).toBe("resume");
		if (outcome.kind !== "resume") return;
		expect(outcome.recovery.conversation).toBe(h.deps.conversation);
		expect(outcome.recovery.partial).toBe(failure.partial);
		expect(outcome.recovery.toolCalls).toBe(failure.toolCalls);
		expect(outcome.recovery.loop).toBe(failure.loop);
		expect(outcome.recovery.overflowed).toBe(true);
		expect(outcome.members).toBe(h.deps.members);
	});

	test("a pre-empt fold that finds nothing resumes unfolded", async () => {
		// The foldability gate raced the fold's own read — the boundary
		// vanished between them. Same resume, same spent budget.
		const h = harness({
			failure: preemptOf(null),
			compact: async () => ({ kind: "noop", reason: "boundary vanished — history changed" }),
		});
		const outcome = await recoverFromOverflow(h.deps);
		expect(outcome.kind).toBe("resume");
		if (outcome.kind !== "resume") return;
		expect(outcome.recovery.overflowed).toBe(true);
	});

	test("a fenced pre-empt fold still fences the turn", async () => {
		const h = harness({
			failure: preemptOf(null),
			compact: () => Promise.reject(new Error("summarizer down")),
			holdsAuthority: false,
		});
		expect(await recoverFromOverflow(h.deps)).toEqual({ kind: "fenced" });
	});

	test("a post-fold fence on the unfolded-resume path fences the turn", async () => {
		const h = harness({
			failure: preemptOf(null),
			compact: () => Promise.reject(new Error("summarizer down")),
			assertAuthority: () => {
				throw new Error("fenced");
			},
		});
		expect(await recoverFromOverflow(h.deps)).toEqual({ kind: "fenced" });
	});
});

describe("transport failure classification", () => {
	test("transport-shaped failures compose the drop line and keep the code", () => {
		expect(terminalFailureMessage(new Error("read ECONNRESET"), false)).toBe(
			"The model connection dropped (ECONNRESET). Nothing was lost — send again or /resume.",
		);
		const viaFetch = new TypeError("fetch failed", {
			cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
		});
		expect(terminalFailureMessage(viaFetch, false)).toBe(
			"The model connection dropped (ECONNRESET). Nothing was lost — send again or /resume.",
		);
		expect(
			terminalFailureMessage(new Error("Failed to process successful response"), false),
		).toBe(
			"The model connection dropped (Failed to process successful response). Nothing was lost — send again or /resume.",
		);
		// A transport-shaped message on the cause classifies the wrapper.
		expect(
			terminalFailureMessage(
				new Error("model stream failed", { cause: new Error("socket hang up") }),
				false,
			),
		).toContain("socket");
		// Undici transport codes classify; arbitrary codes never do.
		expect(
			terminalFailureMessage(
				Object.assign(new Error("died"), { code: "UND_ERR_SOCKET" }),
				false,
			),
		).toContain("UND_ERR_SOCKET");
		expect(
			terminalFailureMessage(Object.assign(new Error("boom"), { code: "rate_limit" }), false),
		).toBe("boom");
	});
});
