// driveClaude — the second turn engine, sibling of turn/stream.ts's
// driveStream. One SDK query() per turn, fed the full assembled view;
// the CLI's loop is the turn loop and goblin's tools execute inside it
// through the bridge (tools.ts). Emits the same UIMessageChunk wire,
// journal rows, and telemetry lines as the streamText path so both
// channel sinks, replay/attach, and crash-resume stay engine-neutral.
//
// v1 rulings (design/model.md → claude-code):
// - Steered messages defer to the next turn — no mid-run folding.
// - No forced toolChoice cuts and no step budget. The loop
//   detector still journals its state (context landings, completed
//   calls) for resume parity, but this engine cannot cut.
// - Rate-limit and auth failures fail loud with distinct text; overflow
//   rides the existing recovery (compaction + fresh turn, no
//   partial-resume — deps.partial is an API-lane continuation seam and
//   is ignored here).
//
// Unverified until the live drift check (live.test.ts): real event
// stream shapes, usage splits, rate-limit/overflow surface. The pinned
// types in translate.ts are the contract; red drift check means re-pin.

import { randomUUID } from "node:crypto";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type {
	AssistantContent,
	FinishReason,
	LanguageModelUsage,
	ModelMessage,
	ToolContent,
	ToolSet,
	UIMessage,
	UIMessageChunk,
} from "ai";
import type { AuthStore } from "../../auth.ts";
import type { CacheObservation } from "../../cache-observation.ts";
import type { ConfigRef } from "../../config.ts";
import type { AppLiveContext } from "../../http/app-wire.ts";
import { log } from "../../log.ts";
import { measurePrompt } from "../../turn/itemize.ts";
import {
	emitChunk,
	type StreamDeps,
	type StreamOutcome,
	type WireMember,
} from "../../turn/stream.ts";
import {
	noteToolError,
	noteToolInput,
	noteToolOutput,
	openToolEvents,
	type ToolEventState,
} from "../../turn/tool-events.ts";
import type { TurnJournal } from "../../turn-journal.ts";
import { serializeToolDefs, type WindowCapture } from "../../window-capture.ts";
import { isContextOverflow } from "../provider-errors.ts";
import {
	type CacheRoute,
	cacheRouteFor,
	cacheRouteKey,
	callHashes,
	hashCacheSettings,
} from "../providers.ts";
import { claudeChildEnv } from "./auth.ts";
import type { ClaudeStep } from "./mod.ts";
import { promptText, safeJson, serializePrompt } from "./prompt.ts";
import { createToolBridge, MCP_SERVER_NAME } from "./tools.ts";
import type {
	ClaudeContentBlock,
	ClaudeMessage,
	ClaudeQuery,
	ClaudeResultEvent,
	ClaudeStreamEvent,
	ClaudeToolResultBlock,
	ClaudeUsage,
} from "./translate.ts";

// The array arm of AssistantContent (the union also allows a bare
// string message, which we never build).
type AssistantPart = Extract<AssistantContent, unknown[]>[number];

export interface ClaudeEngineConfig {
	query: ClaudeQuery;
	auth: AuthStore;
	configRef: ConfigRef;
	observation?: CacheObservation | undefined;
	configDir?: string | undefined;
	/** Test seam: wrap or replace the bridge factory (production uses the real one). */
	bridgeFactory?: typeof createToolBridge | undefined;
}

export interface ClaudeRunDeps<M extends WireMember> extends Omit<StreamDeps<M>, "step"> {
	step: ClaudeStep;
}

// ---------- pure helpers ----------

// The finish-reason vocabulary the wire already carries, from the CLI's
// stop reasons.
export function finishReasonOf(stopReason: string | null, sawToolUse: boolean): FinishReason {
	switch (stopReason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "tool_use":
			return "tool-calls";
		case "max_output_tokens":
			return "length";
		case "refusal":
			return "content-filter";
		default:
			return sawToolUse ? "tool-calls" : "stop";
	}
}

