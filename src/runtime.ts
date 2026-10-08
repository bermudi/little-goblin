// Runtime — per-conversation serial queue, turn loop, authority fencing.
//
// A Turn is a unit of work enqueued on a conversation: one agent loop. One
// active turn per conversation; the queue drains serially.
//
// The authority rule: before any side effect (Telegram send, state write,
// tool call), the turn re-checks that it still holds authority — its
// conversation epoch hasn't advanced since admission. Fenced turns abort
// quietly and log it.

import { type LanguageModel, type ToolSet, type UIMessage, type UIMessageChunk } from "ai";
import type { ProviderOptions, ToolExecutionOptions } from "@ai-sdk/provider-utils";
import { randomUUID } from "node:crypto";
import type { AcceptsMedia, MediaPosition } from "./agent/attachments.ts";
import type { OutgoingFile } from "./agent/tools/send.ts";
import type { Conversation, ConversationStore } from "./conversation.ts";
import type { MemoryDocument } from "./hindsight.ts";
import {
	buildRetentionDocument,
	memoryBoundEntries,
	messageText,
	recallMemory,
	retentionSourceFrom,
	type MemoryTurnDeps,
	type RecallContext,
	type RetentionSource,
} from "./memory.ts";
import { log } from "./log.ts";
import { runCompaction, type CompactionOutcome } from "./agent/compaction.ts";
import type { CompletedTurn, PriorTurnContext, ReviewerDeps } from "./reviewer.ts";
import type { JevClient } from "./jev.ts";
import { cancelAllReviews, cancelReviews, considerTurn } from "./reviewer.ts";
import { admitTurn, type LiveWire } from "./turn/admission.ts";
import {
	ContextOverflowError,
	failureFromStream,
	overflowHoldable,
	recoverFromOverflow,
	terminalFailureMessage,
	type TurnRecovery,
} from "./turn/overflow.ts";
import { TurnState, type ForcedKind } from "./turn/state.ts";
import { buildModelView, type ViewContext } from "./turn/view.ts";
import { claimMembers, driveStream, endLive, openLive, type LiveChunks } from "./turn/stream.ts";

// Loop landings (design/model.md → "No step budget — loops are caught,
// not capped"): a turn has no step budget; whichever cut fires first —
// detector, watchdog, context, or the operator's /stop — owns a final
// tools-off step, and the turn ends in an answer. The machinery that
// decides and escalates lives in turn/state.ts; the forced step's
// instruction text and its fold into the request live in the stream
// driver (turn/stream.ts).

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
// The watchdog's cadence — one check every N completed calls.
const LOOP_CHECK_EVERY = 16;
// Auto-compaction trigger (DESIGN.md, Compaction): a completed turn at
// or past this fraction of the catalog context window compacts in-lane.
// The ≥80% utilization warn stays as the alarm that it didn't keep up.
const COMPACT_AT_PCT = 75;

// ---------- sink: what the turn streams into (tg implements) ----------

// Which landing forced the answer — the loop machinery names its kinds
// (turn/state.ts); re-exported so TurnDone and the sinks share it.
export type { ForcedKind } from "./turn/state.ts";

export type TurnDone =
	| { kind: "completed"; forced?: ForcedKind }
	| { kind: "fenced" }
	| { kind: "error"; message: string };

// Every submitted sink receives exactly one onDone — completed, fenced, or
// error — so it can release resources (typing intervals, etc.) no matter
// how the turn ends, including being dropped from the queue by /stop.
export interface TurnSink {
	onTextDelta(delta: string): void;
	onReasoningDelta(delta: string): void;
	onToolCall(toolName: string, input: unknown): void;
	// Raw UIMessage-stream pass-through — the app channel's HTTP surface
	// forwards every chunk to the client verbatim, where the delta
	// methods above are telegram delivery (DESIGN.md, App channel).
	// Called on the head sink only, after the authority check, for every
	// chunk the runtime consumes — including finish/error/abort.
	onStreamChunk?(chunk: UIMessageChunk): void;
	onVoiceNote?(audio: Uint8Array): Promise<void>;
	// The send_file tool's door, matching speak's: the tool hands a
	// workspace path to the sink, which owns the Telegram send — so
	// "Telegram send is delivery, not a tool" stays true and file sends
	// ride the same serialized chain and authority fencing as text.
	// asFile forces the byte-exact document path (sendPhoto compresses).
	onFile?(file: OutgoingFile): Promise<void>;
	// The speak tool's synthesis is a visible wait: start a record_voice
	// chat action and return its stopper. Optional like onVoiceNote —
	// the runtime only wires the door when the sink provides it.
	onVoiceSynthesisStart?(): () => void;
	setAuthorityCheck?(check: () => boolean): void;
	onDone(done: TurnDone): void | Promise<void>;
}

