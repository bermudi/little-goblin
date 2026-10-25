import type { UIMessage } from "ai";
import type { CompactionOutcome } from "../agent/compaction.ts";
import { isContextOverflow } from "../agent/provider-errors.ts";
import type { Conversation } from "../conversation.ts";
import { log } from "../log.ts";
import type { RecallContext } from "../memory/mod.ts";
import type { ToolCallDigest } from "../reviewer.ts";
import type { LoopTurnState } from "./state.ts";
import type { LiveChunks, StreamOutcome } from "./stream.ts";

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
		readonly arm: "pressure" | "fidelity",
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
		readonly arm: "pressure" | "fidelity",
		readonly stepNumber: number,
	) {
		super(partial, seenText, toolCalls, digest, loop);
		this.name = "PreemptCompactError";
	}
}

// The two arms (design/compaction.md → Triggers). Pressure reads the last
// completed step's reported input against the catalog window — it exists
// to prevent hitting a wall. Fidelity estimates the unfolded span since
// the previous boundary (history chars minus the carried summary, chars/4)
// — it exists because the fold is the lossy step and span size sets its
// loss. Fidelity wins ties: it is checked first and fires at any window.
export interface PreemptInfo {
	inputTokens: number | null;
	historyChars: number;
	summaryChars: number;
	contextWindow: number | undefined;
}

export function preemptArm(
	info: PreemptInfo,
	arms: { pressurePct: number; fidelitySpanTokens: number },
): "pressure" | "fidelity" | null {
	const span = Math.ceil(Math.max(0, info.historyChars - info.summaryChars) / 4);
	if (span >= arms.fidelitySpanTokens) return "fidelity";
	if (
		info.contextWindow !== undefined &&
		info.inputTokens !== null &&
		info.inputTokens >= info.contextWindow * arms.pressurePct
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
	if (failure instanceof PreemptCompactError) {
		// Not a failure — a scheduled fold. The step that would have
		// dispatched never did, so no provider call was wasted.
		log.info("compaction pre-empt — folding at the step boundary, resuming turn", {
			conversation: convId,
			epoch,
			arm: failure.arm,
			step: failure.stepNumber,
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
	let outcome: CompactionOutcome;
	try {
		outcome = await deps.compact();
	} catch (compactErr) {
		if (!deps.holdsAuthority() || deps.signal.aborted) {
			log.info("turn fenced", { conversation: convId, epoch, error: String(compactErr) });
			return { kind: "fenced" };
		}
		log.warn("overflow compaction failed — turn ends", compactErr, { conversation: convId });
		const msg = compactErr instanceof Error ? compactErr.message : String(compactErr);
		return {
			kind: "error",
			message: `context window full and compacting failed: ${msg.slice(0, 120)}`,
		};
	}
	if (outcome.kind === "noop") {
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