// BetaUsage bills the prompt as input + cache creation + cache read —
// the same "inputTokens includes the cached ones" convention the API
// lane's usage lines carry.
export function billedInput(usage: ClaudeUsage | null): number | null {
	if (usage === null) return null;
	return (
		(usage.input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0)
	);
}

const RATE_LIMIT_TEXT = /rate.?limit|usage limit|5-hour|per hour|quota/i;

export function isRateLimitText(text: string): boolean {
	return RATE_LIMIT_TEXT.test(text);
}

export function resultErrorText(text: string, assistantError: string | undefined): string {
	const base = text || "claude code returned an error result";
	// Typed SDK error codes first; text matching is only the fallback.
	if (assistantError === "account_on_hold") {
		return `Claude Code account is on hold — no retry; resolve it with Anthropic. (${base})`;
	}
	if (
		assistantError === "authentication_failed" ||
		assistantError === "oauth_org_not_allowed" ||
		assistantError === "billing_error"
	) {
		return `Claude Code auth failed — the subscription token is missing, expired or not allowed; rotate the claude-code auth record. (${assistantError}: ${base})`;
	}
	if (assistantError === "rate_limit" || isRateLimitText(base)) {
		return `Claude Code subscription limit hit — no retry; switch this conversation to an API model or wait for the window to reset. (${base})`;
	}
	if (/not logged in|authentication|oauth|credential|token\b(?!s)/i.test(base)) {
		return `Claude Code auth failed — the subscription token is missing or expired; rotate the claude-code auth record. (${base})`;
	}
	return base;
}

// A tool-result echo's content, when no bridge result is adoptable:
// string as-is, content blocks joined, anything else serialized.
export function echoContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "object" && part !== null && "text" in part) {
					return String((part as { text?: unknown }).text ?? "");
				}
				return JSON.stringify(part);
			})
			.join("\n");
	}
	return JSON.stringify(content) ?? "";
}

function v4Usage(usage: ClaudeUsage | null): LanguageModelV4Usage | undefined {
	if (usage === null) return undefined;
	return {
		inputTokens: {
			total: billedInput(usage) ?? undefined,
			noCache: usage.input_tokens ?? undefined,
			cacheRead: usage.cache_read_input_tokens ?? undefined,
			cacheWrite: usage.cache_creation_input_tokens ?? undefined,
		},
		outputTokens: {
			total: usage.output_tokens ?? undefined,
			text: undefined,
			reasoning: undefined,
		},
	};
}

// One tool part per call, evolved in place: input-available →
// output-available/output-error, matching how the client reducer folds
// the same chunks into a single part.
function evolveToolPart(run: RunState, toolCallId: string, part: UIMessage["parts"][number]): void {
	const idx = run.parts.findIndex((p) => "toolCallId" in p && p.toolCallId === toolCallId);
	if (idx >= 0) run.parts[idx] = part;
	else run.parts.push(part);
}

function modelOutput(output: unknown): ToolResultOutput {
	if (typeof output === "string") return { type: "text", value: output };
	try {
		return { type: "json", value: JSON.parse(JSON.stringify(output ?? null)) as never };
	} catch {
		return { type: "text", value: safeJson(output) };
	}
}

