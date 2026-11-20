// Per-conversation serial lanes and epoch fencing: fenced turns still run
// terminal callbacks so every sink is settled.

import { randomUUID } from "node:crypto";
import type { Tools } from "./tool.ts";
import type { Message, MessageChunk } from "./message.ts";
import { isClaudeStep, type ClaudeEngine, type ClaudeStep } from "./agent/claude-code/mod.ts";
import type { ClaudeSessionRecord, ClaudeSessionStore } from "./claude-sessions.ts";
import { type CompactionOutcome, chooseBoundary, type PrefixSummarizer } from "./agent/compaction.ts";
import type { FallbackNote } from "./agent/model-fallback.ts";
import { resolveSkillRef } from "./agent/skill-inject.ts";
import { lastInputTokensOf, type Conversation } from "./conversation-read.ts";
import type { ConversationStore } from "./conversation.ts";
import type { OutgoingFile } from "./agent/tools/send.ts";
import { PendingInputs, type PendingInputMode } from "./pending-input.ts";
import { log } from "./log.ts";
import {
	activeExchangeExcluded,
	type MemoryTurnDeps,
	memoryBoundEntries,
	messageText,
	type RecallContext,
	recallMemory,
} from "./memory/mod.ts";
import type { PriorTurnContext } from "./reviewer-evidence.ts";
import { Reviewer } from "./reviewer.ts";
import {
	LaneRegistry,
	type ClaimedTurn,
	type ConversationEvent,
	type QueuedTurn,
} from "./runtime-lanes.ts";
import {
	type AttemptOutcome,
	type AttemptProgress,
	type AttemptScope,
	errorRail,
	fencedRail,
	journalFaultRail,
	overflowRail,
} from "./runtime-rails.ts";
import type { System1Client } from "./system1.ts";
import { admitTurn, type LiveWire } from "./turn/admission.ts";
import { type CompactionSeam, runCompactJob } from "./turn/compact-job.ts";
import { makePrefixSummarizer } from "./turn/prefix-summary.ts";
import {
	persistableToolSet,
	restoreToolSet,
	storedModelOutputTools,
	toToolSet,
	type SDKToolSet,
} from "./turn/ai-sdk-tools.ts";
import { sinkDelivery } from "./turn/delivery.ts";
import { pickEngine, type TurnEngine } from "./turn/engine.ts";
import type { ModelStep } from "./turn/ai-sdk-step.ts";
import { type LandedAttempt, landAttempt, submitTurnReview } from "./turn/finish.ts";
import { stepModelRef } from "./turn/model-ref.ts";
import {
	ContextOverflowError,
	compactTriggerTokens,
	failureFromStream,
	overflowHoldable,
	preemptArm,
	type TurnRecovery,
} from "./turn/overflow.ts";
import type { RunOwnershipHooks } from "./turn/run-ownership.ts";
import { openRunRecord } from "./turn/run-record.ts";
import type { TurnDone, TurnSink } from "./turn/sink.ts";
import type { SkillWatch } from "./turn/skill-attribution.ts";
import { TurnState } from "./turn/state.ts";
import { openStepRules, type PreemptArm, type StepRules } from "./turn/step-rules.ts";
import {
	claimMembers,
	endLive,
	type LiveChunks,
	type LiveSubscriber,
	openLive,
} from "./turn/stream.ts";
import type { StreamOutcome } from "./turn/attempt-recorder.ts";
import {
	openToolAuthority,
	type ToolAuthority,
	type TurnToolMaker,
} from "./turn/tool-authority.ts";
import { buildModelView, type ViewContext } from "./turn/view.ts";
import type { TurnJournal } from "./turn-journal.ts";
import type { WindowCapture } from "./window-capture.ts";

export type TurnStep = ModelStep | ClaudeStep;

const LOOP_CHECK_EVERY = 16;
// design/compaction.md → Budgets: the verbatim tail is 20k tokens —
// pi/OpenClaw's keepRecentTokens — absolute at scale (the 1M-era rule:
// fractions of a big window are consumption rules, not safety rules),
// clamped to the window's own fractions on small models so a 32k window
// keeps a working tail and chunk instead of a tail that swallows it.
const COMPACT_TAIL_TOKENS = 20_000;
const COMPACT_CHUNK_TOKENS = 100_000;

function queuedSeq(turn: QueuedTurn): number {
	if (turn.seq === null) throw new Error(`pending input ${turn.pending?.id ?? "?"} was not claimed`);
	return turn.seq;
}

// The compaction budgets as a pure function (design/compaction.md →
// Budgets) — exported for the ruling's tests. Small windows keep the
// window's own fractions exactly (the caps never bind below 80k tail /
// 200k chunk); at scale the absolute values take over. A null window
// (manual /compact with the catalog silent) takes the absolute values.
export function compactionBudgets(contextWindow: number | null): {
	tailTokenBudget: number;
	inputTokenBudget: number;
} {
	if (contextWindow === null) {
		return { tailTokenBudget: COMPACT_TAIL_TOKENS, inputTokenBudget: COMPACT_CHUNK_TOKENS };
	}
	return {
		tailTokenBudget: Math.min(COMPACT_TAIL_TOKENS, Math.round(contextWindow * 0.25)),
		inputTokenBudget: Math.min(COMPACT_CHUNK_TOKENS, Math.floor(contextWindow * 0.5)),
	};
}

export interface RuntimeDeps {
	store: ConversationStore;
	// Resolve model settings fresh per turn; auth resolution may be async.
	// A claude-code provider yields a ClaudeStep (engine: "claude-code") —
	// the turn runs on whichever engine accepts the step (turn/engine.ts).
	buildStep(
		conv: Conversation,
		tools: Tools,
	): TurnStep | Promise<TurnStep>;
	// The turn engines, tried in order (turn/engine.ts pickEngine):
	// index.ts binds [claude-code, ai-sdk]. A step no engine accepts
	// fails the turn loud, never silently degrades.
	engines: readonly TurnEngine[];
	// Capture channel settings at admission so recovery and compaction share a
	// stable snapshot. A later settings change fences the current attempt.
	captureConversation?(conv: Conversation): Conversation;
	// The operator's global model fallback list, read live per turn
	// (design/model.md → Model fallback list). Absent or [] = no fallback.
	modelFallbacks?(): readonly string[];
	// Tool authority's tool builder (turn/tool-authority.ts): builds the
	// deployment workspace's tools; delivery hooks connect speak and file
	// tools to the running sink.
	makeTools: TurnToolMaker;
	// Optional memory recall is bounded, fail-open, and cache-stable; retention
	// is enqueued only while the turn retains authority. Memory input is kept
	// separate from the model's complete conversation view.
	memory?: MemoryTurnDeps;
	// Optional compaction: the seam turn/compact-job.ts consumes.
	compaction?: CompactionSeam;
	// Between-turns persisted pruning: runs after the next batch is
	// claimed and before runTurn builds its view, so committed markers are
	// visible to the admission read. A throw is logged and the turn
	// proceeds — the projection commit is atomic.
	pruneBetweenTurns?: (convId: string) => void;
	// Each admitted attempt opens a run row before any tool side effect
	// can run. Optional — test rigs journal nothing.
	turnJournal?: TurnJournal;
	// Durable wake ownership (wake-dispatcher.ts): the hooks contract
	// lives at turn/run-ownership.ts.
	runOwnership?: RunOwnershipHooks;
	// The context-window view's store (window-capture.ts): the attempt's
	// final outbound prompt, recorded per conversation, latest wins.
	// Observability, never turn state — a throw is logged, the turn
	// proceeds (the journal owns what must be honest; this row only
	// feeds the view).
	recordWindow?(
		conversationId: string,
		input: { model: string; step: number; capture: WindowCapture; recallVersion: number },
	): void;
	windowVersion?(): number;
	// #418: native Claude session records, one per (conversation, model
	// ref). Absent = every claude turn runs the pre-#418 full-prompt
	// path and nothing is persisted.
	claudeSessions?: ClaudeSessionStore | undefined;
	// After a completed turn, off the reply path — the curator pass
	// gate (interval, config) lives in the callback. A throw is logged
	// and swallowed: curation never fails a turn.
	onTurnSettled?: (convId: string) => void;
}

