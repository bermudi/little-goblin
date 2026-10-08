// Overflow — turn a failed attempt into a resume decision or a
// terminal error (design/runtime-turn.md → phase 7). Provider bodies
// are classified in agent/provider-errors.ts and the stream driver
// decides whether a failure is held off the wire for recovery; this
// module owns the rest of the recovery: the failure vocabulary the
// rails throw and match, the one-recovery budget, the partial's
// worth-continuing gate, and the TurnRecovery package a resumed
// attempt restores from. The compaction call stays the runtime's
// (doCompact, reason "overflow") and rides in injected, fenced behind
// the injected authority checks — no extracted await runs outside one
// of the doc's two authority arrangements.

import type { UIMessage } from "ai";
import type { CompactionOutcome } from "../agent/compaction.ts";
import { isContextOverflow } from "../agent/provider-errors.ts";
import type { Conversation } from "../conversation.ts";
import { log } from "../log.ts";
import type { RecallContext } from "../memory.ts";
import type { ToolCallDigest } from "../reviewer.ts";
import type { LoopTurnState } from "./state.ts";
import type { LiveChunks, StreamOutcome } from "./stream.ts";

// Everything the resume attempt inherits from the failed one: the
// partial reply (continued as the same message, so tools never re-run),
// the recall result (recall does not re-run on a snapshot that already
// moved), and the turn-scoped evidence so block separation, the
// reviewer's gate, and durationMs cover the whole turn. This list is
// the exhaustive whitelist — anything not on it dies with the attempt.
export interface TurnRecovery {
	conversation: Conversation;
	partial: UIMessage | null;
	memory: { prior: RecallContext[]; current: RecallContext | null };
	seenText: boolean;
	toolCalls: string[];
	digest: { id: string; entry: ToolCallDigest }[];
	loop: LoopTurnState;
	startedAt: number;
	// The live wire log carries across the recovery: the resume
	// continues the same wire (holdForRecovery kept the failure off
	// it), so attached subscribers and the log must survive the
	// attempt boundary.
	live: LiveChunks;
	filterRetryUsed: boolean;
}

// The provider rejected the request for context size mid-turn. Not an
// ordinary failure: thrown after the stream loop with the failed
// attempt's accumulated reply so the catch can compact and resume —
// the pi mechanism (pi-mono agent-session _checkCompaction drops only
// the failed attempt, compacts, then continues).
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

// The failed attempt as the stream driver reports it.
export type StreamFailure = Extract<StreamOutcome, { kind: "failed" }>;

// The catch rail's translation of a failed attempt: a held overflow
// becomes the ContextOverflowError carrying the resume payload;
// anything else a plain error over the stream's error text with the
// provider's body on the cause chain.
export function failureFromStream(outcome: StreamFailure): Error {
	if (outcome.holdForRecovery) {
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

// The one-recovery budget: only a first attempt with compaction wired
// may hold an overflow off the wire for a compact-and-resume. The
// budget belongs to the classifier, not to the attempt loop — a second
// overflow on the same logical turn is terminal
// (terminalFailureMessage below).
export function overflowHoldable(
	recovery: TurnRecovery | undefined,
	compactionWired: boolean,
): boolean {
	return recovery === undefined && compactionWired;
}

// The give-up wording for an overflow the budget already spent: the
// compaction ran, the provider's line still says too big.
const STILL_FULL =
	"context window still full after compacting — the latest message or tool output is too big for this model";

// The terminal message for a failure escaping the rails: an overflow
// on a resumed attempt gets the give-up wording, anything else its own
// text.
export function terminalFailureMessage(err: unknown, resumed: boolean): string {
	if (resumed && isContextOverflow(err)) return STILL_FULL;
	return err instanceof Error ? err.message : String(err);
}

// The decision for a caught overflow. `resume` carries everything the
// next attempt restores plus the membership; fenced and error are
// terminal — the caller delivers them and stops. This is the overflow
// rail's half of the doc's AttemptOutcome: the attempt loop consumes
// it unchanged.
export type OverflowOutcome<M> =
	| { kind: "fenced" }
	| { kind: "error"; message: string }
	| { kind: "resume"; recovery: TurnRecovery; members: M[] };

export interface OverflowDeps<M> {
	convId: string;
	epoch: number;
	// The held failure — the failed attempt's handoff.
	failure: ContextOverflowError;
	// Recovery-carried inputs the failed attempt owned and the resume
	// must not re-derive: the settings-pinned conversation, the recall
	// result, the clock, the wire, the filter retry budget.
	conversation: Conversation;
	memory: TurnRecovery["memory"];
	startedAt: number;
	live: LiveChunks;
	filterRetryUsed: boolean;
	// The turn's membership — rides the decision so the resume claims
	// it explicitly, never by closure.
	members: M[];
	// Compaction invocation — the runtime's doCompact behind its own
	// authority fencing.
	compact(): Promise<CompactionOutcome>;
	// The authority rule's two arrangements for this module: the
	// throwing check before packaging, the non-throwing compare for a
	// compaction that itself died fenced.
	assertAuthority(): void;
	holdsAuthority(): boolean;
	// The failed attempt's abort handle — a /stop during the compaction
	// window fences the resume even when the epoch compare races.
	signal: AbortSignal;
}

export async function recoverFromOverflow<M>(deps: OverflowDeps<M>): Promise<OverflowOutcome<M>> {
	const { convId, epoch, failure } = deps;
	log.warn("context overflow — compacting and resuming turn", {
		conversation: convId,
		epoch,
		toolCalls: failure.toolCalls.length,
		partialParts: failure.partial?.parts.length ?? 0,
	});
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
		},
		members: deps.members,
	};
}

// A failed attempt's partial is worth continuing only if it streamed
// real content — step-start markers alone mean the reply never began,
// and continuing an empty message would seed the model with a blank
// assistant turn.
function hasContent(m: UIMessage | null): m is UIMessage {
	return m !== null && m.parts.some((p) => p.type !== "step-start");
}
