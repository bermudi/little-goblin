import type { UIMessage } from "ai";
import type { CompactionOutcome } from "../agent/compaction.ts";
import type { FallbackTrail } from "../agent/model-fallback.ts";
import { isContextOverflow } from "../agent/provider-errors.ts";
import type { Conversation } from "../conversation-read.ts";
import { log } from "../log.ts";
import type { RecallContext } from "../memory/mod.ts";
import type { ToolCallDigest } from "../reviewer-evidence.ts";
import type { LoopTurnState } from "./state.ts";
import type { LiveChunks, StreamOutcome } from "./stream.ts";

// design/compaction.md → Triggers: the one fold trigger — the lower of
// 50% of the catalog window and an absolute 128k cap. Every call
// re-sends the whole context, so the cap bounds the per-call input bill
// on a 1M window. The same threshold drives the step-boundary pre-empt,
// the end-of-turn backstop, and the app's compaction gauge.
export const COMPACT_TRIGGER_RATIO = 0.5;
export const COMPACT_TRIGGER_CAP_TOKENS = 128_000;

// The trigger in tokens for a catalog window; an unknown window fires
// at the cap alone.
export function compactTriggerTokens(contextWindow: number | undefined | null): number {
	if (contextWindow === undefined || contextWindow === null) {
		return COMPACT_TRIGGER_CAP_TOKENS;
	}
	return Math.min(Math.round(contextWindow * COMPACT_TRIGGER_RATIO), COMPACT_TRIGGER_CAP_TOKENS);
}

export interface TurnRecovery {
	conversation: Conversation;
	partial: UIMessage | null;
	memory?: { prior: RecallContext[]; current: RecallContext | null } | undefined;
	seenText: boolean;
	toolCalls: string[];
	digest: { id: string; entry: ToolCallDigest }[];
	loop: LoopTurnState;
	startedAt: number;
	live: LiveChunks;
	filterRetryUsed: boolean;
	resumedFrom?: string | undefined;
	predecessorRun?: string | undefined;
	// The operator's real request for the loop watchdog's progress check —
	// set only by operator-resume, whose head event is a generated
	// provenance marker rather than the ask. Absent, the attempt falls
	// back to the head message's text (every other head IS the request).
	operatorRequest?: string | undefined;
	overflowed?: boolean | undefined;
	recallVersion?: number | null | undefined;
	sourceInputSeq?: number | null | undefined;
	// Inputs consumed by earlier attempts, including those hidden by a fold.
	ownedInputSeqs?: number[] | undefined;
	// Taint from visible, potentially unowned inputs in the original admission.
	admissionExchangeExcluded?: boolean | undefined;
	// Set once the turn has a fallback history (design/model.md → Model
	// fallback list): `conversation.model` is then the serving candidate,
	// `configured` the operator's selection, `tried` the candidates that
	// failed before it. Carried through overflow recovery and resume.
	fallback?: FallbackTrail | undefined;
}

export class ContextOverflowError extends Error {
	constructor(
		readonly partial: UIMessage | null,
		readonly seenText: boolean,
		readonly toolCalls: string[],
		readonly digest: { id: string; entry: ToolCallDigest }[],
		readonly loop: LoopTurnState,
	) {
		super("context window overflow");
		this.name = "ContextOverflowError";
	}
}

// ---------- step-boundary pre-emption (design/compaction.md → Timing) ----------

// Thrown from the step boundary (prepareStep) when a pre-empt arm fires:
// the next model call must not dispatch. The turn folds and resumes on
// the compacted view through the same rail as an overflow. Carries only
// the decision — the recovery payload is assembled by the driver, where
// the partial lives.
export class PreemptSignal extends Error {
	constructor(
		readonly arm: "pressure",
		readonly stepNumber: number,
	) {
		super("compaction pre-empt — the step boundary folded the context before dispatch");
		this.name = "PreemptSignal";
	}
}

// The failed outcome's preempt payload becomes this at the runtime
// boundary: same recovery rail as a provider 400, different compact
// reason (full tail, "preempt") and a different operator-facing story.
// The arm and step number ride along so the recovery log names what fired.
export class PreemptCompactError extends ContextOverflowError {
	constructor(
		partial: UIMessage | null,
		seenText: boolean,
		toolCalls: string[],
		digest: { id: string; entry: ToolCallDigest }[],
		loop: LoopTurnState,
		readonly arm: "pressure",
		readonly stepNumber: number,
	) {
		super(partial, seenText, toolCalls, digest, loop);
		this.name = "PreemptCompactError";
	}
}

// The one arm (design/compaction.md → Triggers). It budgets the UPCOMING
// request — the last completed step's reported input plus the growth
// since its dispatch (assistant output, tool results, steers), estimated
// at chars/4 — because a tool result can blow the window in one step
// while the previous request read small. The runtime gate-checks
// foldability before any interruption — a trigger with nothing stored
// to fold stands down.
export interface PreemptInfo {
	/** Null before the first completed step — no reported input to project from. */
	projectedInputTokens: number | null;
	contextWindow: number | undefined;
}

export function preemptArm(info: PreemptInfo): "pressure" | null {
	if (
		info.projectedInputTokens !== null &&
		info.projectedInputTokens >= compactTriggerTokens(info.contextWindow)
	) {
		return "pressure";
	}
	return null;
}

export type StreamFailure = Extract<StreamOutcome, { kind: "failed" }>;

