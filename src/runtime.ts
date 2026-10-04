// Runtime — per-conversation serial queue, turn loop, authority fencing.
//
// A Turn is a unit of work enqueued on a conversation: one agent loop. One
// active turn per conversation; the queue drains serially.
//
// The authority rule: before any side effect (Telegram send, state write,
// tool call), the turn re-checks that it still holds authority — its
// conversation epoch hasn't advanced since admission. Fenced turns abort
// quietly and log it.

import {
	convertToModelMessages,
	isStepCount,
	streamText,
	toUIMessageStream,
	type CallWarning,
	type LanguageModel,
	type ModelMessage,
	type ToolSet,
	type UIMessage,
	type UIMessageChunk,
} from "ai";
import type { ProviderOptions, ToolExecutionOptions } from "@ai-sdk/provider-utils";
import { randomUUID } from "node:crypto";
import { INLINE_ITEM_MAX_BYTES, materializeAttachments, type AcceptsMedia, type MediaPosition } from "./agent/attachments.ts";
import type { OutgoingFile } from "./agent/tools/send.ts";
import type { Conversation, ConversationStore } from "./conversation.ts";
import type { MemoryConfig } from "./config.ts";
import {
	HindsightClient,
	HindsightError,
	type MemoryDocument,
} from "./hindsight.ts";
import {
	buildRecallQuery,
	buildRetentionDocument,
	formatRecallBlock,
	messageText,
	withMemoryBlocks,
	type MemoryContexts,
	type RecallContext,
} from "./memory.ts";
import { log } from "./log.ts";
import { runCompaction, type CompactionOutcome } from "./agent/compaction.ts";
import { isContextOverflow } from "./agent/provider-errors.ts";
import type { CompletedTurn, PriorTurnContext, ReviewerDeps, ToolCallDigest } from "./reviewer.ts";
import { cancelAllReviews, cancelReviews, considerTurn, summarize, toolOk } from "./reviewer.ts";

const MAX_STEPS = 25;

// Auto-compaction trigger (DESIGN.md, Compaction): a completed turn at
// or past this fraction of the catalog context window compacts in-lane.
// The ≥80% utilization warn stays as the alarm that it didn't keep up.
const COMPACT_AT_PCT = 75;

// Provider capability warnings are observability, not control — logged
// compact, never fatal. Kept as strings so a warning object carrying a
// full tool definition can't bloat the log line. (Spec v4 collapsed the
// per-setting/per-tool variants into feature strings.)
function describeWarning(w: CallWarning): string {
	switch (w.type) {
		case "unsupported":
		case "compatibility":
			return `${w.type}:${w.feature}`;
		case "deprecated":
			return `deprecated:${w.setting}`;
		case "other":
			return `other:${w.message}`;
	}
}

// A message that cannot convert to the wire format degrades to a
// readable placeholder in position — role and id preserved — instead of
// failing every future turn identically. The corrupt-row precedent lives
// at the store boundary (conversation.ts, corruptPlaceholder); this is
// the same degradation one step later, at the conversion boundary. The
// original message stays in history: arrival-order storage is the truth.
function unconvertiblePlaceholder(m: UIMessage): UIMessage {
	return {
		id: m.id,
		role: m.role,
		parts: [
			{
				type: "text",
				text: `[this message could not be prepared for the model (${m.role} role) — it is kept in history; any attachment it carried may still be readable with read_file or bash tools]`,
			},
		],
	};
}

// ---------- sink: what the turn streams into (tg implements) ----------

export type TurnDone =
	| { kind: "completed" }
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

// Everything a memory-enabled turn needs. Built once at boot from the
// boot-time memory config (mini-app memory edits apply on restart, so a
// config change can never redirect queued personal content mid-run).
export interface MemoryTurnDeps {
	client: HindsightClient;
	config: MemoryConfig;
	contexts: MemoryContexts;
	// Records the latest recall outcome for /memory status. True =
	// service answered (results or empty); false = outage. Skips and
	// cancellations leave it untouched.
	noteRecall(ok: boolean): void;
}

// ---------- fencing ----------

export class FencedError extends Error {
	constructor(convId: string) {
		super(`turn fenced: conversation ${convId} epoch advanced`);
		this.name = "FencedError";
	}
}

// Everything the resume attempt inherits from the failed one: the
// partial reply (continued as the same message, so tools never re-run),
// the recall result (recall does not re-run on a snapshot that already
// moved), and the turn-scoped evidence so block separation, the
// reviewer's gate, and durationMs cover the whole turn.
interface TurnRecovery {
	partial: UIMessage | null;
	memory: { prior: RecallContext[]; current: RecallContext | null };
	seenText: boolean;
	toolCalls: string[];
	digest: { id: string; entry: ToolCallDigest }[];
	startedAt: number;
	// The live wire log carries across an overflow recovery: the resume
	// continues the same wire (holdForRecovery kept the failure off it),
	// so attached subscribers and the log must survive the recursion.
	live: LiveChunks;
}

// The provider rejected the request for context size mid-turn. Not an
// ordinary failure: thrown after the stream loop with the failed
// attempt's accumulated reply so the catch can compact and resume —
// the pi mechanism (pi-mono agent-session _checkCompaction drops only
// the failed attempt, compacts, then continues).
class ContextOverflowError extends Error {
	constructor(
		readonly partial: UIMessage | null,
		readonly seenText: boolean,
		readonly toolCalls: string[],
		readonly digest: { id: string; entry: ToolCallDigest }[],
	) {
		super("context window overflow");
		this.name = "ContextOverflowError";
	}
}

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

