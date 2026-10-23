// Per-conversation serial lanes and epoch fencing: fenced turns still run
// terminal callbacks so every sink is settled.

import { randomUUID } from "node:crypto";
import type { ProviderOptions, ToolExecutionOptions } from "@ai-sdk/provider-utils";
import { type LanguageModel, type ToolSet, type UIMessage, type UIMessageChunk } from "ai";
import type { AcceptsMedia, MediaPosition } from "./agent/attachments.ts";
import { type CompactionOutcome, runCompaction } from "./agent/compaction.ts";
import { isTransientTurnFailure } from "./agent/provider-errors.ts";
import { resolveSkillRef } from "./agent/skill-inject.ts";
import type { OutgoingFile } from "./agent/tools/send.ts";
import type { Conversation, ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";
import {
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
import { landAttempt, submitTurnReview } from "./turn/finish.ts";
import {
	ContextOverflowError,
	failureFromStream,
	overflowHoldable,
	recoverFromOverflow,
	type TurnRecovery,
	terminalFailureMessage,
} from "./turn/overflow.ts";
import type { SkillWatch } from "./turn/skill-attribution.ts";
import { type ForcedKind, TurnState } from "./turn/state.ts";
import { claimMembers, driveStream, endLive, type LiveChunks, openLive } from "./turn/stream.ts";
import { buildModelView, type ViewContext } from "./turn/view.ts";
import { replayKey, type TurnJournal } from "./turn-journal.ts";
import { buildRetryGuard, classifyRetry, type RetryGuard } from "./turn/retry-guard.ts";

const LOOP_CHECK_EVERY = 16;
// Completed turns at/above this compact in-lane — the lane stays occupied
// until the summary finishes so the next turn sees one whole view.
const COMPACT_AT_PCT = 75;

export type { ForcedKind } from "./turn/state.ts";

export type TurnDone =
	| { kind: "completed"; forced?: ForcedKind }
	| { kind: "fenced" }
	// modelCalls/transient are stamped only where the runtime can
	// know them — the terminal failure path. Absent means unknown, and
	// consumers must treat unknown as not-retryable.
	| { kind: "error"; message: string; modelCalls?: number; transient?: boolean };

// Exactly one terminal notification per submitted sink, including work
// dropped from the queue — channel sinks release typing and stream
// resources on completed, fenced, and failed turns alike.
export interface TurnSink {
	onTextDelta(delta: string): void;
	onReasoningDelta(delta: string): void;
	onToolCall(toolName: string, input: unknown): void;
	// The head receives emitted UIMessage chunks after authority checks. Overflow
	// recovery withholds its error chunk and successors, not prior partial output;
	// terminal status reaches sinks through onDone.
	onStreamChunk?(chunk: UIMessageChunk): void;
	onVoiceNote?(audio: Uint8Array): Promise<void>;
	// The sink owns file delivery, so it remains on the serialized,
	// authority-fenced delivery path. Both sides of its await re-check
	// authority; `asFile` preserves exact document bytes.
	onFile?(file: OutgoingFile): Promise<void>;
	// Voice synthesis exposes a visible wait and returns its stopper. Starting
	// that indicator is a side effect and is fenced by the running turn.
	onVoiceSynthesisStart?(): () => void;
	setAuthorityCheck?(check: () => boolean, anchorSeq?: number | null): void;
	onDone(done: TurnDone): void | Promise<void>;
}

export interface ModelStep {
	model: LanguageModel;
	system: string;
	providerOptions?: ProviderOptions;
	// Stored reply metadata uses this resolved config reference.
	label?: string;
	// Controls which stored attachments materialize as file parts; absent means
	// attachments degrade to path references. This keeps unsupported media out
	// of the model request rather than failing the whole turn.
	inputModalities?: Set<string>;
	// Second, position-aware gate for inlining media through the provider pipe;
	// a model capability alone is not enough when the provider cannot carry it.
	carries?: (mediaType: string, position: MediaPosition) => boolean;
	// Context-window denominator for utilization logging, when known.
	contextWindow?: number;
	// Retry budget for the provider's chat calls, when the provider's own
	// rules override the SDK default (2) — 1min bills every attempt, so
	// its steps carry 0. Absent keeps the default.
	maxRetries?: number;
}

export interface RuntimeDeps {
	store: ConversationStore;
	// Resolve model settings fresh per turn; auth resolution may be async.
	buildStep(conv: Conversation, tools: ToolSet): ModelStep | Promise<ModelStep>;
	// Capture channel settings at admission so recovery and compaction share a
	// stable snapshot. A later settings change fences the current attempt.
	captureConversation?(conv: Conversation): Conversation;
	// Build tools for the deployment workspace and conversation; delivery hooks
	// connect speak and file tools to the running sink.
	makeTools(
		conv: Conversation,
		deliverVoice?: (audio: Uint8Array) => Promise<void>,
		recording?: () => () => void,
		deliverFile?: (file: OutgoingFile) => Promise<void>,
		// Filled after buildStep so fetch can render stored PDF references with
		// this turn's media capabilities.
		accepts?: { current: AcceptsMedia },
		context?: { runId: string; sourceMessageId(): string },
	): ToolSet;
	// Optional memory recall is bounded, fail-open, and cache-stable; retention
	// is enqueued only while the turn retains authority. Memory input is kept
	// separate from the model's complete conversation view.
	memory?: MemoryTurnDeps;
	// Optional compaction uses the conversation's model; its dedicated signal
	// lets /stop and shutdown cancel an in-flight summary. A failed summary
	// leaves the event stream and compaction pointer untouched.
	compaction?: {
		modelRef(conv: Conversation): string;
		// Catalog window lookup — metadata only, never a model step: no
		// auth resolution and no prompt build, so a compaction pass can
		// never mint or rewrite the frozen prompt snapshot. Null means
		// unknown; budgets fall back to the defaults.
		contextWindow(conv: Conversation): number | null | Promise<number | null>;
		summarize(
			conv: Conversation,
			system: string,
			prompt: string,
			signal: AbortSignal,
		): Promise<string>;
	};
	// Between-turns persisted pruning: runs after the next batch is
	// claimed and before runTurn builds its view, so committed markers are
	// visible to the admission read. A throw is logged and the turn
	// proceeds — the projection commit is atomic.
	pruneBetweenTurns?: (convId: string) => void;
	// Each admitted attempt opens a run row before any tool side effect
	// can run. Optional — test rigs journal nothing.
	turnJournal?: TurnJournal;
	// Durable wake ownership (wake-dispatcher.ts): the composition's
	// window into which journal run processes which submitted message.
	// `begin` fires after the run row exists and before the stream can
	// reach a tool — the admitted members' durable event seqs plus the
	// run rows this attempt continues (explicit resume) or inherits
	// (overflow). `members` fires when a steered submit joins the
	// membership mid-run. `end` fires at the run's terminal journal
	// stamp. Membership is named by event seq, never by client message
	// id — ids are untrusted and may repeat across events, so an id
	// match could hand a wake to a run that never processed it. Only
	// meaningful when turnJournal exists; hooks must not throw (they
	// observe the turn, they never gate it).
	runOwnership?: {
		begin(event: {
			runId: string;
			conversationId: string;
			memberSeqs: number[];
			resumedFrom?: string;
			inheritFrom?: string[];
		}): void;
		members(runId: string, conversationId: string, memberSeqs: number[]): void;
		end(
			runId: string,
			status: "fenced" | "completed" | "error",
			delivery: "delivered" | "undelivered" | "failed",
		): void;
		/** The attempt died before `begin` could link its members — no run
		 *  row exists for reconcile to read, so the attempt's terminal
		 *  outcome is otherwise invisible to ownership. Fired on every
		 *  pre-run terminal path (a refused admission, an overflow that
		 *  will NOT resume — a resuming attempt's fresh run links
		 *  normally). Hooks must not throw, like the rest. */
		preRunFailure?(event: { conversationId: string; memberSeqs: number[]; error: string }): void;
	};
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
		let seq: number;
		if (journal !== undefined && seed.resumedFrom !== undefined) {
			seq = this.deps.store.db.transaction(() => {
				// The registry names the seq this append actually wrote —
				// inferring it (e.g. lastUserSeq) would silently register an
				// unrelated event if the message's shape ever changed.
				const seqs = this.deps.store.append(conv.id, [message]);
				journal.noteResumeRequest(seed.resumedFrom!, seqs[0]!);
				return seqs[0]!;
			})();
		} else {
			const seqs = this.deps.store.append(conv.id, [message]);
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

	// Compaction summarizes the event delta without rewriting the event stream.
	// Its dedicated controller handles stop/shutdown; authority checks leave the
	// pointer and prompt snapshot unchanged on cancellation or fencing. The
	// caller decides whether a failure is reported or retried.
	private async doCompact(
		conv: Conversation,
		reason: "threshold" | "manual" | "overflow",
	): Promise<CompactionOutcome> {
		if (reason === "manual") {
			conv = this.deps.store.get(conv.id) ?? conv;
			conv = this.deps.captureConversation?.(conv) ?? conv;
		}
		const compaction = this.deps.compaction;
		if (!compaction) return { kind: "noop", reason: "compaction not configured" };
		// Threshold/overflow use the admitted epoch; manual jobs resolve a fresh
		// conversation before taking authority.
		const epoch = conv.epoch;
		// Register before the first await so /stop can cancel a pending
		// contextWindow lookup.
		const lane = this.lane(conv.id);
		const controller = new AbortController();
		lane.compactController = controller;
		try {
			// Metadata only — never buildStep: resolving a model and building
			// a system prompt here would freeze a snapshot no turn asked for.
			const contextWindow = await compaction.contextWindow(conv);
			// The authority check doubles as the abort check: compactController
			// is only aborted by cancelFenced after the epoch commits, so a
			// /stop during the lookup already reports as a fence. runCompaction
			// reverses the order after each call — a provider may resolve under
			// abort, so there the signal check must land first.
			this.checkAuthority(conv.id, epoch);
			const tailTokenBudget = contextWindow !== null ? Math.round(contextWindow * 0.25) : 20_000;
			// Overflow recovery uses a smaller tail to stay below the provider's
			// observed limit.
			const tail = reason === "overflow" ? Math.floor(tailTokenBudget / 2) : tailTokenBudget;
			// Keep summarizer input below half the window to leave answer headroom.
			const inputTokenBudget = contextWindow !== null ? Math.floor(contextWindow * 0.5) : 32_000;
			const modelRef = compaction.modelRef(conv);
			log.info("compaction window", {
				conversation: conv.id,
				model: modelRef,
				contextWindow,
				tailTokenBudget: tail,
				inputTokenBudget,
				reason,
			});
			const outcome = await runCompaction(
				conv.id,
				this.deps.store,
				modelRef,
				(system, prompt, signal) => compaction.summarize(conv, system, prompt, signal),
				{
					tailTokenBudget: tail,
					inputTokenBudget,
					reason,
					assertAuthority: () => this.checkAuthority(conv.id, epoch),
				},
				controller.signal,
			);
			if (outcome.kind === "compacted") {
				// Rebuild the frozen prompt after compaction changed history.
				this.deps.store.clearPromptSnapshot(conv.id);
				log.info("prompt snapshot cleared for rebuild", {
					conversation: conv.id,
					reason,
				});
			}
			return outcome;
		} finally {
			if (lane.compactController === controller) lane.compactController = null;
		}
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

	// Keep terminal delivery exactly once, even when a sink throws. Mark before
	// invoking the hook so re-entrant error handling cannot notify it twice.
	private async notifyDone(turn: QueuedTurn, done: TurnDone): Promise<void> {
		if (turn.doneSent) return;
		turn.doneSent = true;
		try {
			await turn.sink.onDone(done);
		} catch (err) {
			log.warn("sink onDone failed", err);
		} finally {
			turn.release?.();
		}
	}

	// Awaiting work must not outlive the captured conversation epoch. Settings
	// mutations advance the epoch even when they do not abort the controller.
	private checkAuthority(convId: string, epoch: number): void {
		const current = this.deps.store.get(convId)?.epoch;
		if (current !== epoch) throw new FencedError(convId);
	}

	// Tools execute inside the SDK stream, so each tool needs its own authority
	// check; tools are fresh per turn. A tool cannot rely on the outer chunk
	// loop's check to fence its side effects. The same seam writes the crash
	// journal's dispatch/result/error transitions — dispatch only after the
	// authority check passes, so a fenced call never reads as entered.
	//
	// A journal write that throws is fatal to the turn, not a tool error:
	// the row is the only record of what ran — letting the SDK surface an
	// ordinary tool failure invites the model to repeat a side effect the
	// journal can no longer describe. The first fault aborts the attempt
	// and fences every later dispatch; the attempt's catch reports it as
	// a turn error, never 'fenced'.
	private fenceTools(
		tools: ToolSet,
		convId: string,
		epoch: number,
		runId?: string,
		guard?: RetryGuard,
		journalFault?: { current: unknown },
		onJournalFault?: () => void,
	): ToolSet {
		const journal = this.deps.turnJournal;
		const note = (write: () => void): void => {
			try {
				write();
			} catch (err) {
				if (journalFault !== undefined && journalFault.current === undefined) {
					journalFault.current = err;
				}
				onJournalFault?.();
				throw err;
			}
		};
		for (const [name, t] of Object.entries(tools)) {
			const execute = t.execute?.bind(t);
			if (execute === undefined) continue;
			t.execute = (input: unknown, options: ToolExecutionOptions<unknown>) => {
				this.checkAuthority(convId, epoch);
				if (journalFault?.current !== undefined) throw journalFault.current;
				if (journal !== undefined && runId !== undefined) {
					// Recovery fence: a signature that collides with the
					// interrupted attempt's own history is evidence, never an
					// answer. An operator's grant CAS-consumes in the same
					// transaction as the dispatch; a refusal journals as a
					// synthetic replayed result — it never reads as execution.
					const verdict = classifyRetry(name, guard?.get(replayKey(name, input)));
					if (verdict.kind === "refuse") {
						const value = { error: verdict.error };
						note(() =>
							journal.noteToolResult(runId, options.toolCallId, value, {
								replayed: true,
							}),
						);
						log.info("tool call refused by the recovery fence", {
							conversation: convId,
							tool: name,
							toolCallId: options.toolCallId,
						});
						return value;
					}
					note(() =>
						journal.noteToolDispatch(
							runId,
							options.toolCallId,
							name,
							input,
							verdict.kind === "execute-grant"
								? { retryCallId: verdict.grant.toolCallId }
								: undefined,
						),
					);
					if (verdict.kind === "execute-grant") {
						verdict.grant.retryConsumed = true;
					}
				}
				let result: ReturnType<typeof execute>;
				try {
					result = execute(input as never, options);
				} catch (err) {
					if (journal !== undefined && runId !== undefined) {
						note(() => journal.noteToolError(runId, options.toolCallId, err));
					}
					throw err;
				}
				if (
					journal !== undefined &&
					runId !== undefined &&
					result !== null &&
					typeof result === "object" &&
					"then" in result &&
					typeof (result as { then: unknown }).then === "function"
				) {
					// A settled promise is the earliest the result is known —
					// the wrapper resolves only after the journal row lands.
					return (result as PromiseLike<unknown>).then(
						(value) => {
							note(() => journal.noteToolResult(runId, options.toolCallId, value));
							return value;
						},
						(err: unknown) => {
							note(() => journal.noteToolError(runId, options.toolCallId, err));
							throw err;
						},
					);
				}
				if (journal !== undefined && runId !== undefined) {
					note(() => journal.noteToolResult(runId, options.toolCallId, result));
				}
				return result;
			};
		}
		return tools;
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
		let filterRetryUsed = recovery?.filterRetryUsed ?? false;
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
			endLive(live, done, convId);
			for (const t of turns) await this.notifyDone(t, done);
		};
		// The ownership window: from admission until the begin hook, the
		// attempt's members are unlinked — a terminal failure in that span
		// (a refused admission included) is invisible to the dispatcher's
		// reconcile (no run row to read), so it must be announced instead
		// of re-admitting the trigger forever.
		let ownershipBegun = false;
		const announcePreRunFailure = (err: unknown) => {
			if (ownershipBegun) return;
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
		sink.setAuthorityCheck?.(() => this.deps.store.get(convId)?.epoch === epoch, anchorSeq);
		const controller = new AbortController();
		this.lane(convId).controller = controller;
		this.lanes.get(convId)!.live = live;

		// Reuse recall on overflow resume; it belongs to the pre-compaction view.
		// Reissuing it would spend memory quota twice for one logical turn.
		let memory: { prior: RecallContext[]; current: RecallContext | null } = {
			prior: [],
			current: null,
		};
		// The crash journal's per-attempt state: a fresh runId per attempt
		// (an overflow resume opens a second row — the failed attempt keeps
		// its own record), stamped terminal exactly once. The finally guard
		// is the invariant's backstop: a begun row never escapes this attempt
		// still 'running', whatever the escape path.
		const journal = this.deps.turnJournal;
		// An operator-resume admission carries the interrupted run it
		// continues — every attempt of this turn links its run row to it
		// and inherits its calls as evidence: a re-asked effect conflicts
		// unless an operator grant names it.
		const sourceRunId = recovery?.resumedFrom;
		let runId: string | null = null;
		// A thrown journal write anywhere in the fence lands here — the
		// catch below aborts the turn instead of letting the SDK report a
		// tool error the model could retry.
		const journalFault: { current: unknown } = { current: undefined };
		let runStamped = false;
		const stampRun = (
			status: "fenced" | "completed" | "error",
			delivery: "delivered" | "undelivered" | "failed",
		) => {
			if (journal === undefined || runId === null || runStamped) return;
			journal.finishRun(runId, status, delivery);
			runStamped = true;
			// The terminal stamp IS the durable acknowledgement a wake
			// waits on — the hook fires after the row lands so the
			// dispatcher's settle read never sees a live run by mistake.
			this.deps.runOwnership?.end(runId, status, delivery);
		};
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
			const deliverVoice = sink.onVoiceNote
				? async (audio: Uint8Array) => {
						this.checkAuthority(convId, epoch);
						await sink.onVoiceNote!(audio);
						this.checkAuthority(convId, epoch);
					}
				: undefined;
			// File delivery is fenced before and after its await.
			const deliverFile = sink.onFile
				? async (file: OutgoingFile) => {
						this.checkAuthority(convId, epoch);
						await sink.onFile!(file);
						this.checkAuthority(convId, epoch);
					}
				: undefined;
			// Fence the chat action that starts synthesis; the sink's stopper can
			// resume its delivery UI after synthesis.
			const recording = sink.onVoiceSynthesisStart
				? () => {
						this.checkAuthority(convId, epoch);
						return sink.onVoiceSynthesisStart!();
					}
				: undefined;
			// Until buildStep resolves, media capability must conservatively reject
			// inlining.
			const accepts: { current: AcceptsMedia } = {
				current: { modalities: new Set(["text"]), carries: () => false },
			};
			// The run row lands before the SDK's loop can reach a tool:
			// after this line every dispatch is journaled under runId.
			// Creation, evidence inheritance (an operator-resume source
			// and any overflow-failed predecessor), and the source's
			// consumption are one journal transaction — a crash between
			// them must never leave a successor that re-executes recorded
			// side effects.
			runId = randomUUID();
			const rawTools = this.deps.makeTools(conv, deliverVoice, recording, deliverFile, accepts, {
				runId,
				sourceMessageId: () => turns[turns.length - 1]!.message.id,
			});
			journal?.beginRun({
				runId,
				conversationId: convId,
				epoch,
				anchorSeq,
				steerMark: snapshot.steerMarkSeed,
				convSnapshot: { model: conv.model, thinking: conv.thinking },
				toolNames: Object.keys(rawTools),
				startedAt: new Date(turnStartMs).toISOString(),
				ownedInputSeqs: snapshot.ownedInputSeqs,
				resumedFrom: sourceRunId,
				inheritFrom: recovery?.predecessorRun === undefined ? undefined : [recovery.predecessorRun],
			});
			// Every member claimed into this attempt — the drain's initial
			// claim and a resume admission's queue claim are both already
			// on `turns` — becomes this run's owned input here, before the
			// stream can reach a tool. A wake linked to a predecessor the
			// row continues or inherits moves with it.
			if (journal !== undefined) {
				this.deps.runOwnership?.begin({
					runId,
					conversationId: convId,
					memberSeqs: turns.map((t) => t.seq),
					...(sourceRunId !== undefined ? { resumedFrom: sourceRunId } : {}),
					...(recovery?.predecessorRun !== undefined
						? { inheritFrom: [recovery.predecessorRun] }
						: {}),
				});
				ownershipBegun = true;
			}
			// The recovery guard reads the fresh row once, after
			// inheritance: it already carries the source's decisions and
			// every predecessor attempt's recorded executions. Calls this
			// attempt then makes never join the set — same-run intentional
			// repetition is a live-turn matter, not recovery's.
			const recoveryGuard =
				journal === undefined ? undefined : buildRetryGuard(journal.callsFor(runId));
			const tools = this.fenceTools(
				rawTools,
				convId,
				epoch,
				runId,
				recoveryGuard,
				journalFault,
				() => controller.abort(),
			);
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
				skillRef: resolveSkillRef,
			};
			const merged = await buildModelView(viewCtx, {
				entries,
				prior: memory.prior,
				current: memory.current,
				partial: recovery?.partial ?? null,
				ownedSeqs: snapshot.ownedInputSeqs,
				assertAuthority: () => this.checkAuthority(convId, epoch),
			});

			const outcome = await driveStream({
				convId,
				epoch,
				head: sink,
				members: turns,
				live,
				state,
				journal,
				runId,
				// A steer that joins mid-run is processed by this run — the
				// wake hook hears only the joined seqs (converts that failed
				// were settled, never joined). Journaled turns only.
				...(journal === undefined
					? {}
					: {
							noteRunMembers: (seqs: number[]) =>
								this.deps.runOwnership?.members(runId!, convId, seqs),
						}),
				assertAuthority: () => {
					this.checkAuthority(convId, epoch);
					if (journalFault.current !== undefined) throw journalFault.current;
				},
				holdsAuthority: () => this.deps.store.get(convId)?.epoch === epoch,
				step,
				messages: merged,
				tools,
				view: viewCtx,
				claimSteers: () => claimPending(this.lane(convId), sink.onStreamChunk !== undefined, false),
				unrequeueSteers: (steered) => this.lane(convId).pending.unshift(...steered),
				settle: (m, done) => void this.notifyDone(m, done),
				steerMarkSeed: snapshot.steerMarkSeed,
				ownedInputSeqs: snapshot.ownedInputSeqs,
				partial: recovery?.partial ?? null,
				seenText: recovery?.seenText ?? false,
				toolCalls: recovery ? [...recovery.toolCalls] : [],
				digest: recovery ? [...recovery.digest] : [],
				filterRetryUsed,
				overflowRecoverable: overflowHoldable(recovery, this.deps.compaction !== undefined),
				evidence: this.reviewer?.evidence,
				skillWatch: this.skillWatch,
				turnStartMs,
				signal: controller.signal,
			});
			if (outcome.kind === "failed") {
				// Carry the filter retry budget into a possible resume.
				filterRetryUsed = outcome.filterRetryUsed;
				throw failureFromStream(outcome);
			}
			// A stream that reached its finish while a journal write
			// faulted must not land a reply the journal can't describe.
			if (journalFault.current !== undefined) throw journalFault.current;
			// Land the durable reply, then keep the post-delivery authority check:
			// a stop during sink flushing must fence follow-up work. Persistence and
			// delivery are both on the same authority-checked finish path.
			const landed = landAttempt({
				convId,
				epoch,
				conv,
				modelEntries: () => store.modelEntries(convId),
				memoryEligibility: () => store.memoryEligibility(convId),
				steerMark: outcome.steerMark,
				responseMessage: outcome.responseMessage,
				finishReason: outcome.finishReason,
				usage: outcome.usage,
				lastStepInputTokens: outcome.lastStepInputTokens,
				contextWindow: step.contextWindow,
				forcedKind: state.forcedCompletion(),
				sink,
				members: turns,
				live,
				append: (messages, opts) => store.append(convId, messages, opts),
				memory: this.deps.memory,
			});
			await notifyAll(landed.done);
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
			if (landed.window && landed.window.pct >= COMPACT_AT_PCT) {
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
			if (journalFault.current !== undefined) {
				// The crash journal is the only record of what the turn's
				// tools did — when it cannot write, the turn dies as an
				// error (never 'fenced', never completed) so no reported
				// failure can invite a repeat of an unjournaled effect.
				controller.abort();
				const fault = journalFault.current;
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
			} else if (err instanceof FencedError || controller.signal.aborted) {
				// Abort even an epoch-fenced provider call; otherwise it may keep
				// generating into an abandoned stream and consume provider capacity.
				controller.abort();
				log.info("turn fenced", { conversation: convId, epoch, error: String(err) });
				announcePreRunFailure(err);
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
					failedRunId: runId ?? undefined,
					operatorRequest: recovery?.operatorRequest,
					members: turns,
					compact: () => this.doCompact(conv, "overflow"),
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
					return { kind: "resume", recovery: outcome.recovery, turns: outcome.members };
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
				log.error("turn failed", err, { conversation: convId });
				// The stamps are what lets a trigger owner (a schedule fire) tell
				// a zero-call transport blip from a failure the provider already
				// spent work on; other error paths stay unstamped.
				const done: TurnDone = {
					kind: "error",
					message: terminalFailureMessage(err, recovery !== undefined),
					modelCalls: state.snapshot().modelCalls,
					transient: isTransientTurnFailure(err),
				};
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