// ---------- deps injected by the composition root ----------

export interface ModelStep {
	model: LanguageModel;
	system: string;
	providerOptions?: ProviderOptions;
	// The config ref this step resolved ("zai/glm-5.3") — observability
	// only; it rides the finish metadata so a stored reply remembers
	// which model wrote it after a later switch.
	label?: string;
	// The model's input modalities (models.dev) — decides which stored
	// attachment parts materialize as file parts this turn. Absent =
	// text-only, everything degrades to path references.
	inputModalities?: Set<string>;
	// What the provider pipe can carry (carriesMedia, providers.ts) —
	// the second gate on inlining, position-aware (user message vs tool
	// result). Absent = anything in user messages (legacy behavior).
	carries?: (mediaType: string, position: MediaPosition) => boolean;
	// The model's context window (models.dev), when known — the
	// denominator for window-utilization logging.
	contextWindow?: number;
}

export interface RuntimeDeps {
	store: ConversationStore;
	// Resolve the conversation's effective model + system prompt + provider
	// options (thinking level) fresh at each turn. May be async (auth
	// `!command` resolution shells out).
	buildStep(conv: Conversation, tools: ToolSet): ModelStep | Promise<ModelStep>;
	// Capture channel settings once at admission; compaction and overflow
	// recovery share this copy so edits affect only the next turn.
	captureConversation?(conv: Conversation): Conversation;
	// Build the tool set — bound to the deployment workspace by the
	// composition root. deliverVoice/recording wire the speak tool into
	// the running turn's sink (voice delivery + chat-action indicator).
	// The conversation is passed so conversation-pinned tools (program)
	// know where they run without the model handling chat ids.
	makeTools(
		conv: Conversation,
		deliverVoice?: (audio: Uint8Array) => Promise<void>,
		recording?: () => () => void,
		deliverFile?: (file: OutgoingFile) => Promise<void>,
		// Filled from this turn's ModelStep once buildStep resolves it;
		// the fetch tool reads it at request time when rendering stored
		// PDF references (see attachments.ts, AcceptsMedia).
		accepts?: { current: AcceptsMedia },
	): ToolSet;
	// Long-term memory — absent = exact current behavior. When present,
	// admitted turns recall bounded evidence pre-turn (fail-open,
	// cache-stable) and completed text exchanges enqueue retention under
	// the turn's authority check.
	memory?: MemoryTurnDeps;
	// Compaction wiring — absent = compaction never runs (tests, degraded
	// boots). summarize resolves the conversation's own model and returns
	// the summary text; modelRef labels the compactions row. The signal is
	// the compaction's own abort handle — /stop and shutdown cancel an
	// in-flight summary rather than waiting it out.
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

// ---------- fencing ----------

export class FencedError extends Error {
	constructor(convId: string) {
		super(`turn fenced: conversation ${convId} epoch advanced`);
		this.name = "FencedError";
	}
}

// Overflow recovery (turn/overflow.ts) owns the decision half: the
// failure vocabulary, the one-recovery budget, the partial gate, and
// the TurnRecovery package. This file keeps the invocation half —
// doCompact — and the attempt rails that consume the decision.

// ---------- runtime ----------

interface QueuedTurn {
	// The user message this submit appended to history. Steering input:
	// a live predecessor folds it into its next model call (DESIGN.md,
	// Turn).
	message: UIMessage;
	sink: TurnSink;
	// Guards the exactly-once onDone contract: a sink whose onDone throws
	// must not be re-notified by the drain guard below.
	doneSent: boolean;
	// A streaming sink whose onStreamChunk threw is detached from the
	// fan-out — one dead client must not kill the turn for the others.
	streamFailed?: boolean;
}

// A /compact waiting for the lane — run between turns so a running
// turn's exchange is whole in history before the cut is chosen.
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
	// The abort handle for an in-flight compaction summary call — aborted
	// by stop()/shutdown() so a stalled provider can't stall the process.
	compactController: AbortController | null;
	// The drain loop's promise — shutdown awaits it so a fenced sink's
	// final flush finishes before the process exits.
	draining: Promise<void> | null;
	// The running turn's wire log — see LiveChunks. Null between turns.
	live: LiveChunks | null;
}

// A queued submit "streams" iff its sink defines onStreamChunk — the
// app channel's raw chunk pass-through (DESIGN.md, App channel) is the
// only sink that does. A turn headed by a NON-streaming sink (the
// spin-off's headless bell — design/app.md → Spin-off — or a Telegram
// delivery sink) must never absorb a streaming submit: merged into its
// turn, that sink would get only onDone and the client watching the
// stream would see no reply at all. How many leading pending items a
// turn may claim: the whole queue when the head streams; otherwise
// only the leading run of non-streaming items, leaving the first
// streaming one to head its own turn.
function claimableCount(pending: QueuedTurn[], headStreams: boolean): number {
	if (headStreams) return pending.length;
	const first = pending.findIndex((t) => t.sink.onStreamChunk !== undefined);
	return first === -1 ? pending.length : first;
}

