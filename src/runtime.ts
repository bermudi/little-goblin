// Per-conversation serial lanes and epoch fencing: fenced turns still run
// terminal callbacks so every sink is settled.

import { randomUUID } from "node:crypto";
import { type ToolSet, type UIMessage, type UIMessageChunk } from "ai";
import type { AcceptsMedia } from "./agent/attachments.ts";
import type { ClaudeStep } from "./agent/claude-code/mod.ts";
import type { ClaudeSessionStore } from "./claude-sessions.ts";
import { type CompactionOutcome, chooseBoundary } from "./agent/compaction.ts";
import {
	exhaustedMessage,
	type FallbackMiss,
	type FallbackNote,
	failureClass,
	missReason,
} from "./agent/model-fallback.ts";
import {
	isContentFilter,
	isContextOverflow,
	isTransientTurnFailure,
	quotaExhausted,
} from "./agent/provider-errors.ts";
import { resolveSkillRef } from "./agent/skill-inject.ts";
import type { Conversation, ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";
import {
	activeExchangeExcluded,
	type MemoryTurnDeps,
	memoryBoundEntries,
	messageText,
	type RecallContext,
	recallMemory,
} from "./memory/mod.ts";
import type { PriorTurnContext } from "./reviewer.ts";
import { Reviewer } from "./reviewer.ts";
import type { System1Client } from "./system1.ts";
import { admitTurn, type LiveWire } from "./turn/admission.ts";
import { type CompactionSeam, runCompactJob } from "./turn/compact-job.ts";
import { sinkDelivery } from "./turn/delivery.ts";
import { isClaudeStep, type ModelStep, pickEngine, type TurnEngine } from "./turn/engine.ts";
import { landAttempt, submitTurnReview } from "./turn/finish.ts";
import {
	ContextOverflowError,
	compactTriggerTokens,
	failureFromStream,
	overflowHoldable,
	PreemptCompactError,
	preemptArm,
	recoverFromOverflow,
	type TurnRecovery,
	terminalFailureMessage,
} from "./turn/overflow.ts";
import type { RunOwnershipHooks } from "./turn/run-ownership.ts";
import { openRunRecord } from "./turn/run-record.ts";
import type { TurnDone, TurnSink } from "./turn/sink.ts";
import type { SkillWatch } from "./turn/skill-attribution.ts";
import { type ForcedKind, TurnState } from "./turn/state.ts";
import { claimMembers, emitChunk, endLive, type LiveChunks, openLive } from "./turn/stream.ts";
import {
	openToolAuthority,
	type ToolAuthority,
	type TurnToolMaker,
} from "./turn/tool-authority.ts";
import { buildModelView, type ViewContext } from "./turn/view.ts";
import type { TurnJournal } from "./turn-journal.ts";
import type { WindowCapture } from "./window-capture.ts";

const LOOP_CHECK_EVERY = 16;
// design/compaction.md → Budgets: the verbatim tail is 20k tokens —
// pi/OpenClaw's keepRecentTokens — absolute at scale (the 1M-era rule:
// fractions of a big window are consumption rules, not safety rules),
// clamped to the window's own fractions on small models so a 32k window
// keeps a working tail and chunk instead of a tail that swallows it.
const COMPACT_TAIL_TOKENS = 20_000;
const COMPACT_CHUNK_TOKENS = 100_000;

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
		tools: ToolSet,
	): ModelStep | ClaudeStep | Promise<ModelStep | ClaudeStep>;
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
}

export class FencedError extends Error {
	constructor(convId: string) {
		super(`turn fenced: conversation ${convId} epoch advanced`);
		this.name = "FencedError";
	}
}

// An operator-resume admission's seed (turn-resume.ts builds it): the
// interrupted run's carry-over minus the dead attempt's live wire and
// recall, both re-derived at the fresh admission. `resumedFrom` links the
// new run row to the source and arms the fence's recovery guard.
export type ResumeSeed = Omit<TurnRecovery, "live" | "memory" | "overflowed">;

interface QueuedTurn {
	// The durable event seq of the appended message — captured from the
	// append (or the persisting caller) so steering ownership never has to
	// match client message ids, which are neither unique nor trusted.
	seq: number;
	// Already appended to history; a live predecessor may fold it into its
	// next model call.
	message: UIMessage;
	sink: TurnSink;
	// Prevents a throwing sink from receiving a second terminal notification.
	// Drain's last-ditch handler can therefore safely settle the whole lane.
	doneSent: boolean;
	// A throwing stream sink is detached without killing the turn; remaining
	// sinks receive future chunks.
	streamFailed?: boolean;
	// Present only on a claim head — a seeded turn answers for the
	// interrupted run it continues; claimed as a member its recovery
	// would silently drop, so the claim boundary stops before it.
	resumeSeed?: ResumeSeed | undefined;
	release?: (() => void) | undefined;
}

// Compaction jobs run between turns so the preceding exchange is whole.
// A submit arriving during the job waits for the next drain pass.
interface QueuedCompact {
	conv: Conversation;
	resolve: (outcome: CompactionOutcome) => void;
	reject: (err: unknown) => void;
}

interface Lane {
	pending: QueuedTurn[];
	compacts: QueuedCompact[];
	running: boolean;
	controller: AbortController | null;
	// Dedicated cancellation for an in-flight compaction summary. It is
	// registered before the first await so /stop cannot miss a pending build.
	compactController: AbortController | null;
	// Shutdown awaits the drain so terminal sink flushes finish.
	draining: Promise<void> | null;
	live: LiveChunks | null;
	admitted: Map<string, QueuedTurn[]>;
}