export class FencedError extends Error {
	constructor(convId: string) {
		super(`turn fenced: conversation ${convId} epoch advanced`);
		this.name = "FencedError";
	}
}

// The runtime's side of one attempt: the rails' scope plus what only
// the phases before a landing read.
interface Attempt extends AttemptScope {
	// The first member's sink owns delivery hooks.
	sink: TurnSink;
	activeFloor: number;
	priorInputTokens: number | null;
	// checkAuthority plus the journal's fault box — the engine's and the
	// step rules' check.
	assertAuthority(): void;
}

// What openSeams hands the later phases.
interface AttemptSeams {
	auth: ToolAuthority;
	tools: Tools;
	step: TurnStep;
	rules: StepRules;
	engine: TurnEngine;
	overflowRecoverable: boolean;
}

type ViewOptions = Parameters<typeof buildModelView>[1];

interface AttemptView {
	ctx: ViewContext;
	options: ViewOptions;
	messages: Awaited<ReturnType<typeof buildModelView>>;
	// #418: the recorded native session the step resumes, if any.
	claudeRec: ClaudeSessionRecord | null;
	sentSeqMax: number | null;
	// Steers the attempt folded mid-turn (#582) — the native
	// session holds them, so the record's watermark may cover them.
	foldedSeqs: Set<number>;
}

type CompletedStream = Extract<StreamOutcome, { kind: "ok" }>;

export class Runtime {
	private lanes = new LaneRegistry();
	private readonly pendingInputs: PendingInputs;
	private turnEndWatchers = new Map<string, boolean>();
	private readonly lastTurnTools = new Map<
		string,
		{ epoch: number; tools: SDKToolSet; hydratedModelOutputTools?: string[] }
	>();
	// Closed runtimes record submits but never run them.
	private closed = false;
	// The runtime supplies ordering and the prior-turn chain, not gate
	// logic — Reviewer owns the rest.
	private reviewer: Reviewer | undefined;
	// The stream records turn writes into the catalog.
	private skillWatch: SkillWatch | undefined;
	// Optional watchdog; repeat detection and context limits still apply when
	// it is absent.
	private loopWatchdog: { decide: System1Client["decide"]; every: number } | null = null;
	// Reviewer sequence number; gate latency must not reorder reviews.
	private turnCounter = 0;
	// Previous reviewable turn per conversation, used as correction evidence.
	// Off-the-record turns deliberately break this chain.
	private lastTurns = new Map<string, PriorTurnContext>();

	constructor(private deps: RuntimeDeps) {
		this.pendingInputs = new PendingInputs(deps.store.db);
	}

	setReviewer(reviewer: Reviewer): void {
		this.reviewer = reviewer;
	}

	// The composition root owns the dirs and the recorder; the stream owns
	// the observation. Null unwires it (tests, provenance off).
	setSkillWatch(watch: SkillWatch | null): void {
		this.skillWatch = watch ?? undefined;
	}

	setLoopWatchdog(watchdog: { decide: System1Client["decide"]; every?: number } | null): void {
		this.loopWatchdog =
			watchdog === null
				? null
				: { decide: watchdog.decide, every: watchdog.every ?? LOOP_CHECK_EVERY };
	}

	// Guest mode checks this before submitting so a second summon cannot steer
	// an existing turn.
	hasActiveTurn(conversationId: string): boolean {
		return this.lanes.hasActiveTurn(conversationId);
	}

	// Persist immediately; the return value distinguishes lane admission from
	// history-only recording after shutdown. The message is durable even when
	// no turn can be admitted.
	submit(conv: Conversation, message: Message, sink: TurnSink): boolean {
		const seqs = this.deps.store.append(conv.id, [message]);
		return this.admit(conv, message, sink, seqs[0]!);
	}

	// The inbox has already persisted this message; appending again would
	// duplicate a recovered turn. `seq` is that persisted event's seq — the
	// persisting caller watched the append, so the queue never has to guess
	// it from a client message id.
	submitPersisted(conv: Conversation, message: Message, sink: TurnSink, seq: number): boolean {
		return this.admit(conv, message, sink, seq);
	}

	submitPending(
		conv: Conversation,
		message: Message,
		mode: PendingInputMode,
		sink: TurnSink,
	): string {
		if (!this.busy(conv.id)) throw new Error(`cannot queue pending input on idle conversation ${conv.id}`);
		const row = this.pendingInputs.add(conv.id, message, mode);
		this.lanes.enqueue(conv.id, {
			seq: null,
			pending: { id: row.id, mode },
			message,
			sink,
			doneSent: false,
		});
		this.lanes.emitConversation(conv.id, { type: "pending" });
		this.lanes.startDraining(conv.id, () => this.drain(conv.id));
		log.info("app pending input added", { conversation: conv.id, pendingId: row.id, mode });
		return row.id;
	}

	listPending(convId: string): ReturnType<PendingInputs["list"]> {
		return this.pendingInputs.list(convId);
	}

	dequeuePending(convId: string, pendingId: string): Message | null {
		const removed = this.lanes.removePending(convId, pendingId);
		if (removed === null) {
			log.info("app pending input dequeue refused", {
				conversation: convId,
				pendingId,
				reason: "already-taken",
			});
			return null;
		}
		let input: ReturnType<PendingInputs["take"]>;
		try {
			input = this.deps.store.db.transaction(() => this.pendingInputs.take(pendingId))();
			if (input === null) throw new Error(`pending input row ${pendingId} missing during dequeue`);
		} catch (err) {
			this.lanes.restorePending(convId, removed.turn, removed.index);
			throw err;
		}
		this.lanes.emitConversation(convId, { type: "pending" });
		log.info("app pending input dequeued", { conversation: convId, pendingId });
		return input.message;
	}

	// A live admission by client-visible id — loose matching for
	// callers that only carry the id. `eventSeq` tightens it to one
	// durable event: a different admitted event reusing the same client
	// id must not stand in for the seq the caller actually means.
	isAdmitted(conversationId: string, messageId: string, eventSeq?: number): boolean {
		return this.lanes.isAdmitted(conversationId, messageId, eventSeq);
	}

	private admit(conv: Conversation, message: Message, sink: TurnSink, seq: number): boolean {
		if (this.closed) {
			void this.notifyDone({ seq, message, sink, doneSent: false }, { kind: "fenced" });
			return false;
		}
		this.lanes.enqueue(conv.id, { seq, message, sink, doneSent: false });
		this.lanes.startDraining(conv.id, () => this.drain(conv.id));
		return true;
	}

	// Callers offering future work must gate on this after shutdown; submit still
	// records and fences the message.
	accepting(): boolean {
		return !this.closed;
	}

	// Busy is the lane holding any work — a claimed or queued turn, or a
	// queued/in-flight compaction. Compaction counts because it rewrites
	// the model view between turns: app retries use this to avoid turning
	// a retry into steering input.
	busy(convId: string): boolean {
		return this.lanes.busy(convId);
	}

	// Every conversation busy() would report — the release script's idle
	// wait reads this through the loopback /api/runtime/busy endpoint.
	busyConversations(): string[] {
		return this.lanes.busyConversations();
	}

	subscribeConversation(
		convId: string,
		listener: (event: ConversationEvent) => void,
	): () => void {
		return this.lanes.subscribeConversation(convId, listener);
	}

	conversationLive(convId: string): boolean {
		const live = this.lanes.liveOf(convId);
		return live !== null && !live.ended;
	}

	attachLiveChunks(
		convId: string,
		onChunk: (chunk: MessageChunk) => void,
		onEnd: (done: TurnDone) => void,
	): { replay: MessageChunk[]; detach: () => void } | null {
		const live = this.lanes.liveOf(convId);
		if (live === null || live.ended) return null;
		const subscriber: LiveSubscriber = { onChunk, onEnd };
		live.subscribers.add(subscriber);
		return {
			replay: [...live.chunks],
			detach: () => live.subscribers.delete(subscriber),
		};
	}

