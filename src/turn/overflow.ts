import type { Message } from "../message.ts";
import type { CompactionOutcome } from "../agent/compaction.ts";
import type { FallbackTrail } from "../agent/model-fallback.ts";
import { isContextOverflow } from "../agent/provider-errors.ts";
import type { Conversation } from "../conversation-read.ts";
import { log } from "../log.ts";
import type { RecallContext } from "../memory/mod.ts";
import type { ToolCallDigest } from "../reviewer-evidence.ts";
import type { LoopTurnState } from "./state.ts";
import type { StreamOutcome } from "./attempt-recorder.ts";
import type { LiveChunks } from "./stream.ts";
import { compactTriggerTokens } from "./compact-trigger.ts";

export interface TurnRecovery {
	conversation: Conversation;
	partial: Message | null;
	memory?: { prior: RecallContext[]; current: RecallContext | null } | undefined;
	seenText: boolean;
	toolCalls: string[];
	digest: { id: string; entry: ToolCallDigest }[];
	loop: LoopTurnState;
	startedAt: number;
	live: LiveChunks;
	filterRetryUsed: boolean;
	predecessorRun?: string | undefined;
	overflowed?: boolean | undefined;
	recallVersion?: number | null | undefined;
	sourceInputSeq?: number | null | undefined;
	ownedInputSeqs?: number[] | undefined;
	admissionExchangeExcluded?: boolean | undefined;
	fallback?: FallbackTrail | undefined;
}

export class ContextOverflowError extends Error {
	constructor(
		readonly partial: Message | null,
		readonly seenText: boolean,
		readonly toolCalls: string[],
		readonly digest: { id: string; entry: ToolCallDigest }[],
		readonly loop: LoopTurnState,
	) {
		super("context window overflow");
		this.name = "ContextOverflowError";
	}
}

export class PreemptSignal extends Error {
	constructor(
		readonly arm: "pressure",
		readonly stepNumber: number,
	) {
		super("compaction pre-empt — the step boundary folded the context before dispatch");
		this.name = "PreemptSignal";
	}
}

export class PreemptCompactError extends ContextOverflowError {
	constructor(
		partial: Message | null,
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

export interface PreemptInfo {
	projectedInputTokens: number | null;
	contextWindow: number | undefined;
	uncapped: boolean;
}

export function preemptArm(info: PreemptInfo): "pressure" | null {
	if (
		info.projectedInputTokens !== null &&
		info.projectedInputTokens >= compactTriggerTokens(info.contextWindow, info.uncapped)
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
	"context window still full after compacting once — the latest message or tool output is too big for this model; try a model with a bigger context window";

const TRANSPORT_MARKERS = /econnreset|econnrefused|etimedout|epipe|eai_again|enotfound|fetch failed|socket|failed to process successful response|network|connection (?:reset|closed|dropped|terminated)/i;
const TRANSPORT_CODES =
	/^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETRESET|UND_ERR_)/;

function transportCodeIn(err: unknown, depth: number): string | null {
	if (depth > 3 || err === null || typeof err !== "object") return null;
	const code = (err as { code?: unknown }).code;
	if (typeof code === "string" && TRANSPORT_CODES.test(code)) return code;
	return transportCodeIn((err as { cause?: unknown }).cause, depth + 1);
}

export function transportFailureCode(err: unknown): string | null {
	const code = transportCodeIn(err, 0);
	if (code !== null) return code;
	for (let e: unknown = err, depth = 0; depth <= 3; depth++) {
		const message = e instanceof Error ? e.message : e == null ? "" : String(e);
		const match = TRANSPORT_MARKERS.exec(message);
		if (match !== null) return match[0];
		e = e instanceof Error ? e.cause : undefined;
	}
	return null;
}

export function transportFailureText(err: unknown): string | null {
	const code = transportFailureCode(err);
	if (code === null) return null;
	return `The model connection dropped (${code}). Nothing was lost — send again.`;
}

export function terminalFailureMessage(err: unknown, continued: boolean): string {
	if (continued && isContextOverflow(err)) return STILL_FULL;
	const transport = transportFailureText(err);
	if (transport !== null) return transport;
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
	failedRunId?: string | undefined;
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
					"context window full and there's nothing left to compact — the latest message or tool output may be too big for this model; try a model with a bigger context window",
			};
		}
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
			predecessorRun: deps.failedRunId,
			overflowed: true,
			recallVersion: deps.recallVersion,
			sourceInputSeq: deps.sourceInputSeq,
		},
		members: deps.members,
	};
}

function hasContent(m: Message | null): m is Message {
	return m !== null && m.parts.some((p) => p.type !== "step-start");
}