// Claim the leading pending items a turn may absorb — the splice half
// of the membership seam (design/runtime-turn.md → admission; the
// replay half and its one home live in turn/stream.ts). The
// head-streaming rule is claimableCount's; every claim site (drain,
// steering, the resume claim) goes through here.
function claimPending(lane: Lane, headStreams: boolean): QueuedTurn[] {
	return lane.pending.splice(0, claimableCount(lane.pending, headStreams));
}

// The attempt loop's decision vocabulary (design/runtime-turn.md →
// recursion→loop): a terminal outcome — every settle path (admission
// failure, fenced, error, completed) already ran — or a resume carrying
// the next attempt's TurnRecovery and the grown membership. TurnRecovery
// stays the only attempt-to-attempt wire; the membership rides the
// decision, never a closure.
type AttemptOutcome =
	| { kind: "done" }
	| { kind: "resume"; recovery: TurnRecovery; turns: QueuedTurn[] };

export class Runtime {
	private lanes = new Map<string, Lane>();
	// Set by shutdown(): submits still land in history but never run.
	private closed = false;
	// The skill reviewer — attached after the bot exists (its save note
	// delivers through bot.api). Absent = the feature is off.
	private reviewer: ReviewerDeps | undefined;
	// The loop watchdog — setReviewer's twin: index.ts wires the
	// reviewer's JevClient here (one instance, shared auth closure).
	// Absent = watchdog off; the repeat detector and the context landing
	// still bound the turn.
	private loopWatchdog: { decide: JevClient["decide"]; every: number } | null = null;
	// Turn-completion counter — the reviewer queue's serialization
	// order (gate latency must not reorder reviews).
	private turnCounter = 0;
	// The previous completed turn per conversation — a correction's
	// review needs the turn it corrects as evidence. Off-the-record
	// turns are never stored (and break the chain).
	private lastTurns = new Map<string, PriorTurnContext>();

	constructor(private deps: RuntimeDeps) {}

	setReviewer(reviewer: ReviewerDeps): void {
		this.reviewer = reviewer;
	}

	setLoopWatchdog(watchdog: { decide: JevClient["decide"]; every?: number } | null): void {
		this.loopWatchdog =
			watchdog === null
				? null
				: { decide: watchdog.decide, every: watchdog.every ?? LOOP_CHECK_EVERY };
	}

	// Is a turn queued or running on this conversation? Guest summons
	// consults this before submitting: steering would fold a second
	// summons into a running turn and deliver its reply into another
	// summons' message (design/telegram.md → Guest mode).
	hasActiveTurn(conversationId: string): boolean {
		const lane = this.lanes.get(conversationId);
		return lane !== undefined && (lane.running || lane.pending.length > 0);
	}

	// Enqueue a user message + a sink. The message lands in history
	// immediately — it's real regardless of when the turn runs, or
	// whether it runs at all (post-shutdown submits record only).
	// True means admitted to a lane; false means history-only after close.
	submit(conv: Conversation, message: UIMessage, sink: TurnSink): boolean {
		this.deps.store.append(conv.id, [message]);
		return this.admit(conv, message, sink);
	}

	// Telegram's durable inbox commits its user event and consumes the
	// inbox batch in one SQLite transaction before reaching this method.
	// Never append again here: that would duplicate a recovered turn.
	// The just-appended message rides along: steering input for a live
	// turn.
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

	// False after shutdown(): a closed runtime still appends submits to
	// history and fences them, so a caller offering future work (a webhook
	// hit) must gate on this rather than trusting submit's return.
	accepting(): boolean {
		return !this.closed;
	}

	// True while the lane holds live or queued work — the app's retry
	// route gates on it so "run again" can't land mid-turn as steering
	// input.
	busy(convId: string): boolean {
		const lane = this.lanes.get(convId);
		return lane !== undefined && (lane.pending.length > 0 || lane.controller !== null);
	}

	// Attach to a live turn's chunk stream — the resumable-stream half of
	// the app channel (a reload mid-turn, a second screen, the SDK's
	// reconnectToStream). Returns everything the wire has seen so far,
	// and the callbacks receive what follows; onEnd fires exactly once
	// with the turn's final outcome (the same TurnDone member sinks
	// receive). Null = no live turn: the caller answers 204 and the
	// client falls back to history. Snapshot + subscribe happen in one
	// synchronous step, so replay ∪ live is gapless.
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