	hasConversationWatchers(convId: string): boolean {
		return (
			this.lanes.conversationSubscriberCount(convId) > 0 ||
			(this.lanes.liveOf(convId)?.subscribers.size ?? 0) > 0
		);
	}

	turnHadWatchersAtEnd(convId: string): boolean {
		return this.turnEndWatchers.get(convId) ?? this.hasConversationWatchers(convId);
	}

	conversationEventSubscriberCount(convId: string): number {
		return this.lanes.conversationSubscriberCount(convId);
	}

	// Close intake, fence live lanes, and await their terminal sink flushes.
	async shutdown(): Promise<void> {
		this.closed = true;
		// Drained lanes may still have pending gates or reviews; fence them too.
		if (this.reviewer) {
			const reviewsCancelled = this.reviewer.cancelAllReviews();
			log.info("reviewer shutdown fenced", { reviewsCancelled });
		}
		const drains: Promise<void>[] = [];
		for (const convId of this.lanes.conversationIds()) {
			// Await dropped sinks so shutdown does not cut off their final flush.
			drains.push(this.stop(convId).settled);
		}
		drains.push(...this.lanes.drainingPromises());
		await Promise.all(drains);
	}

	// /stop advances the epoch, aborts live work, drops queued work, cancels
	// compaction and reviews, and still settles every dropped sink. `stopped`
	// is synchronous; `settled` waits for terminal delivery; `active` waits
	// for the turn that was running at call time to leave runTurn — the
	// record (the unlanded progress event) is in history by then. A queued
	// compact resolves as a noop so the command waiting on it still completes.
	stop(convId: string): {
		stopped: boolean;
		settled: Promise<void>;
		reviewsCancelled: number;
		active: Promise<void>;
	} {
		const epoch = this.deps.store.bumpEpochIfPresent(convId);
		if (epoch === null) {
			log.info("stop — conversation already gone", { conversation: convId });
			return {
				stopped: false,
				settled: Promise.resolve(),
				reviewsCancelled: 0,
				active: Promise.resolve(),
			};
		}
		return this.cancelFenced(convId, epoch);
	}

	// The caller commits the epoch transaction first. Fence and cancellation stay
	// outside that transaction with no await or intervening submission.
	cancelFenced(
		convId: string,
		epoch: number,
	): { stopped: boolean; settled: Promise<void>; reviewsCancelled: number; active: Promise<void> } {
		if (
			!Number.isSafeInteger(epoch) ||
			epoch <= 0 ||
			this.deps.store.get(convId)?.epoch !== epoch
		) {
			throw new Error(
				`cannot cancel conversation ${convId}: committed epoch ${epoch} no longer matches`,
			);
		}
		const dropped = this.lanes.dropAll(convId);
		this.movePendingToHistory(dropped.turns, "stop-move");
		if (dropped.turns.some((turn) => turn.pending !== undefined)) {
			this.lanes.emitConversation(convId, { type: "pending" });
		}
		const notifies: Promise<void>[] = [];
		for (const t of dropped.turns) {
			notifies.push(this.notifyDone(t, { kind: "fenced" }));
		}
		for (const c of dropped.compacts) {
			c.resolve({ kind: "noop", reason: "stopped" });
		}
		const reviewsCancelled = this.reviewer ? this.reviewer.cancelReviews(convId) : 0;
		if (dropped.stopped) {
			log.info("turn stopped", { conversation: convId, epoch, reviewsCancelled });
		} else {
			log.debug("stop — nothing was running", { conversation: convId, epoch, reviewsCancelled });
		}
		return {
			stopped: dropped.stopped,
			settled: Promise.all(notifies).then(() => undefined),
			reviewsCancelled,
			// Captured here — the turn running at call time, not any submitted later.
			active: this.lanes.activeTurn(convId) ?? Promise.resolve(),
		};
	}

	private materializeClaimed(convId: string, turns: QueuedTurn[]): void {
		const pending = turns.filter((turn) => turn.pending !== undefined);
		if (pending.length === 0) return;
		const claimed = this.deps.store.db.transaction(() =>
			pending.map((turn) => {
				const meta = turn.pending!;
				const row = this.pendingInputs.take(meta.id);
				if (row === null || row.conversation !== convId) {
					throw new Error(`pending input ${meta.id} missing from ${convId} during claim`);
				}
				const seq = this.deps.store.append(convId, [row.message])[0]!;
				return { turn, id: meta.id, seq };
			}),
		)();
		for (const { turn, id, seq } of claimed) {
			turn.seq = seq;
			delete turn.pending;
			log.info("app pending input claimed", {
				conversation: convId,
				pendingId: id,
				seq,
			});
		}
		this.lanes.emitConversation(convId, { type: "pending" });
	}

	private movePendingToHistory(turns: QueuedTurn[], reason: "stop-move"): void {
		const pending = turns.filter((turn) => turn.pending !== undefined);
		if (pending.length === 0) return;
		const moved = this.deps.store.db.transaction(() =>
			pending.map((turn) => {
				const meta = turn.pending!;
				const row = this.pendingInputs.take(meta.id);
				if (row === null) throw new Error(`pending input row ${meta.id} missing during ${reason}`);
				const seq = this.deps.store.append(row.conversation, [row.message])[0]!;
				return { turn, row, seq };
			}),
		)();
		for (const { turn, row, seq } of moved) {
			turn.seq = seq;
			delete turn.pending;
			log.info(`app pending input ${reason}`, {
				conversation: row.conversation,
				pendingId: row.id,
				seq,
			});
		}
	}

	// Queue compaction behind the running turn so its response is not orphaned.
	compact(conv: Conversation, focus?: string): Promise<CompactionOutcome> {
		return new Promise<CompactionOutcome>((resolve, reject) => {
			this.lanes.enqueueCompact({ conv, reason: "manual", focus, resolve, reject });
			this.lanes.startDraining(conv.id, () => this.drain(conv.id));
		});
	}

	async idleFold(convId: string): Promise<"compacted" | "noop" | "busy" | "gone"> {
		const conv = this.deps.store.get(convId);
		if (conv === null) return "gone";
		if (this.lanes.busy(convId)) return "busy";
		const outcome = await new Promise<CompactionOutcome>((resolve, reject) => {
			this.lanes.enqueueCompact({ conv, reason: "idle", resolve, reject });
			this.lanes.startDraining(convId, () => this.drain(convId));
		});
		return outcome.kind === "compacted" ? "compacted" : "noop";
	}

