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
	stepCountIs,
	streamText,
	type LanguageModel,
	type ToolSet,
	type UIMessage,
} from "ai";
import type { ProviderOptions, ToolCallOptions } from "@ai-sdk/provider-utils";
import type { LanguageModelV2CallWarning } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import { materializeAttachments } from "./agent/attachments.ts";
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
import type { CompletedTurn, ReviewerDeps } from "./reviewer.ts";
import { considerTurn } from "./reviewer.ts";

const MAX_STEPS = 25;

// Auto-compaction trigger (DESIGN.md, Compaction): a completed turn at
// or past this fraction of the catalog context window compacts in-lane.
// The ≥80% utilization warn stays as the alarm that it didn't keep up.
const COMPACT_AT_PCT = 75;

// Provider capability warnings are observability, not control — logged
// compact, never fatal. Kept as strings so a warning object carrying a
// full tool definition can't bloat the log line.
function describeWarning(w: LanguageModelV2CallWarning): string {
	switch (w.type) {
		case "unsupported-setting":
			return `unsupported-setting:${w.setting}`;
		case "unsupported-tool":
			return `unsupported-tool:${(w.tool as { name?: string }).name ?? "provider-defined"}`;
		default:
			return JSON.stringify(w);
	}
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
	// The model's input modalities (models.dev) — decides which stored
	// attachment parts materialize as file parts this turn. Absent =
	// text-only, everything degrades to path references.
	inputModalities?: Set<string>;
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

// ---------- runtime ----------

interface QueuedTurn {
	sink: TurnSink;
	// Guards the exactly-once onDone contract: a sink whose onDone throws
	// must not be re-notified by the drain guard below.
	doneSent: boolean;
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
}

export class Runtime {
	private lanes = new Map<string, Lane>();
	// Set by shutdown(): submits still land in history but never run.
	private closed = false;
	// The skill reviewer — attached after the bot exists (its save note
	// delivers through bot.api). Absent = the feature is off.
	private reviewer: ReviewerDeps | undefined;

	constructor(private deps: RuntimeDeps) {}

	setReviewer(reviewer: ReviewerDeps): void {
		this.reviewer = reviewer;
	}

	// Enqueue a user message + a sink. The message lands in history
	// immediately — it's real regardless of when the turn runs, or
	// whether it runs at all (post-shutdown submits record only).
	submit(conv: Conversation, message: UIMessage, sink: TurnSink): void {
		this.deps.store.append(conv.id, [message]);
		if (this.closed) {
			void this.notifyDone({ sink, doneSent: false }, { kind: "fenced" });
			return;
		}
		const lane = this.lane(conv.id);
		lane.pending.push({ sink, doneSent: false });
		if (!lane.running) lane.draining = this.drain(conv.id);
	}

	// False after shutdown(): a closed runtime still appends submits to
	// history and fences them, so a caller offering future work (a webhook
	// hit) must gate on this rather than trusting submit's return.
	accepting(): boolean {
		return !this.closed;
	}

	// Graceful stop: close intake, then fence every live lane — running
	// turns abort, queued ones drop. Resolves when the drains settle,
	// which includes each sink's final flush (the "⏹ superseded" stamp).
	async shutdown(): Promise<void> {
		this.closed = true;
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
	// dropped sinks' onDone calls settle — shutdown awaits it.
	stop(convId: string): { stopped: boolean; settled: Promise<void> } {
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
		if (stopped) {
			log.info("turn stopped", { conversation: convId, epoch });
		} else {
			log.debug("stop — nothing was running", { conversation: convId, epoch });
		}
		return { stopped, settled: Promise.all(notifies).then(() => undefined) };
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
	private async doCompact(conv: Conversation): Promise<CompactionOutcome> {
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
			return await runCompaction(
				conv.id,
				this.deps.store,
				compaction.modelRef(conv),
				(system, prompt, signal) => compaction.summarize(conv, system, prompt, signal),
				{ tailTokenBudget },
				controller.signal,
			);
		} finally {
			if (lane.compactController === controller) lane.compactController = null;
		}
	}

	private lane(convId: string): Lane {
		let l = this.lanes.get(convId);
		if (!l) {
			l = { pending: [], compacts: [], running: false, controller: null, compactController: null, draining: null };
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
			t.execute = (input: unknown, options: ToolCallOptions) => {
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
				// beat, and a single model call answers them all.
				const turns = lane.pending.splice(0);
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
						job.resolve(await this.doCompact(job.conv));
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
			// A drained lane is cheap to recreate on the next submit —
			// don't pin one per conversation for the life of the process.
			if (lane.pending.length === 0 && lane.compacts.length === 0) this.lanes.delete(convId);
		}
	}

	private async runTurn(convId: string, turns: QueuedTurn[]): Promise<void> {
		const { store } = this.deps;
		// The first queued sink streams the response; the rest get the
		// same terminal outcome and nothing else — one onDone per submit.
		const sink = turns[0]!.sink;
		const notifyAll = async (done: TurnDone) => {
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
		sink.setAuthorityCheck?.(() => this.deps.store.get(convId)?.epoch === epoch);
		// History snapshot is part of admission: a message submitted while
		// the model step resolves lands in history but must NOT join this
		// turn's context — it stays queued for its own turn. Reading it
		// here, before the awaits, is what keeps that boundary — and because
		// the snapshot is the compacted model view (summary + tail, DESIGN.md
		// Compaction), a /compact landing mid-turn can't rewrite what this
		// turn already sees. The anchor
		// rides along: this turn's response is stamped with the seq of
		// the user message that triggered it, so the causal view can
		// place the reply immediately after its question. One snapshot
		// serves history, anchor, and retention-source together — a message
		// landing between two reads must not split them.
		const entries = store.modelEntries(convId);
		const history = entries.map((e) => e.message);
		let anchorSeq: number | null = null;
		for (const e of entries) {
			if (e.message.role === "user" && (anchorSeq === null || e.seq > anchorSeq)) anchorSeq = e.seq;
		}
		const retentionSource = retentionSourceFrom(entries);
		log.info("turn started", { conversation: convId, epoch, history: history.length });
		const controller = new AbortController();
		this.lane(convId).controller = controller;

		try {
			this.checkAuthority(convId, epoch);
			const memory = await this.recallMemory(conv, anchorSeq, history, controller.signal);
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
			const tools = this.fenceTools(
				this.deps.makeTools(conv, deliverVoice, recording, deliverFile),
				convId,
				epoch,
			);
			const step = await this.deps.buildStep(conv, tools);
			this.checkAuthority(convId, epoch);
			// Materialize attachment refs against THIS turn's model — a
			// media part the provider can't consume degrades to its path
			// reference instead of failing the request on every turn.
			// Memory recall blocks interleave before their anchored user
			// message (persisted, never regenerated); without memory the
			// sequence is byte-identical to history.
			const prepared = await materializeAttachments(
				mergeConsecutiveUsers(withMemoryBlocks(entries, memory.prior, memory.current)),
				step.inputModalities,
			);
			this.checkAuthority(convId, epoch);
			const messages = convertToModelMessages(prepared, {
				tools,
				ignoreIncompleteToolCalls: true,
			});

			// Cache observability (DESIGN.md, Cache stability): the per-call
			// request hashes — head (system + tools) and full request — are
			// logged by the model wrapper at EVERY call: tool-loop
			// continuations, retries, titling. See observedModel in
			// agent/providers.ts; this line only anchors the turn.
			log.info("model request", {
				conversation: convId,
				messages: messages.length,
			});

			// The last step's input is the fullest prompt this turn sent —
			// the honest numerator for window utilization.
			let lastStepInputTokens: number | null = null;
			const result = streamText({
				model: step.model,
				system: step.system,
				messages,
				tools,
				...(step.providerOptions ? { providerOptions: step.providerOptions } : {}),
				stopWhen: stepCountIs(MAX_STEPS),
				abortSignal: controller.signal,
				onError: ({ error }) => {
					log.error("model stream error", error, { conversation: convId });
				},
				onStepFinish: ({ usage }) => {
					lastStepInputTokens = usage.inputTokens ?? null;
					// The cached split is how cache health is read off the log:
					// undefined means the provider didn't report it (logged as
					// null), 0 means reported-and-cold. inputTokens includes the
					// cached ones.
					log.info("model step usage", {
						conversation: convId,
						inputTokens: usage.inputTokens ?? null,
						cachedInputTokens: usage.cachedInputTokens ?? null,
						outputTokens: usage.outputTokens ?? null,
					});
				},
			});

			// The SDK hands provider capability warnings back on the result —
			// previously the one fail-quiet seam in the model path: an ignored
			// setting or an inexpressible tool vanished. Observability only;
			// the turn proceeds regardless.
			void result.warnings
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
			// Every tool call this turn, in order — the reviewer's gate
			// state (count + names) and its fallback rule read this.
			const toolCalls: string[] = [];
			// Block-boundary tracking for the live stream: last text part id
			// within a step, plus whether any text has streamed at all (see
			// the text-delta and start-step cases).
			let lastTextPartId: string | null = null;
			let seenText = false;
			// Stream errors arrive as `error` chunks — they don't throw. The
			// authoritative signal is the finish outcome: "failed" means the
			// turn must surface an error, not commit partial output as a
			// clean completion.
			let streamError: string | null = null;
			const uiStream = result.toUIMessageStream<UIMessage>({
				sendReasoning: true,
				// Retention keys documents and source refs to the assistant
				// message identity — without a generator the SDK leaves it
				// blank, so every completed turn mints one here.
				generateMessageId: randomUUID,
				// The default serializer emits "An error occurred." — meant
				// for public HTTP clients. This stream feeds the operator's
				// own chat; the real message is what they need.
				onError: (error) => (error instanceof Error ? error.message : String(error)),
				onFinish: ({ responseMessage: rm, isAborted, outcome }) => {
					if (isAborted) return;
					if (outcome.status === "failed") {
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

			for await (const chunk of uiStream) {
				this.checkAuthority(convId, epoch);
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
						// Side-effecting boundary — the chat shows a status
						// line, the log gets the durable record. Args are
						// truncated metadata, not payloads.
						log.info("tool call", {
							conversation: convId,
							tool: chunk.toolName,
							arg: JSON.stringify(chunk.input).slice(0, 200),
						});
						break;
					case "error":
						streamError = chunk.errorText;
						break;
				}
			}

			this.checkAuthority(convId, epoch);
			if (streamError !== null) throw new Error(streamError);
			const usage = await result.usage.catch((err) => {
				// Totals are observability, not control — but a dropped usage
				// promise must be visible, not a silent null on the log line.
				log.warn("turn usage unavailable — totals skipped", {
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
			if (responseMessage !== null) {
				// responseMessage already carries an SDK-assigned id.
				// The anchor ties it to the user message that triggered
				// this turn — the causal view places the reply right
				// after its question, not after later arrivals. Completed
				// text exchanges also enqueue retention in the same
				// transaction; fenced/failed turns never reach here.
				const memoryOpt = this.retentionOpt(conv, anchorSeq, retentionSource, responseMessage);
				store.append(
					convId,
					[responseMessage],
					memoryOpt ? { anchorSeq, memory: memoryOpt } : { anchorSeq },
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
				usage:
					usage && {
						input: usage.inputTokens ?? null,
						cached: usage.cachedInputTokens ?? null,
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
			// Skill reviewer (DESIGN.md): every completed turn gates a
			// possible background review — fire-and-forget, off the lane,
			// never delaying the successor. Fenced/failed turns never
			// reach here. The backstop only sees bugs: gate failures fall
			// back inside considerTurn, review failures log their own lines.
			if (this.reviewer) {
				const snapshot: CompletedTurn = {
					conversationId: convId,
					operatorTexts: retentionSource.userTexts,
					replyText: responseMessage ? messageText(responseMessage) : "",
					toolNames: toolCalls,
				};
				void considerTurn(this.reviewer, snapshot).catch((err: unknown) => {
					log.error("reviewer failed", err, { conversation: convId });
				});
			}
			// Auto-compaction (DESIGN.md, Compaction): the reply has landed and
			// the sinks are released; the lane stays busy through the summary
			// call so a queued successor reads the compacted view, not a
			// mid-flight one. Failure is loud but lossless — no boundary
			// written, the next threshold crossing retries. Deliberately NOT
		// thrown to the outer handler: onDone already fired.
			if (window && window.pct >= COMPACT_AT_PCT) {
				try {
					await this.doCompact(conv);
				} catch (err) {
					log.warn("compaction failed — view unchanged, will retry on next threshold crossing", {
						conversation: convId,
						error: String(err),
					});
				}
			}
		} catch (err) {
			if (err instanceof FencedError || controller.signal.aborted) {
				// Fenced turns abort quietly and log it.
				log.info("turn fenced", { conversation: convId, epoch, error: String(err) });
				await notifyAll({ kind: "fenced" });
			} else {
				log.error("turn failed", err, { conversation: convId });
				await notifyAll({
					kind: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
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
// conversational beat — merge adjacent user messages so the model
// reads them as a single message, not N. Keeps the first id.
function mergeConsecutiveUsers(messages: UIMessage[]): UIMessage[] {
	const out: UIMessage[] = [];
	for (const m of messages) {
		const prev = out[out.length - 1];
		if (m.role === "user" && prev?.role === "user") {
			prev.parts.push(...m.parts);
		} else {
			out.push(m);
		}
	}
	return out;
}

export function userMessage(parts: UIMessage["parts"]): UIMessage {
	return { id: randomUUID(), role: "user", parts };
}