// The CLI names MCP tools mcp__<server>__<tool>; goblin knows bare names.
function bareToolName(name: string): string {
	const prefix = `mcp__${MCP_SERVER_NAME}__`;
	return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

// ---------- the driver ----------

interface RunState {
	// wire + journal reconstruction
	parts: UIMessage["parts"];
	partialMessages: ModelMessage[];
	// ledger
	events: ToolEventState;
	sawText: boolean;
	lastTextPartId: string | null;
	// usage accumulation
	totalInput: number | null;
	totalOutput: number | null;
	totalCacheRead: number | null;
	totalCacheWrite: number | null;
	lastInput: number | null;
	lastCacheRead: number | null;
	// call tracking
	stepCount: number;
	sawToolUse: boolean;
	lastStopReason: string | null;
	lastAssistantError: string | undefined;
	pendingCall: boolean;
	// stream block bookkeeping
	streamedBlocks: Set<number>;
	blockIds: Map<number, string>;
	openTextBlocks: Set<number>;
	openReasoningBlocks: Set<number>;
	toolNameById: Map<string, string>;
	pendingToolUse: Map<string, { name: string; input: unknown }>;
}

export async function driveClaude<M extends WireMember>(
	engine: ClaudeEngineConfig,
	deps: ClaudeRunDeps<M>,
): Promise<StreamOutcome> {
	const { convId, head, members, live, state } = deps;
	const step = deps.step;
	const label = step.label;

	const run: RunState = {
		parts: [],
		partialMessages: [],
		events: openToolEvents({ toolCalls: deps.toolCalls, digest: deps.digest }),
		sawText: deps.seenText,
		lastTextPartId: null,
		totalInput: null,
		totalOutput: null,
		totalCacheRead: null,
		totalCacheWrite: null,
		lastInput: null,
		lastCacheRead: null,
		stepCount: 0,
		sawToolUse: false,
		lastStopReason: null,
		lastAssistantError: undefined,
		pendingCall: false,
		streamedBlocks: new Set(),
		blockIds: new Map(),
		openTextBlocks: new Set(),
		openReasoningBlocks: new Set(),
		toolNameById: new Map(),
		pendingToolUse: new Map(),
	};
	const eventsDeps = {
		convId,
		evidence: deps.evidence,
		skillWatch: deps.skillWatch,
		onCompleted: (tool: string, input: unknown, result: unknown, failed: boolean) =>
			state.noteCompletedCall(tool, input, result, failed),
	};

	let holdForRecovery = false;
	const emit = (chunk: UIMessageChunk): void => {
		// Overflow recovery withholds its error chunk and successors, not
		// prior partial output — the same rule the API lane applies.
		if (holdForRecovery) return;
		emitChunk(convId, members, live, chunk);
	};

	// --- request identity: hash + observation parity with the API lane ---
	const prompt = serializePrompt(deps.messages);
	const promptForHash: unknown[] = [
		{ role: "system", content: step.system },
		{ role: "user", content: promptText(prompt) },
	];
	const toolDefs = serializeToolDefs(deps.tools);
	const hashes = callHashes(promptForHash, toolDefs);
	const settingsHash = hashCacheSettings({
		providerOptions: { "claude-code": step.thinking },
		toolChoice: { type: "auto" },
	});
	const route = cacheRouteFor(engine.configRef.current, label) as CacheRoute | undefined;
	const routeKey = cacheRouteKey(
		route ?? { provider: "claude-code", kind: "inferred", base: "unknown", modelRef: label },
	);
	const baseFields = {
		conversation: convId,
		model: label,
		routeKey,
		routeEvidence: route === undefined ? "inferred" : "configured",
	};
	const observation = engine.observation;

	let callId: string | null = null;
	let obs: ReturnType<CacheObservation["begin"]> | undefined;
	let callOpen = false;

	const beginCall = (): void => {
		// Context landing feeds the detector state even though this engine
		// cannot cut — parity with prepareStep's recording.
		state.noteContextLanding(run.lastInput ?? undefined, step.contextWindow);
		callOpen = true;
		callId = randomUUID();
		obs = observation?.begin({
			callId,
			conversationId: convId,
			purpose: null,
			model: label,
			routeKey,
			headHash: hashes.headHash,
			requestHash: hashes.requestHash,
			settingsHash,
			promptHashes: hashes.promptHashes,
		});
		log.info("model call", {
			...baseFields,
			callId,
			call: "stream",
			messages: deps.messages.length,
			headHash: hashes.headHash.slice(0, 16),
			requestHash: hashes.requestHash.slice(0, 16),
			settingsHash: settingsHash.slice(0, 16),
			...(obs
				? {
						idleMs: obs.idleMs,
						prefixRelation: obs.prefixRelation,
						sharedMessages: obs.sharedMessages,
					}
				: {}),
		});
		run.pendingCall = true;
		emit({ type: "start-step" });
	};

	const failCall = (stage: "read" | "provider-error" | "no-finish", error?: unknown): void => {
		if (callId === null) return;
		callOpen = false;
		obs?.fail();
		log.error("model call failed", undefined, {
			...baseFields,
			callId,
			stage,
			...(error === undefined
				? {}
				: { errorName: error instanceof Error ? error.name : "provider-error" }),
		});
		callId = null;
		obs = undefined;
	};

	const finishStep = (message: ClaudeMessage): void => {
		run.stepCount += 1;
		run.pendingCall = false;
		callOpen = false;
		const usage = message.usage;
		const input = billedInput(usage);
		run.lastInput = input;
		run.lastCacheRead = usage?.cache_read_input_tokens ?? null;
		if (input !== null) run.totalInput = (run.totalInput ?? 0) + input;
		if (usage !== null) {
			run.totalOutput = (run.totalOutput ?? 0) + (usage.output_tokens ?? 0);
			run.totalCacheRead = (run.totalCacheRead ?? 0) + (usage.cache_read_input_tokens ?? 0);
			run.totalCacheWrite = (run.totalCacheWrite ?? 0) + (usage.cache_creation_input_tokens ?? 0);
		}
		if (callId !== null) {
			const finished = callId;
			obs?.finish(v4Usage(usage));
			log.info("model call usage", {
				...baseFields,
				callId: finished,
				inputTokens: input,
				cacheReadTokens: usage?.cache_read_input_tokens ?? null,
				cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
				outputTokens: usage?.output_tokens ?? null,
			});
			callId = null;
			obs = undefined;
		}
		// null = provider didn't report the split, 0 = reported-and-cold;
		// inputTokens includes the cached ones.
		log.info("model step usage", {
			conversation: convId,
			inputTokens: input,
			cacheReadTokens: usage?.cache_read_input_tokens ?? null,
			cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
			outputTokens: usage?.output_tokens ?? null,
		});
		emit({ type: "finish-step" });
		// The composer's context gauge reads settled turns only — the wire
		// carries this step's window occupancy as a transient data part.
		if (deps.holdsAuthority()) {
			const liveContext: AppLiveContext = { input: run.lastInput, cacheRead: run.lastCacheRead };
			emit({ type: "data-context", transient: true, data: liveContext });
		}
		deps.journal?.checkpoint(deps.runId, {
			loopState: state.snapshot(),
			filterRetryUsed: deps.filterRetryUsed,
			...(run.partialMessages.length > 0 ? { partial: run.partialMessages } : {}),
		});
	};

	const blockId = (index: number, kind: "text" | "reasoning"): string => {
		const existing = run.blockIds.get(index);
		if (existing !== undefined && existing.startsWith(kind)) return existing;
		const id = `${kind}-${run.stepCount + 1}-${index}-${randomUUID().slice(0, 8)}`;
		run.blockIds.set(index, id);
		return id;
	};

	const spendPendingCall = (): void => {
		// Fail closed like the API lane: a call that produced nothing but
		// an error must leave modelCalls at 0 (it gates the retry ladder).
		if (run.pendingCall) {
			state.noteModelCall();
			run.pendingCall = false;
		}
	};

	const handleStreamEvent = (ev: ClaudeStreamEvent): void => {
		switch (ev.type) {
			case "message_start":
				flushAssistant();
				beginCall();
				return;
			case "content_block_start": {
				const block = ev.content_block;
				spendPendingCall();
				if (block.type === "text") {
					run.openTextBlocks.add(ev.index);
					emit({ type: "text-start", id: blockId(ev.index, "text") });
				} else if (block.type === "thinking" || block.type === "redacted_thinking") {
					run.openReasoningBlocks.add(ev.index);
					emit({ type: "reasoning-start", id: blockId(ev.index, "reasoning") });
				} else if (block.type === "tool_use" && typeof block.id === "string") {
					run.toolNameById.set(block.id, bareToolName(block.name ?? ""));
				}
				return;
			}
			case "content_block_delta": {
				const d = ev.delta;
				if (d.type === "text_delta" && typeof d.text === "string") {
					spendPendingCall();
					run.streamedBlocks.add(ev.index);
					const id = blockId(ev.index, "text");
					if (run.sawText && run.lastTextPartId !== id) head.onTextDelta("\n\n");
					run.lastTextPartId = id;
					run.sawText = true;
					head.onTextDelta(d.text);
					emit({ type: "text-delta", id, delta: d.text });
				} else if (
					(d.type === "thinking_delta" || d.type === "signature_delta") &&
					typeof d.thinking === "string" &&
					d.thinking !== ""
				) {
					spendPendingCall();
					run.streamedBlocks.add(ev.index);
					head.onReasoningDelta(d.thinking);
					emit({
						type: "reasoning-delta",
						id: blockId(ev.index, "reasoning"),
						delta: d.thinking,
					});
				}
				return;
			}
			case "content_block_stop": {
				if (run.openTextBlocks.delete(ev.index)) {
					emit({ type: "text-end", id: blockId(ev.index, "text") });
				}
				if (run.openReasoningBlocks.delete(ev.index)) {
					emit({ type: "reasoning-end", id: blockId(ev.index, "reasoning") });
				}
				return;
			}
			case "message_delta":
				if (ev.delta?.stop_reason) run.lastStopReason = ev.delta.stop_reason;
				return;
			case "message_stop":
				return;
		}
	};

	// The CLI sends one `assistant` frame per content block; frames of one
	// model reply share a message.id and usage. Group them: the step
	// closes (flushAssistant) when a new message starts, the id changes,
	// a tool-result echo arrives, or the stream ends — never per frame.
	let curMessage: ClaudeMessage | null = null;
	let curBlockOffset = 0;
	let curParts: AssistantPart[] = [];

	const flushAssistant = (): void => {
		if (curMessage === null) return;
		const message = curMessage;
		curMessage = null;
		curBlockOffset = 0;
		curParts = [];
		// Close any blocks the stream never stopped (defensive; the CLI
		// emits content_block_stop for each).
		for (const index of [...run.openTextBlocks]) {
			run.openTextBlocks.delete(index);
			emit({ type: "text-end", id: blockId(index, "text") });
		}
		for (const index of [...run.openReasoningBlocks]) {
			run.openReasoningBlocks.delete(index);
			emit({ type: "reasoning-end", id: blockId(index, "reasoning") });
		}
		run.blockIds.clear();
		run.streamedBlocks.clear();
		run.lastStopReason = message.stop_reason ?? run.lastStopReason;
		finishStep(message);
	};

	const handleAssistant = (message: ClaudeMessage, error: string | undefined): void => {
		run.lastAssistantError = error;
		if (curMessage !== null && curMessage.id !== message.id) flushAssistant();
		if (curMessage === null) {
			// A complete assistant message without preceding stream frames
			// (a call the CLI chose not to stream) still opens its model call.
			if (!callOpen) beginCall();
			curParts = [];
			run.partialMessages.push({ role: "assistant", content: curParts });
		}
		curMessage = message;
		if (message.content.length > 0) spendPendingCall();
		for (const [i, block] of message.content.entries()) {
			const part = wireFromBlock(
				run,
				eventsDeps,
				emit,
				head,
				block,
				run.streamedBlocks.has(curBlockOffset + i),
				deps.journal,
				deps.runId,
			);
			if (part !== null) curParts.push(part);
		}
		curBlockOffset += message.content.length;
		if (message.content.some((b) => b.type === "tool_use")) run.sawToolUse = true;
		run.lastStopReason = message.stop_reason ?? run.lastStopReason;
	};

	const handleUserEcho = (content: string | ClaudeToolResultBlock[]): void => {
		flushAssistant();
		if (typeof content === "string") return;
		const toolParts: ToolContent = [];
		for (const block of content) {
			if (typeof block !== "object" || block === null || block.type !== "tool_result") continue;
			const name = run.toolNameById.get(block.tool_use_id) ?? "";
			const pending = run.pendingToolUse.get(block.tool_use_id);
			const adopted = bridge.adoptResult(pending?.name ?? name, pending?.input ?? null);
			run.pendingToolUse.delete(block.tool_use_id);
			const output =
				adopted !== null && adopted.output !== null
					? adopted.output
					: echoContentText(block.content);
			const errorText =
				adopted?.error ?? (block.is_error === true ? echoContentText(block.content) : null);
			if (errorText !== null) {
				emit({ type: "tool-output-error", toolCallId: block.tool_use_id, errorText });
				noteToolError(run.events, eventsDeps, block.tool_use_id, errorText);
				evolveToolPart(run, block.tool_use_id, {
					type: `tool-${name}` as never,
					toolCallId: block.tool_use_id,
					state: "output-error",
					...(pending !== undefined ? { input: pending.input } : {}),
					errorText,
				});
				toolParts.push({
					type: "tool-result",
					toolCallId: block.tool_use_id,
					toolName: name,
					output: { type: "error-text", value: errorText },
				});
			} else {
				emit({ type: "tool-output-available", toolCallId: block.tool_use_id, output });
				noteToolOutput(run.events, eventsDeps, block.tool_use_id, output);
				evolveToolPart(run, block.tool_use_id, {
					type: `tool-${name}` as never,
					toolCallId: block.tool_use_id,
					state: "output-available",
					...(pending !== undefined ? { input: pending.input } : {}),
					output,
				});
				toolParts.push({
					type: "tool-result",
					toolCallId: block.tool_use_id,
					toolName: name,
					output: modelOutput(output),
				});
			}
		}
		if (toolParts.length > 0) run.partialMessages.push({ role: "tool", content: toolParts });
	};

	// --- the run ---
	const abortController = new AbortController();
	const onAbort = (): void => {
		abortController.abort();
	};
	deps.signal.addEventListener("abort", onAbort, { once: true });

	const childEnv = await claudeChildEnv(engine.auth, step.auth, engine.configDir);
	const makeBridge = engine.bridgeFactory ?? createToolBridge;
	const bridge = makeBridge({ convId, tools: deps.tools, signal: deps.signal });

	const messageId = randomUUID();
	emit({ type: "start", messageId });

	let resultFrame: ClaudeResultEvent | null = null;
	let streamError: string | null = null;
	let rawError: unknown = null;

	try {
		outer: for await (const ev of engine.query({
			prompt,
			options: {
				model: step.modelId,
				systemPrompt: step.system,
				...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
				thinking:
					step.thinking !== undefined && step.thinking.disabled === true
						? { type: "disabled" }
						: { type: "adaptive" },
				...(step.thinking?.effort !== undefined ? { effort: step.thinking.effort } : {}),
				mcpServers: { goblin: bridge.server() },
				allowedTools: bridge.allowedTools(),
				cwd: process.cwd(),
				env: childEnv.env,
				abortController,
				stderr: (data) => {
					log.debug("claude-code child stderr", {
						conversation: convId,
						stderr: data.slice(0, 500),
					});
				},
			},
		})) {
			deps.assertAuthority();
			switch (ev.type) {
				case "init":
					log.info("claude engine session", {
						conversation: convId,
						model: ev.model ?? null,
						cli: ev.cliVersion ?? null,
						session: ev.sessionId ?? null,
						tools: Array.isArray(ev.tools) ? ev.tools.length : null,
						mcpServers: Array.isArray(ev.mcpServers) ? ev.mcpServers.length : null,
					});
					break;
				case "stream":
					handleStreamEvent(ev.event);
					break;
				case "assistant":
					handleAssistant(ev.message, ev.error);
					break;
				case "user":
					handleUserEcho(ev.content);
					break;
				case "result":
					// The result frame is the turn-complete signal — stop
					// there (the vendor generator's return() cleans up the
					// child), never waiting on post-result chatter.
					flushAssistant();
					resultFrame = ev;
					break outer;
			}
		}
		flushAssistant();
	} catch (err) {
		// A fenced/stopped turn must surface as the authority error, not a
		// provider failure — /stop and shutdown ride this path.
		deps.assertAuthority();
		rawError = err;
		if (deps.signal.aborted) throw err;
		failCall("read", err);
		log.error("model stream error", err, { conversation: convId, model: label });
		streamError =
			resultFrame !== null && resultFrame.isError
				? resultErrorText(resultFrame.result, run.lastAssistantError)
				: err instanceof Error
					? err.message
					: String(err);
	} finally {
		deps.signal.removeEventListener("abort", onAbort);
	}

	// The result frame carries terminal truth even when the iterator
	// completed cleanly — an error result without a throw still fails.
	if (streamError === null && resultFrame !== null && resultFrame.isError) {
		streamError = resultErrorText(resultFrame.result, run.lastAssistantError);
		rawError = rawError ?? new Error(streamError);
		failCall("provider-error", rawError);
		log.error("model stream error", rawError, { conversation: convId, model: label });
	}
	if (streamError !== null && isContextOverflow(streamError) && deps.overflowRecoverable) {
		holdForRecovery = true;
	}

	const usageTotals: LanguageModelUsage | null =
		run.totalInput === null && run.totalOutput === null
			? null
			: {
					inputTokens: run.totalInput ?? undefined,
					outputTokens: run.totalOutput ?? undefined,
					totalTokens: undefined,
					inputTokenDetails: {
						noCacheTokens: undefined,
						cacheReadTokens: run.totalCacheRead ?? undefined,
						cacheWriteTokens: run.totalCacheWrite ?? undefined,
					},
					outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
				};

	// The window record rides both outcome rails, gated on stepCount —
	// a prompt a call never completed is not a window anything saw.
	const windowCapture = (): WindowCapture | null => {
		if (run.stepCount === 0) return null;
		return {
			v: 1,
			system: step.system,
			tools: toolDefs,
			messages: deps.messages,
			segments: measurePrompt(step.system, deps.tools, deps.messages),
		};
	};

	deps.assertAuthority();
	if (streamError !== null) {
		// Failed turns surface an error chunk on the wire, like the API
		// lane's error part — overflow recovery is the one holdback.
		// A zero-effect error with a fallback candidate waiting is held
		// too (design/model.md → Model fallback list); the runtime emits
		// it if the turn ends here.
		const errorHeld =
			!holdForRecovery && deps.holdZeroEffectError === true && state.snapshot().modelCalls === 0;
		if (!holdForRecovery && !errorHeld) emit({ type: "error", errorText: streamError });
		return {
			kind: "failed",
			errorText: streamError,
			rawError,
			holdForRecovery,
			...(errorHeld ? { errorHeld: true } : {}),
			partial: run.parts.length > 0 ? { id: messageId, role: "assistant", parts: run.parts } : null,
			seenText: run.sawText,
			toolCalls: run.events.toolCalls,
			digestRing: run.events.digestRing,
			loop: state.snapshot(),
			steerMark: deps.steerMarkSeed,
			filterRetryUsed: deps.filterRetryUsed,
			window: windowCapture(),
			model: label,
			steps: run.stepCount,
		};
	}

	// The reply message the durable lane lands: metadata in the same
	// shape messageMetadata writes for the API lane.
	const finishReason = finishReasonOf(run.lastStopReason, run.sawToolUse);
	const segments = measurePrompt(step.system, deps.tools, deps.messages);
	const metadata = {
		model: label,
		finishReason,
		durationMs: Date.now() - deps.turnStartMs,
		usage: {
			input: run.totalInput,
			output: run.totalOutput,
			cacheRead: run.totalCacheRead,
			cacheWrite: run.totalCacheWrite,
			// input above sums every step's billed prompt across the tool
			// loop; the window gauge reads the final step.
			lastInput: run.lastInput,
			lastCacheRead: run.lastCacheRead,
		},
		...(segments !== null ? { promptChars: { ...segments } } : {}),
		...(deps.fallbackMisses !== undefined && deps.fallbackMisses.length > 0
			? { fallback: { from: deps.fallbackMisses.map(({ ref, reason }) => ({ ref, reason })) } }
			: {}),
	};
	emit({ type: "finish", finishReason, messageMetadata: metadata });
	const responseMessage: UIMessage | null =
		run.parts.length > 0 ? { id: messageId, role: "assistant", parts: run.parts, metadata } : null;

	return {
		kind: "ok",
		responseMessage,
		usage: usageTotals,
		finishReason,
		lastStepInputTokens: run.lastInput,
		toolCalls: run.events.toolCalls,
		digestRing: run.events.digestRing,
		steerMark: deps.steerMarkSeed,
		window: windowCapture(),
		model: label,
		steps: run.stepCount,
	};
}

// One content block of a completed assistant message → wire chunks,
// ledger entries, head notifications, and the reconstructed ModelMessage
// part. Streaming already covered text/thinking deltas; this is the
// canonical complete form (and the only form when the CLI does not
// stream partials for a block).
function wireFromBlock(
	run: RunState,
	eventsDeps: Parameters<typeof noteToolOutput>[1],
	emit: (chunk: UIMessageChunk) => void,
	head: {
		onTextDelta(delta: string): void;
		onReasoningDelta(delta: string): void;
		onToolCall(toolName: string, input: unknown): void;
	},
	block: ClaudeContentBlock,
	streamed: boolean,
	journal: TurnJournal | undefined,
	runId: string,
): AssistantPart | null {
	switch (block.type) {
		case "text": {
			const text = block.text ?? "";
			if (text !== "") run.parts.push({ type: "text", text });
			// The display sink heard streamed deltas already; a block that
			// only arrives complete still needs its head notification.
			if (!streamed && text !== "") head.onTextDelta(text);
			return { type: "text", text };
		}
		case "thinking":
		case "redacted_thinking": {
			const text = block.thinking ?? "";
			if (text !== "") run.parts.push({ type: "reasoning", text });
			if (!streamed && text !== "") head.onReasoningDelta(text);
			return null;
		}
		case "tool_use": {
			const id = block.id ?? `toolu-${randomUUID().slice(0, 8)}`;
			const name = bareToolName(block.name ?? "unknown");
			const input = block.input ?? {};
			run.toolNameById.set(id, name);
			run.pendingToolUse.set(id, { name, input });
			head.onToolCall(name, input);
			noteToolInput(
				run.events,
				{
					convId: eventsDeps.convId,
					evidence: eventsDeps.evidence,
					// No noteJournal: the CLI's toolu_ ids never match the
					// bridge ids fenceTools journals under, so a planned row
					// here would stay stale beside the completed one.
				},
				id,
				name,
				input,
			);
			run.parts.push({
				type: `tool-${name}` as never,
				toolCallId: id,
				state: "input-available",
				input,
			});
			emit({ type: "tool-input-available", toolCallId: id, toolName: name, input });
			return { type: "tool-call", toolCallId: id, toolName: name, input };
		}
		default:
			log.debug("claude engine: unrecognized content block dropped", { blockType: block.type });
			return null;
	}
}