	private async doCompact(
		conv: Conversation,
		reason: "threshold" | "manual" | "idle" | "overflow" | "preempt",
		activeFloor?: number,
		focus?: string,
	): Promise<CompactionOutcome> {
		return runCompactJob(conv, reason, activeFloor, focus, {
			store: this.deps.store,
			compaction: this.deps.compaction,
			captureConversation: this.deps.captureConversation,
			modelFallbacks: this.deps.modelFallbacks,
			budgets: compactionBudgets,
			checkAuthority: (convId, epoch) => this.checkAuthority(convId, epoch),
			foldCeiling: (convId, floor) => this.lanes.pendingFloor(convId, floor),
			makePrefix: async (target, modelRef, signal, foldedThroughSeq) => {
				const seam = this.deps.compaction;
				if (seam === undefined) return null;
				const storedTools = this.deps.store.lastTurnTools(target.id);
				if (storedTools === null || storedTools.epoch !== target.epoch) return null;
				let lastTurn = this.lastTurnTools.get(target.id);
				if (lastTurn === undefined) {
					const tools = restoreToolSet(storedTools.tools);
					lastTurn = {
						epoch: storedTools.epoch,
						tools,
						hydratedModelOutputTools: storedModelOutputTools(storedTools.tools),
					};
					this.lastTurnTools.set(target.id, lastTurn);
					log.info("last-turn tools hydrated", {
						conversation: target.id,
						epoch: storedTools.epoch,
						tools: Object.keys(tools).length,
					});
				}
				if (lastTurn.epoch !== target.epoch) return null;
				const claudeStep = seam.claudePrefixStep?.(target, modelRef) ?? null;
				const engine = this.deps.engines.find((candidate): candidate is ClaudeEngine =>
					candidate.id === "claude-code" &&
					"forkSummarize" in candidate &&
					typeof candidate.forkSummarize === "function",
				);
				if (claudeStep !== null && engine !== undefined) {
					const noVoice = async (_audio: Uint8Array): Promise<void> => {};
					const recording = (): (() => void) => () => {};
					const noFile = async (_file: OutgoingFile): Promise<void> => {};
					const availableTools = this.deps.makeTools(
						target,
						noVoice,
						recording,
						noFile,
						{
							runId: "compaction-summary",
							sourceMessageId: () => "",
							sourceInputSeq: () => null,
							contextFill: () => null,
						},
					);
					const domainTools: Tools = {};
					for (const name of Object.keys(lastTurn.tools)) {
						const definition = availableTools[name];
						if (definition !== undefined) domainTools[name] = definition;
					}
					const exactTools = await persistableToolSet(domainTools);
					if ("unpersistable" in exactTools || exactTools.json !== storedTools.json) {
						log.warn("claude compaction tool definitions differ from last turn — using text mode", {
							conversation: target.id,
							unpersistable: "unpersistable" in exactTools ? exactTools.unpersistable : null,
						});
						return null;
					}
					const summarizer: PrefixSummarizer = {
						modelRef,
						mode: "claude-code",
						async call(turns, callSignal, cut, context) {
							if (context === undefined && cut === undefined) {
								throw new Error("claude-code prefix summary context is missing");
							}
							const callContext = context ?? {
								foldedText: "",
								previousSummary: null,
								foldedThroughSeq,
							};
							const prompt = [
								...(callContext.previousSummary === null
									? []
									: [`Previous goblin summary (verbatim):\n${callContext.previousSummary}`]),
								callContext.foldedText,
								...turns.map((turn) =>
									turn.role === "assistant"
										? `Rejected previous summary attempt:\n${turn.text}`
										: turn.text,
								),
							].join("\n\n");
							return engine.forkSummarize!({
								conversationId: target.id,
								modelRef,
								step: claudeStep,
								tools: domainTools,
								foldedThroughSeq: callContext.foldedThroughSeq,
								prompt,
								signal: callSignal,
								...(cut !== undefined ? { cut } : {}),
							});
						},
					};
					return summarizer;
				}
				if (seam.prefixStep === undefined) return null;
				const prefixStep = await seam.prefixStep(target, modelRef);
				if (prefixStep === null) return null;
				const prefixInput = {
					conv: target,
					step: prefixStep,
					store: this.deps.store,
					tools: lastTurn.tools,
					...(lastTurn.hydratedModelOutputTools !== undefined
						? { hydratedModelOutputTools: lastTurn.hydratedModelOutputTools }
						: {}),
					...(this.deps.memory !== undefined ? { memory: this.deps.memory } : {}),
					foldCeiling: () => this.lanes.pendingFloor(target.id, activeFloor),
					assertAuthority: () => {
						signal.throwIfAborted();
						this.checkAuthority(target.id, target.epoch);
					},
				};
				const summarizer = makePrefixSummarizer(prefixInput);
				const prefixFlush = seam.prefixFlush?.({
					...prefixInput,
					modelRef,
				});
				return {
					...summarizer,
					...(prefixFlush !== undefined && prefixFlush !== null ? { flush: prefixFlush } : {}),
				};
			},
			holdController: (controller) => this.lanes.holdCompactController(conv.id, controller),
			releaseController: (controller) =>
				this.lanes.releaseCompactController(conv.id, controller),
		});
	}

	// A fence landing while the runtime is closed is a shutdown — stamp the
	// cause once so every consumer (member sinks and reattached live
	// streams) sees the same terminal value. Idempotent.
	private withCause(done: TurnDone): TurnDone {
		return done.kind === "fenced" && this.closed ? { kind: "fenced", shutdown: true } : done;
	}

	// Keep terminal delivery exactly once, even when a sink throws. Mark before
	// invoking the hook so re-entrant error handling cannot notify it twice.
	private async notifyDone(turn: QueuedTurn, done: TurnDone): Promise<void> {
		if (turn.doneSent) return;
		turn.doneSent = true;
		try {
			await turn.sink.onDone(this.withCause(done));
		} catch (err) {
			log.warn("sink onDone failed", err);
		} finally {
			turn.release?.();
		}
	}

	// Awaiting work must not outlive the captured conversation epoch. Settings
	// mutations advance the epoch even when they do not abort the controller.
	private checkAuthority(convId: string, epoch: number): void {
		const current = this.deps.store.epochOf(convId) ?? undefined;
		if (current !== epoch) throw new FencedError(convId);
	}

	private claimQueuedMembers(
		convId: string,
		sink: TurnSink,
		live: LiveWire,
		members: ClaimedTurn[],
	): ClaimedTurn[] {
		return claimMembers<ClaimedTurn>(
			convId,
			() =>
				this.lanes.claim(
					convId,
					sink.delivery === "stream",
					false,
					(turns) => this.materializeClaimed(convId, turns),
					true,
				),
			live,
			members,
		) as ClaimedTurn[];
	}

	private async recallMemory(
		conv: Conversation,
		anchorSeq: number | null,
		history: Message[],
		signal: AbortSignal,
		epoch: number,
	): Promise<{ prior: RecallContext[]; current: RecallContext | null }> {
		return recallMemory({
			conv,
			anchorSeq,
			history,
			signal,
			memory: this.deps.memory,
			assertAuthority: () => this.checkAuthority(conv.id, epoch),
			isExcluded: () => this.deps.store.get(conv.id)?.memoryExcluded ?? conv.memoryExcluded,
		});
	}

	private async drain(convId: string): Promise<void> {
		if (!this.lanes.beginDrain(convId)) return;
		try {
			for (;;) {
				// Coalesce the claimable queue into one conversational beat; a
				// left-behind streaming item starts the next pass. The head sink's
				// delivery mode determines the claim boundary.
				const turns = this.lanes.claim(
					convId,
					this.lanes.headStreams(convId),
					true,
					(claimed) => this.materializeClaimed(convId, claimed),
				);
				if (turns.length > 0) {
					if (turns.length > 1) {
						log.info("queued submits coalesced", {
							conversation: convId,
							count: turns.length,
						});
					}
					try {
						this.deps.pruneBetweenTurns?.(convId);
					} catch (err) {
						log.error("cache pruning pass failed — turn proceeds", err, {
							conversation: convId,
						});
					}
					// The /stop settle seam: `active` resolves once this turn's
					// runTurn has returned — history writes and terminal sink
					// notifications included, the crash guard either way. Set
					// before the first await so a stop racing the claim reads it.
					let settleActiveTurn: () => void = () => {};
					const activeTurn = new Promise<void>((resolve) => {
						settleActiveTurn = resolve;
					});
					this.lanes.setActiveTurn(convId, activeTurn);
					try {
						try {
							await this.runTurn(convId, turns);
						} catch (err) {
							// Last-ditch guard: one bad turn must not stall the lane or leak sinks.
							// Expected failures have already notified their members.
							log.error("turn crashed", err, { conversation: convId });
							const done: TurnDone = {
								kind: "error",
								message: err instanceof Error ? err.message : String(err),
							};
							// End before a successor can replace the live wire, or
							// attached subscribers would hang without a terminal event.
							const crashed = this.lanes.liveOf(convId);
							if (crashed !== null) endLive(crashed, done, convId);
							for (const t of turns) await this.notifyDone(t, done);
						}
						// A finished turn must not make /stop report live work.
						this.lanes.registerController(convId, null);
					} finally {
						settleActiveTurn();
						this.lanes.setActiveTurn(convId, null);
					}
					continue;
				}
				// Run queued compaction only between whole turns.
				const job = this.lanes.nextCompact(convId);
				if (job !== undefined) {
					try {
						job.resolve(await this.doCompact(job.conv, job.reason, undefined, job.focus));
					} catch (err) {
						job.reject(err);
					}
					continue;
				}
				return;
			}
		} finally {
			this.lanes.endDrain(convId);
		}
	}

