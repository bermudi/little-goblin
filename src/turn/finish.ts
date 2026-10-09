// Finish — land a completed attempt durably (design/runtime-turn.md →
// phase 6). Two halves bracket the runtime's delivery: landAttempt
// runs before the completed onDone — the ownership-bounded anchor and
// retention source, the defiance guard, the append with its retention
// enqueue, the window signal, the completion log line — and
// submitTurnReview runs after it — the reviewer's fire-and-forget
// gate with its snapshot and the prior-turn chain. Delivery itself
// (notifyAll) and the authority checks bracketing the path stay the
// runtime's: exactly-one onDone per submit is the sink contract, and
// the post-delivery check owns the stop-during-flush window.

import { randomUUID } from "node:crypto";
import type { FinishReason, LanguageModelUsage, UIMessage } from "ai";
import type { Conversation } from "../conversation.ts";
import type { MemoryDocument } from "../hindsight.ts";
import { log } from "../log.ts";
import {
	buildRetentionDocument,
	type MemoryEligibility,
	type MemoryTurnDeps,
	memoryBoundEntries,
	messageText,
	type RetentionSource,
	retentionSourceFrom,
} from "../memory.ts";
import {
	type CompletedTurn,
	type PriorTurnContext,
	Reviewer,
	type ToolCallDigest,
} from "../reviewer.ts";
import type { ForcedKind } from "./state.ts";
import { emitChunk, type DisplaySink, type LiveChunks, type WireMember } from "./stream.ts";

// A provider that defies toolChoice "none" on the forced step — still
// emitting tool calls or no prose — gets this plain-language answer
// appended so the stamp never lies about a nothing.
const DEFIANCE_NOTE: Record<ForcedKind, string> = {
	repeat:
		'I got stuck repeating the same tool call and was stopped before writing my answer — the work above is what I checked. Say "continue" and I\'ll pick up from there with a different approach.',
	watchdog:
		'A progress check stopped me as stuck before I wrote my answer — the work above is what I checked. Say "continue" and I\'ll pick up from there with a different approach.',
	context:
		'My context window filled up before I wrote my answer — the work above is what I checked. Say "continue" and I\'ll pick up from those findings.',
};

// The completed terminal outcome as this module produces it — the
// structural shape of runtime's TurnDone member sinks receive.
export type CompletedDone = { kind: "completed"; forced?: ForcedKind };

// The window-utilization signal: the last step's input against the
// catalog context limit. Cached tokens still occupy the window, so
// this is the filling gauge regardless of cache health; the runtime
// reads it for the threshold-compaction decision.
export interface WindowSignal {
	input: number;
	limit: number;
	pct: number;
}

export interface LandDeps {
	convId: string;
	epoch: number;
	conv: Conversation;
	// History re-read as the exchange ended, the eligibility stamps
	// for the memory-bound projection, and the append the reply lands
	// through — all injected: no turn/ module sees the store.
	modelEntries(): { seq: number; message: UIMessage }[];
	memoryEligibility(): MemoryEligibility;
	append(
		messages: UIMessage[],
		opts: { anchorSeq?: number | null; memory?: { target: string; document: MemoryDocument } },
	): void;
	memory: MemoryTurnDeps | undefined;
	// The ownership high-water mark the stream's steer fold left.
	steerMark: number;
	// The attempt's outputs (the stream outcome's ok member).
	responseMessage: UIMessage | null;
	finishReason: FinishReason | null;
	usage: LanguageModelUsage | null;
	lastStepInputTokens: number | null;
	contextWindow: number | undefined;
	// Which landing forced the answer, if any — TurnState's stamp.
	forcedKind: ForcedKind | null;
	// Synthetic prose rides both delivery projections: the head's display
	// deltas and the shared wire for streaming members and attach clients.
	sink: DisplaySink;
	members: WireMember[];
	live: LiveChunks;
}

export interface LandedAttempt {
	// The reply as persisted — the defiance note already folded in.
	reply: UIMessage | null;
	done: CompletedDone;
	window: WindowSignal | null;
	// The retention source: the reviewer snapshot reads the operator
	// burst from it.
	source: RetentionSource;
}

