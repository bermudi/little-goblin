// Runtime — per-conversation serial queues and authority fencing.
// Epoch checks gate turn effects and channel delivery; fenced turns still run
// terminal callbacks so every sink is settled.

import { randomUUID } from "node:crypto";
import type { ProviderOptions, ToolExecutionOptions } from "@ai-sdk/provider-utils";
import { type LanguageModel, type ToolSet, type UIMessage, type UIMessageChunk } from "ai";
import type { AcceptsMedia, MediaPosition } from "./agent/attachments.ts";
import { type CompactionOutcome, runCompaction } from "./agent/compaction.ts";
import type { OutgoingFile } from "./agent/tools/send.ts";
import type { Conversation, ConversationStore } from "./conversation.ts";
import type { JevClient } from "./jev.ts";
import { log } from "./log.ts";
import {
	type MemoryTurnDeps,
	memoryBoundEntries,
	messageText,
	type RecallContext,
	recallMemory,
} from "./memory.ts";
import type { PriorTurnContext } from "./reviewer.ts";
import { Reviewer } from "./reviewer.ts";
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
import { type ForcedKind, TurnState } from "./turn/state.ts";
import { claimMembers, driveStream, endLive, type LiveChunks, openLive } from "./turn/stream.ts";
import { buildModelView, type ViewContext } from "./turn/view.ts";

const LOOP_CHECK_EVERY = 16;
// Completed turns at or above this threshold compact in-lane. The lane stays
// occupied until the summary finishes so the next turn sees one whole view.
const COMPACT_AT_PCT = 75;

export type { ForcedKind } from "./turn/state.ts";

export type TurnDone =
	| { kind: "completed"; forced?: ForcedKind }
	| { kind: "fenced" }
	| { kind: "error"; message: string };

// Every submitted sink receives exactly one terminal notification, including
// work dropped from the queue. This lets channel sinks release typing and
// stream resources on completed, fenced, and failed turns alike.
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
	setAuthorityCheck?(check: () => boolean): void;
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
		summarize(
			conv: Conversation,
			system: string,
			prompt: string,
			signal: AbortSignal,
		): Promise<string>;
	};
}

export class FencedError extends Error {
	constructor(convId: string) {
		super(`turn fenced: conversation ${convId} epoch advanced`);
		this.name = "FencedError";
	}
}

interface QueuedTurn {
	// The message appended to history; a live predecessor may fold it into its
	// next model call.
	message: UIMessage;
	sink: TurnSink;
	// Prevents a throwing sink from receiving a second terminal notification.
	// Drain's last-ditch handler can therefore safely settle the whole lane.
	doneSent: boolean;
	// A throwing stream sink is detached without killing the turn; remaining
	// sinks receive future chunks.
	streamFailed?: boolean;
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
}

// Keep a streaming submit queued behind a headless turn so it can lead its own
// attempt. A streaming head may claim all pending work; a headless head claims
// only the leading non-streaming run.
function claimableCount(pending: QueuedTurn[], headStreams: boolean): number {
	if (headStreams) return pending.length;
	const first = pending.findIndex((t) => t.sink.onStreamChunk !== undefined);
	return first === -1 ? pending.length : first;
}