	// Keep one wire log and membership across attempts; recovery controls the
	// next attempt without recursion. The live log therefore survives overflow
	// while late subscribers retain one continuous stream.
	private async runTurn(convId: string, turns: ClaimedTurn[]): Promise<void> {
		const live = openLive();
		// An overflow/fallback continuation enters the same recovery slot
		// its decision fills — the attempt loop consumes it identically.
		// The wire is always the fresh log: the failed attempt's went away
		// with its row.
		let recovery: TurnRecovery | undefined;
		let members = turns;
		for (;;) {
			const outcome = await this.runAttempt(convId, members, recovery, live);
			if (outcome.kind === "done") return;
			recovery = outcome.recovery;
			members = outcome.turns;
		}
	}

	// A terminal attempt has settled its sinks; an overflow may return a
	// recovery decision. `live` spans all attempts and late subscribers, so an
	// attach cannot mistake a resumed attempt for a new turn.
	private async runAttempt(
		convId: string,
		turns: ClaimedTurn[],
		recovery: TurnRecovery | undefined,
		live: LiveChunks,
	): Promise<AttemptOutcome> {
		const a = await this.openAttempt(convId, turns, recovery, live);
		if (a === null) return { kind: "done" };
		try {
			await this.runAdmitted(a);
		} catch (err) {
			// The rail order is load-bearing (runtime-rails.ts): a journal
			// fault outranks every other cause, then a fence, then the one
			// overflow recovery; anything else is the error rail.
			const fault = a.record.journalFault.current;
			if (fault !== undefined) return await journalFaultRail(a, fault);
			if (err instanceof FencedError || a.controller.signal.aborted) return await fencedRail(a, err);
			if (err instanceof ContextOverflowError) return await overflowRail(a, err);
			return await errorRail(a, err);
		} finally {
			// Whatever escaped the catch above — a throw inside recovery
			// or notifyAll — must not leave a begun row 'running': rows
			// left 'running' mean process death (a graceful shutdown
			// included, #471), and only the journal gets to say that. The
			// shutdown fence's leaveRunning seals the record first, so
			// this guard stays a no-op on the one deliberate escape.
			a.record.stampRun("error", "failed");
		}
		return { kind: "done" };
	}

	// Admission fixes the attempt's ownership and model input; the rest
	// is the attempt's fixed scope. Null when admission refused — the
	// members are settled. Nothing here is inside the rails: a throw
	// escapes to the drain's last-ditch settle.
	private async openAttempt(
		convId: string,
		turns: ClaimedTurn[],
		recovery: TurnRecovery | undefined,
		live: LiveChunks,
	): Promise<Attempt | null> {
		const { store } = this.deps;
		const recallVersion = this.attemptRecallVersion(convId, recovery);
		// Preserve loop history across overflow, while attempt-scoped state resets.
		// Completed tool calls stay in the recovery package as evidence —
		// they are never re-entered from this list; the journal's recovery
		// guard owns what a fresh invocation may do.
		const state = new TurnState(
			{
				convId,
				watchdog: this.loopWatchdog,
				request: messageText(turns[0]!.message),
			},
			recovery?.loop,
		);
		// The first sink owns delivery hooks; streaming members receive chunks and
		// every member receives one terminal notification. Replies belong to the
		// conversation, not to the connection that submitted first.
		const sink = turns[0]!.sink;
		const notifyAll = async (done: TurnDone) => {
			// One stamped value for the live wire and every member sink — a
			// reattached app stream reads the shutdown cause off endLive too.
			const final = this.withCause(done);
			this.turnEndWatchers.set(convId, this.hasConversationWatchers(convId));
			endLive(live, final, convId);
			for (const t of turns) await this.notifyDone(t, final);
			this.lanes.emitConversation(convId, { type: "turn-end" });
			this.turnEndWatchers.delete(convId);
		};
		const progress: AttemptProgress = {
			memory: { prior: [], current: null },
			authority: undefined,
			filterRetryUsed: recovery?.filterRetryUsed ?? false,
			errorHeld: false,
		};
		// The ownership window: from admission until the begin hook, the
		// attempt's members are unlinked — a terminal failure in that span
		// (a refused admission included) is invisible to the dispatcher's
		// reconcile (no run row to read), so it must be announced instead
		// of re-admitting the trigger forever. The authority seam owns the
		// begun fact; before it exists there is no row to link, so
		// announcing is always right there.
		const announcePreRunFailure = (err: unknown) => {
			if (progress.authority?.ownershipBegun === true) return;
			this.deps.runOwnership?.preRunFailure?.({
				conversationId: convId,
				memberSeqs: turns.map(queuedSeq),
				error: err instanceof Error ? err.message : String(err),
			});
		};
		// A throw is still a terminal death inside the ownership window, so
		// it announces the same as a refused admission before propagating.
		let admitted: ReturnType<typeof admitTurn>;
		try {
			admitted = admitTurn(
				{
					convId,
					live,
					getConversation: () => store.get(convId),
					captureConversation: this.deps.captureConversation,
					claimQueued: (wire) => this.claimQueuedMembers(convId, sink, wire, turns),
					pendingSeqs: () => this.lanes.pendingSeqs(convId),
					// Read after claimQueued — it can add members to `turns`.
					ownedInputSeqs: () => new Set(turns.map(queuedSeq)),
					modelEntries: () => store.modelEntries(convId),
					now: Date.now,
				},
				recovery === undefined
					? undefined
					: { conversation: recovery.conversation, startedAt: recovery.startedAt },
			);
		} catch (err) {
			announcePreRunFailure(err);
			throw err;
		}
		if (admitted.kind !== "admitted") {
			announcePreRunFailure(
				admitted.kind === "missing" ? "conversation missing" : admitted.message,
			);
			await notifyAll({
				kind: "error",
				message: admitted.kind === "missing" ? "conversation missing" : admitted.message,
			});
			return null;
		}
		const { snapshot } = admitted;
		const { conv, epoch, entries } = snapshot;
		// Continuation inputs join `turns` before admission so all paths
		// settle them. An admission failure must not strand a member
		// claimed during recovery.
		const ownedInputSeqs = new Set([
			...snapshot.ownedInputSeqs,
			...(recovery?.ownedInputSeqs ?? []),
		]);
		const admissionExchangeExcluded =
			recovery?.admissionExchangeExcluded === true ||
			activeExchangeExcluded(entries, store.memoryEligibility(convId));
		if (admissionExchangeExcluded) {
			log.info("memory exchange excluded at admission", {
				conversation: convId,
				inherited: recovery?.admissionExchangeExcluded === true,
			});
		}
		const ownedInputExcluded = () => {
			const eligible = store.memoryEligibility(convId).eligibleSeqs;
			return admissionExchangeExcluded || [...ownedInputSeqs].some((seq) => !eligible.has(seq));
		};
		const holdsAuthority = (): boolean => store.get(convId)?.epoch === epoch;
		sink.setAuthorityCheck?.(holdsAuthority, snapshot.anchorSeq, ownedInputExcluded);
		const controller = new AbortController();
		this.lanes.registerController(convId, controller);
		const hadLiveWire = this.conversationLive(convId);
		this.lanes.registerLive(convId, live);
		if (!hadLiveWire) this.lanes.emitConversation(convId, { type: "turn-start" });

		// The active exchange starts at the earliest member seq: this turn's
		// stored user events (replies still in flight) and, above them, every
		// input queued behind the running request. Compaction — the pre-empt
		// foldability probe and the fold itself — must see only completed
		// history strictly before it (foldCeiling).
		const activeFloor = Math.min(...turns.map(queuedSeq));
		const sourceInputSeq = (): number | null => {
			let max: number | null = null;
			for (const t of turns) {
				const seq = queuedSeq(t);
				if (max === null || seq > max) max = seq;
			}
			return max ?? recovery?.sourceInputSeq ?? null;
		};
		const lastStoredUsage = [...store.history(convId)]
			.reverse()
			.find((message) => message.role === "assistant" && lastInputTokensOf(message) !== null);
		const priorInputTokens =
			recovery?.overflowed === true || lastStoredUsage === undefined
				? null
				: lastInputTokensOf(lastStoredUsage);
		const checkAuthority = (): void => this.checkAuthority(convId, epoch);
		// The crash journal's per-attempt row — turn/run-record.ts owns its
		// lifecycle; runAttempt's finally guard is the backstop that a
		// begun row never escapes still 'running' except a deliberate
		// shutdown leave (#471).
		const journal = this.deps.turnJournal;
		const record = openRunRecord({
			journal,
			store,
			runOwnership: this.deps.runOwnership,
			modelFallbacks: this.deps.modelFallbacks,
			convId,
			epoch,
			convModel: conv.model,
			recovery,
			ownedInputSeqs,
			// The authority seam mints the id and holds it; the record
			// reads it through this getter — never a write-back callback.
			runId: () => progress.authority?.runId ?? null,
		});
		return {
			convId,
			turns,
			recovery,
			live,
			snapshot,
			recallVersion,
			ownedInputSeqs,
			admissionExchangeExcluded,
			state,
			controller,
			record,
			journal,
			progress,
			sink,
			activeFloor,
			priorInputTokens,
			sourceInputSeq,
			notifyAll,
			announcePreRunFailure,
			shuttingDown: () => this.closed,
			compact: (reason) => this.doCompact(conv, reason, activeFloor),
			checkAuthority,
			holdsAuthority,
			assertAuthority: () => {
				checkAuthority();
				if (record.journalFault.current !== undefined) throw record.journalFault.current;
			},
		};
	}

