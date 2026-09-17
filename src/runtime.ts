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
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { randomUUID } from "node:crypto";
import type { Conversation, ConversationStore } from "./conversation.ts";
import { log } from "./log.ts";

const MAX_STEPS = 25;

// ---------- sink: what the turn streams into (tg implements) ----------

export type TurnDone =
	| { kind: "completed" }
	| { kind: "fenced" }
	| { kind: "aborted" }
	| { kind: "error"; message: string };

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
	// options (thinking level) fresh at each turn.
	buildStep(conv: Conversation): ModelStep;
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
		lane.pending.push({ sink });
		if (!lane.running) void this.drain(conv.id);
	}

	// /stop — advance the epoch (fences the in-flight turn) and abort its
	// stream. Queued turns are dropped: stop means stop.
	stop(convId: string): void {
		const epoch = this.deps.store.bumpEpoch(convId);
		const lane = this.lanes.get(convId);
		if (lane) {
			lane.pending.length = 0;
			lane.controller?.abort();
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

	// Re-check authority around every await: the captured epoch must still
	// be the conversation's epoch.
	private checkAuthority(convId: string, epoch: number): void {
		const current = this.deps.store.get(convId)?.epoch;
		if (current !== epoch) throw new FencedError(convId);
	}

	private async drain(convId: string): Promise<void> {
		const lane = this.lane(convId);
		if (lane.running) return;
		lane.running = true;
		try {
			for (;;) {
				const turn = lane.pending.shift();
				if (!turn) return;
				await this.runTurn(convId, turn);
			}
		} finally {
			lane.running = false;
			lane.controller = null;
		}
	}

	private async runTurn(convId: string, turn: QueuedTurn): Promise<void> {
		const { store } = this.deps;
		// Admission: capture the epoch this turn holds authority under.
		const conv = store.get(convId);
		if (!conv) {
			log.error("turn for missing conversation", undefined, { conversation: convId });
			return;
		}
		const epoch = conv.epoch;
		const controller = new AbortController();
		this.lane(convId).controller = controller;

		try {
			this.checkAuthority(convId, epoch);
			const step = this.deps.buildStep(conv);
			const tools = this.deps.makeTools(conv.cwd);
			const history = store.history(convId);
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
			const uiStream = result.toUIMessageStream<UIMessage>({
				sendReasoning: true,
				onFinish: ({ responseMessage: rm, isAborted }) => {
					if (!isAborted) responseMessage = rm;
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
				}
			}

			this.checkAuthority(convId, epoch);
			if (responseMessage !== null) {
				// responseMessage already carries an SDK-assigned id.
				store.append(convId, [responseMessage]);
			}
			await turn.sink.onDone({ kind: "completed" });
			log.info("turn completed", { conversation: convId, epoch });
		} catch (err) {
			if (err instanceof FencedError || controller.signal.aborted) {
				// Fenced turns abort quietly and log it.
				log.info("turn fenced", { conversation: convId, epoch, error: String(err) });
				await turn.sink.onDone({ kind: "fenced" });
			} else {
				log.error("turn failed", err, { conversation: convId });
				await turn.sink.onDone({
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