export function failureFromStream(outcome: StreamFailure): Error {
	if (outcome.holdForRecovery) {
		if (outcome.preempt !== undefined) {
			return new PreemptCompactError(
				outcome.partial,
				outcome.seenText,
				outcome.toolCalls,
				outcome.digestRing,
				outcome.loop,
				outcome.preempt.arm,
				outcome.preempt.step,
			);
		}
		return new ContextOverflowError(
			outcome.partial,
			outcome.seenText,
			outcome.toolCalls,
			outcome.digestRing,
			outcome.loop,
		);
	}
	return new Error(outcome.errorText, { cause: outcome.rawError });
}

export function overflowHoldable(
	recovery: TurnRecovery | undefined,
	compactionWired: boolean,
): boolean {
	return recovery?.overflowed !== true && compactionWired;
}

const STILL_FULL =
	"context window still full after compacting — the latest message or tool output is too big for this model";

export function terminalFailureMessage(err: unknown, resumed: boolean): string {
	if (resumed && isContextOverflow(err)) return STILL_FULL;
	return err instanceof Error ? err.message : String(err);
}

export type OverflowOutcome<M> =
	| { kind: "fenced" }
	| { kind: "error"; message: string }
	| { kind: "resume"; recovery: TurnRecovery; members: M[] };

export interface OverflowDeps<M> {
	convId: string;
	epoch: number;
	failure: ContextOverflowError;
	conversation: Conversation;
	memory: TurnRecovery["memory"];
	startedAt: number;
	live: LiveChunks;
	filterRetryUsed: boolean;
	resumedFrom?: string | undefined;
	failedRunId?: string | undefined;
	// Carried forward so an operator-resumed turn that overflows keeps
	// the real request on its continuation attempt.
	operatorRequest?: string | undefined;
	recallVersion?: number | null | undefined;
	sourceInputSeq?: number | null | undefined;
	members: M[];
	compact(): Promise<CompactionOutcome>;
	assertAuthority(): void;
	holdsAuthority(): boolean;
	signal: AbortSignal;
}

export async function recoverFromOverflow<M>(deps: OverflowDeps<M>): Promise<OverflowOutcome<M>> {
	const { convId, epoch, failure } = deps;
	const preempt = failure instanceof PreemptCompactError ? failure : null;
	if (preempt !== null) {
		// Not a failure — a scheduled fold. The step that would have
		// dispatched never did, so no provider call was wasted.
		log.info("compaction pre-empt — folding at the step boundary, resuming turn", {
			conversation: convId,
			epoch,
			arm: preempt.arm,
			step: preempt.stepNumber,
			toolCalls: failure.toolCalls.length,
			partialParts: failure.partial?.parts.length ?? 0,
		});
	} else {
		log.warn("context overflow — compacting and resuming turn", {
			conversation: convId,
			epoch,
			toolCalls: failure.toolCalls.length,
			partialParts: failure.partial?.parts.length ?? 0,
		});
	}
	let outcome: CompactionOutcome | null = null;
	try {
		outcome = await deps.compact();
	} catch (compactErr) {
		if (!deps.holdsAuthority() || deps.signal.aborted) {
			log.info("turn fenced", { conversation: convId, epoch, error: String(compactErr) });
			return { kind: "fenced" };
		}
		if (preempt === null) {
			log.warn("overflow compaction failed — turn ends", compactErr, { conversation: convId });
			const msg = compactErr instanceof Error ? compactErr.message : String(compactErr);
			return {
				kind: "error",
				message: `context window full and compacting failed: ${msg.slice(0, 120)}`,
			};
		}
		// The arm fired before the window was full — a failed fold must
		// not end a turn that never overflowed. Resume on the unfolded
		// view with the same spent budget: the arm cannot re-fire (no
		// loop), and a still-growing turn meets the context landing or a
		// real 400, which fail honestly as themselves.
		log.warn("compaction pre-empt fold failed — resuming on the unfolded view", compactErr, {
			conversation: convId,
			epoch,
			arm: preempt.arm,
			step: preempt.stepNumber,
		});
	}
	if (outcome?.kind === "noop") {
		if (preempt === null) {
			log.warn("context overflow — nothing left to compact", {
				conversation: convId,
				epoch,
				reason: outcome.reason,
			});
			return {
				kind: "error",
				message:
					"context window full and there's nothing left to compact — the latest message or tool output may be too big for this model",
			};
		}
		// The foldability gate fired the arm but the fold's own read
		// found nothing (history moved mid-compaction). Same resume:
		// nothing was interrupted for a fold that could not happen, so
		// the turn continues unfolded.
		log.warn("compaction pre-empt fold found nothing to fold — resuming on the unfolded view", {
			conversation: convId,
			epoch,
			arm: preempt.arm,
			step: preempt.stepNumber,
			reason: outcome.reason,
		});
	}
	try {
		deps.assertAuthority();
	} catch {
		log.info("turn fenced", { conversation: convId, epoch });
		return { kind: "fenced" };
	}
	return {
		kind: "resume",
		recovery: {
			conversation: deps.conversation,
			partial: hasContent(failure.partial) ? failure.partial : null,
			memory: deps.memory,
			seenText: failure.seenText,
			toolCalls: failure.toolCalls,
			digest: failure.digest,
			loop: failure.loop,
			startedAt: deps.startedAt,
			live: deps.live,
			filterRetryUsed: deps.filterRetryUsed,
			resumedFrom: deps.resumedFrom,
			predecessorRun: deps.failedRunId,
			operatorRequest: deps.operatorRequest,
			overflowed: true,
			recallVersion: deps.recallVersion,
			sourceInputSeq: deps.sourceInputSeq,
		},
		members: deps.members,
	};
}

function hasContent(m: UIMessage | null): m is UIMessage {
	return m !== null && m.parts.some((p) => p.type !== "step-start");
}