	// An overflow resume keeps the window version its recall belongs to.
	private attemptRecallVersion(convId: string, recovery: TurnRecovery | undefined): number | null {
		if (recovery !== undefined && recovery.recallVersion !== undefined) return recovery.recallVersion;
		try {
			return this.deps.windowVersion?.() ?? 0;
		} catch (err) {
			log.warn("recall version unreadable — window capture disabled for this attempt", {
				conversation: convId,
				error: String(err),
			});
			return null;
		}
	}

	// Recall through the post-landing work, in order. Every throw lands on
	// runAttempt's rails.
	private async runAdmitted(a: Attempt): Promise<void> {
		const { snapshot } = a;
		a.checkAuthority();
		// Recall uses admission-time eligibility; the model view still sees the
		// full conversation.
		a.progress.memory =
			a.recovery?.memory ??
			(await this.recallMemory(
				snapshot.conv,
				snapshot.anchorSeq,
				memoryBoundEntries(snapshot.entries, this.deps.store.memoryEligibility(a.convId)).map(
					(e) => e.message,
				),
				a.controller.signal,
				snapshot.epoch,
			));
		a.checkAuthority();
		const seams = await this.openSeams(a);
		a.checkAuthority();
		const view = await this.buildView(a, seams);
		const outcome = await this.runEngine(a, seams, view);
		if (outcome.kind === "failed") {
			a.progress.filterRetryUsed = outcome.filterRetryUsed;
			a.progress.errorHeld = outcome.errorHeld === true;
			throw failureFromStream(outcome);
		}
		// A stream that reached its finish while a journal write
		// faulted must not land a reply the journal can't describe.
		if (a.record.journalFault.current !== undefined) throw a.record.journalFault.current;
		const landed = await this.landReply(a, seams, view, outcome);
		await this.afterLanding(a, seams, outcome, landed);
	}

	// Delivery and tool authority are turn-owned seams: the fenced
	// sink hooks (turn/delivery.ts), then the run row + ownership
	// link + the tool fence + step-end persistence's one home,
	// saveStep (turn/tool-authority.ts). Then the step, its rules, and
	// the engine that runs it.
	private async openSeams(a: Attempt): Promise<AttemptSeams> {
		const { convId, turns, sink, snapshot, recovery } = a;
		const { conv, epoch } = snapshot;
		const delivery = sinkDelivery(sink, a.checkAuthority);
		// #477's gate arms only once buildStep names the engine: the
		// streamText engine folds steers at its prepareStep boundary,
		// so a parked steer skips unlaunched calls. A claude-code
		// attempt folds when a tool call settles (#582) and keeps
		// the gate off: the CLI, not goblin, dispatches its calls.
		const steerGate = { armed: false };
		// The attempt's shared engine rules (turn/step-rules.ts) — opened
		// once buildStep names the step; tools read the fill through it.
		let stepRules: StepRules | null = null;
		const auth = openToolAuthority({
			conv,
			convId,
			epoch,
			makeTools: this.deps.makeTools,
			delivery,
			sourceMessageId: () => turns[turns.length - 1]!.message.id,
			record: {
				anchorSeq: snapshot.anchorSeq,
				steerMarkSeed: snapshot.steerMarkSeed,
				startedAtMs: snapshot.turnStartMs,
				ownedInputSeqs: a.ownedInputSeqs,
				admissionExchangeExcluded: a.admissionExchangeExcluded,
				memberSeqs: turns.map(queuedSeq),
				sourceInputSeq: a.sourceInputSeq,
				predecessorRun: recovery?.predecessorRun,
				fallbackConfigured: a.record.fallback.configured,
			},
			journal: a.journal,
			journaled: a.record.journaled,
			journalFault: a.record.journalFault,
			onJournalFault: () => a.controller.abort(),
			runOwnership: this.deps.runOwnership,
			checkAuthority: a.checkAuthority,
			// Same source prepareStep's claim reads — a peek, never a
			// splice; the claim still belongs to the model call.
			steerWaiting: () =>
				steerGate.armed && this.lanes.claimablePending(convId, sink.delivery === "stream"),
			contextFill: () => stepRules?.contextFill() ?? null,
		});
		a.progress.authority = auth;
		const tools = auth.tools;
		await this.rememberTurnTools(convId, epoch, tools);
		const step = await this.deps.buildStep(conv, tools);
		const overflowRecoverable = overflowHoldable(recovery, this.deps.compaction !== undefined);
		const rules = openStepRules({
			convId,
			epoch,
			model: stepModelRef(step),
			state: a.state,
			signal: a.controller.signal,
			contextWindow: step.contextWindow,
			priorInputTokens: a.priorInputTokens,
			filterRetryUsed: a.progress.filterRetryUsed,
			maxRetries: isClaudeStep(step) ? undefined : step.maxRetries,
			transientRetryDelayMs: isClaudeStep(step) ? undefined : step.transientRetryDelayMs,
			overflowRecoverable,
			assertAuthority: a.assertAuthority,
			holdsAuthority: a.holdsAuthority,
			// design/compaction.md → Timing: the step-boundary trigger.
			// Wired only when the fold-resume is possible — the gate and
			// the budget are the same invariant (one fold-resume per
			// logical turn), so an already-resumed attempt keeps
			// dispatching and the 85% context landing stays its backstop.
			...(this.deps.compaction !== undefined && recovery?.overflowed !== true
				? {
						preemptCheck: (info: { projectedInputTokens: number | null; stepNumber: number }) =>
							this.preemptCheck(a, step, info),
					}
				: {}),
		});
		stepRules = rules;
		const engine = pickEngine(this.deps.engines, step, convId);
		steerGate.armed = engine.rules.toolLaunchGate;
		return { auth, tools, step, rules, engine, overflowRecoverable };
	}