// A live turn's wire log + subscribers — the resumable-stream half of
// the app channel (design/app.md → Streaming members): every chunk the
// wire has seen, appended at the single emission point, plus HTTP
// subscribers attached mid-flight (GET .../stream — a reload, a second
// screen). One object per turn.
interface LiveChunks {
	chunks: UIMessageChunk[];
	subscribers: Set<{
		onChunk(chunk: UIMessageChunk): void;
		onEnd(done: TurnDone): void;
	}>;
	ended: boolean;
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

export class Runtime {
	private lanes = new Map<string, Lane>();
	// Set by shutdown(): submits still land in history but never run.
	private closed = false;
	// The skill reviewer — attached after the bot exists (its save note
	// delivers through bot.api). Absent = the feature is off.
	private reviewer: ReviewerDeps | undefined;
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
	// cancel it rather than waiting out a stalled provider.
	private async doCompact(
		conv: Conversation,
		reason: "threshold" | "manual" | "overflow",
	): Promise<CompactionOutcome> {
		const compaction = this.deps.compaction;
		if (!compaction) return { kind: "noop", reason: "compaction not configured" };
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
			return await runCompaction(
				conv.id,
				this.deps.store,
				compaction.modelRef(conv),
				(system, prompt, signal) => compaction.summarize(conv, system, prompt, signal),
				{ tailTokenBudget: tail, inputTokenBudget, reason },
				controller.signal,
			);
		} finally {
			if (lane.compactController === controller) lane.compactController = null;
		}
	}