function claimPending(lane: Lane, headStreams: boolean): QueuedTurn[] {
	return lane.pending.splice(0, claimableCount(lane.pending, headStreams));
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
	// Reviewer state is owned by Reviewer; the runtime only submits snapshots.
	// The runtime supplies ordering and the prior-turn chain, not gate logic.
	private reviewer: Reviewer | undefined;
	// Optional watchdog; repeat detection and context limits still apply when
	// it is absent.
	private loopWatchdog: { decide: JevClient["decide"]; every: number } | null = null;
	// Reviewer sequence number; gate latency must not reorder reviews.
	private turnCounter = 0;
	// Previous reviewable turn per conversation, used as correction evidence.
	// Off-the-record turns deliberately break this chain.
	private lastTurns = new Map<string, PriorTurnContext>();

	constructor(private deps: RuntimeDeps) {}

	setReviewer(reviewer: Reviewer): void {
		this.reviewer = reviewer;
	}

	setLoopWatchdog(watchdog: { decide: JevClient["decide"]; every?: number } | null): void {
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
		this.deps.store.append(conv.id, [message]);
		return this.admit(conv, message, sink);
	}

	// The inbox has already persisted this message; appending again would
	// duplicate a recovered turn.
	submitPersisted(conv: Conversation, message: UIMessage, sink: TurnSink): boolean {
		return this.admit(conv, message, sink);
	}

	private admit(conv: Conversation, message: UIMessage, sink: TurnSink): boolean {
		if (this.closed) {
			void this.notifyDone({ message, sink, doneSent: false }, { kind: "fenced" });
			return false;
		}
		const lane = this.lane(conv.id);
		lane.pending.push({ message, sink, doneSent: false });
		if (!lane.running) lane.draining = this.drain(conv.id);
		return true;
	}

	// Callers offering future work must gate on this after shutdown; submit still
	// records and fences the message.
	accepting(): boolean {
		return !this.closed;
	}

	// Used by app retries to avoid turning a retry into steering input.
	busy(convId: string): boolean {
		const lane = this.lanes.get(convId);
		return lane !== undefined && (lane.pending.length > 0 || lane.controller !== null);
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
		// Register before the first await so /stop can cancel a pending buildStep.
		const lane = this.lane(conv.id);
		const controller = new AbortController();
		lane.compactController = controller;
		try {
			const step = await this.deps.buildStep(conv, {});
			const tailTokenBudget =
				step.contextWindow !== undefined ? Math.round(step.contextWindow * 0.25) : 20_000;
			// Overflow recovery uses a smaller tail to stay below the provider's
			// observed limit.
			const tail = reason === "overflow" ? Math.floor(tailTokenBudget / 2) : tailTokenBudget;
			// Keep summarizer input below half the window to leave answer headroom.
			const inputTokenBudget =
				step.contextWindow !== undefined ? Math.floor(step.contextWindow * 0.5) : 32_000;
			const outcome = await runCompaction(
				conv.id,
				this.deps.store,
				compaction.modelRef(conv),
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
	// loop's check to fence its side effects.
	private fenceTools(tools: ToolSet, convId: string, epoch: number): ToolSet {
		for (const t of Object.values(tools)) {
			const execute = t.execute?.bind(t);
			if (execute === undefined) continue;
			t.execute = (input: unknown, options: ToolExecutionOptions<unknown>) => {
				this.checkAuthority(convId, epoch);
				return execute(input as never, options);
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
			() => claimPending(this.lane(convId), sink.onStreamChunk !== undefined),
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
						if (crashed != null) endLive(crashed, done);
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
				endLive(lane.live, { kind: "error", message: "turn ended without an outcome" });
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
		turns: QueuedTurn[],
		recovery: TurnRecovery | undefined,
		live: LiveChunks,
	): Promise<AttemptOutcome> {
		const { store } = this.deps;
		let filterRetryUsed = recovery?.filterRetryUsed ?? false;
		// Preserve loop history across overflow, while attempt-scoped state resets.
		// Completed tool calls stay in the recovery package rather than replaying.
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
			endLive(live, done);
			for (const t of turns) await this.notifyDone(t, done);
		};
		// Admission fixes this attempt's ownership and model input.
		const admitted = admitTurn(
			{
				convId,
				live,
				getConversation: () => store.get(convId),
				captureConversation: this.deps.captureConversation,
				claimQueued: (wire) => this.claimQueuedMembers(convId, sink, wire, turns),
				pendingIds: () => new Set(this.lane(convId).pending.map((t) => t.message.id)),
				modelEntries: () => store.modelEntries(convId),
				now: Date.now,
			},
			recovery === undefined
				? undefined
				: { conversation: recovery.conversation, startedAt: recovery.startedAt },
		);
		if (admitted.kind !== "admitted") {
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
		sink.setAuthorityCheck?.(() => this.deps.store.get(convId)?.epoch === epoch);
		const controller = new AbortController();
		this.lane(convId).controller = controller;
		this.lanes.get(convId)!.live = live;

		// Reuse recall on overflow resume; it belongs to the pre-compaction view.
		// Reissuing it would spend memory quota twice for one logical turn.
		let memory: TurnRecovery["memory"] = { prior: [], current: null };
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
			const tools = this.fenceTools(
				this.deps.makeTools(conv, deliverVoice, recording, deliverFile, accepts),
				convId,
				epoch,
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
			};
			const merged = await buildModelView(viewCtx, {
				entries,
				prior: memory.prior,
				current: memory.current,
				partial: recovery?.partial ?? null,
				assertAuthority: () => this.checkAuthority(convId, epoch),
			});

			const outcome = await driveStream({
				convId,
				epoch,
				head: sink,
				members: turns,
				live,
				state,
				assertAuthority: () => this.checkAuthority(convId, epoch),
				holdsAuthority: () => this.deps.store.get(convId)?.epoch === epoch,
				step,
				messages: merged,
				tools,
				view: viewCtx,
				claimSteers: () => claimPending(this.lane(convId), sink.onStreamChunk !== undefined),
				unrequeueSteers: (steered) => this.lane(convId).pending.unshift(...steered),
				settle: (m, done) => void this.notifyDone(m, done),
				modelEntries: () => store.modelEntries(convId),
				steerMarkSeed: snapshot.steerMarkSeed,
				partial: recovery?.partial ?? null,
				seenText: recovery?.seenText ?? false,
				toolCalls: recovery ? [...recovery.toolCalls] : [],
				digest: recovery ? [...recovery.digest] : [],
				filterRetryUsed,
				overflowRecoverable: overflowHoldable(recovery, this.deps.compaction !== undefined),
				evidence: this.reviewer?.evidence,
				turnStartMs,
				signal: controller.signal,
			});
			if (outcome.kind === "failed") {
				// Carry the filter retry budget into a possible resume.
				filterRetryUsed = outcome.filterRetryUsed;
				throw failureFromStream(outcome);
			}
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
			if (err instanceof FencedError || controller.signal.aborted) {
				// Abort even an epoch-fenced provider call; otherwise it may keep
				// generating into an abandoned stream and consume provider capacity.
				controller.abort();
				log.info("turn fenced", { conversation: convId, epoch, error: String(err) });
				await notifyAll({ kind: "fenced" });
			} else if (err instanceof ContextOverflowError) {
				// Recover once: compact the failed attempt and resume with its partial
				// so completed tools are not repeated. A second overflow follows the
				// terminal error path.
				const outcome = await recoverFromOverflow({
					convId,
					epoch,
					failure: err,
					conversation: conv,
					memory,
					startedAt: turnStartMs,
					live,
					filterRetryUsed,
					members: turns,
					compact: () => this.doCompact(conv, "overflow"),
					assertAuthority: () => this.checkAuthority(convId, epoch),
					holdsAuthority: () => this.deps.store.get(convId)?.epoch === epoch,
					signal: controller.signal,
				});
				if (outcome.kind === "resume") {
					return { kind: "resume", recovery: outcome.recovery, turns: outcome.members };
				}
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
				await notifyAll({
					kind: "error",
					message: terminalFailureMessage(err, recovery !== undefined),
				});
			}
		}
		return { kind: "done" };
	}
}

export function userMessage(parts: UIMessage["parts"]): UIMessage {
	return { id: randomUUID(), role: "user", parts };
}
