import { randomUUID } from "node:crypto";
import type { FinishReason, LanguageModelUsage, ToolSet, UIMessage } from "ai";
import type { Conversation } from "../conversation.ts";
import { log } from "../log.ts";
import type { MemoryDocument } from "../memory/hindsight.ts";
import {
	buildRetentionDocument,
	type MemoryEligibility,
	MemoryRetentionTooLargeError,
	type MemoryTurnDeps,
	memoryBoundEntries,
	messageText,
	type RetentionSource,
	retentionSourceFrom,
} from "../memory/mod.ts";
import {
	type CompletedTurn,
	type PriorTurnContext,
	Reviewer,
	type ToolCallDigest,
} from "../reviewer.ts";
import type { ForcedKind } from "./state.ts";
import { type DisplaySink, emitChunk, type LiveChunks, type WireMember } from "./stream.ts";

const DEFIANCE_NOTE: Record<ForcedKind, string> = {
	repeat:
		'I got stuck repeating the same tool call and was stopped before writing my answer — the work above is what I checked. Say "continue" and I\'ll pick up from there with a different approach.',
	watchdog:
		'A progress check stopped me as stuck before I wrote my answer — the work above is what I checked. Say "continue" and I\'ll pick up from there with a different approach.',
	context:
		'My context window filled up before I wrote my answer — the work above is what I checked. Say "continue" and I\'ll pick up from those findings.',
};

export type CompletedDone = { kind: "completed"; forced?: ForcedKind };

export interface WindowSignal {
	input: number;
	limit: number;
	pct: number;
}

export interface LandDeps {
	convId: string;
	epoch: number;
	conv: Conversation;
	modelEntries(): { seq: number; message: UIMessage }[];
	memoryEligibility(): MemoryEligibility;
	append(
		messages: UIMessage[],
		opts: { anchorSeq?: number | null; memory?: { target: string; document: MemoryDocument } },
	): void;
	memory: MemoryTurnDeps | undefined;
	steerMark: number;
	responseMessage: UIMessage | null;
	finishReason: FinishReason | null;
	usage: LanguageModelUsage | null;
	lastStepInputTokens: number | null;
	contextWindow: number | undefined;
	forcedKind: ForcedKind | null;
	sink: DisplaySink;
	members: WireMember[];
	live: LiveChunks;
}

export interface LandedAttempt {
	reply: UIMessage | null;
	done: CompletedDone;
	window: WindowSignal | null;
	source: RetentionSource;
}

export function landAttempt(deps: LandDeps): LandedAttempt {
	const { convId, epoch } = deps;
	const finalEntries = deps.modelEntries().filter((e) => e.seq <= deps.steerMark);
	let finalAnchor: number | null = null;
	for (const e of finalEntries) {
		if (e.message.role === "user" && (finalAnchor === null || e.seq > finalAnchor)) {
			finalAnchor = e.seq;
		}
	}
	const finalSource = retentionSourceFrom(
		memoryBoundEntries(finalEntries, deps.memoryEligibility()),
	);
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
		const memoryOpt = retentionOpt(deps.conv, deps.memory, finalAnchor, finalSource, reply);
		deps.append(
			[reply],
			memoryOpt ? { anchorSeq: finalAnchor, memory: memoryOpt } : { anchorSeq: finalAnchor },
		);
	}
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
	if (responseMessage.id.trim() === "") {
		log.warn("memory retention skipped — assistant message has no id", {
			conversation: conv.id,
		});
		return null;
	}
	let doc: MemoryDocument | null;
	try {
		doc = buildRetentionDocument({
			conversationId: conv.id,
			anchorSeq,
			userTexts: source.userTexts,
			userIds: source.userIds,
			assistant: responseMessage,
			priorContext: source.priorContext,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		if (!(err instanceof MemoryRetentionTooLargeError)) throw err;
		log.warn("memory retention skipped — oversized exchange", {
			conversation: conv.id,
			characters: err.characters,
			limit: 1_000_000,
		});
		return null;
	}
	if (!doc) {
		log.debug("memory retention skipped — no text to retain", {
			conversation: conv.id,
		});
		return null;
	}
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
	reviewer: Reviewer | undefined;
	memoryExcluded(): boolean;
	nextTurnSeq(): number;
	priorTurn(): PriorTurnContext | undefined;
	rememberTurn(prior: PriorTurnContext): void;
	forgetTurn(): void;
	source: RetentionSource;
	reply: UIMessage | null;
	toolCalls: string[];
	digestRing: { id: string; entry: ToolCallDigest }[];
	tools?: ToolSet;
}

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
		toolInventory: (() => {
			const tools = deps.tools;
			if (tools === undefined) return [];
			return Object.keys(tools)
				.sort()
				.map((name) => {
					const d = tools[name]!.description;
					return { name, description: (typeof d === "string" ? d : "").slice(0, 200) };
				});
		})(),
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
