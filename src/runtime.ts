
import { randomUUID } from "node:crypto";
import { isHandoverCard } from "./handover-message.ts";
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
import {
	TOOLS_PART,
	declarationsOf,
	diffDeclarations,
	foldDeclarations,
	storedToolChanges,
	type ToolChange,
} from "./agent/tool-declarations.ts";
import { INSERTS_PART } from "./agent/turn-inserts.ts";
import { PendingInputs, type PendingInput, type PendingInputMode } from "./pending-input.ts";
import { type Bump, runFence } from "./fence.ts";
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
import { compactTriggerTokens } from "./turn/compact-trigger.ts";
import {
	ContextOverflowError,
	failureFromStream,
	overflowHoldable,
	preemptArm,
	type TurnRecovery,
} from "./turn/overflow.ts";
import type { RunOwnershipHooks } from "./turn/run-ownership.ts";
import { openRunRecord } from "./turn/run-record.ts";
import type { TurnDone, TurnSink } from "./turn/sink.ts";
import { TurnState } from "./turn/state.ts";
import { openStepRules, type PreemptArm, type StepRules } from "./turn/step-rules.ts";
import {
	claimMembers,
	endLive,
	type LiveChunks,
	type LiveSubscriber,
	liveElapsed,
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
const COMPACT_TAIL_TOKENS = 20_000;
const COMPACT_CHUNK_TOKENS = 100_000;

function queuedSeq(turn: QueuedTurn): number {
	if (turn.seq === null) throw new Error(`pending input ${turn.pending?.id ?? "?"} was not claimed`);
	return turn.seq;
}

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
	buildStep(
		conv: Conversation,
		tools: Tools,
	): TurnStep | Promise<TurnStep>;
	engines: readonly TurnEngine[];
	captureConversation?(conv: Conversation): Conversation;
	modelFallbacks?(): readonly string[];
	memory?: MemoryTurnDeps;
	compaction?: CompactionSeam;
	pruneBetweenTurns?: (convId: string) => void;
	turnJournal?: TurnJournal;
	recordWindow?(
		conversationId: string,
		input: { model: string; step: number; capture: WindowCapture; recallVersion: number },
	): void;
	windowVersion?(): number;
	claudeSessions?: ClaudeSessionStore | undefined;
	onTurnSettled?: (convId: string) => void;
}

export interface RuntimeMount {
	makeTools: TurnToolMaker;
	runOwnership?: RunOwnershipHooks;
}

export interface Cancellation {
	stopped: boolean;
	settled: Promise<void>;
	reviewsCancelled: number;
	active: Promise<void>;
	notSent: { id: string; message: Message }[];
}

export class FencedError extends Error {
	constructor(convId: string) {
		super(`turn fenced: conversation ${convId} epoch advanced`);
		this.name = "FencedError";
	}
}