// A streaming submit stays queued behind a headless turn so it can lead its
// own attempt. A streaming head may claim all pending work; a headless head
// claims only the leading non-streaming run. A resume seed leads only its own
// claim — joining another turn as a member would drop its recovery.
// `headLeads` distinguishes the two claim contexts: the drain's claim
// promotes pending[0] to head (its seed rides along), while wire/steer
// claims take members only — a seed at index 0 must stop them too.
function claimableCount(pending: QueuedTurn[], headStreams: boolean, headLeads: boolean): number {
	const start = headLeads ? 1 : 0;
	const seeded = pending.findIndex((t, i) => i >= start && t.resumeSeed !== undefined);
	const limit = seeded === -1 ? pending.length : seeded;
	if (headStreams) return limit;
	const first = pending.findIndex((t, i) => i >= start && t.sink.onStreamChunk !== undefined);
	return first === -1 ? limit : Math.min(limit, first);
}

function claimPending(lane: Lane, headStreams: boolean, headLeads = true): QueuedTurn[] {
	return lane.pending.splice(0, claimableCount(lane.pending, headStreams, headLeads));
}

// Terminal outcomes have settled their sinks; resumes carry recovery and
// membership into the next attempt. Membership is data on the decision,
// not a closure over a queue that may have changed.
type AttemptOutcome =
	| { kind: "done" }
	| { kind: "resume"; recovery: TurnRecovery; turns: QueuedTurn[] };

export class Runtime {
	private lanes = new Map<string, Lane>();
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

