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

export type StreamFailure = Extract<StreamOutcome, { kind: "failed" }>;

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