export function landAttempt(deps: LandDeps): LandedAttempt {
	const { convId, epoch } = deps;
	// Steering folded mid-turn submits into this exchange, so the
	// retention source and anchor read history as the exchange ENDED —
	// but only up to the ownership mark: queued input this turn never
	// read must not anchor the reply. Nothing else can have appended
	// meanwhile — the lane is serial and every mid-turn submit funnels
	// through it.
	const finalEntries = deps.modelEntries().filter((e) => e.seq <= deps.steerMark);
	let finalAnchor: number | null = null;
	for (const e of finalEntries) {
		if (e.message.role === "user" && (finalAnchor === null || e.seq > finalAnchor)) {
			finalAnchor = e.seq;
		}
	}
	// Retention is memory-bound: the burst and prior context read the
	// eligible projection of the exchange as it ended (#85) — messages
	// and replies written while the topic was excluded never enter a
	// document, not even as labelled context. Eligibility re-reads
	// here (with finalEntries) so steered-in messages carry their own
	// append-time stamps.
	const finalSource = retentionSourceFrom(
		memoryBoundEntries(finalEntries, deps.memoryEligibility()),
	);
	// The defiance guard: a forced landing whose step STILL ended in
	// tool calls (a provider ignoring toolChoice:none) or produced no
	// prose would deliver a stamped nothing. The invariant gets the
	// last word: append plain-language prose to history, the app wire,
	// and the display delta path (Telegram delivers text only through
	// deltas).
	let reply = deps.responseMessage;
	const forcedKind = deps.forcedKind;
	if (
		forcedKind !== null &&
		reply !== null &&
		(deps.finishReason === "tool-calls" ||
			!reply.parts.some((p) => p.type === "text" && p.text.trim() !== ""))
	) {
		const note = DEFIANCE_NOTE[forcedKind];
		log.warn("forced landing produced no prose — synthetic answer appended", {
			conversation: convId,
			forced: forcedKind,
			finishReason: deps.finishReason,
		});
		reply = {
			...reply,
			parts: [...reply.parts, { type: "text", text: note }],
		};
		const id = randomUUID();
		emitChunk(convId, deps.members, deps.live, { type: "text-start", id });
		emitChunk(convId, deps.members, deps.live, { type: "text-delta", id, delta: note });
		emitChunk(convId, deps.members, deps.live, { type: "text-end", id });
		deps.sink.onTextDelta(`\n\n${note}`);
	}
	if (reply !== null) {
		// reply already carries an SDK-assigned id. The anchor ties it
		// to the user message that triggered this turn — the causal
		// view places the reply right after its question, not after
		// later arrivals. Completed text exchanges also enqueue
		// retention in the same transaction; fenced/failed turns never
		// reach here.
		const memoryOpt = retentionOpt(deps.conv, deps.memory, finalAnchor, finalSource, reply);
		deps.append(
			[reply],
			memoryOpt ? { anchorSeq: finalAnchor, memory: memoryOpt } : { anchorSeq: finalAnchor },
		);
	}
	// Window utilization rides the completion line. Logged BEFORE the
	// final notify — onDone means the turn is fully finished, log
	// included.
	const window =
		deps.contextWindow !== undefined && deps.lastStepInputTokens !== null
			? {
					input: deps.lastStepInputTokens,
					limit: deps.contextWindow,
					pct: Math.round((deps.lastStepInputTokens / deps.contextWindow) * 100),
				}
			: null;
	log.info("turn completed", {
		conversation: convId,
		epoch,
		finish: deps.finishReason,
		usage: deps.usage && {
			input: deps.usage.inputTokens ?? null,
			cacheRead: deps.usage.inputTokenDetails?.cacheReadTokens ?? null,
			cacheWrite: deps.usage.inputTokenDetails?.cacheWriteTokens ?? null,
			output: deps.usage.outputTokens ?? null,
		},
		window,
	});
	if (window && window.pct >= 80) {
		log.warn("context window ≥80% — history is approaching the limit", {
			conversation: convId,
			...window,
		});
	}
	return {
		reply,
		done: forcedKind !== null ? { kind: "completed", forced: forcedKind } : { kind: "completed" },
		window,
		source: finalSource,
	};
}

