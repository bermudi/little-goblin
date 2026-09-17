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
import { randomUUID } from "node:crypto";
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
	onDone(done: TurnDone): void | Promise<void>;
}

// ---------- deps injected by the composition root ----------

export interface ModelStep {
	model: LanguageModel;
	system: string;
	providerOptions?: ProviderOptions;
}

export interface RuntimeDeps {
	store: ConversationStore;
	// Resolve the conversation's effective model + system prompt + provider
	// options (thinking level) fresh at each turn. May be async (auth
	// `!command` resolution shells out).
	buildStep(conv: Conversation): ModelStep | Promise<ModelStep>;
	// Build the tool set bound to the conversation's cwd.
	makeTools(cwd: string): ToolSet;
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
}

export class Runtime {
	private lanes = new Map<string, Lane>();

	constructor(private deps: RuntimeDeps) {}

	// Enqueue a user message + a sink. The message lands in history
	// immediately — it's real regardless of when the turn runs.
	submit(conv: Conversation, message: UIMessage, sink: TurnSink): void {
		this.deps.store.append(conv.id, [message]);
		const lane = this.lane(conv.id);
		lane.pending.push({ sink, doneSent: false });
		if (!lane.running) void this.drain(conv.id);
	}

	// /stop — advance the epoch (fences the in-flight turn) and abort its
	// stream. Queued turns are dropped: stop means stop. Dropped sinks still
	// get their onDone so nothing leaks.
	stop(convId: string): void {
		const epoch = this.deps.store.bumpEpoch(convId);
		const lane = this.lanes.get(convId);
		if (lane) {
			const dropped = lane.pending.splice(0);
			lane.controller?.abort();
			for (const t of dropped) {
				void this.notifyDone(t, { kind: "fenced" });
			}
		}
		log.info("turn stopped", { conversation: convId, epoch });
	}

	private lane(convId: string): Lane {
		let l = this.lanes.get(convId);
		if (!l) {
			l = { pending: [], running: false, controller: null };
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
				const turn = lane.pending.shift();
				if (!turn) return;
				try {
					await this.runTurn(convId, turn);
				} catch (err) {
					// runTurn handles expected failures; this is a last-ditch guard
					// so one bad turn can't stall the lane or leak its sink.
					log.error("turn crashed", err, { conversation: convId });
					await this.notifyDone(turn, {
						kind: "error",
						message: err instanceof Error ? err.message : String(err),
					});
				}
			}
		} finally {
			lane.running = false;
			lane.controller = null;
			// A drained lane is cheap to recreate on the next submit —
			// don't pin one per conversation for the life of the process.
			if (lane.pending.length === 0) this.lanes.delete(convId);
		}
	}

	private async runTurn(convId: string, turn: QueuedTurn): Promise<void> {
		const { store } = this.deps;
		// Admission: capture the epoch this turn holds authority under.
		const conv = store.get(convId);
		if (!conv) {
			log.error("turn for missing conversation", undefined, { conversation: convId });
			// The sink contract still holds: exactly one onDone per submit.
			await this.notifyDone(turn, { kind: "error", message: "conversation missing" });
			return;
		}
		const epoch = conv.epoch;
		// History snapshot is part of admission: a message submitted while
		// the model step resolves lands in history but must NOT join this
		// turn's context — it stays queued for its own turn. Reading it
		// here, before the awaits, is what keeps that boundary.
		const history = store.history(convId);
		const controller = new AbortController();
		this.lane(convId).controller = controller;

		try {
			this.checkAuthority(convId, epoch);
			const step = await this.deps.buildStep(conv);
			this.checkAuthority(convId, epoch);
			const tools = this.fenceTools(this.deps.makeTools(conv.cwd), convId, epoch);
			const messages = convertToModelMessages(history, {
				tools,
				ignoreIncompleteToolCalls: true,
			});

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
			});

			let responseMessage: UIMessage | null = null;
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
					case "text-delta":
						turn.sink.onTextDelta(chunk.delta);
						break;
					case "reasoning-delta":
						turn.sink.onReasoningDelta(chunk.delta);
						break;
					case "tool-input-available":
						turn.sink.onToolCall(chunk.toolName, chunk.input);
						break;
					case "error":
						streamError = chunk.errorText;
						break;
				}
			}

			this.checkAuthority(convId, epoch);
			if (streamError !== null) throw new Error(streamError);
			if (responseMessage !== null) {
				// responseMessage already carries an SDK-assigned id.
				store.append(convId, [responseMessage]);
			}
			await this.notifyDone(turn, { kind: "completed" });
			log.info("turn completed", { conversation: convId, epoch });
		} catch (err) {
			if (err instanceof FencedError || controller.signal.aborted) {
				// Fenced turns abort quietly and log it.
				log.info("turn fenced", { conversation: convId, epoch, error: String(err) });
				await this.notifyDone(turn, { kind: "fenced" });
			} else {
				log.error("turn failed", err, { conversation: convId });
				await this.notifyDone(turn, {
					kind: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}
}

export function userMessage(parts: UIMessage["parts"]): UIMessage {
	return { id: randomUUID(), role: "user", parts };
}