	// Graceful stop: close intake, then fence every live lane — running
	// turns abort, queued ones drop. Resolves when the drains settle,
	// which includes each sink's final flush (the "⏹ superseded" stamp).
	async shutdown(): Promise<void> {
		this.closed = true;
		// Drained lanes no longer exist, but their gates/reviews can still be
		// pending. Fence them before the caller closes the store.
		if (this.reviewer) {
			const reviewsCancelled = cancelAllReviews();
			log.info("reviewer shutdown fenced", { reviewsCancelled });
		}
		const drains: Promise<void>[] = [];
		for (const [convId, lane] of this.lanes) {
			// stop().settled resolves once the dropped turns' onDone calls
			// settle — a sink's final flush must finish before the process
			// exits.
			drains.push(this.stop(convId).settled);
			if (lane.draining) drains.push(lane.draining);
		}
		await Promise.all(drains);
	}

	// /stop — advance the epoch (fences the in-flight turn) and abort its
	// stream. Queued turns are dropped: stop means stop. Dropped sinks still
	// get their onDone so nothing leaks. An in-flight compaction summary
	// aborts too — no pointer written, the next threshold crossing retries —
	// and queued /compact jobs drop with the turns, resolving as a noop so
	// the command still gets its reply.
	// The return value tells the caller
	// — synchronously — whether anything was actually live, so /stop can
	// say "stopped" vs "nothing was running"; `settled` resolves once the
	// dropped sinks' onDone calls settle — shutdown awaits it. Reviews the
	// reviewer queued or is running for this conversation are cancelled
	// too: /stop is the operator's panic lever, and a background
	// skill-write from a fenced topic must not outlive it (DESIGN.md,
	// "Skill reviewer").
	stop(convId: string): { stopped: boolean; settled: Promise<void>; reviewsCancelled: number } {
		const epoch = this.deps.store.bumpEpoch(convId);
		return this.cancelFenced(convId, epoch);
	}