	private async rememberTurnTools(convId: string, epoch: number, tools: Tools): Promise<void> {
		this.lastTurnTools.set(convId, { epoch, tools: toToolSet(tools) });
		const persistedTools = await persistableToolSet(tools);
		if ("unpersistable" in persistedTools) {
			this.deps.store.saveLastTurnTools(convId, epoch, null);
			log.warn("last-turn tools not persistable", {
				conversation: convId,
				tool: persistedTools.unpersistable,
			});
			return;
		}
		const stored = this.deps.store.lastTurnTools(convId);
		if (stored?.epoch !== epoch || stored.json !== persistedTools.json) {
			this.deps.store.saveLastTurnTools(convId, epoch, persistedTools.json);
			log.info("last-turn tools persisted", {
				conversation: convId,
				epoch,
				tools: Object.keys(persistedTools.tools).length,
			});
		}
	}

	private preemptCheck(
		a: Attempt,
		step: TurnStep,
		info: { projectedInputTokens: number | null; stepNumber: number },
	): PreemptArm | null {
		const { convId } = a;
		const { store } = this.deps;
		const previousFold = store.getCompaction(convId);
		const arm = preemptArm({
			projectedInputTokens: info.projectedInputTokens,
			contextWindow: step.contextWindow,
		});
		if (arm === null) return null;
		// Never interrupt for a fold that cannot happen: a
		// no-op compact on the recovery rail is a TERMINAL
		// error, and the live turn's own growth is never
		// foldable — only stored history is. A trigger with
		// nothing to fold stands down; a genuinely doomed
		// turn still fails honestly through the overflow
		// rail (a real 400, not a projection).
		const { tailTokenBudget } = compactionBudgets(step.contextWindow ?? null);
		const foldable =
			chooseBoundary(store.historyDetail(convId), {
				tailTokenBudget,
				previousBoundary: previousFold?.boundarySeq ?? null,
				previousSplit: previousFold?.split ?? null,
				// Completed history only — inputs queued behind
				// this request must not push the boundary onto
				// the running exchange.
				beforeSeq: this.lanes.pendingFloor(convId, a.activeFloor),
			}) !== null;
		if (!foldable) {
			log.info("compaction pre-empt stood down — arm fired but nothing foldable", {
				conversation: convId,
				arm,
				step: info.stepNumber,
			});
			return null;
		}
		return arm;
	}

	// Steered messages use the same fixed capability gates as the initial
	// view, preserving the stable prompt prefix. Only the appended tail
	// changes when a steer is folded in.
	private async buildView(a: Attempt, seams: AttemptSeams): Promise<AttemptView> {
		const { convId, snapshot } = a;
		const { step, tools } = seams;
		const { entries } = snapshot;
		const ctx: ViewContext = {
			convId,
			modelRef: stepModelRef(step),
			tools,
			modalities: step.inputModalities,
			carries: step.carries ?? (() => true),
			keepProviderExecuted: !isClaudeStep(step) && step.keepProviderExecuted === true,
			skillRef: resolveSkillRef,
		};
		// #418: a recorded native session sees only the seq delta —
		// entries past seen_seq, minus the reply the session itself
		// produced (it already holds that natively). Entries with no
		// seq — recall inserts, the recovery partial — belong to this
		// turn and ride along inside the view.
		const claudeRec =
			isClaudeStep(step) && this.deps.claudeSessions !== undefined
				? this.deps.claudeSessions.get(convId, step.label)
				: null;
		const viewEntries =
			claudeRec === null
				? entries
				: entries.filter((e) => e.seq > claudeRec.seenSeq && e.seq !== claudeRec.replySeq);
		const sentSeqMax =
			viewEntries.length === 0 ? null : Math.max(...viewEntries.map((e) => e.seq));
		const options: ViewOptions = {
			entries: viewEntries,
			prior: a.progress.memory.prior,
			current: a.progress.memory.current,
			partial: a.recovery?.partial ?? null,
			// The summary entry rides `entries` by its boundary seq —
			// the same store fact eligibility classifies by (#206).
			summarySeq: this.deps.store.memoryEligibility(convId).summarySeq,
			ownedSeqs: snapshot.ownedInputSeqs,
			assertAuthority: a.checkAuthority,
		};
		const messages = await buildModelView(ctx, options);
		return { ctx, options, messages, claudeRec, sentSeqMax, foldedSeqs: new Set<number>() };
	}

	// The engine resumes the recorded session at its head; the
	// fullPrompt thunk stays lazy — only a dead-session retry pays
	// for the second view build.
	private claudeSessionPlan(a: Attempt, step: TurnStep, view: AttemptView) {
		if (!isClaudeStep(step)) return undefined;
		const { convId } = a;
		const { claudeRec } = view;
		return {
			...(claudeRec !== null
				? {
						resume: {
							sessionId: claudeRec.sessionId,
							headUuid: claudeRec.headUuid,
						},
						fullPrompt: () =>
							buildModelView(view.ctx, { ...view.options, entries: a.snapshot.entries }),
					}
				: {}),
			onDrop: () => {
				try {
					this.deps.claudeSessions?.drop(convId, step.label, "session resume failed");
				} catch (err) {
					log.warn("claude session drop failed — turn continues", err, {
						conversation: convId,
					});
				}
			},
		};
	}

	private async runEngine(a: Attempt, seams: AttemptSeams, view: AttemptView): Promise<StreamOutcome> {
		const { convId, turns, sink, live, snapshot, recovery, journal } = a;
		const { auth, tools, step, rules, engine } = seams;
		const { fallback } = a.record;
		const claudeSession = this.claudeSessionPlan(a, step, view);
		const outcome = await engine.run({
			convId,
			epoch: snapshot.epoch,
			head: sink,
			members: turns,
			live,
			state: a.state,
			journal,
			// The authority seam minted the run id and owns it.
			runId: auth.runId,
			// #195: step-end persistence's one home — the engines'
			// checkpoints ride the seam, never the journal directly.
			saveStep: auth.saveStep,
			// A steer that joins mid-run is processed by this run — the
			// wake hook hears only the joined seqs (converts that failed
			// were settled, never joined). Journaled turns only.
			...(journal === undefined
				? {}
				: {
						noteRunMembers: (seqs: number[]) =>
							this.deps.runOwnership?.members(auth.runId, convId, seqs),
					}),
			assertAuthority: a.assertAuthority,
			holdsAuthority: a.holdsAuthority,
			messages: view.messages,
			tools,
			view: view.ctx,
			claimSteers: () =>
				this.lanes.claim(
					convId,
					sink.delivery === "stream",
					false,
					(claimed) => this.materializeClaimed(convId, claimed),
					true,
				),
			unrequeueSteers: (steered) => this.lanes.unrequeue(convId, steered),
			settle: (m, done) => void this.notifyDone(m, done),
			steerMarkSeed: snapshot.steerMarkSeed,
			ownedInputSeqs: [...a.ownedInputSeqs],
			onOwnedInputs: (seqs) => {
				for (const seq of seqs) {
					a.ownedInputSeqs.add(seq);
					view.foldedSeqs.add(seq);
				}
			},
			sourceInputSeq: a.sourceInputSeq,
			partial: recovery?.partial ?? null,
			seenText: recovery?.seenText ?? false,
			toolCalls: recovery ? [...recovery.toolCalls] : [],
			digest: recovery ? [...recovery.digest] : [],
			overflowRecoverable: seams.overflowRecoverable,
			rules,
			evidence: this.reviewer?.evidence,
			skillWatch: this.skillWatch,
			turnStartMs: snapshot.turnStartMs,
			signal: a.controller.signal,
			// Held when a fallback could follow, or when earlier candidates
			// already failed — the terminal error then lists every miss.
			holdZeroEffectError:
				fallback.fresh && (fallback.next() !== undefined || fallback.misses.length > 0),
			...(fallback.misses.length > 0 ? { fallbackMisses: fallback.misses } : {}),
			step,
			...(claudeSession !== undefined ? { claudeSession } : {}),
		});
		// Record the window on both rails — the failed rail throws its
		// recovery/error, and the request went out either way.
		if (outcome.window !== null && a.recallVersion !== null) {
			try {
				this.deps.recordWindow?.(convId, {
					model: outcome.model,
					step: outcome.steps,
					capture: outcome.window,
					recallVersion: a.recallVersion,
				});
			} catch (err) {
				log.error("context window record failed — turn continues", err, {
					conversation: convId,
				});
			}
		}
		return outcome;
	}

