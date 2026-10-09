// Overflow unit tests: the recovery decision's boundary rules
// (design/runtime-turn.md → phase 7) — the failure translation, the
// one-recovery budget, the partial's worth-continuing gate, and the
// fenced / give-up / resume decision over an injected compaction. The
// resume loop itself (steering across attempts, lane interplay, the
// one-compaction-per-turn bound) stays pinned e2e in runtime.test.ts.

import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { Conversation } from "../conversation.ts";
import {
	ContextOverflowError,
	failureFromStream,
	type OverflowDeps,
	overflowHoldable,
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
	persona: "personal",
	archivedAt: null,
	epoch,
	createdAt: "2026-01-01T00:00:00Z",
});

const loop: LoopTurnState = {
	detector: { records: [], warned: [] },
	watchdogRing: [],
	watchdogStrikes: 0,
	completedCalls: 0,
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

interface Harness {
	deps: OverflowDeps<string>;
	compacted: () => unknown;
}

// The runtime half of the seam, faked at its edges: compaction is a
// script, the authority checks are toggles, the wire and membership
// are plain objects.
function harness(
	over: {
		failure?: ContextOverflowError;
		compact?: () => Promise<unknown>;
		holdsAuthority?: boolean;
		assertAuthority?: () => void;
		aborted?: boolean;
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
	test("only a first attempt with compaction wired may hold", () => {
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
		};
		expect(overflowHoldable(recovery, true)).toBe(false);
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
		// The whitelist is passed through untouched — identity, not copy,
		// for the objects the resume must continue (wire, loop, digest).
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
		expect(outcome.members).toBe(h.deps.members);
		expect(h.compacted()).toBe(1);
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
		// The provider's own message is truncated to 120 chars — the
		// operator gets the cause, not the wall.
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
});