interface Attempt extends AttemptScope {
	sink: TurnSink;
	activeFloor: number;
	priorInputTokens: number | null;
	assertAuthority(): void;
}

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
	claudeRec: ClaudeSessionRecord | null;
	sentSeqMax: number | null;
	foldedSeqs: Set<number>;
	pendingToolChange: ToolChange | null;
	toolStamp: ToolChange | null;
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
	private closed = false;
	private mounted: RuntimeMount | null = null;
	private reviewer: Reviewer | undefined;
	private loopWatchdog: { decide: System1Client["decide"]; every: number } | null = null;
	private turnCounter = 0;
	private lastTurns = new Map<string, PriorTurnContext>();

	constructor(private deps: RuntimeDeps) {
		this.pendingInputs = new PendingInputs(deps.store.db);
	}

	mount(mount: RuntimeMount): void {
		if (this.mounted !== null) throw new Error("runtime mounted twice — boot-order bug");
		this.mounted = mount;
	}

	private getMount(): RuntimeMount {
		if (this.mounted === null) throw new Error("runtime not mounted — boot-order bug");
		return this.mounted;
	}

	setReviewer(reviewer: Reviewer): void {
		this.reviewer = reviewer;
	}


	setLoopWatchdog(watchdog: { decide: System1Client["decide"]; every?: number } | null): void {
		this.loopWatchdog =
			watchdog === null
				? null
				: { decide: watchdog.decide, every: watchdog.every ?? LOOP_CHECK_EVERY };
	}

	hasActiveTurn(conversationId: string): boolean {
		return this.lanes.hasActiveTurn(conversationId);
	}

	submit(conv: Conversation, message: Message, sink: TurnSink): boolean {
		this.getMount();
		const seqs = this.deps.store.append(conv.id, [message]);
		return this.admit(conv, message, sink, seqs[0]!);
	}

	submitPersisted(conv: Conversation, message: Message, sink: TurnSink, seq: number): boolean {
		this.getMount();
		return this.admit(conv, message, sink, seq);
	}

	submitPending(
		conv: Conversation,
		message: Message,
		mode: PendingInputMode,
		sink: TurnSink,
	): string {
		this.getMount();
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

	listPending(convId: string): (PendingInput & { status: "waiting" | "notSent" })[] {
		const waiting = this.lanes.pendingIds(convId);
		return this.pendingInputs.list(convId).map((row) => ({
			...row,
			status: waiting.has(row.id) ? ("waiting" as const) : ("notSent" as const),
		}));
	}

	dequeuePending(convId: string, pendingId: string): Message | null {
		const removed = this.lanes.removePending(convId, pendingId);
		if (removed === null) {
			const notSent = this.deps.store.db.transaction(() =>
				this.pendingInputs.take(convId, pendingId),
			)();
			if (notSent === null) {
				log.info("app pending input dequeue refused", {
					conversation: convId,
					pendingId,
					reason: "already-taken",
				});
				return null;
			}
			this.lanes.emitConversation(convId, { type: "pending" });
			log.info("app pending input dequeued", {
				conversation: convId,
				pendingId,
				status: "notSent",
			});
			return notSent.message;
		}
		let input: ReturnType<PendingInputs["take"]>;
		try {
			input = this.deps.store.db.transaction(() => this.pendingInputs.take(convId, pendingId))();
			if (input === null) throw new Error(`pending input row ${pendingId} missing during dequeue`);
		} catch (err) {
			this.lanes.restorePending(convId, removed.turn, removed.index);
			throw err;
		}
		this.lanes.emitConversation(convId, { type: "pending" });
		log.info("app pending input dequeued", {
			conversation: convId,
			pendingId,
			status: "waiting",
		});
		return input.message;
	}

	isAdmitted(conversationId: string, messageId: string, eventSeq?: number): boolean {
		return this.lanes.isAdmitted(conversationId, messageId, eventSeq);
	}

	private admit(conv: Conversation, message: Message, sink: TurnSink, seq: number): boolean {
		if (this.closed) {
			void this.notifyDone({ seq, message, sink, doneSent: false }, { kind: "fenced" });
			return false;
		}
		this.lanes.enqueue(conv.id, { seq, message, sink, doneSent: false, isolated: isHandoverCard(message.parts) });
		this.lanes.startDraining(conv.id, () => this.drain(conv.id));
		return true;
	}

	accepting(): boolean {
		return !this.closed;
	}

	busy(convId: string): boolean {
		return this.lanes.busy(convId);
	}

	busyConversations(): string[] {
		return this.lanes.busyConversations();
	}

	subscribeConversation(
		convId: string,
		listener: (event: ConversationEvent) => void,
	): () => void {
		return this.lanes.subscribeConversation(convId, listener);
	}

	emitConversationRewound(convId: string, messageId: string, replacedBy: string): void {
		this.lanes.emitConversation(convId, { type: "rewound", messageId, replacedBy });
	}

	emitConversationHistory(convId: string): void {
		this.lanes.emitConversation(convId, { type: "history" });
	}

	conversationLive(convId: string): boolean {
		const live = this.lanes.liveOf(convId);
		return live !== null && !live.ended;
	}

	liveElapsedMs(convId: string): number | null {
		const live = this.lanes.liveOf(convId);
		return live === null || live.ended ? null : liveElapsed(live);
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

	async shutdown(): Promise<void> {
		this.closed = true;
		if (this.reviewer) {
			const reviewsCancelled = this.reviewer.cancelAllReviews();
			log.info("reviewer shutdown fenced", { reviewsCancelled });
		}
		const drains: Promise<void>[] = [];
		for (const convId of this.lanes.conversationIds()) {
			drains.push(this.stop(convId).settled);
		}
		drains.push(...this.lanes.drainingPromises());
		await Promise.all(drains);
	}

	stop(convId: string): Cancellation {
		const epoch = this.deps.store.bumpEpochIfPresent(convId);
		if (epoch === null) {
			log.info("stop — conversation already gone", { conversation: convId });
			return {
				stopped: false,
				settled: Promise.resolve(),
				reviewsCancelled: 0,
				active: Promise.resolve(),
				notSent: [],
			};
		}
		return this.cancelFenced(convId, epoch);
	}

	fence<T>(work: (bump: Bump) => T): { result: T; cancelled: Map<string, Cancellation> } {
		return runFence(this.deps.store, work, (convId, epoch) => {
			const cancellation = this.cancelFenced(convId, epoch);
			cancellation.settled.catch((err: unknown) =>
				log.error("fence settle failed", err, { conversation: convId, epoch }),
			);
			return cancellation;
		});
	}

	private cancelFenced(convId: string, epoch: number): Cancellation {
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
		const notSent = dropped.turns
			.filter((turn) => turn.pending !== undefined)
			.map((turn) => ({ id: turn.pending!.id, message: turn.message }));
		for (const item of notSent) {
			log.info("app pending input not sent", {
				conversation: convId,
				pendingId: item.id,
				shutdown: this.closed,
			});
		}
		if (notSent.length > 0) {
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
			active: this.lanes.activeTurn(convId) ?? Promise.resolve(),
			notSent,
		};
	}

	private materializeClaimed(convId: string, turns: QueuedTurn[]): void {
		const pending = turns.filter((turn) => turn.pending !== undefined);
		if (pending.length === 0) return;
		const claimed = this.deps.store.db.transaction(() =>
			pending.map((turn) => {
				const meta = turn.pending!;
				const row = this.pendingInputs.take(convId, meta.id);
				if (row === null) {
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

	compact(conv: Conversation, focus?: string): Promise<CompactionOutcome> {
		this.getMount();
		return new Promise<CompactionOutcome>((resolve, reject) => {
			this.lanes.enqueueCompact({ conv, reason: "manual", focus, resolve, reject });
			this.lanes.startDraining(conv.id, () => this.drain(conv.id));
		});
	}

	async idleFold(convId: string): Promise<"compacted" | "noop" | "busy" | "gone"> {
		this.getMount();
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
					const availableTools = this.getMount().makeTools(
						target,
						noVoice,
						recording,
						noFile,
						{
							runId: "compaction-summary",
							sourceMessageId: () => "",
							sourceInputSeq: () => null,
							inputSeqs: () => new Set(),
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

	private withCause(done: TurnDone): TurnDone {
		return done.kind === "fenced" && this.closed ? { kind: "fenced", shutdown: true } : done;
	}

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
			recallNew: this.deps.store.bots.membership(conv.id) === null,
		});
	}

	private async drain(convId: string): Promise<void> {
		if (!this.lanes.beginDrain(convId)) return;
		try {
			for (;;) {
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
					let settleActiveTurn: () => void = () => {};
					const activeTurn = new Promise<void>((resolve) => {
						settleActiveTurn = resolve;
					});
					this.lanes.setActiveTurn(convId, activeTurn);
					try {
						try {
							await this.runTurn(convId, turns);
						} catch (err) {
							log.error("turn crashed", err, { conversation: convId });
							const done: TurnDone = {
								kind: "error",
								message: err instanceof Error ? err.message : String(err),
							};
							const crashed = this.lanes.liveOf(convId);
							if (crashed !== null) endLive(crashed, done, convId);
							for (const t of turns) await this.notifyDone(t, done);
						}
						this.lanes.registerController(convId, null);
					} finally {
						settleActiveTurn();
						this.lanes.setActiveTurn(convId, null);
					}
					continue;
				}
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

	private async runTurn(convId: string, turns: ClaimedTurn[]): Promise<void> {
		const live = openLive();
		let recovery: TurnRecovery | undefined;
		let members = turns;
		for (;;) {
			const outcome = await this.runAttempt(convId, members, recovery, live);
			if (outcome.kind === "done") return;
			recovery = outcome.recovery;
			members = outcome.turns;
		}
	}

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
			const fault = a.record.journalFault.current;
			if (fault !== undefined) return await journalFaultRail(a, fault);
			if (err instanceof FencedError || a.controller.signal.aborted) return await fencedRail(a, err);
			if (err instanceof ContextOverflowError) return await overflowRail(a, err);
			return await errorRail(a, err);
		} finally {
			a.record.stampRun("error", "failed");
		}
		return { kind: "done" };
	}

	private async openAttempt(
		convId: string,
		turns: ClaimedTurn[],
		recovery: TurnRecovery | undefined,
		live: LiveChunks,
	): Promise<Attempt | null> {
		const { store } = this.deps;
		const recallVersion = this.attemptRecallVersion(convId, recovery);
		const state = new TurnState(
			{
				convId,
				watchdog: this.loopWatchdog,
				request: messageText(turns[0]!.message),
			},
			recovery?.loop,
		);
		const sink = turns[0]!.sink;
		const notifyAll = async (done: TurnDone) => {
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
		const announcePreRunFailure = (err: unknown) => {
			if (progress.authority?.ownershipBegun === true) return;
			this.getMount().runOwnership?.preRunFailure?.({
				conversationId: convId,
				memberSeqs: turns.map(queuedSeq),
				error: err instanceof Error ? err.message : String(err),
			});
		};
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
					ownedInputSeqs: () => new Set(turns.map(queuedSeq)),
					modelEntries: () => store.modelEntries(convId),
					now: Date.now,
				},
				recovery === undefined
					? undefined
					: { conversation: recovery.conversation, startedAt: recovery.startedAt },
			);
			if (admitted.kind === "admitted" && recovery === undefined) {
				const { anchorSeq, entries, ownedInputSeqs } = admitted.snapshot;
				if (anchorSeq !== null && ownedInputSeqs.includes(anchorSeq)) {
					const anchor = entries.findLast((entry) => entry.seq === anchorSeq && entry.message.role === "user");
					if (anchor !== undefined) anchor.message = store.chatNotePins.capture(convId, anchor.seq, anchor.message);
				}
			}
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
		sink.setAuthorityCheck?.(
			holdsAuthority,
			snapshot.anchorSeq,
			ownedInputExcluded,
			() => live.chunks.findLast((chunk) => chunk.type === "start")?.messageId,
		);
		const controller = new AbortController();
		this.lanes.registerController(convId, controller);
		const hadLiveWire = this.conversationLive(convId);
		this.lanes.registerLive(convId, live);
		if (!hadLiveWire)
			this.lanes.emitConversation(convId, { type: "turn-start", elapsedMs: liveElapsed(live) });

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
		const journal = this.deps.turnJournal;
		const record = openRunRecord({
			journal,
			store,
			runOwnership: this.getMount().runOwnership,
			modelFallbacks: this.deps.modelFallbacks,
			convId,
			epoch,
			convModel: conv.model,
			recovery,
			ownedInputSeqs,
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

	private async runAdmitted(a: Attempt): Promise<void> {
		const { snapshot } = a;
		a.checkAuthority();
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
		if (a.record.journalFault.current !== undefined) throw a.record.journalFault.current;
		const landed = await this.landReply(a, seams, view, outcome);
		await this.afterLanding(a, seams, outcome, landed);
	}

	private async openSeams(a: Attempt): Promise<AttemptSeams> {
		const { convId, turns, sink, snapshot, recovery } = a;
		const { conv, epoch } = snapshot;
		const delivery = sinkDelivery(sink, a.checkAuthority);
		const steerGate = { armed: false };
		let stepRules: StepRules | null = null;
		const auth = openToolAuthority({
			conv,
			convId,
			epoch,
			makeTools: this.getMount().makeTools,
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
			runOwnership: this.getMount().runOwnership,
			checkAuthority: a.checkAuthority,
			steerWaiting: () =>
				steerGate.armed && this.lanes.claimablePending(convId, sink.delivery === "stream"),
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
			uncapped: step.uncapped === true,
		});
		if (arm === null) return null;
		const { tailTokenBudget } = compactionBudgets(step.contextWindow ?? null);
		const foldable =
			chooseBoundary(store.historyDetail(convId), {
				tailTokenBudget,
				previousBoundary: previousFold?.boundarySeq ?? null,
				previousSplit: previousFold?.split ?? null,
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
			toolsInInput: !isClaudeStep(step) && step.toolsInInput === true,
			skillRef: resolveSkillRef,
		};
		const toolHistory = this.deps.store.toolHistoryEntries(convId);
		const changes = storedToolChanges(toolHistory, convId).map(({ change }) => change);
		const pendingToolChange = diffDeclarations(foldDeclarations(changes), declarationsOf(tools));
		ctx.pendingToolChange = pendingToolChange;
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
			toolHistory,
			prior: a.progress.memory.prior,
			current: a.progress.memory.current,
			partial: a.recovery?.partial ?? null,
			summarySeq: this.deps.store.memoryEligibility(convId).summarySeq,
			ownedSeqs: snapshot.ownedInputSeqs,
			assertAuthority: a.checkAuthority,
		};
		const messages = await buildModelView(ctx, options);
		return {
			ctx,
			options,
			messages,
			claudeRec,
			sentSeqMax,
			foldedSeqs: new Set<number>(),
			pendingToolChange,
			toolStamp: pendingToolChange ?? (changes.length === 0 ? { added: [], removed: [] } : null),
		};
	}

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
			runId: auth.runId,
			saveStep: auth.saveStep,
			...(journal === undefined
				? {}
				: {
						noteRunMembers: (seqs: number[]) =>
							this.getMount().runOwnership?.members(auth.runId, convId, seqs),
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
			turnStartMs: snapshot.turnStartMs,
			signal: a.controller.signal,
			holdZeroEffectError:
				fallback.fresh && (fallback.next() !== undefined || fallback.misses.length > 0),
			...(fallback.misses.length > 0 ? { fallbackMisses: fallback.misses } : {}),
			step,
			...(claudeSession !== undefined ? { claudeSession } : {}),
		});
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

	private async landReply(
		a: Attempt,
		seams: AttemptSeams,
		view: AttemptView,
		outcome: CompletedStream,
	): Promise<LandedAttempt> {
		const { convId, turns, sink, live, snapshot, record, journal } = a;
		const { conv, epoch, entries } = snapshot;
		const { store } = this.deps;
		const visibleUserSeqs = new Set(
			entries.filter((e) => e.message.role === "user").map((e) => e.seq),
		);
		let landedReplySeq: number | null = null;
		const landed = landAttempt({
			convId,
			epoch,
			conv,
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
			responseMessage:
				outcome.responseMessage !== null &&
				(view.toolStamp !== null || outcome.inserts.length > 0)
					? {
							...outcome.responseMessage,
							parts: [
								...(view.toolStamp !== null
									? [{ type: TOOLS_PART, data: view.toolStamp } as Message["parts"][number]]
									: []),
								...(outcome.inserts.length > 0
									? [{
										type: INSERTS_PART,
										data: { inserts: outcome.inserts },
									} as Message["parts"][number]]
									: []),
								...outcome.responseMessage.parts,
							],
						}
					: outcome.responseMessage,
			finishReason: outcome.finishReason,
			usage: outcome.usage,
			lastStepInputTokens: outcome.lastStepInputTokens,
			contextWindow: seams.step.contextWindow,
			forcedKind: a.state.forcedCompletion(),
			sink,
			members: turns,
			live,
			append: (messages, opts) =>
				store.db.transaction(() => {
					const seqs = store.append(convId, messages, opts);
					landedReplySeq = seqs[0] ?? null;
					record.journaled(() => journal?.noteReplyLanded(seams.auth.runId, landedReplySeq));
					return seqs;
				})(),
			memory: this.deps.memory,
		});
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
		a.checkAuthority();
		this.lanes.releaseController(convId, a.controller);
		return landed;
	}

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

	private async afterLanding(
		a: Attempt,
		seams: AttemptSeams,
		outcome: CompletedStream,
		landed: LandedAttempt,
	): Promise<void> {
		const { convId } = a;
		const { conv, epoch } = a.snapshot;
		const { store } = this.deps;
		submitTurnReview({
			convId,
			reviewer: this.reviewer,
			memoryExcluded: () => store.get(convId)?.memoryExcluded ?? conv.memoryExcluded,
			exchangeExcluded: landed.exchangeExcluded,
			nextTurnSeq: () => ++this.turnCounter,
			priorTurn: () => this.lastTurns.get(convId),
			rememberTurn: (prior) => this.lastTurns.set(convId, prior),
			forgetTurn: () => this.lastTurns.delete(convId),
			source: landed.source,
			reply: landed.reply,
			toolCalls: outcome.toolCalls,
			digestRing: outcome.digestRing,
			...(this.reviewer === undefined ? {} : { tools: seams.tools }),
		});
		if (
			landed.window &&
			landed.window.input >= compactTriggerTokens(landed.window.limit, seams.step.uncapped === true)
		) {
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