	// Land the durable reply, then keep the post-delivery authority check:
	// a stop during sink flushing must fence follow-up work. Persistence and
	// delivery are both on the same authority-checked finish path.
	private async landReply(
		a: Attempt,
		seams: AttemptSeams,
		view: AttemptView,
		outcome: CompletedStream,
	): Promise<LandedAttempt> {
		const { convId, turns, sink, live, snapshot, record, journal } = a;
		const { conv, epoch, entries } = snapshot;
		const { store } = this.deps;
		// A pending or failed steer can have a seq below the final mark.
		// Only admission-visible or successfully consumed users were read.
		const visibleUserSeqs = new Set(
			entries.filter((e) => e.message.role === "user").map((e) => e.seq),
		);
		let landedReplySeq: number | null = null;
		const landed = landAttempt({
			convId,
			epoch,
			conv,
			// Live flag, like the reviewer's — a mid-turn exclusion
			// lands the reply but ships no memory.
			memoryExcluded: () => store.get(convId)?.memoryExcluded ?? conv.memoryExcluded,
			modelEntries: () =>
				store
					.modelEntries(convId)
					.filter(
						(e) =>
							e.message.role !== "user" ||
							visibleUserSeqs.has(e.seq) ||
							a.ownedInputSeqs.has(e.seq),
					),
			memoryEligibility: () => store.memoryEligibility(convId),
			steerMark: outcome.steerMark,
			ownedInputSeqs: a.ownedInputSeqs,
			admissionExchangeExcluded: a.admissionExchangeExcluded,
			responseMessage: outcome.responseMessage,
			finishReason: outcome.finishReason,
			usage: outcome.usage,
			lastStepInputTokens: outcome.lastStepInputTokens,
			contextWindow: seams.step.contextWindow,
			forcedKind: a.state.forcedCompletion(),
			sink,
			members: turns,
			live,
			// The reply and the fact it landed are one commit: a kill
			// inside terminal delivery must never leave a durable
			// reply behind a run row that still claims none — boot
			// recovery's interrupted rail reads the flag.
			append: (messages, opts) =>
				store.db.transaction(() => {
					const seqs = store.append(convId, messages, opts);
					landedReplySeq = seqs[0] ?? null;
					record.journaled(() => journal?.noteReplyLanded(seams.auth.runId, landedReplySeq));
					return seqs;
				})(),
			memory: this.deps.memory,
		});
		// The reply landed durably — a failure past this point must not
		// also record a progress event (the final reply is the record).
		record.markReplyLanded();
		this.advanceClaudeSession(a, seams.step, view, outcome, landedReplySeq);
		const { fallback } = record;
		const fallbackNote: FallbackNote | undefined =
			fallback.misses.length > 0 && conv.model !== null
				? {
						servedBy: conv.model,
						misses: fallback.misses.map(({ ref, reason }) => ({ ref, reason })),
					}
				: undefined;
		await a.notifyAll(
			fallbackNote !== undefined && landed.done.kind === "completed"
				? { ...landed.done, fallback: fallbackNote }
				: landed.done,
		);
		record.stampRun("completed", "delivered");
		// A stop during terminal delivery must prevent follow-up work.
		a.checkAuthority();
		// Clear the turn controller before retention/review/compaction so /stop
		// reports no generating turn; compaction has its own controller.
		this.lanes.releaseController(convId, a.controller);
		return landed;
	}

	// #418: advance the native session record only now — the reply
	// is durable, so the next turn resumes at this head with a
	// delta cut at these seqs. Interrupted and failed turns never
	// reach this and leave the record at the last finish.
	private advanceClaudeSession(
		a: Attempt,
		step: TurnStep,
		view: AttemptView,
		outcome: CompletedStream,
		landedReplySeq: number | null,
	): void {
		if (!isClaudeStep(step) || outcome.claudeSession === undefined || landedReplySeq === null) {
			return;
		}
		const { convId } = a;
		const { foldedSeqs } = view;
		const headUuid = outcome.claudeSession.headUuid;
		let seenSeq = view.sentSeqMax ?? view.claudeRec?.seenSeq ?? 0;
		if (foldedSeqs.size > 0) {
			// Advance past the folded steers only when every entry
			// up to the last one was sent: a message still queued
			// between them must reach the next turn's delta. A held
			// watermark re-sends the steers instead — a duplicate,
			// never a loss.
			const top = Math.max(...foldedSeqs);
			const unsent = this.deps.store
				.modelEntries(convId)
				.filter((e) => e.seq > seenSeq && e.seq <= top && !foldedSeqs.has(e.seq))
				.map((e) => e.seq);
			if (unsent.length === 0) seenSeq = top;
			else {
				log.info("claude session watermark held below folded steers", {
					conversation: convId,
					seenSeq,
					folded: [...foldedSeqs],
					unsent,
				});
			}
		}
		if (headUuid === "") {
			log.warn("claude session head missing — record not advanced", {
				conversation: convId,
			});
			return;
		}
		try {
			this.deps.claudeSessions?.put({
				conversationId: convId,
				modelRef: step.label,
				sessionId: outcome.claudeSession.sessionId,
				headUuid,
				seenSeq,
				replySeq: landedReplySeq,
			});
		} catch (err) {
			log.warn("claude session record write failed — turn continues", err, {
				conversation: convId,
			});
		}
	}

	// Off the reply path: review, threshold compaction, the curator pass.
	private async afterLanding(
		a: Attempt,
		seams: AttemptSeams,
		outcome: CompletedStream,
		landed: LandedAttempt,
	): Promise<void> {
		const { convId } = a;
		const { conv, epoch } = a.snapshot;
		const { store } = this.deps;
		// Review receives the completed exchange and prior-turn chain off-lane.
		submitTurnReview({
			convId,
			reviewer: this.reviewer,
			memoryExcluded: () => store.get(convId)?.memoryExcluded ?? conv.memoryExcluded,
			// The landed exchange's own taint — a flag flipped back
			// since admission can't cleanse what the turn consumed.
			exchangeExcluded: landed.exchangeExcluded,
			nextTurnSeq: () => ++this.turnCounter,
			priorTurn: () => this.lastTurns.get(convId),
			rememberTurn: (prior) => this.lastTurns.set(convId, prior),
			forgetTurn: () => this.lastTurns.delete(convId),
			source: landed.source,
			reply: landed.reply,
			toolCalls: outcome.toolCalls,
			digestRing: outcome.digestRing,
			// Same "only when configured" convention as the digest —
			// the reviewer's already-covered check reads this set.
			...(this.reviewer === undefined ? {} : { tools: seams.tools }),
		});
		// Keep the lane busy through auto-compaction so successors see a whole
		// compacted view; failure writes no boundary and retries later.
		// design/compaction.md → Triggers: the landed input against the
		// same trigger the step boundary checks.
		if (landed.window && landed.window.input >= compactTriggerTokens(landed.window.limit)) {
			try {
				await this.doCompact(conv, "threshold");
			} catch (err) {
				if (err instanceof FencedError) {
					log.info("threshold compaction fenced — view unchanged", {
						conversation: convId,
						epoch,
					});
				} else {
					log.warn(
						"compaction failed — view unchanged, will retry on next threshold crossing",
						err,
						{
							conversation: convId,
						},
					);
				}
			}
		}
		// Off the reply path, post-compaction: the deterministic
		// curator pass when its interval elapsed (gated inside the
		// hook). A throw is logged and swallowed — curation never
		// fails a turn.
		try {
			this.deps.onTurnSettled?.(convId);
		} catch (err) {
			log.warn("post-turn curator pass failed — turn already delivered", err, {
				conversation: convId,
			});
		}
	}
}

export function userMessage(parts: Message["parts"]): Message {
	return { id: randomUUID(), role: "user", parts };
}