	constructor(private deps: RuntimeDeps) {}

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
		const lane = this.lanes.get(conversationId);
		return lane !== undefined && (lane.running || lane.pending.length > 0);
	}

	// Persist immediately; the return value distinguishes lane admission from
	// history-only recording after shutdown. The message is durable even when
	// no turn can be admitted.
	submit(conv: Conversation, message: UIMessage, sink: TurnSink): boolean {
		const seqs = this.deps.store.append(conv.id, [message]);
		return this.admit(conv, message, sink, seqs[0]!);
	}

	// The inbox has already persisted this message; appending again would
	// duplicate a recovered turn. `seq` is that persisted event's seq — the
	// persisting caller watched the append, so the queue never has to guess
	// it from a client message id.
	submitPersisted(conv: Conversation, message: UIMessage, sink: TurnSink, seq: number): boolean {
		return this.admit(conv, message, sink, seq);
	}

	// Admission for an operator-resumed turn — turn-resume.ts owns the
	// validation and builds the source-linked resume event. Registering the
	// event on the source run and appending it to history are one
	// transaction: a partial write must not leave an unregistered event the
	// next resume would read as foreign input. The seed restores what the
	// interrupted attempt produced. Same lane and authority rules as
	// submitPersisted.
	resume(conv: Conversation, message: UIMessage, sink: TurnSink, seed: ResumeSeed): boolean {
		const journal = this.deps.turnJournal;
		const eligible = this.deps.store.memoryEligibility(conv.id).eligibleSeqs;
		const exclude =
			seed.admissionExchangeExcluded === true ||
			(seed.ownedInputSeqs ?? []).some((seq) => !eligible.has(seq));
		let seq: number;
		if (journal !== undefined && seed.resumedFrom !== undefined) {
			seq = this.deps.store.db.transaction(() => {
				// The registry names the seq this append actually wrote —
				// inferring it (e.g. lastUserSeq) would silently register an
				// unrelated event if the message's shape ever changed.
				const seqs = this.deps.store.append(conv.id, [message], { exclude });
				journal.noteResumeRequest(seed.resumedFrom!, seqs[0]!);
				return seqs[0]!;
			})();
		} else {
			const seqs = this.deps.store.append(conv.id, [message], { exclude });
			seq = seqs[0]!;
		}
		return this.admit(conv, message, sink, seq, seed);
	}

	// A live admission by client-visible id — loose matching for
	// callers that only carry the id. `eventSeq` tightens it to one
	// durable event: a different admitted event reusing the same client
	// id must not stand in for the seq the caller actually means.
	isAdmitted(conversationId: string, messageId: string, eventSeq?: number): boolean {
		return (
			this.lanes
				.get(conversationId)
				?.admitted.get(messageId)
				?.some((t) => !t.doneSent && (eventSeq === undefined || t.seq === eventSeq)) ?? false
		);
	}

	private admit(
		conv: Conversation,
		message: UIMessage,
		sink: TurnSink,
		seq: number,
		seed?: ResumeSeed,
	): boolean {
		if (this.closed) {
			void this.notifyDone({ seq, message, sink, doneSent: false }, { kind: "fenced" });
			return false;
		}
		const lane = this.lane(conv.id);
		const turn: QueuedTurn = { seq, message, sink, doneSent: false, resumeSeed: seed };
		turn.release = () => {
			const holders = lane.admitted.get(message.id);
			if (holders === undefined) return;
			const index = holders.indexOf(turn);
			if (index !== -1) holders.splice(index, 1);
			if (holders.length === 0) lane.admitted.delete(message.id);
		};
		lane.pending.push(turn);
		const holders = lane.admitted.get(message.id);
		if (holders === undefined) lane.admitted.set(message.id, [turn]);
		else holders.push(turn);
		if (!lane.running) lane.draining = this.drain(conv.id);
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
	// a retry into steering input, and resume admission refuses on it so
	// the visibility it measured cannot move before the resumed turn runs.
	busy(convId: string): boolean {
		const lane = this.lanes.get(convId);
		return (
			lane !== undefined && (lane.running || lane.pending.length > 0 || lane.compacts.length > 0)
		);
	}

	// Every conversation busy() would report — the release script's idle
	// wait reads this through the loopback /api/runtime/busy endpoint.
	busyConversations(): string[] {
		return [...this.lanes.keys()].filter((convId) => this.busy(convId));
	}

	// Replay the existing wire and subscribe atomically; the replay/live union is
	// gapless. `onEnd` is delivered once with the same terminal outcome as the
	// member sink. Null means the caller should fall back to history.
	subscribeLiveChunks(
		convId: string,
		onChunk: (chunk: UIMessageChunk) => void,
		onEnd: (done: TurnDone) => void,
	): UIMessageChunk[] | null {
		const live = this.lanes.get(convId)?.live;
		if (live === undefined || live === null || live.ended) return null;
		live.subscribers.add({ onChunk, onEnd });
		return [...live.chunks];
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
		for (const [convId, lane] of this.lanes) {
			// Await dropped sinks so shutdown does not cut off their final flush.
			drains.push(this.stop(convId).settled);
			if (lane.draining) drains.push(lane.draining);
		}
		await Promise.all(drains);
	}

	// /stop advances the epoch, aborts live work, drops queued work, cancels
	// compaction and reviews, and still settles every dropped sink. `stopped`
	// is synchronous; `settled` waits for terminal delivery. A queued compact
	// resolves as a noop so the command waiting on it still completes.
	stop(convId: string): { stopped: boolean; settled: Promise<void>; reviewsCancelled: number } {
		const epoch = this.deps.store.bumpEpoch(convId);
		return this.cancelFenced(convId, epoch);
	}

	// The caller commits the epoch transaction first. Fence and cancellation stay
	// outside that transaction with no await or intervening submission.
	cancelFenced(
		convId: string,
		epoch: number,
	): { stopped: boolean; settled: Promise<void>; reviewsCancelled: number } {
		if (
			!Number.isSafeInteger(epoch) ||
			epoch <= 0 ||
			this.deps.store.get(convId)?.epoch !== epoch
		) {
			throw new Error(
				`cannot cancel conversation ${convId}: committed epoch ${epoch} no longer matches`,
			);
		}
		const lane = this.lanes.get(convId);
		const stopped =
			lane !== undefined &&
			(lane.pending.length > 0 ||
				lane.compacts.length > 0 ||
				lane.controller !== null ||
				lane.compactController !== null);
		const notifies: Promise<void>[] = [];
		if (lane) {
			const dropped = lane.pending.splice(0);
			const droppedCompacts = lane.compacts.splice(0);
			lane.controller?.abort();
			lane.compactController?.abort();
			for (const t of dropped) {
				notifies.push(this.notifyDone(t, { kind: "fenced" }));
			}
			for (const c of droppedCompacts) {
				c.resolve({ kind: "noop", reason: "stopped" });
			}
		}
		const reviewsCancelled = this.reviewer ? this.reviewer.cancelReviews(convId) : 0;
		if (stopped) {
			log.info("turn stopped", { conversation: convId, epoch, reviewsCancelled });
		} else {
			log.debug("stop — nothing was running", { conversation: convId, epoch, reviewsCancelled });
		}
		return { stopped, settled: Promise.all(notifies).then(() => undefined), reviewsCancelled };
	}

	// Queue compaction behind the running turn so its response is not orphaned.
	compact(conv: Conversation): Promise<CompactionOutcome> {
		const lane = this.lane(conv.id);
		return new Promise<CompactionOutcome>((resolve, reject) => {
			lane.compacts.push({ conv, resolve, reject });
			if (!lane.running) lane.draining = this.drain(conv.id);
		});
	}

	private async doCompact(
		conv: Conversation,
		reason: "threshold" | "manual" | "overflow" | "preempt",
		activeFloor?: number,
	): Promise<CompactionOutcome> {
		return runCompactJob(conv, reason, activeFloor, {
			store: this.deps.store,
			compaction: this.deps.compaction,
			captureConversation: this.deps.captureConversation,
			modelFallbacks: this.deps.modelFallbacks,
			budgets: compactionBudgets,
			checkAuthority: (convId, epoch) => this.checkAuthority(convId, epoch),
			foldCeiling: (convId, floor) => this.foldCeiling(convId, floor),
			holdController: (controller) => {
				this.lane(conv.id).compactController = controller;
			},
			releaseController: (controller) => {
				const lane = this.lanes.get(conv.id);
				if (lane !== undefined && lane.compactController === controller) {
					lane.compactController = null;
				}
			},
		});
	}

	private lane(convId: string): Lane {
		let l = this.lanes.get(convId);
		if (!l) {
			l = {
				pending: [],
				compacts: [],
				running: false,
				controller: null,
				compactController: null,
				draining: null,
				live: null,
				admitted: new Map(),
			};
			this.lanes.set(convId, l);
		}
		return l;
	}

	// Where completed history ends for a fold: the lowest seq whose reply
	// has not landed. While a turn runs, that is its earliest member — every
	// event at or after it is that exchange or input queued behind it. On an
	// idle lane it is the first still-queued input (its reply comes only
	// with its own turn). Events at or after the ceiling must never be
	// folded: their reply would anchor at or below the boundary and drop
	// out of the model view, unseen by the summary that replaced it.
	private foldCeiling(convId: string, activeFloor?: number): number | null {
		let ceiling = activeFloor ?? null;
		for (const t of this.lanes.get(convId)?.pending ?? []) {
			if (ceiling === null || t.seq < ceiling) ceiling = t.seq;
		}
		return ceiling;
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
		members: QueuedTurn[],
	): QueuedTurn[] {
		return claimMembers(
			convId,
			() => claimPending(this.lane(convId), sink.onStreamChunk !== undefined, false),
			live,
			members,
		);
	}

	private async recallMemory(
		conv: Conversation,
		anchorSeq: number | null,
		history: UIMessage[],
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
		const lane = this.lane(convId);
		if (lane.running) return;
		lane.running = true;
		try {
			for (;;) {
				// Coalesce the claimable queue into one conversational beat; a
				// left-behind streaming item starts the next pass. The head sink's
				// delivery mode determines the claim boundary.
				const turns = claimPending(lane, lane.pending[0]?.sink.onStreamChunk !== undefined);
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
						// End before a successor can replace lane.live, or attached
						// subscribers would hang without a terminal event.
						const crashed = this.lanes.get(convId)?.live;
						if (crashed != null) endLive(crashed, done, convId);
						for (const t of turns) await this.notifyDone(t, done);
					}
					// A finished turn must not make /stop report live work.
					this.lane(convId).controller = null;
					continue;
				}
				// Run queued compaction only between whole turns.
				const job = lane.compacts.shift();
				if (job !== undefined) {
					try {
						job.resolve(await this.doCompact(job.conv, "manual"));
					} catch (err) {
						job.reject(err);
					}
					continue;
				}
				return;
			}
		} finally {
			lane.running = false;
			lane.controller = null;
			lane.draining = null;
			// Fail closed if a path leaves attached streams without an outcome.
			// Hanging an attach request is worse than sending an explicit error.
			if (lane.live !== null && !lane.live.ended) {
				log.error("live chunk log never ended — closing attach streams", undefined, {
					conversation: convId,
				});
				endLive(lane.live, { kind: "error", message: "turn ended without an outcome" }, convId);
			}
			lane.live = null;
			// Do not retain idle lanes for the process lifetime.
			if (lane.pending.length === 0 && lane.compacts.length === 0) this.lanes.delete(convId);
		}
	}

	// Keep one wire log and membership across attempts; recovery controls the
	// next attempt without recursion. The live log therefore survives overflow
	// while late subscribers retain one continuous stream.
	private async runTurn(convId: string, turns: QueuedTurn[]): Promise<void> {
		const live = openLive();
		// An operator-resume seed enters the same recovery slot an
		// overflow decision fills — the attempt loop consumes it
		// identically. The wire is always the fresh log: the dead turn's
		// went away with the process.
		const seed = turns[0]?.resumeSeed;
		let recovery: TurnRecovery | undefined = seed === undefined ? undefined : { ...seed, live };
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
		turns: QueuedTurn[],
		recovery: TurnRecovery | undefined,
		live: LiveChunks,
	): Promise<AttemptOutcome> {
		const { store } = this.deps;
		let recallVersion: number | null;
		if (recovery !== undefined && recovery.recallVersion !== undefined) {
			recallVersion = recovery.recallVersion;
		} else {
			try {
				recallVersion = this.deps.windowVersion?.() ?? 0;
			} catch (err) {
				log.warn("recall version unreadable — window capture disabled for this attempt", {
					conversation: convId,
					error: String(err),
				});
				recallVersion = null;
			}
		}
		let filterRetryUsed = recovery?.filterRetryUsed ?? false;
		// Set when the engine withheld a zero-effect error off the wire for
		// a possible fallback; the terminal path emits it if none follows.
		let errorHeld = false;
		// Preserve loop history across overflow, while attempt-scoped state resets.
		// Completed tool calls stay in the recovery package as evidence —
		// they are never re-entered from this list; the journal's recovery
		// guard owns what a fresh invocation may do.
		const state = new TurnState(
			{
				convId,
				watchdog: this.loopWatchdog,
				// An operator-resume head is the generated provenance marker —
				// the seed carries the run's real request for the watchdog;
				// every other head message is itself the request.
				request: recovery?.operatorRequest ?? messageText(turns[0]!.message),
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
			endLive(live, final, convId);
			for (const t of turns) await this.notifyDone(t, final);
		};
		// The ownership window: from admission until the begin hook, the
		// attempt's members are unlinked — a terminal failure in that span
		// (a refused admission included) is invisible to the dispatcher's
		// reconcile (no run row to read), so it must be announced instead
		// of re-admitting the trigger forever. The authority seam owns the
		// begun fact; before it exists there is no row to link, so
		// announcing is always right there.
		let authority: ToolAuthority | undefined;
		const announcePreRunFailure = (err: unknown) => {
			if (authority?.ownershipBegun === true) return;
			this.deps.runOwnership?.preRunFailure?.({
				conversationId: convId,
				memberSeqs: turns.map((t) => t.seq),
				error: err instanceof Error ? err.message : String(err),
			});
		};
		// Admission fixes this attempt's ownership and model input. A
		// throw escapes to the drain's last-ditch settle — still a
		// terminal death inside the ownership window, so it announces
		// the same as a refused admission before propagating.
		let admitted: ReturnType<typeof admitTurn>;
		try {
			admitted = admitTurn(
				{
					convId,
					live,
					getConversation: () => store.get(convId),
					captureConversation: this.deps.captureConversation,
					claimQueued: (wire) => this.claimQueuedMembers(convId, sink, wire, turns),
					pendingSeqs: () => new Set(this.lane(convId).pending.map((t) => t.seq)),
					// Read after claimQueued — it can add members to `turns`.
					ownedInputSeqs: () => new Set(turns.map((t) => t.seq)),
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
			return { kind: "done" };
		}
		const { snapshot } = admitted;
		const { conv, epoch, entries, anchorSeq, turnStartMs } = snapshot;
		// Resume members join `turns` before admission so all paths settle them.
		// An admission failure must not strand a member claimed during recovery.
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
		sink.setAuthorityCheck?.(
			() => this.deps.store.get(convId)?.epoch === epoch,
			anchorSeq,
			ownedInputExcluded,
		);
		const controller = new AbortController();
		this.lane(convId).controller = controller;
		this.lanes.get(convId)!.live = live;

		// The active exchange starts at the earliest member seq: this turn's
		// stored user events (replies still in flight) and, above them, every
		// input queued behind the running request. Compaction — the pre-empt
		// foldability probe and the fold itself — must see only completed
		// history strictly before it (foldCeiling).
		const activeFloor = Math.min(...turns.map((t) => t.seq));

		// Reuse recall on overflow resume; it belongs to the pre-compaction view.
		// Reissuing it would spend memory quota twice for one logical turn.
		let memory: { prior: RecallContext[]; current: RecallContext | null } = {
			prior: [],
			current: null,
		};
		// The crash journal's per-attempt row — turn/run-record.ts owns its
		// lifecycle; the attempt's finally guard is the backstop that a
		// begun row never escapes still 'running'.
		const journal = this.deps.turnJournal;
		// An operator-resume admission carries the interrupted run it
		// continues — every attempt of this turn links its run row to it
		// and inherits its calls as evidence: a re-asked effect conflicts
		// unless an operator grant names it.
		const sourceRunId = recovery?.resumedFrom;
		const sourceInputSeq = (): number | null => {
			let max: number | null = null;
			for (const [i, t] of turns.entries()) {
				if (i === 0 && sourceRunId !== undefined) continue;
				if (max === null || t.seq > max) max = t.seq;
			}
			return max ?? recovery?.sourceInputSeq ?? null;
		};
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
			runId: () => authority?.runId ?? null,
		});
		const { journalFault, journaled, stampRun, recordUnlandedProgress, fallback } = record;
		// The aborted outcome's cause: a shutdown fence must read as a
		// restart, not an operator stop. Other fences have several sources
		// (stop, settings change, correction, navigation roll) — the wording
		// stays neutral rather than naming one that may not apply.
		const fencedCause = (): string =>
			this.closed
				? "the process was shutting down"
				: "stopped by /stop, superseded by a settings change, or fenced by an operator action";
		try {
			this.checkAuthority(convId, epoch);
			// Recall uses admission-time eligibility; the model view still sees the
			// full conversation.
			memory =
				recovery?.memory ??
				(await this.recallMemory(
					conv,
					anchorSeq,
					memoryBoundEntries(entries, store.memoryEligibility(convId)).map((e) => e.message),
					controller.signal,
					epoch,
				));
			this.checkAuthority(convId, epoch);
			// Delivery and tool authority are turn-owned seams: the fenced
			// sink hooks (turn/delivery.ts), then the run row + ownership
			// link + the tool fence + step-end persistence's one home,
			// saveStep (turn/tool-authority.ts).
			const delivery = sinkDelivery(sink, () => this.checkAuthority(convId, epoch));
			// Until buildStep resolves, media capability must conservatively reject
			// inlining.
			const accepts: { current: AcceptsMedia } = {
				current: { modalities: new Set(["text"]), carries: () => false },
			};
			const auth = openToolAuthority({
				conv,
				convId,
				epoch,
				makeTools: this.deps.makeTools,
				delivery,
				accepts,
				sourceMessageId: () => turns[turns.length - 1]!.message.id,
				record: {
					anchorSeq,
					steerMarkSeed: snapshot.steerMarkSeed,
					startedAtMs: turnStartMs,
					ownedInputSeqs,
					admissionExchangeExcluded,
					memberSeqs: turns.map((t) => t.seq),
					sourceInputSeq,
					resumedFrom: sourceRunId,
					predecessorRun: recovery?.predecessorRun,
					fallbackConfigured: fallback.configured,
				},
				journal,
				journaled,
				journalFault,
				onJournalFault: () => controller.abort(),
				runOwnership: this.deps.runOwnership,
				checkAuthority: () => this.checkAuthority(convId, epoch),
			});
			// The const is what closures below capture — the mutable slot
			// above only bridges the pre-authority failure paths.
			authority = auth;
			const tools = auth.tools;
			const step = await this.deps.buildStep(conv, tools);
			this.checkAuthority(convId, epoch);
			accepts.current = {
				modalities: step.inputModalities ?? new Set(["text"]),
				carries: step.carries ?? (() => true),
			};
			this.checkAuthority(convId, epoch);
			// Steered messages use the same fixed capability gates as the initial
			// view, preserving the stable prompt prefix. Only the appended tail
			// changes when a steer is folded in.
			const viewCtx: ViewContext = {
				convId,
				tools,
				modalities: step.inputModalities,
				carries: accepts.current.carries,
				keepProviderExecuted: !isClaudeStep(step) && step.keepProviderExecuted === true,
				skillRef: resolveSkillRef,
			};
			// #418: a recorded native session sees only the seq delta —
			// entries past seen_seq, minus the reply the session itself
			// produced (it already holds that natively). Entries with no
			// seq — recall inserts, the resume partial — belong to this
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
			const viewOptions = {
				entries: viewEntries,
				prior: memory.prior,
				current: memory.current,
				partial: recovery?.partial ?? null,
				// The summary entry rides `entries` by its boundary seq —
				// the same store fact eligibility classifies by (#206).
				summarySeq: store.memoryEligibility(convId).summarySeq,
				ownedSeqs: snapshot.ownedInputSeqs,
				assertAuthority: () => this.checkAuthority(convId, epoch),
			};
			const merged = await buildModelView(viewCtx, viewOptions);
			// The engine resumes the recorded session at its head; the
			// fullPrompt thunk stays lazy — only a dead-session retry pays
			// for the second view build.
			const claudeSessionPlan = isClaudeStep(step)
				? {
						...(claudeRec !== null
							? {
									resume: {
										sessionId: claudeRec.sessionId,
										headUuid: claudeRec.headUuid,
									},
									fullPrompt: () => buildModelView(viewCtx, { ...viewOptions, entries }),
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
					}
				: undefined;

			const outcome = await pickEngine(this.deps.engines, step, convId).run({
				convId,
				epoch,
				head: sink,
				members: turns,
				live,
				state,
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
				assertAuthority: () => {
					this.checkAuthority(convId, epoch);
					if (journalFault.current !== undefined) throw journalFault.current;
				},
				holdsAuthority: () => this.deps.store.get(convId)?.epoch === epoch,
				messages: merged,
				tools,
				view: viewCtx,
				claimSteers: () => claimPending(this.lane(convId), sink.onStreamChunk !== undefined, false),
				unrequeueSteers: (steered) => this.lane(convId).pending.unshift(...steered),
				settle: (m, done) => void this.notifyDone(m, done),
				steerMarkSeed: snapshot.steerMarkSeed,
				ownedInputSeqs: [...ownedInputSeqs],
				onOwnedInputs: (seqs) => {
					for (const seq of seqs) ownedInputSeqs.add(seq);
				},
				sourceInputSeq,
				partial: recovery?.partial ?? null,
				seenText: recovery?.seenText ?? false,
				toolCalls: recovery ? [...recovery.toolCalls] : [],
				digest: recovery ? [...recovery.digest] : [],
				filterRetryUsed,
				overflowRecoverable: overflowHoldable(recovery, this.deps.compaction !== undefined),
				// design/compaction.md → Timing: the step-boundary trigger.
				// Wired only when the fold-resume is possible — the gate and
				// the budget are the same invariant (one fold-resume per
				// logical turn), so an already-resumed attempt keeps
				// dispatching and the 85% context landing stays its backstop.
				...(this.deps.compaction !== undefined && recovery?.overflowed !== true
					? {
							preemptCheck: (info: { projectedInputTokens: number | null; stepNumber: number }) => {
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
										// Completed history only — inputs queued behind
										// this request must not push the boundary onto
										// the running exchange.
										beforeSeq: this.foldCeiling(convId, activeFloor),
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
							},
						}
					: {}),
				evidence: this.reviewer?.evidence,
				skillWatch: this.skillWatch,
				turnStartMs,
				signal: controller.signal,
				// Held when a fallback could follow, or when earlier candidates
				// already failed — the terminal error then lists every miss.
				holdZeroEffectError:
					fallback.fresh && (fallback.next() !== undefined || fallback.misses.length > 0),
				...(fallback.misses.length > 0 ? { fallbackMisses: fallback.misses } : {}),
				step,
				...(claudeSessionPlan !== undefined ? { claudeSession: claudeSessionPlan } : {}),
			});
			// Record the window on both rails — the failed rail throws its
			// recovery/error below, and the request went out either way.
			if (outcome.window !== null && recallVersion !== null) {
				try {
					this.deps.recordWindow?.(convId, {
						model: outcome.model,
						step: outcome.steps,
						capture: outcome.window,
						recallVersion,
					});
				} catch (err) {
					log.error("context window record failed — turn continues", err, {
						conversation: convId,
					});
				}
			}
			if (outcome.kind === "failed") {
				// Carry the filter retry budget into a possible resume.
				filterRetryUsed = outcome.filterRetryUsed;
				errorHeld = outcome.errorHeld === true;
				throw failureFromStream(outcome);
			}
			// A stream that reached its finish while a journal write
			// faulted must not land a reply the journal can't describe.
			if (journalFault.current !== undefined) throw journalFault.current;
			// Land the durable reply, then keep the post-delivery authority check:
			// a stop during sink flushing must fence follow-up work. Persistence and
			// delivery are both on the same authority-checked finish path.
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
								ownedInputSeqs.has(e.seq),
						),
				memoryEligibility: () => store.memoryEligibility(convId),
				steerMark: outcome.steerMark,
				ownedInputSeqs,
				admissionExchangeExcluded,
				responseMessage: outcome.responseMessage,
				finishReason: outcome.finishReason,
				usage: outcome.usage,
				lastStepInputTokens: outcome.lastStepInputTokens,
				contextWindow: step.contextWindow,
				forcedKind: state.forcedCompletion(),
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
						journaled(() => journal?.noteReplyLanded(auth.runId));
						return seqs;
					})(),
				memory: this.deps.memory,
			});
			// The reply landed durably — a failure past this point must not
			// also record a progress event (the final reply is the record).
			record.markReplyLanded();
			// #418: advance the native session record only now — the reply
			// is durable, so the next turn resumes at this head with a
			// delta cut at these seqs. Interrupted and failed turns never
			// reach this line and leave the record at the last finish.
			if (
				isClaudeStep(step) &&
				outcome.claudeSession !== undefined &&
				landedReplySeq !== null
			) {
				const headUuid = outcome.claudeSession.headUuid;
				if (headUuid !== "") {
					try {
						this.deps.claudeSessions?.put({
							conversationId: convId,
							modelRef: step.label,
							sessionId: outcome.claudeSession.sessionId,
							headUuid,
							seenSeq: sentSeqMax ?? claudeRec?.seenSeq ?? 0,
							replySeq: landedReplySeq,
						});
					} catch (err) {
						log.warn("claude session record write failed — turn continues", err, {
							conversation: convId,
						});
					}
				} else {
					log.warn("claude session head missing — record not advanced", {
						conversation: convId,
					});
				}
			}
			const fallbackNote: FallbackNote | undefined =
				fallback.misses.length > 0 && conv.model !== null
					? {
							servedBy: conv.model,
							misses: fallback.misses.map(({ ref, reason }) => ({ ref, reason })),
						}
					: undefined;
			await notifyAll(
				fallbackNote !== undefined && landed.done.kind === "completed"
					? { ...landed.done, fallback: fallbackNote }
					: landed.done,
			);
			stampRun("completed", "delivered");
			// A stop during terminal delivery must prevent follow-up work.
			this.checkAuthority(convId, epoch);
			// Clear the turn controller before retention/review/compaction so /stop
			// reports no generating turn; compaction has its own controller.
			{
				const lane = this.lanes.get(convId);
				if (lane !== undefined && lane.controller === controller) lane.controller = null;
			}
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
				...(this.reviewer === undefined ? {} : { tools }),
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
		} catch (err) {
			// The crash journal is the only record of what the turn's
			// tools did — when it cannot write, the turn dies as an error
			// (never 'fenced', never completed, never a fallback advance)
			// so no reported failure can invite a repeat of an unjournaled
			// effect.
			const failOnJournalFault = async (fault: unknown): Promise<void> => {
				controller.abort();
				log.error("turn aborted — the turn journal cannot write", fault, {
					conversation: convId,
					epoch,
				});
				announcePreRunFailure(fault);
				stampRun("error", "failed");
				await notifyAll({
					kind: "error",
					message: terminalFailureMessage(fault, recovery !== undefined),
					modelCalls: state.snapshot().modelCalls,
				});
			};
			if (journalFault.current !== undefined) {
				await failOnJournalFault(journalFault.current);
			} else if (err instanceof FencedError || controller.signal.aborted) {
				// Abort even an epoch-fenced provider call; otherwise it may keep
				// generating into an abandoned stream and consume provider capacity.
				controller.abort();
				log.info("turn fenced", { conversation: convId, epoch, error: String(err) });
				announcePreRunFailure(err);
				// What already ran stays transcript — the sanctioned post-fence
				// state write, before the stamp wake settling reads.
				recordUnlandedProgress({ kind: "aborted", cause: fencedCause() });
				stampRun("fenced", "undelivered");
				await notifyAll({ kind: "fenced" });
			} else if (err instanceof ContextOverflowError) {
				// Recover once: compact the failed attempt and resume with its partial
				// so completed tools are not repeated. A second overflow follows the
				// terminal error path. The failed attempt's run id rides the
				// recovery: the continuation's row inherits its settled calls.
				const outcome = await recoverFromOverflow({
					convId,
					epoch,
					failure: err,
					conversation: conv,
					memory,
					startedAt: turnStartMs,
					live,
					filterRetryUsed,
					resumedFrom: sourceRunId,
					failedRunId: authority?.runId,
					operatorRequest: recovery?.operatorRequest,
					recallVersion,
					sourceInputSeq: sourceInputSeq(),
					members: turns,
					compact: () =>
						this.doCompact(
							conv,
							err instanceof PreemptCompactError ? "preempt" : "overflow",
							activeFloor,
						),
					assertAuthority: () => this.checkAuthority(convId, epoch),
					holdsAuthority: () => this.deps.store.get(convId)?.epoch === epoch,
					signal: controller.signal,
				});
				if (outcome.kind === "resume") {
					// This attempt's row is done — the stream failed and its
					// output was withheld for recovery; the resume opens a
					// fresh row that inherits this row's settled calls, so a
					// crash of the continuation still resumes with them.
					// No pre-run announcement: the fresh run links its members
					// through its own begin.
					stampRun("error", "undelivered");
					outcome.recovery.ownedInputSeqs = [...ownedInputSeqs];
					outcome.recovery.admissionExchangeExcluded = admissionExchangeExcluded;
					// The continuation stays on the serving candidate and keeps
					// its fallback story (run-row configured ref, finish note).
					outcome.recovery.fallback = fallback.trail;
					return { kind: "resume", recovery: outcome.recovery, turns: outcome.members };
				}
				if (outcome.kind === "error") {
					recordUnlandedProgress({ kind: "failed", failure: outcome.message });
				} else if (outcome.kind === "fenced") {
					// A fence landing during recovery is still a fence: the
					// attempt's completed work stays transcript.
					recordUnlandedProgress({ kind: "aborted", cause: fencedCause() });
				}
				announcePreRunFailure(err);
				stampRun(
					outcome.kind === "fenced" ? "fenced" : "error",
					outcome.kind === "fenced" ? "undelivered" : "failed",
				);
				await notifyAll(
					outcome.kind === "fenced"
						? { kind: "fenced" }
						: { kind: "error", message: outcome.message },
				);
			} else {
				// Abort provider work on any escaping error, not only on fencing; the
				// stream may still be producing after the chunk loop unwinds.
				controller.abort();
				// Zero effect: no model call completed and no tool was
				// dispatched under this run (design/model.md → Model fallback
				// list — openclaw's canFallbackAfterError gate). The probe is
				// a journal read: if it throws, the turn ends as a journal
				// fault before any fallback is considered.
				let journaledCalls = 0;
				try {
					if (journal !== undefined && authority !== undefined) {
						const id = authority.runId;
						journaledCalls = journaled(() => journal.callsFor(id)).length;
					}
				} catch (probeErr) {
					log.error("fallback gate could not read the turn journal", probeErr, {
						conversation: convId,
						cause: err instanceof Error ? err.message : String(err),
					});
					await failOnJournalFault(probeErr);
					return { kind: "done" };
				}
				const zeroEffect = state.snapshot().modelCalls === 0 && journaledCalls === 0;
				// Quota is logged as its own class so a missing retry explains
				// itself: the scheduler ladder only re-fires transient failures.
				const quota = quotaExhausted(err);
				const errClass = failureClass(err);
				const miss: FallbackMiss = {
					ref: conv.model ?? "(no model)",
					reason: missReason(err),
					transient: isTransientTurnFailure(err),
				};
				// A content-filtered request already spent its one same-model
				// retry; the filter rule ends the turn, it never moves the
				// blocked request to another lane. Context overflow is never
				// a trigger either — it reaches here only when compaction is
				// not wired (no recovery to hand it to), and another lane
				// would face the same history (design/model.md).
				const next =
					zeroEffect && !isContentFilter(err) && !isContextOverflow(err)
						? fallback.next()
						: undefined;
				if (next !== undefined && fallback.configured !== null) {
					log.warn("model fallback", {
						conversation: convId,
						from: miss.ref,
						to: next,
						failureClass: errClass,
						...(quota?.resetAt !== undefined ? { quotaResetAt: quota.resetAt } : {}),
						attempt: fallback.misses.length + 1,
						error: err instanceof Error ? err.message : String(err),
					});
					// Same hand-off as an overflow resume: this row ends
					// undelivered and the successor inherits it (it holds no
					// calls — zero effect — but owns the members' wakes).
					stampRun("error", "undelivered");
					return {
						kind: "resume",
						recovery: {
							conversation: { ...conv, model: next },
							partial: null,
							memory,
							seenText: false,
							toolCalls: [],
							digest: [],
							loop: state.snapshot(),
							startedAt: turnStartMs,
							live,
							filterRetryUsed,
							predecessorRun: authority?.runId,
							recallVersion,
							sourceInputSeq: sourceInputSeq(),
							ownedInputSeqs: [...ownedInputSeqs],
							admissionExchangeExcluded,
							fallback: { configured: fallback.configured, tried: [...fallback.misses, miss] },
						},
						turns,
					};
				}
				// Only a fresh attempt's failure ends the walk; an overflow
				// continuation or resume failing reports its own error.
				const misses = fallback.fresh ? [...fallback.misses, miss] : [miss];
				log.error("turn failed", err, {
					conversation: convId,
					failureClass: errClass,
					...(quota?.resetAt !== undefined ? { quotaResetAt: quota.resetAt } : {}),
					...(misses.length > 1 ? { fallbacksTried: misses.map((m) => m.ref) } : {}),
				});
				// The stamps are what lets a trigger owner (a schedule fire) tell
				// a zero-call transport blip from a failure the provider already
				// spent work on; other error paths stay unstamped. After a
				// fallback walk, transient means every candidate's was.
				const done: TurnDone = {
					kind: "error",
					message:
						misses.length > 1
							? exhaustedMessage(misses)
							: terminalFailureMessage(err, recovery !== undefined),
					modelCalls: state.snapshot().modelCalls,
					transient: misses.every((m) => m.transient),
				};
				// A withheld error never reached the wire — the terminal
				// story goes out now, before the sinks settle.
				if (errorHeld) emitChunk(convId, turns, live, { type: "error", errorText: done.message });
				recordUnlandedProgress({ kind: "failed", failure: done.message });
				announcePreRunFailure(err);
				stampRun("error", "failed");
				await notifyAll(done);
			}
		} finally {
			// Whatever escaped the catch above — a throw inside recovery
			// or notifyAll — must not leave a begun row 'running': rows
			// left 'running' mean process death, and only the journal
			// gets to say that.
			stampRun("error", "failed");
		}
		return { kind: "done" };
	}
}

export function userMessage(parts: UIMessage["parts"]): UIMessage {
	return { id: randomUUID(), role: "user", parts };
}