	// Navigation commits the epoch together with the pin and its receipt,
	// then calls this synchronously. Abort/drop/cancel are runtime effects:
	// doing them inside SQLite's transaction would make rollback dishonest.
	// No await or new submission may intervene between fencing and cancellation.
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
		const reviewsCancelled = this.reviewer ? cancelReviews(convId) : 0;
		if (stopped) {
			log.info("turn stopped", { conversation: convId, epoch, reviewsCancelled });
		} else {
			log.debug("stop — nothing was running", { conversation: convId, epoch, reviewsCancelled });
		}
		return { stopped, settled: Promise.all(notifies).then(() => undefined), reviewsCancelled };
	}

	// Compact a conversation — the manual lever (/compact). Serialized
	// through the lane behind any running turn: the cut must be chosen
	// only after that turn's response is appended, or it could orphan the
	// exchange. Resolves (or rejects) when the job actually runs.
	compact(conv: Conversation): Promise<CompactionOutcome> {
		const lane = this.lane(conv.id);
		return new Promise<CompactionOutcome>((resolve, reject) => {
			lane.compacts.push({ conv, resolve, reject });
			if (!lane.running) lane.draining = this.drain(conv.id);
		});
	}

	// The in-lane body, shared by the auto trigger (a completed turn at
	// ≥75% of the context window — already inside the lane) and the queued
	// manual job. Runs the conversation's own model over the delta and
	// moves the pointer; the event stream is never touched. Throws
	// propagate — the auto path warns, the command path replies. The
	// summary call rides a dedicated abort controller: /stop and shutdown
	// cancel it rather than waiting out a stalled provider. Epoch changes
	// fence the commit the same way (the authority rule): the compaction
	// captures its epoch at entry and re-checks before spending or
	// committing, so a settings change mid-summary leaves the pointer and
	// the frozen snapshot untouched — the next crossing retries.
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
		// The authority this compaction runs under: the turn's admission
		// epoch (threshold/overflow share the admitted selection) or the
		// freshly resolved channel state (manual). checkAuthority throws
		// FencedError the moment the store's epoch moves past it.
		const epoch = conv.epoch;
		// The controller registers BEFORE the first await: a /stop arriving
		// while buildStep is pending must abort this compaction, not a null
		// controller — otherwise the summary runs and the pointer lands
		// despite the stop. The pre-aborted signal makes the summarize call
		// fail fast, so no boundary is written.
		const lane = this.lane(conv.id);
		const controller = new AbortController();
		lane.compactController = controller;
		try {
			// buildStep resolves the effective model (+ its context window from
			// the catalog) with all the usual auth/provider plumbing. Empty tools:
			// the summary call is a plain generate, no tool surface needed.
			const step = await this.deps.buildStep(conv, {});
			const tailTokenBudget =
				step.contextWindow !== undefined ? Math.round(step.contextWindow * 0.25) : 20_000;
			// An overflow proves our estimate was optimistic for this
			// conversation — keep a smaller tail so the resumed prompt
			// lands well under the line the provider just drew.
			const tail = reason === "overflow" ? Math.floor(tailTokenBudget / 2) : tailTokenBudget;
			// The ceiling each summarizer call must fit inside (compaction.ts):
			// half the window leaves room for the system prompt, the carried
			// summary, and the model's answer in the same request.
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
				// Compaction rewrote history — the prefix busts anyway, so this
				// is the free moment to refresh the frozen prompt snapshot
				// from current files (DESIGN.md → Cache stability). The next
				// turn (or the summarizer below) rebuilds and re-freezes.
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

	// Deliver the terminal signal exactly once and never let a throwing
	// sink escape — drain treats an escaped error as a crashed turn and
	// would notify the sink a second time.
	private async notifyDone(turn: QueuedTurn, done: TurnDone): Promise<void> {
		if (turn.doneSent) return;
		turn.doneSent = true;
		try {
			await turn.sink.onDone(done);
		} catch (err) {
			log.warn("sink onDone failed", err);
		}
	}

	// Re-check authority around every await: the captured epoch must still
	// be the conversation's epoch.
	private checkAuthority(convId: string, epoch: number): void {
		const current = this.deps.store.get(convId)?.epoch;
		if (current !== epoch) throw new FencedError(convId);
	}

	// Tool calls are side effects too — wrap every execute so it re-checks
	// authority before running. The SDK executes tools inside the stream,
	// where the chunk loop's check can't reach. Tools are built fresh per
	// turn, so wrapping in place is safe.
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

	// The membership seam's runtime half: claim what queued for a
	// resuming turn and replay the wire to streaming joiners (#96) —
	// the seam itself lives in turn/stream.ts, so the replay cannot be
	// forgotten. Injected into admission as claimQueued; the steer path
	// claims through the same splice. Queue policy never leaves here.
	private claimQueuedMembers(convId: string, sink: TurnSink, live: LiveWire): QueuedTurn[] {
		return claimMembers(
			convId,
			() => claimPending(this.lane(convId), sink.onStreamChunk !== undefined),
			live,
		);
	}

	// Bounded recall before the turn's model calls — the body lives in
	// memory.ts (recall contexts are memory's surface); the epoch
	// re-check around the awaits is injected per the authority rule.
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

	// Retention for a completed exchange: text only, program
	// housekeeping excluded, suppressed documents skipped. Null = append
	// history alone.
	private retentionOpt(
		conv: Conversation,
		anchorSeq: number | null,
		source: RetentionSource,
		responseMessage: UIMessage,
	): { target: string; document: MemoryDocument } | null {
		const mem = this.deps.memory;
		if (!mem || anchorSeq === null || conv.memoryExcluded) return null;
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
			suppressed = mem.contexts.isSuppressed(doc.id);
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
		return { target: mem.client.target, document: doc };
	}

	private async drain(convId: string): Promise<void> {
		const lane = this.lane(convId);
		if (lane.running) return;
		lane.running = true;
		try {
			for (;;) {
				// Drain everything queued into ONE turn — messages that
				// piled up behind a running turn are one conversational
				// beat, and a single model call answers them all. A
				// non-streaming head claims only non-streaming followers
				// (claimableCount); a left-behind streaming item heads
				// the next pass.
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
						// runTurn handles expected failures; this is a last-ditch guard
						// so one bad turn can't stall the lane or leak its sinks.
						log.error("turn crashed", err, { conversation: convId });
						const done: TurnDone = {
							kind: "error",
							message: err instanceof Error ? err.message : String(err),
						};
						// End the live log HERE, not only in the finally below: a
						// successor turn in this same drain pass re-pins lane.live,
						// which would orphan the crashed turn's subscribers — their
						// attach streams would hang without a terminal event.
						// endLive is idempotent, so a live already ended by the
						// turn's own notifyAll is untouched.
						const crashed = this.lanes.get(convId)?.live;
						if (crashed != null) endLive(crashed, done);
						for (const t of turns) await this.notifyDone(t, done);
					}
					// Between turns the lane holds no live controller — /stop's
					// stopped flag must not false-positive on a finished turn.
					this.lane(convId).controller = null;
					continue;
				}
				// /compact jobs run between turns — any running turn's exchange
				// is whole in history by the time the cut is chosen, and a submit
				// arriving mid-job simply starts the next drain pass.
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
			// A wire log no exit path ended is a bug — the notifyAll wrap and
			// this guard are the two ends of the contract. Close the attached
			// streams loudly instead of hanging them on a turn that will never
			// emit again.
			if (lane.live !== null && !lane.live.ended) {
				log.error("live chunk log never ended — closing attach streams", undefined, {
					conversation: convId,
				});
				endLive(lane.live, { kind: "error", message: "turn ended without an outcome" });
			}
			lane.live = null;
			// A drained lane is cheap to recreate on the next submit —
			// don't pin one per conversation for the life of the process.
			if (lane.pending.length === 0 && lane.compacts.length === 0) this.lanes.delete(convId);
		}
	}

	// The logical turn: drive attempts until one is terminal. A resume
	// re-enters with the packaged TurnRecovery (admission re-runs on the
	// resume path); the loop itself is unbounded so the one-recovery budget
	// lives in exactly one place, the overflow classifier. The wire log is
	// logical-turn scoped — opened once here, handed to every attempt: the
	// resume continues the same wire, and stack depth no longer stands in
	// for control flow.
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

	// One pass of the model loop. Returns "done" for every terminal path
	// (the sinks are already settled) and a resume decision for a held
	// overflow — the loop above consumes it. `live` is the logical turn's
	// wire log, opened by runTurn: everything the wire has seen this turn,
	// plus any HTTP subscribers attached mid-flight (GET .../stream).
	private async runAttempt(
		convId: string,
		turns: QueuedTurn[],
		recovery: TurnRecovery | undefined,
		live: LiveChunks,
	): Promise<AttemptOutcome> {
		const { store } = this.deps;
		let filterRetryUsed = recovery?.filterRetryUsed ?? false;
		// The loop machinery (design/model.md → "No step budget"): one
		// logical turn keeps one loop history. TurnState restores the
		// whitelisted fields from the failed attempt on an overflow resume;
		// the attempt-scoped cursor/issued/in-flight reset with the attempt.
		const state = new TurnState(
			{
				convId,
				watchdog: this.loopWatchdog,
				request: messageText(turns[0]!.message),
			},
			recovery?.loop,
		);
		// The first queued sink is the turn's delivery head (delta hooks,
		// voice, files); every streaming member receives the chunks (the
		// reply belongs to the conversation, not to the connection that
		// submitted first — design/app.md → Streaming members) and every
		// member gets exactly one onDone.
		const sink = turns[0]!.sink;
		const notifyAll = async (done: TurnDone) => {
			endLive(live, done);
			for (const t of turns) await this.notifyDone(t, done);
		};
		// Admission (design/runtime-turn.md → admission): the snapshot
		// fixes what this attempt owns, sees, and answers — immutable
		// input to every phase below.
		const admitted = admitTurn(
			{
				convId,
				live,
				getConversation: () => store.get(convId),
				captureConversation: this.deps.captureConversation,
				claimQueued: (wire) => this.claimQueuedMembers(convId, sink, wire),
				pendingIds: () => new Set(this.lane(convId).pending.map((t) => t.message.id)),
				modelEntries: () => store.modelEntries(convId),
				now: Date.now,
			},
			recovery === undefined
				? undefined
				: { conversation: recovery.conversation, startedAt: recovery.startedAt },
		);
		if (admitted.kind !== "admitted") {
			// The sink contract still holds: exactly one onDone per submit.
			await notifyAll({
				kind: "error",
				message: admitted.kind === "missing" ? "conversation missing" : admitted.message,
			});
			return { kind: "done" };
		}
		const { snapshot } = admitted;
		const { conv, epoch, entries, anchorSeq, turnStartMs } = snapshot;
		// Claimed resume members join this turn's membership here — the
		// snapshot carries them as data; the member list is runtime's.
		for (const t of snapshot.claimed) turns.push(t);
		sink.setAuthorityCheck?.(() => this.deps.store.get(convId)?.epoch === epoch);
		const controller = new AbortController();
		this.lane(convId).controller = controller;
		this.lanes.get(convId)!.live = live;

		// Hoisted so the catch can hand a resume attempt the same recall
		// result — recall must not re-run: the query was issued against a
		// pre-compaction snapshot and a second call would spend the quota
		// again for an answer the turn already has.
		let memory: TurnRecovery["memory"] = { prior: [], current: null };
		try {
			this.checkAuthority(convId, epoch);
			// The recall query is memory-bound: it may carry only eligible
			// history (the admission-time stamps, #85) — a re-enabled topic
			// must not query with text written while it was excluded. The
			// MODEL view below still sees everything: exclusion governs what
			// leaves for the memory service, not the conversation itself.
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
			// Same fencing as voice: a /stop'd turn can't emit a file after
			// losing authority.
			const deliverFile = sink.onFile
				? async (file: OutgoingFile) => {
						this.checkAuthority(convId, epoch);
						await sink.onFile!(file);
						this.checkAuthority(convId, epoch);
					}
				: undefined;
			// The speak tool's synthesis shows record_voice instead of
			// typing while it runs. Starting it sends a Telegram chat
			// action — a side effect, so fence the start; the returned
			// stopper only clears an interval.
			const recording = sink.onVoiceSynthesisStart
				? () => {
						this.checkAuthority(convId, epoch);
						return sink.onVoiceSynthesisStart!();
					}
				: undefined;
			// The accept-nothing placeholder is what tools see if they ask
			// before buildStep lands (nothing does — first read is at request
			// build, after the assignment below). Conservative is the safety
			// property: an unfilled ref must never inline anything.
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
			// The model view (design/runtime-turn.md → phase 3): the pure
			// builder owns recall-block interleaving, attachment
			// materialization, per-message conversion, and the burst merge —
			// the cache-stability surface in one unit. The context is fixed
			// for the attempt; the steer fold below converts through the same
			// gates so a steered message materializes exactly as it would
			// have in the next turn's view.
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

			// The stream driver (design/runtime-turn.md → phases 4–5):
			// callbacks, fan-out, wire log, and the steer fold run there,
			// over the state and membership pinned above. The outcome is
			// this attempt's output, translated below into the throws the
			// rails already know.
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
				// The filter retry budget is recovery-carried — hand the
				// resume what this attempt spent.
				filterRetryUsed = outcome.filterRetryUsed;
				throw failureFromStream(outcome);
			}
			// Steering folded mid-turn submits into this exchange, so the
			// retention source and anchor read history as the exchange ENDED —
			// but only up to the ownership mark: queued input this turn never
			// read must not anchor the reply. Nothing else can have appended
			// meanwhile — the lane is serial and every mid-turn submit funnels
			// through it. The admission-time anchor stays for recall (recall
			// already ran on the snapshot).
			const finalEntries = store.modelEntries(convId).filter((e) => e.seq <= outcome.steerMark);
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
				memoryBoundEntries(finalEntries, store.memoryEligibility(convId)),
			);
			// The defiance guard: a forced landing whose step STILL ended in
			// tool calls (a provider ignoring toolChoice:none) or produced no
			// prose would deliver a stamped nothing. The invariant gets the
			// last word: append plain-language prose, to the stored message
			// AND the live delta path (telegram delivers text only through
			// deltas).
			let reply = outcome.responseMessage;
			const forcedKind = state.forcedCompletion();
			if (
				forcedKind !== null &&
				reply !== null &&
				(outcome.finishReason === "tool-calls" ||
					!reply.parts.some((p) => p.type === "text" && p.text.trim() !== ""))
			) {
				const note = DEFIANCE_NOTE[forcedKind];
				log.warn("forced landing produced no prose — synthetic answer appended", {
					conversation: convId,
					forced: forcedKind,
					finishReason: outcome.finishReason,
				});
				reply = {
					...reply,
					parts: [...reply.parts, { type: "text", text: note }],
				};
				sink.onTextDelta(`\n\n${note}`);
			}
			if (reply !== null) {
				// reply already carries an SDK-assigned id.
				// The anchor ties it to the user message that triggered
				// this turn — the causal view places the reply right
				// after its question, not after later arrivals. Completed
				// text exchanges also enqueue retention in the same
				// transaction; fenced/failed turns never reach here.
				const memoryOpt = this.retentionOpt(conv, finalAnchor, finalSource, reply);
				store.append(
					convId,
					[reply],
					memoryOpt ? { anchorSeq: finalAnchor, memory: memoryOpt } : { anchorSeq: finalAnchor },
				);
			}
			// Window utilization rides the completion line: the last step's
			// input against the catalog context limit. Cached tokens still
			// occupy the window, so this is the filling gauge regardless of
			// cache health. Logged BEFORE the final notify — onDone means the
			// turn is fully finished, log included.
			const window =
				step.contextWindow !== undefined && outcome.lastStepInputTokens !== null
					? {
							input: outcome.lastStepInputTokens,
							limit: step.contextWindow,
							pct: Math.round((outcome.lastStepInputTokens / step.contextWindow) * 100),
						}
					: null;
			log.info("turn completed", {
				conversation: convId,
				epoch,
				finish: outcome.finishReason,
				usage: outcome.usage && {
					input: outcome.usage.inputTokens ?? null,
					cacheRead: outcome.usage.inputTokenDetails?.cacheReadTokens ?? null,
					cacheWrite: outcome.usage.inputTokenDetails?.cacheWriteTokens ?? null,
					output: outcome.usage.outputTokens ?? null,
				},
				window,
			});
			if (window && window.pct >= 80) {
				log.warn("context window ≥80% — history is approaching the limit", {
					conversation: convId,
					...window,
				});
			}
			await notifyAll(
				forcedKind !== null ? { kind: "completed", forced: forcedKind } : { kind: "completed" },
			);
			// onDone may itself await a slow delivery. A stop during that
			// await revokes this turn before it can start fresh background
			// work (in particular auto-compaction with a new controller).
			this.checkAuthority(convId, epoch);
			// The reply has landed — nothing generating remains. Drop the
			// lane's controller BEFORE the post-reply work (retention,
			// reviewer, threshold compaction) so a /stop in that window
			// reports "nothing was running" instead of "stopped" for a
			// turn that already answered. Compaction keeps its own
			// compactController, which the stopped flag still counts.
			{
				const lane = this.lanes.get(convId);
				if (lane !== undefined && lane.controller === controller) lane.controller = null;
			}
			// Skill reviewer (DESIGN.md): every completed turn gates a
			// possible background review — fire-and-forget, off the lane,
			// never delaying the successor. Fenced/failed turns never
			// reach here, and neither do memory-excluded ones: off the
			// record means no durable distillation, so the reviewer never
			// sees the turn and the prior-turn chain breaks there (an
			// excluded turn is never evidence for the next review either).
			// The backstop only sees bugs: gate failures fall back inside
			// considerTurn, review failures log their own lines.
			if (this.reviewer) {
				if (store.get(convId)?.memoryExcluded ?? conv.memoryExcluded) {
					log.info("reviewer skipped — memory excluded", { conversation: convId });
					this.lastTurns.delete(convId);
				} else {
					const turnSeq = ++this.turnCounter;
					const snapshot: CompletedTurn = {
						conversationId: convId,
						turnSeq,
						operatorTexts: finalSource.userTexts,
						replyText: reply ? messageText(reply) : "",
						toolNames: outcome.toolCalls,
						toolDigest: outcome.digestRing.map((p) => p.entry),
					};
					void considerTurn(this.reviewer, snapshot, this.lastTurns.get(convId)).catch(
						(err: unknown) => {
							log.error("reviewer failed", err, { conversation: convId });
						},
					);
					this.lastTurns.set(convId, {
						operatorTexts: snapshot.operatorTexts,
						replyText: snapshot.replyText,
						toolDigest: snapshot.toolDigest,
					});
				}
			}
			// Auto-compaction (DESIGN.md, Compaction): the reply has landed and
			// the sinks are released; the lane stays busy through the summary
			// call so a queued successor reads the compacted view, not a
			// mid-flight one. Failure is loud but lossless — no boundary
			// written, the next threshold crossing retries. Deliberately NOT
			// thrown to the outer handler: onDone already fired.
			if (window && window.pct >= COMPACT_AT_PCT) {
				try {
					await this.doCompact(conv, "threshold");
				} catch (err) {
					if (err instanceof FencedError) {
						// A settings change fenced the summary — the same quiet shape
						// as a fenced turn: no pointer, the crossing retries.
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
				// Fenced turns abort quietly and log it. The abort is
				// load-bearing: a settings fence (/voice, /memory) bumps the
				// epoch without touching the controller, so without it the
				// provider keeps generating into a stream nobody reads —
				// billed tokens on a held connection. Aborting an already
				// aborted controller (/stop's path) is a no-op.
				controller.abort();
				log.info("turn fenced", { conversation: convId, epoch, error: String(err) });
				await notifyAll({ kind: "fenced" });
			} else if (err instanceof ContextOverflowError) {
				// Overflow recovery (turn/overflow.ts decides, runtime invokes):
				// drop only the failed attempt, compact, resume — the partial
				// carries the tool results, so tools never re-run. One recovery
				// per turn: the resume gets recovery !== undefined and falls to
				// the generic branch on a second overflow.
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
					// The decision, not a self-call: the attempt loop above
					// re-enters with the packaged recovery.
					return { kind: "resume", recovery: outcome.recovery, turns: outcome.members };
				}
				await notifyAll(
					outcome.kind === "fenced"
						? { kind: "fenced" }
						: { kind: "error", message: outcome.message },
				);
			} else {
				// Same bill as the fenced branch: any other exception escaping
				// mid-stream (a throwing sink hook, a tool-path bug) must kill
				// the provider call too — exiting the chunk loop alone leaves
				// it generating into a stream nobody reads.
				controller.abort();
				log.error("turn failed", err, { conversation: convId });
				await notifyAll({
					kind: "error",
					message: terminalFailureMessage(err, recovery !== undefined),
				});
			}
		}
		// Every path reaching here already settled the sinks.
		return { kind: "done" };
	}
}

export function userMessage(parts: UIMessage["parts"]): UIMessage {
	return { id: randomUUID(), role: "user", parts };
}
