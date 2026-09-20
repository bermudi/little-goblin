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
import { createHash, randomUUID } from "node:crypto";
import { materializeAttachments } from "./agent/attachments.ts";
import type { Conversation, ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";

const MAX_STEPS = 25;

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
	buildStep(conv: Conversation): ModelStep | Promise<ModelStep>;
	// Build the tool set — bound to the deployment workspace by the
	// composition root.
	makeTools(deliverVoice?: (audio: Uint8Array) => Promise<void>): ToolSet;
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

interface Lane {
	pending: QueuedTurn[];
	running: boolean;
	controller: AbortController | null;
	// The drain loop's promise — shutdown awaits it so a fenced sink's
	// final flush finishes before the process exits.
	draining: Promise<void> | null;
}

export class Runtime {
	private lanes = new Map<string, Lane>();
	// Set by shutdown(): submits still land in history but never run.
	private closed = false;

	constructor(private deps: RuntimeDeps) {}

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

	// Graceful stop: close intake, then fence every live lane — running
	// turns abort, queued ones drop. Resolves when the drains settle,
	// which includes each sink's final flush (the "⏹ superseded" stamp).
	async shutdown(): Promise<void> {
		this.closed = true;
		const drains: Promise<void>[] = [];
		for (const [convId, lane] of this.lanes) {
			// stop() resolves once the dropped turns' onDone calls settle —
			// a sink's final flush must finish before the process exits.
			drains.push(this.stop(convId));
			if (lane.draining) drains.push(lane.draining);
		}
		await Promise.all(drains);
	}

	// /stop — advance the epoch (fences the in-flight turn) and abort its
	// stream. Queued turns are dropped: stop means stop. Dropped sinks still
	// get their onDone so nothing leaks. Resolves when those notifications
	// settle — shutdown awaits it; /stop callers may ignore it.
	stop(convId: string): Promise<void> {
		const epoch = this.deps.store.bumpEpoch(convId);
		const lane = this.lanes.get(convId);
		const notifies: Promise<void>[] = [];
		if (lane) {
			const dropped = lane.pending.splice(0);
			lane.controller?.abort();
			for (const t of dropped) {
				notifies.push(this.notifyDone(t, { kind: "fenced" }));
			}
		}
		log.info("turn stopped", { conversation: convId, epoch });
		return Promise.all(notifies).then(() => undefined);
	}

	private lane(convId: string): Lane {
		let l = this.lanes.get(convId);
		if (!l) {
			l = { pending: [], running: false, controller: null, draining: null };
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
				if (turns.length === 0) return;
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
			}
		} finally {
			lane.running = false;
			lane.controller = null;
			lane.draining = null;
			// A drained lane is cheap to recreate on the next submit —
			// don't pin one per conversation for the life of the process.
			if (lane.pending.length === 0) this.lanes.delete(convId);
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
		// here, before the awaits, is what keeps that boundary. The anchor
		// rides along: this turn's response is stamped with the seq of
		// the user message that triggered it, so the causal view can
		// place the reply immediately after its question.
		const history = store.history(convId);
		const anchorSeq = store.lastUserSeq(convId);
		log.info("turn started", { conversation: convId, epoch, history: history.length });
		const controller = new AbortController();
		this.lane(convId).controller = controller;

		try {
			this.checkAuthority(convId, epoch);
			const step = await this.deps.buildStep(conv);
			this.checkAuthority(convId, epoch);
			const deliverVoice = sink.onVoiceNote
				? async (audio: Uint8Array) => {
						this.checkAuthority(convId, epoch);
						await sink.onVoiceNote!(audio);
						this.checkAuthority(convId, epoch);
					}
				: undefined;
			const tools = this.fenceTools(this.deps.makeTools(deliverVoice), convId, epoch);
			// Materialize attachment refs against THIS turn's model — a
			// media part the provider can't consume degrades to its path
			// reference instead of failing the request on every turn.
			const prepared = await materializeAttachments(
				mergeConsecutiveUsers(history),
				step.inputModalities,
			);
			this.checkAuthority(convId, epoch);
			const messages = convertToModelMessages(prepared, {
				tools,
				ignoreIncompleteToolCalls: true,
			});

			// Cache observability (DESIGN.md, Cache stability). headHash covers
			// system + tools — the request head — and must never move between
			// turns on its own; if it does, something automated rewrote the
			// head and the provider prefix cache went with it. requestHash
			// covers the whole request and moves by appends only: same message
			// count with a different hash, or a shrinking count, is the
			// visible signature of a history rewrite.
			const headHash = createHash("sha256")
				.update(
					JSON.stringify({
						system: step.system,
						tools: Object.entries(tools)
							.map(([name, t]) => `${name}=${(t as { description?: string }).description ?? ""}`)
							.sort(),
					}),
				)
				.digest("hex")
				.slice(0, 16);
			const requestHash = createHash("sha256")
				.update(JSON.stringify(messages))
				.digest("hex")
				.slice(0, 16);
			log.info("model request", {
				conversation: convId,
				headHash,
				requestHash,
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

			let responseMessage: UIMessage | null = null;
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
			const usage = await result.usage.catch(() => null);
			if (responseMessage !== null) {
				// responseMessage already carries an SDK-assigned id.
				// The anchor ties it to the user message that triggered
				// this turn — the causal view places the reply right
				// after its question, not after later arrivals.
				store.append(convId, [responseMessage], { anchorSeq });
			}
			await notifyAll({ kind: "completed" });
			// Window utilization rides the completion line: the last step's
			// input against the catalog context limit. Cached tokens still
			// occupy the window, so this is the filling gauge regardless of
			// cache health.
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