	private lane(convId: string): Lane {
		let l = this.lanes.get(convId);
		if (!l) {
			l = { pending: [], compacts: [], running: false, controller: null, compactController: null, draining: null, live: null };
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
			log.warn("sink onDone failed", { error: String(err) });
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

	// Bounded recall before the turn's model calls. Fail-open: outages
	// persist an "unavailable" block (stable prefix, model sees the
	// difference from empty); anything unpersistable is left out so the
	// prefix never carries bytes that won't survive a restart.
	private async recallMemory(
		conv: Conversation,
		anchorSeq: number | null,
		history: UIMessage[],
		signal: AbortSignal,
		epoch: number,
	): Promise<{ prior: RecallContext[]; current: RecallContext | null }> {
		const mem = this.deps.memory;
		if (!mem || anchorSeq === null || conv.memoryExcluded) return { prior: [], current: null };
		// Local store failures are memory outages too — a corrupt
		// contexts table must degrade the turn, never fail it.
		let prior: RecallContext[];
		try {
			prior = mem.contexts.load(conv.id);
		} catch (err) {
			log.warn("memory contexts unreadable — continuing without prior blocks", {
				conversation: conv.id,
				error: String(err),
			});
			prior = [];
		}
		const query = buildRecallQuery(history);
		if (query === "") {
			log.debug("memory recall skipped — no text to query", { conversation: conv.id });
			return { prior, current: null };
		}
		try {
			const facts = await mem.client.recall(query, {
				signal,
				maxTokens: mem.config.maxTokens,
				budget: mem.config.budget,
			});
			this.checkAuthority(conv.id, epoch);
			const block = formatRecallBlock(facts, facts.length > 0 ? "results" : "empty");
			const sources = [...new Set(
				facts.map((f) => f.document_id).filter((d): d is string => typeof d === "string"),
			)].slice(0, 100);
			const current: RecallContext = { anchorSeq, content: block, sourceIds: sources };
			try {
				mem.contexts.save(conv.id, anchorSeq, block, sources);
			} catch (err) {
				log.warn("memory recall not persisted — continuing without it", {
					conversation: conv.id,
					error: String(err),
				});
				return { prior, current: null };
			}
			mem.noteRecall(true);
			log.info("memory recall stored", {
				conversation: conv.id,
				anchor: anchorSeq,
				facts: facts.length,
			});
			return { prior, current };
		} catch (err) {
			this.checkAuthority(conv.id, epoch);
			// A /stop during recall owns the outcome via the fence check —
			// don't mark the service degraded for an operator action.
			if (err instanceof HindsightError && err.kind === "cancelled") {
				return { prior, current: null };
			}
			if (err instanceof HindsightError) {
				mem.noteRecall(false);
				log.warn("memory recall unavailable — proceeding without it", {
					conversation: conv.id,
					kind: err.kind,
					status: err.status ?? null,
					retryable: err.retryable,
				});
				const block = formatRecallBlock(null, "unavailable");
				const current: RecallContext = { anchorSeq, content: block, sourceIds: [] };
				try {
					mem.contexts.save(conv.id, anchorSeq, block, []);
				} catch (saveErr) {
					log.warn("memory outage marker not persisted — continuing without it", {
						conversation: conv.id,
						error: String(saveErr),
					});
					return { prior, current: null };
				}
				return { prior, current };
			}
			log.warn("memory recall failed without a service error — continuing without it", {
				conversation: conv.id,
				error: String(err),
			});
			return { prior, current: null };
		}
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
			log.warn("memory suppression unreadable — skipping retention", {
				conversation: conv.id,
				error: String(err),
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
				const turns = lane.pending.splice(
					0,
					claimableCount(lane.pending, lane.pending[0]?.sink.onStreamChunk !== undefined),
				);
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
				log.error(
					"live chunk log never ended — closing attach streams",
					undefined,
					{ conversation: convId },
				);
				endLive(lane.live, { kind: "error", message: "turn ended without an outcome" });
			}
			lane.live = null;
			// A drained lane is cheap to recreate on the next submit —
			// don't pin one per conversation for the life of the process.
			if (lane.pending.length === 0 && lane.compacts.length === 0) this.lanes.delete(convId);
		}
	}

	private async runTurn(convId: string, turns: QueuedTurn[], recovery?: TurnRecovery): Promise<void> {
		const { store } = this.deps;
		// The first queued sink is the turn's delivery head (delta hooks,
		// voice, files); every streaming member receives the chunks (the
		// reply belongs to the conversation, not to the connection that
		// submitted first — design/app.md → Streaming members) and every
		// member gets exactly one onDone.
		const sink = turns[0]!.sink;
		// The wire log: everything the wire has seen this turn, plus any
		// HTTP subscribers attached mid-flight (GET .../stream). Carried
		// across overflow recovery by TurnRecovery — the resume continues
		// the same wire.
		const live = recovery?.live ?? { chunks: [], subscribers: new Set(), ended: false } as LiveChunks;
		const notifyAll = async (done: TurnDone) => {
			endLive(live, done);
			for (const t of turns) await this.notifyDone(t, done);
		};
		// Admission: capture the epoch this turn holds authority under.
		const conv = store.get(convId);
		if (!conv) {
			log.error("turn for missing conversation", undefined, { conversation: convId });
			// The sink contract still holds: exactly one onDone per submit.
			await notifyAll({ kind: "error", message: "conversation missing" });
			return;
		}
		const epoch = conv.epoch;
		// A resume attempt owns whatever queued while the overflow
		// compaction ran: those messages are already inside the fresh
		// snapshot below, so leaving them pending would steer them in a
		// second time. Claim them the way drain does.
		if (recovery !== undefined) {
			const lane = this.lane(convId);
			turns.push(
				...lane.pending.splice(
					0,
					claimableCount(lane.pending, sink.onStreamChunk !== undefined),
				),
			);
		}
		// Turn wall-clock for the finish metadata — admission to done,
		// so recall/attachments are inside the number the app displays.
		// A resume continues the failed attempt's clock, not a new one.
		const turnStartMs = recovery?.startedAt ?? Date.now();
		sink.setAuthorityCheck?.(() => this.deps.store.get(convId)?.epoch === epoch);
		// History snapshot is part of admission: the turn's context is the
		// compacted model view (summary + tail, DESIGN.md Compaction) as it
		// stood at admission — a /compact landing mid-turn can't rewrite
		// what this turn already sees. Newer input steers in later (see
		// prepareStep below), but recall and the reply anchor read THIS
		// snapshot; the retention source is recomputed at completion over
		// the exchange as it ended. Reading here, before the awaits, is
		// what keeps the boundary. The anchor rides along: recall blocks
		// and the causal view key off the triggering user message's seq.
		const entries = store.modelEntries(convId);
		const history = entries.map((e) => e.message);
		let anchorSeq: number | null = null;
		for (const e of entries) {
			if (e.message.role === "user" && (anchorSeq === null || e.seq > anchorSeq)) anchorSeq = e.seq;
		}
		// Ownership high-water mark: the newest event this turn is answer-
		// ing. Steering advances it (below); queued input this turn never
		// saw stays above the mark, so the reply never causally sorts after
		// input it didn't read (DESIGN.md, causal view).
		let steerHighWater = 0;
		for (const e of entries) steerHighWater = Math.max(steerHighWater, e.seq);
		log.info("turn started", { conversation: convId, epoch, history: history.length });
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
			memory = recovery?.memory ?? (await this.recallMemory(conv, anchorSeq, history, controller.signal, epoch));
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
			// Materialize attachment refs against THIS turn's model — a
			// media part the provider can't consume degrades to its path
			// reference instead of failing the request on every turn.
			// Memory recall blocks interleave before their anchored user
			// message (persisted, never regenerated); without memory the
			// sequence is byte-identical to history.
			const view = withMemoryBlocks(entries, memory.prior, memory.current);
			// A resume's partial reply goes last: it is this turn's
			// in-progress assistant message, and its tool results get the
			// same media treatment as any history event.
			if (recovery?.partial) view.push(recovery.partial);
			const prepared = await materializeAttachments(
				view,
				step.inputModalities,
				INLINE_ITEM_MAX_BYTES,
				accepts.current.carries,
			);
			this.checkAuthority(convId, epoch);
			// Convert per message: one malformed message must not fail the
			// turn. History is durable — a whole-array conversion failure
			// would repeat identically on every future turn and brick the
			// conversation (a failed steer leaves exactly such a message
			// behind). Degrade the offending message to a readable
			// placeholder in position — the corrupt-row precedent at the
			// store boundary (conversation.ts); the original stays on disk.
			// Per-message conversion is output-identical: the converter is a
			// pure per-message mapper (its only cross-message step, the
			// incomplete-tool-call filter, is itself per-message).
			const messages: ModelMessage[] = [];
			for (const m of prepared) {
				try {
					messages.push(
						...(await convertToModelMessages([m], {
							tools,
							ignoreIncompleteToolCalls: true,
						})),
					);
				} catch (err) {
					log.warn("message unconvertible — degrading to placeholder", {
						conversation: convId,
						message: m.id,
						role: m.role,
						error: err instanceof Error ? err.message : String(err),
					});
					messages.push(
						...(await convertToModelMessages([unconvertiblePlaceholder(m)], {
							tools,
							ignoreIncompleteToolCalls: true,
						})),
					);
				}
			}

			// Merge after conversion: one malformed message must degrade
			// ALONE — a UIMessage-level merge would fuse it with its
			// burst-mates and the placeholder would swallow their text.
			const merged = mergeConsecutiveUserModels(messages);

			// Cache observability (DESIGN.md, Cache stability): the per-call
			// request hashes — head (system + tools) and full request — are
			// logged by the model wrapper at EVERY call: tool-loop
			// continuations, retries, titling. See observedModel in
			// agent/providers.ts; this line only anchors the turn.
			log.info("model request", {
				conversation: convId,
				messages: merged.length,
			});

			// The last step's input is the fullest prompt this turn sent —
			// the honest numerator for window utilization.
			let lastStepInputTokens: number | null = null;
			// The raw provider error behind the stream's `error` chunk —
			// the chunk carries only the serialized message, and the
			// overflow classifier needs the body/cause chain too.
			let rawError: unknown = null;
			const result = streamText({
				model: step.model,
				// `instructions` is the v7 primary; the internal ModelStep keeps
				// its own `system` field name — the seam stays one property deep.
				instructions: step.system,
				messages: merged,
				tools,
				// Steering (DESIGN.md, Turn): prepareStep runs before every
				// model call inside the tool loop — including the first, so a
				// submit landing during the turn's startup (recall, attachments)
				// steers in too. Submits that arrived while this turn runs sit
				// in the lane queue; each boundary folds them into the next
				// request as an appended tail. Prefix bytes are untouched, so
				// the provider cache stays warm (DESIGN.md, Cache stability),
				// and the override carries forward to later steps.
				prepareStep: async ({ messages: stepMessages, stepNumber }) => {
					const lane = this.lane(convId);
					// Steering folds pending submits into the live request —
					// but a headless head (no onStreamChunk) must not absorb
					// a streaming submit; it stays queued to head the next
					// turn (claimableCount).
					const steered = lane.pending.splice(
						0,
						claimableCount(lane.pending, sink.onStreamChunk !== undefined),
					);
					if (steered.length === 0) return undefined;
					if (this.deps.store.get(convId)?.epoch !== epoch) {
						// Fenced on the way out (/stop bumped the epoch): put the
						// input back — stop() owns the queue and drops it. Never
						// throw here: a thrown prepareStep fails the stream as an
						// error instead of a fence.
						lane.pending.unshift(...steered);
						return undefined;
					}
					const injected: ModelMessage[] = [];
					const claimedIds = new Set<string>();
					let admittedCount = 0;
					for (const t of steered) {
						try {
							// Same treatment as the admission snapshot: media
							// materializes against this turn's model or degrades
							// to a path reference.
							const materialized = await materializeAttachments(
								[t.message],
								step.inputModalities,
								INLINE_ITEM_MAX_BYTES,
								accepts.current.carries,
							);
							injected.push(
								...(await convertToModelMessages(materialized, {
									tools,
									ignoreIncompleteToolCalls: true,
								})),
								);
							turns.push(t);
							// A streaming member that joined mid-turn missed everything
							// emitted before the join — replay the wire log so its
							// client sees the reply from the first token, not from
							// mid-sentence (sync code: nothing can interleave). A
							// dead client is detached, not fatal.
							if (t.sink.onStreamChunk !== undefined) {
								for (const c of live.chunks) {
									try {
										t.sink.onStreamChunk(c);
									} catch (err) {
										t.streamFailed = true;
										log.warn("sink onStreamChunk failed during replay — stream detached", {
											conversation: convId,
											error: String(err),
										});
										break;
									}
									}
								}
							claimedIds.add(t.message.id);
							admittedCount++;
						} catch (err) {
							// The message is durable history but this turn cannot
							// carry it. Error that submit's own delivery — never
							// requeue: the message would sit in history and fail
							// every successor turn's admission conversion the same
							// way, a poison pill. Later model views degrade it to a
							// placeholder at the admission boundary (runTurn's
							// conversion), so the conversation stays answerable.
							log.warn("steer conversion failed — submit errored, message degrades in later views", {
								conversation: convId,
								message: t.message.id,
								error: err instanceof Error ? err.message : String(err),
							});
							void this.notifyDone(t, {
								kind: "error",
								message: `that message could not be prepared for the model: ${err instanceof Error ? err.message : String(err)}`,
							});
						}
					}
					if (injected.length === 0) return undefined;
					// Advance the ownership mark by identity, not position. The
					// lane is serial but the queue is not this turn's: a submit
					// landing mid-conversion sits pending (never spliced), and a
					// failed steer is dropped above — neither may anchor this
					// reply (DESIGN.md, causal view).
					for (const e of this.deps.store.modelEntries(convId)) {
						if (e.seq > steerHighWater && claimedIds.has(e.message.id)) steerHighWater = e.seq;
					}
					log.info("steered into turn", {
						conversation: convId,
						submits: admittedCount,
						step: stepNumber,
					});
					return { messages: [...stepMessages, ...injected] };
				},
				...(step.providerOptions ? { providerOptions: step.providerOptions } : {}),
				stopWhen: isStepCount(MAX_STEPS),
				abortSignal: controller.signal,
				onError: ({ error }) => {
					// Kept for classification: the ui stream's error chunk
					// carries only the message string, but the overflow check
					// needs the provider's body/cause chain too.
					rawError = error;
					log.error("model stream error", error, { conversation: convId });
				},
				onStepEnd: ({ usage }) => {
					lastStepInputTokens = usage.inputTokens ?? null;
					// The cached split is how cache health is read off the log:
					// null means the provider didn't report it, 0 means
					// reported-and-cold. inputTokens includes the cached ones.
					// Spec v4 splits reads from writes — Anthropic-style caches
					// bill both; read-only caches (OpenRouter, openai-compatible)
					// leave write null.
					log.info("model step usage", {
						conversation: convId,
						inputTokens: usage.inputTokens ?? null,
						cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
						cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? null,
						outputTokens: usage.outputTokens ?? null,
					});
				},
			});

			// The SDK hands provider capability warnings back on the result —
			// previously the one fail-quiet seam in the model path: an ignored
			// setting or an inexpressible tool vanished. Observability only;
			// the turn proceeds regardless. (v7 exposes result promises as
			// bare PromiseLikes — Promise.resolve buys back .catch.)
			void Promise.resolve(result.warnings)
				.then((ws) => {
					if (ws !== undefined && ws.length > 0) {
						log.warn("model warnings", {
						conversation: convId,
						warnings: ws.map(describeWarning),
						});
					}
				})
				.catch((err: unknown) => {
					// An aborted stream's warnings promise rejects with it —
					// expected on /stop, not worth a warn line.
					log.debug("model warnings unavailable", {
						conversation: convId,
						error: String(err),
					});
				});

			let responseMessage: UIMessage | null = null;
			// The failed attempt's accumulated reply — stashed on a failed
			// finish so an overflow recovery can continue it as the same
			// message instead of starting the answer over.
			let partialResponse: UIMessage | null = null;
			// Every tool call this turn, in order — the reviewer's gate
			// state (count + names) and its fallback rule read this. A
			// resume inherits the failed attempt's: the gate sees the
			// whole turn.
			const toolCalls: string[] = recovery ? [...recovery.toolCalls] : [];
			// Reviewer evidence, captured while the stream still exists: the
			// last `evidence.calls` calls with truncated args/result/status.
			// Only captured when the reviewer is configured — zero cost when
			// the feature is off. Ring order = call order; an entry whose
			// result never arrives (stream ended) reads "(no result)".
			const evidence = this.reviewer?.evidence;
			const digestRing: { id: string; entry: ToolCallDigest }[] = recovery
				? [...recovery.digest]
				: [];
			// Block-boundary tracking for the live stream: last text part id
			// within a step, plus whether any text has streamed at all (see
			// the text-delta and start-step cases). A resume inherits the
			// failed attempt's flag so a continued text block doesn't get a
			// phantom "\n\n" before its first delta.
			let lastTextPartId: string | null = null;
			let seenText = recovery?.seenText ?? false;
			// Stream errors arrive as `error` chunks — they don't throw. The
			// authoritative signal is the finish outcome: "failed" means the
			// turn must surface an error, not commit partial output as a
			// clean completion.
			let streamError: string | null = null;
			// Set when the stream died on a classified context overflow and
			// a compact-and-resume can still run: the failed attempt's error
			// — and every chunk after it — stays off the client's stream
			// because the resumed attempt continues the same message.
			let holdForRecovery = false;
			const uiStream = toUIMessageStream<ToolSet, UIMessage>({
				stream: result.stream,
				sendReasoning: true,
				// Continuing a partial: the SDK seeds the response message
				// from the last assistant original — its id, its parts — so
				// the resumed stream's chunks merge into ONE message, and the
				// start chunk carries the id the client already saw.
				...(recovery?.partial ? { originalMessages: [recovery.partial] } : {}),
				// Retention keys documents and source refs to the assistant
				// message identity — without a generator the SDK leaves it
				// blank, so every completed turn mints one here.
				generateMessageId: randomUUID,
				// Finish metadata lands on the wire finish chunk AND the
				// stored response message — the app client reads live
				// stats and history reloads carry the same numbers.
				messageMetadata: ({ part }) =>
					part.type === "finish"
						? {
								model:
									step.label ??
									(typeof step.model === "string" ? step.model : step.model.modelId),
								finishReason: part.finishReason,
								durationMs: Date.now() - turnStartMs,
								usage: {
									input: part.totalUsage.inputTokens ?? null,
									output: part.totalUsage.outputTokens ?? null,
									cacheRead: part.totalUsage.inputTokenDetails?.cacheReadTokens ?? null,
									cacheWrite: part.totalUsage.inputTokenDetails?.cacheWriteTokens ?? null,
								},
							}
						: undefined,
				// The default serializer emits "An error occurred." — meant
				// for public HTTP clients. This stream feeds the operator's
				// own chat; the real message is what they need.
				onError: (error) => (error instanceof Error ? error.message : String(error)),
				onFinish: ({ responseMessage: rm, isAborted, outcome }) => {
					if (isAborted) return;
					if (outcome.status === "failed") {
						// rm is the accumulated message even on failure (the
						// SDK ends the stream with its state) — the overflow
						// recovery continues exactly this reply.
						partialResponse = rm;
						streamError ??=
							outcome.error instanceof Error
								? outcome.error.message
								: outcome.error != null
									? String(outcome.error)
									: "model stream failed";
						return;
					}
					responseMessage = rm;
				},
			});

			// call id → tool name: output-error chunks carry only the id,
			// and the failure line must name the tool.
			const toolNameByCallId = new Map<string, string>();
			for await (const chunk of uiStream) {
				this.checkAuthority(convId, epoch);
				if (chunk.type === "error") {
					// A classified overflow on an attempt that may still
					// recover (first attempt, compaction wired): hold the
					// failure off the wire. The resumed stream continues the
					// same message, so an error event now would lie — and if
					// recovery later gives up, onDone reports it.
					const overflow =
						isContextOverflow(chunk.errorText) || isContextOverflow(rawError);
					if (overflow && recovery === undefined && this.deps.compaction !== undefined) {
						holdForRecovery = true;
					}
				}
				// The app channel's sinks ride the raw stream — each chunk is
				// serialized to the SSE wire verbatim (DESIGN.md, App channel).
				// Fan-out: every streaming member receives it (audit #4 — a
				// second client's stream used to run dry), a throwing sink is
				// detached rather than allowed to kill the turn, and the wire
				// log records exactly what the wire saw for late joiners and
				// resumers. The fence above is the app stream's back-pressure-
				// free cut: a fenced turn stops streaming to the client too. A
				// held failure takes its error chunk — and everything after —
				// with it.
				if (!holdForRecovery) {
					for (const t of turns) {
						if (t.streamFailed === true) continue;
						try {
							t.sink.onStreamChunk?.(chunk);
						} catch (err) {
							t.streamFailed = true;
							log.warn("sink onStreamChunk failed — stream detached", {
								conversation: convId,
								error: String(err),
							});
						}
					}
					live.chunks.push(chunk);
					for (const sub of live.subscribers) {
						try {
							sub.onChunk(chunk);
						} catch {
							// The SSE writer self-guards; a throwing subscriber is
							// dead weight until the turn ends.
							live.subscribers.delete(sub);
						}
					}
				}
				switch (chunk.type) {
					case "start-step":
						// A new step is always a new block — and id comparison
						// alone can't see this seam: openai-compatible providers
						// synthesize part ids per request, so step 2 can reuse
						// step 1's id verbatim. Reset instead of trusting ids.
						lastTextPartId = null;
						break;
					case "text-delta":
						// Distinct text parts are distinct blocks. A multi-step
						// turn — text, then a tool call, then more text — must
						// not fuse its blocks in the chat bubble ("what's up" +
						// "Workspace" streamed as "upWorkspace" otherwise).
						// History keeps the parts separate; this seam is
						// display-only.
						if (seenText && (lastTextPartId === null || chunk.id !== lastTextPartId)) {
							sink.onTextDelta("\n\n");
						}
						lastTextPartId = chunk.id;
						seenText = true;
						sink.onTextDelta(chunk.delta);
						break;
					case "reasoning-delta":
						sink.onReasoningDelta(chunk.delta);
						break;
					case "tool-input-available":
						sink.onToolCall(chunk.toolName, chunk.input);
						toolCalls.push(chunk.toolName);
						toolNameByCallId.set(chunk.toolCallId, chunk.toolName);
						if (evidence !== undefined) {
							digestRing.push({
								id: chunk.toolCallId,
								entry: {
									tool: chunk.toolName,
									args: summarize(chunk.input, evidence.argChars),
									result: "(no result)",
									// A result that never arrives (cut stream) stays neutral.
									ok: true,
								},
							});
							if (digestRing.length > evidence.calls) digestRing.shift();
						}
						// Side-effecting boundary — the chat shows a status
						// line, the log gets the durable record. Args are
						// truncated metadata, not payloads.
						log.info("tool call", {
							conversation: convId,
							tool: chunk.toolName,
							arg: JSON.stringify(chunk.input).slice(0, 200),
						});
						break;
					case "tool-input-error":
						// A schema-rejected call never executes, so the "tool
						// call" line never fires — and without this case the
						// only trace of a provider that cannot fill a schema is
						// the model's own complaints. Mail went dark for two
						// days exactly like that (Sep 28).
						log.warn("tool call rejected", {
							conversation: convId,
							tool: chunk.toolName,
							arg: JSON.stringify(chunk.input ?? null).slice(0, 200),
							error: chunk.errorText.slice(0, 300),
						});
						break;
					case "tool-output-available":
						// Reviewer evidence: what the call actually returned.
						if (evidence !== undefined) {
							for (let i = digestRing.length - 1; i >= 0; i--) {
								if (digestRing[i]!.id !== chunk.toolCallId) continue;
								digestRing[i]!.entry.result = summarize(chunk.output, evidence.outChars);
								digestRing[i]!.entry.ok = toolOk(chunk.output);
								break;
							}
						}
						break;
					case "tool-output-error":
						// A throw out of execute surfaces to the model as a
						// retryable error and to nobody else — without this line
						// it only lives in the reviewer's evidence ring, when
						// one is open at all.
						log.warn("tool execute failed", {
							conversation: convId,
							tool: toolNameByCallId.get(chunk.toolCallId) ?? chunk.toolCallId,
							error: chunk.errorText.slice(0, 300),
						});
						if (evidence !== undefined) {
							for (let i = digestRing.length - 1; i >= 0; i--) {
								if (digestRing[i]!.id !== chunk.toolCallId) continue;
								digestRing[i]!.entry.result = summarize(chunk.errorText, evidence.outChars);
								digestRing[i]!.entry.ok = false;
								break;
							}
						}
						break;
					case "error":
						streamError = chunk.errorText;
						break;
				}
			}

			this.checkAuthority(convId, epoch);
			if (streamError !== null) {
				if (holdForRecovery) {
					throw new ContextOverflowError(partialResponse, seenText, toolCalls, digestRing);
				}
				throw new Error(streamError, { cause: rawError });
			}
			const usage = await Promise.resolve(result.usage).catch((err) => {
				// Totals are observability, not control — but a dropped usage
				// promise must be visible, not a silent null on the log line.
				log.warn("turn usage unavailable — totals skipped", {
					conversation: convId,
					error: String(err),
				});
				return null;
			});
			// The stop reason is a signal, not noise: "length" means the
			// reply was cut off mid-flight, "content-filter" that the
			// provider withheld it. Joins usage in the fenced seam below.
			const finishReason = await Promise.resolve(result.finishReason).catch((err) => {
				log.warn("turn finish reason unavailable", {
					conversation: convId,
					error: String(err),
				});
				return null;
			});
			// The last await before the history write and the "completed"
			// notification — the one spot the fence didn't cover: a /stop
			// landing while usage settles must not deliver an unstamped
			// reply into history.
			this.checkAuthority(convId, epoch);
			// Steering folded mid-turn submits into this exchange, so the
			// retention source and anchor read history as the exchange ENDED —
			// but only up to the ownership mark: queued input this turn never
			// read must not anchor the reply. Nothing else can have appended
			// meanwhile — the lane is serial and every mid-turn submit funnels
			// through it. The admission-time anchor stays for recall (recall
			// already ran on the snapshot).
			const finalEntries = store.modelEntries(convId).filter((e) => e.seq <= steerHighWater);
			let finalAnchor: number | null = null;
			for (const e of finalEntries) {
				if (e.message.role === "user" && (finalAnchor === null || e.seq > finalAnchor)) {
					finalAnchor = e.seq;
				}
			}
			const finalSource = retentionSourceFrom(finalEntries);
			if (responseMessage !== null) {
				// responseMessage already carries an SDK-assigned id.
				// The anchor ties it to the user message that triggered
				// this turn — the causal view places the reply right
				// after its question, not after later arrivals. Completed
				// text exchanges also enqueue retention in the same
				// transaction; fenced/failed turns never reach here.
				const memoryOpt = this.retentionOpt(conv, finalAnchor, finalSource, responseMessage);
				store.append(
					convId,
					[responseMessage],
					memoryOpt ? { anchorSeq: finalAnchor, memory: memoryOpt } : { anchorSeq: finalAnchor },
				);
			}
			// Window utilization rides the completion line: the last step's
			// input against the catalog context limit. Cached tokens still
			// occupy the window, so this is the filling gauge regardless of
			// cache health. Logged BEFORE the final notify — onDone means the
			// turn is fully finished, log included.
			const window =
				step.contextWindow !== undefined && lastStepInputTokens !== null
					? {
							input: lastStepInputTokens,
							limit: step.contextWindow,
							pct: Math.round((lastStepInputTokens / step.contextWindow) * 100),
						}
					: null;
			log.info("turn completed", {
				conversation: convId,
				epoch,
				finish: finishReason,
				usage:
					usage && {
						input: usage.inputTokens ?? null,
						cacheRead: usage.inputTokenDetails?.cacheReadTokens ?? null,
						cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? null,
						output: usage.outputTokens ?? null,
					},
				window,
			});
			if (window && window.pct >= 80) {
				log.warn("context window ≥80% — history is approaching the limit", {
					conversation: convId,
					...window,
				});
			}
			await notifyAll({ kind: "completed" });
			// onDone may itself await a slow delivery. A stop during that
			// await revokes this turn before it can start fresh background
			// work (in particular auto-compaction with a new controller).
			this.checkAuthority(convId, epoch);
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
						replyText: responseMessage ? messageText(responseMessage) : "",
						toolNames: toolCalls,
						toolDigest: digestRing.map((p) => p.entry),
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
					log.warn("compaction failed — view unchanged, will retry on next threshold crossing", {
						conversation: convId,
						error: String(err),
					});
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
				// Overflow recovery (pi's _checkCompaction, adapted): drop
				// only the failed attempt, compact, resume — the partial
				// carries the tool results, so tools never re-run. One
				// recovery per turn: the resume gets recovery !== undefined
				// and falls to the generic branch on a second overflow.
				log.warn("context overflow — compacting and resuming turn", {
					conversation: convId,
					epoch,
					toolCalls: err.toolCalls.length,
					partialParts: err.partial?.parts.length ?? 0,
				});
				let outcome: CompactionOutcome;
				try {
					outcome = await this.doCompact(conv, "overflow");
				} catch (compactErr) {
					if (store.get(convId)?.epoch !== epoch || controller.signal.aborted) {
						log.info("turn fenced", {
							conversation: convId,
							epoch,
							error: String(compactErr),
						});
						await notifyAll({ kind: "fenced" });
					} else {
						log.warn("overflow compaction failed — turn ends", {
							conversation: convId,
							error: String(compactErr),
						});
						const msg =
							compactErr instanceof Error ? compactErr.message : String(compactErr);
						await notifyAll({
							kind: "error",
							message: `context window full and compacting failed: ${msg.slice(0, 120)}`,
						});
					}
					return;
				}
				if (outcome.kind === "noop") {
					log.warn("context overflow — nothing left to compact", {
						conversation: convId,
						epoch,
						reason: outcome.reason,
					});
					await notifyAll({
						kind: "error",
						message:
							"context window full and there's nothing left to compact — the latest message or tool output may be too big for this model",
					});
					return;
				}
				try {
					this.checkAuthority(convId, epoch);
				} catch {
					log.info("turn fenced", { conversation: convId, epoch });
					await notifyAll({ kind: "fenced" });
					return;
				}
				return this.runTurn(convId, turns, {
					partial: hasContent(err.partial) ? err.partial : null,
					memory,
					seenText: err.seenText,
					toolCalls: err.toolCalls,
					digest: err.digest,
					startedAt: turnStartMs,
					live,
				});
			} else {
				log.error("turn failed", err, { conversation: convId });
				await notifyAll({
					kind: "error",
					message:
						recovery !== undefined && isContextOverflow(err)
							? "context window still full after compacting — the latest message or tool output is too big for this model"
							: err instanceof Error
								? err.message
								: String(err),
				});
			}
		}
	}
}