// Retention for a completed exchange: text only, program housekeeping
// excluded, suppressed documents skipped. Null = append history alone.
export function retentionOpt(
	conv: Conversation,
	memory: MemoryTurnDeps | undefined,
	anchorSeq: number | null,
	source: RetentionSource,
	responseMessage: UIMessage,
): { target: string; document: MemoryDocument } | null {
	if (!memory || anchorSeq === null || conv.memoryExcluded) return null;
	if (source.program) {
		log.debug("memory retention skipped — program housekeeping", {
			conversation: conv.id,
		});
		return null;
	}
	// The document ID and source refs are keyed to the assistant
	// message identity — without one there is nothing stable to
	// retain. Providers normally assign it; a blank one fails open
	// loudly here rather than forging an identity.
	if (responseMessage.id.trim() === "") {
		log.warn("memory retention skipped — assistant message has no id", {
			conversation: conv.id,
		});
		return null;
	}
	const doc = buildRetentionDocument({
		conversationId: conv.id,
		anchorSeq,
		userTexts: source.userTexts,
		userIds: source.userIds,
		assistant: responseMessage,
		priorContext: source.priorContext,
		timestamp: new Date().toISOString(),
	});
	if (!doc) {
		log.debug("memory retention skipped — no text to retain", {
			conversation: conv.id,
		});
		return null;
	}
	// Suppression is checked after the model already streamed — a
	// store failure here must skip retention, never drop the response.
	let suppressed = false;
	try {
		suppressed = memory.contexts.isSuppressed(doc.id);
	} catch (err) {
		log.warn("memory suppression unreadable — skipping retention", err, {
			conversation: conv.id,
		});
		return null;
	}
	if (suppressed) {
		log.info("memory retention suppressed", {
			conversation: conv.id,
			document: doc.id,
		});
		return null;
	}
	return { target: memory.client.target, document: doc };
}

export interface ReviewDeps {
	convId: string;
	// Absent = the reviewer feature is off: no gate, and the
	// prior-turn chain stays untouched.
	reviewer: Reviewer | undefined;
	// Off-the-record read at completion — a fresh store read with the
	// admission copy as fallback, so a settings flip during delivery
	// suppresses the review (exclusion is decided when the turn lands,
	// not when it was admitted).
	memoryExcluded(): boolean;
	// The runtime's conversation-scoped reviewer state: the gate's
	// serialization counter and the prior-turn chain.
	nextTurnSeq(): number;
	priorTurn(): PriorTurnContext | undefined;
	rememberTurn(prior: PriorTurnContext): void;
	forgetTurn(): void;
	// The exchange as it ended: landAttempt's source and reply, plus
	// the stream outcome's reviewer evidence.
	source: RetentionSource;
	reply: UIMessage | null;
	toolCalls: string[];
	digestRing: { id: string; entry: ToolCallDigest }[];
}

// Every completed turn gates a possible background review —
// fire-and-forget, off the lane, never delaying the successor.
// Fenced/failed turns never reach here, and neither do memory-excluded
// ones: off the record means no durable distillation, so the reviewer
// never sees the turn and the prior-turn chain breaks there (an
// excluded turn is never evidence for the next review either). The
// backstop only sees bugs: gate failures fall back inside
// considerTurn, review failures log their own lines.
export function submitTurnReview(deps: ReviewDeps): void {
	const reviewer = deps.reviewer;
	if (reviewer === undefined) return;
	if (deps.memoryExcluded()) {
		log.info("reviewer skipped — memory excluded", { conversation: deps.convId });
		deps.forgetTurn();
		return;
	}
	const turnSeq = deps.nextTurnSeq();
	const snapshot: CompletedTurn = {
		conversationId: deps.convId,
		turnSeq,
		operatorTexts: deps.source.userTexts,
		replyText: deps.reply ? messageText(deps.reply) : "",
		toolNames: deps.toolCalls,
		toolDigest: deps.digestRing.map((p) => p.entry),
	};
	void reviewer.considerTurn(snapshot, deps.priorTurn()).catch((err: unknown) => {
		log.error("reviewer failed", err, { conversation: deps.convId });
	});
	deps.rememberTurn({
		operatorTexts: snapshot.operatorTexts,
		replyText: snapshot.replyText,
		toolDigest: snapshot.toolDigest,
	});
}