// Fire each subscriber's onEnd exactly once and retire the log. The
// turn's outcome rides along — an attach stream needs the same terminal
// semantics a member sink gets (an error event on a non-completed
// outcome, then [DONE]).
function endLive(live: LiveChunks, done: TurnDone): void {
	if (live.ended) return;
	live.ended = true;
	for (const sub of live.subscribers) {
		try {
			sub.onEnd(done);
		} catch {
			// The SSE writer self-guards; nothing to do.
		}
	}
	live.subscribers.clear();
}

// What a completed turn retains: the user burst it answered (everything
// after the previous assistant message), bounded prior text for
// reference resolution, and whether the burst is program housekeeping
// alone (which is never retained — it isn't operator memory). A mixed
// burst — the scheduler firing while an operator message waits for its
// turn — keeps the operator's messages and drops the housekeeping text
// instead.
interface RetentionSource {
	userTexts: string[];
	userIds: string[];
	priorContext: string;
	program: boolean;
}

function retentionSourceFrom(entries: { seq: number; message: UIMessage }[]): RetentionSource {
	// The burst boundary is causal, not arrival: a message that lands
	// mid-turn has an arrival seq below the response it interrupted, so
	// comparing seqs would demote the operator's follow-up to prior
	// context. Split on the last assistant position in the causally
	// sorted view instead.
	let lastAsstIndex = -1;
	for (let i = 0; i < entries.length; i++) {
		const m = entries[i]!.message;
		if (m.role === "assistant" && !m.id.startsWith("compact-")) lastAsstIndex = i;
	}
	const userTexts: string[] = [];
	const userIds: string[] = [];
	const priorParts: string[] = [];
	let sawProgram = false;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		// The compaction summary rides the model view as a user-role
		// message — carried context, not operator speech. In a tail with
		// no assistant reply yet (a failed turn, a just-run /compact) it
		// would otherwise retain the whole summary blob as something the
		// operator said.
		if (e.message.id.startsWith("compact-")) continue;
		if (e.message.role !== "user" && e.message.role !== "assistant") continue;
		const t = messageText(e.message);
		if (t === "") continue;
		if (e.message.role === "user" && i > lastAsstIndex) {
			// Program fires and delegation notices are housekeeping, not
			// operator memory — but an operator message in the same burst
			// is, so housekeeping drops out of the retained set rather
			// than fencing the whole burst. The legacy "[scheduled: "
			// prefix still matches: a fire queued before the
			// jobs→programs cutover can land unanswered.
			if (
				t.startsWith("[program: ") ||
				t.startsWith("[delegation: ") ||
				t.startsWith("[scheduled: ")
			) {
				sawProgram = true;
				continue;
			}
			userTexts.push(t);
			userIds.push(e.message.id);
		} else {
			priorParts.push(t);
		}
	}
	const priorContext = priorParts.join("\n").slice(-500);
	return {
		userTexts,
		userIds,
		priorContext,
		// Retention is skipped only for program-only bursts — once
		// operator text remains, there is real memory to keep.
		program: sawProgram && userTexts.length === 0,
	};
}

// A burst of user input with no answer between the messages is one
// conversational beat — merge adjacent user messages so the model reads
// them as a single message, not N. Runs on the CONVERTED messages: the
// conversion must stay per-message (one malformed message degrades
// alone — a merge before conversion would let its placeholder swallow
// burst-mates' text), and the wire bytes are identical either way for
// valid input.
function mergeConsecutiveUserModels(messages: ModelMessage[]): ModelMessage[] {
	const out: ModelMessage[] = [];
	for (const m of messages) {
		const prev = out[out.length - 1];
		if (m.role === "user" && prev?.role === "user") {
			const prevContent = typeof prev.content === "string" ? [{ type: "text" as const, text: prev.content }] : prev.content;
			const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
			prev.content = [...prevContent, ...content];
		} else {
			out.push(m);
		}
	}
	return out;
}

// A failed attempt's partial is worth continuing only if it streamed
// real content — step-start markers alone mean the reply never began,
// and continuing an empty message would seed the model with a blank
// assistant turn.
function hasContent(m: UIMessage | null): m is UIMessage {
	return m !== null && m.parts.some((p) => p.type !== "step-start");
}

export function userMessage(parts: UIMessage["parts"]): UIMessage {
	return { id: randomUUID(), role: "user", parts };
}
