// driveClaude — the second turn engine, sibling of turn/stream.ts's
// driveStream. One SDK query() per turn, fed the full assembled view;
// the CLI's loop is the turn loop and goblin's tools execute inside it
// through the bridge (tools.ts). Emits the same UIMessageChunk wire,
// journal rows, and telemetry lines as the streamText path so both
// channel sinks, replay/attach, and crash-resume stay engine-neutral.
//
// Rulings (design/model.md → claude-code):
// - Steers fold mid-turn (#582). A steer belongs to this run only after
//   the CLI acks it; a batch never acked returns to pending input and
//   leads the next turn (the CLI may have read it without acking, so a
//   duplicate is possible, never a loss). A steer that arrives while the
//   model writes its final reply waits for the successor turn.
// - No forced toolChoice cuts and no step budget. The loop
//   detector still journals its state (context landings, completed
//   calls) for resume parity, but this engine cannot cut.
// - Rate-limit and auth failures fail loud with distinct text; overflow
//   rides the existing recovery (compaction + fresh turn, no
//   partial-resume — deps.partial is an API-lane continuation seam and
//   is ignored here).
//
// Unverified until the live drift check (live.test.ts): real event
// stream shapes, usage splits, rate-limit/overflow surface. Output usage
// comes from each call's final message_delta; result usage cross-checks
// the segment and logs mismatches. The pinned types in translate.ts are
// the contract; red drift check means re-pin.

import { randomUUID } from "node:crypto";
import type {
	AssistantContent,
	PromptMessage,
	ToolContent,
	ToolResultOutput,
} from "../../prompt-message.ts";
import type {
	FinishReason,
	Message,
	MessageChunk,
	Usage,
} from "../../message.ts";
import type { AuthStore } from "../../auth.ts";
import type { CacheObservation } from "../../cache-observation.ts";
import type { ClaudeSessionStore } from "../../claude-sessions.ts";
import type { ConfigRef } from "../../config.ts";
import { log } from "../../log.ts";
import { measurePrompt } from "../../turn/itemize.ts";
import { toToolSet } from "../../turn/ai-sdk-tools.ts";
import { stepModelRef } from "../../turn/model-ref.ts";
import {
	openAttemptRecorder,
	type AttemptRecorder,
	type StreamOutcome,
} from "../../turn/attempt-recorder.ts";
import {
	admitSteers,
	claimSteerBatch,
	emitChunk,
	returnSteers,
	type StreamDeps,
	type SteerBatch,
	type WireMember,
} from "../../turn/stream.ts";
import { serializeToolDefs, type WindowCapture } from "../../window-capture.ts";
import {
	isContextOverflow,
	ProviderError,
	type ProviderVerdict,
} from "../provider-errors.ts";
import {
	type CacheRoute,
	cacheRouteFor,
	cacheRouteKey,
	callHashes,
	hashCacheSettings,
} from "../providers.ts";
import { claudeChildEnv } from "./auth.ts";
import type { ClaudeStep } from "./mod.ts";
import { promptText, safeJson, serializePrompt, serializeSteer } from "./prompt.ts";
import { steerChannel } from "./steers.ts";
import { createToolBridge, MCP_SERVER_NAME } from "./tools.ts";
import type {
	ClaudeContentBlock,
	ClaudeMessage,
	ClaudeQuery,
	ClaudeResultEvent,
	ClaudeStreamEvent,
	ClaudeToolResultBlock,
	ClaudeUsage,
	SteerChannel,
} from "./translate.ts";

const CLAUDE_VERDICTS = new Map<string, ProviderVerdict>([
	["rate_limit", "quota"],
	["overloaded", "transient"],
	["server_error", "transient"],
]);

export function claudeProviderError(
	message: string,
	result: ClaudeResultEvent | null,
	assistantError: string | undefined,
	retryStatus: number | null,
	cause?: unknown,
): ProviderError {
	// The CLI retries throttles and overloads itself; a surfaced rate_limit is the subscription window.
	return new ProviderError(message, {
		status: result?.apiErrorStatus ?? retryStatus ?? undefined,
		verdict: assistantError === undefined ? undefined : CLAUDE_VERDICTS.get(assistantError),
	}, { cause });
}

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
	/** #418: the claude_sessions store — native compaction reads/writes it. */
	sessions?: ClaudeSessionStore | undefined;
}

export interface ClaudeRunDeps<M extends WireMember> extends Omit<StreamDeps<M>, "step"> {
	step: ClaudeStep;
	/**
	 * #418 native session plan for this attempt. `resume` names the
	 * recorded session and its head anchor; absent = fresh session.
	 * `fullPrompt` lazily rebuilds the complete view — the one-shot
	 * retry's prompt when the recorded session fails to resume.
	 * `onDrop` tells the store the record is dead.
	 */
	claudeSession?:
		| {
				resume?: { sessionId: string; headUuid: string } | undefined;
				fullPrompt?: (() => Promise<PromptMessage[]>) | undefined;
				onDrop?: (() => void) | undefined;
		  }
		| undefined;
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

// #418: a resume that dies before any content reached the wire gets one
// fresh-session retry in the same attempt. These are the shapes a dead
// session file or a rejected resumeSessionAt surface as.
const RESUME_FAILURE_TEXT =
	/resume rejected|failed to resume|resume_session_at|no conversation found/i;

function isResumeFailure(
	resultFrame: ClaudeResultEvent | null,
	errorText: string | null,
	rawError: unknown,
): boolean {
	const blob = [
		resultFrame?.result ?? "",
		errorText ?? "",
		rawError instanceof Error ? rawError.message : String(rawError ?? ""),
	].join("\n");
	if (RESUME_FAILURE_TEXT.test(blob)) return true;
	if (
		/resume|session/i.test(blob) &&
		/not found|missing|enoent|no such|does not exist|expired|invalid/i.test(blob)
	) {
		return true;
	}
	return resultFrame?.subtype === "error_during_execution" && /resume|session/i.test(blob);
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
// string as-is, content blocks joined, anything else serialized. Image
// blocks become a placeholder — their base64 payload must never land
// in a stored output (issue #606).
export function echoContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "object" && part !== null) {
					const p = part as { type?: unknown; text?: unknown };
					if (p.type === "image") return "[image]";
					if ("text" in p) return String(p.text ?? "");
				}
				return JSON.stringify(part);
			})
			.join("\n");
	}
	return JSON.stringify(content) ?? "";
}

// Later usage wins field by field; null/undefined never erase a count.
function overlayUsage(
	base: Partial<ClaudeUsage> | null,
	patch: Partial<ClaudeUsage>,
): Partial<ClaudeUsage> {
	const out: Partial<ClaudeUsage> = { ...base };
	for (const key of [
		"input_tokens",
		"output_tokens",
		"cache_read_input_tokens",
		"cache_creation_input_tokens",
	] as const) {
		const value = patch[key];
		if (value !== null && value !== undefined) out[key] = value;
	}
	if (patch.cache_creation !== undefined) out.cache_creation = patch.cache_creation;
	return out;
}

export function cacheTtlMs(usage: ClaudeUsage | null): number | null {
	if ((usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) return 3_600_000;
	if ((usage?.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) return 300_000;
	return null;
}

function goblinUsage(usage: ClaudeUsage | null): Usage | undefined {
	if (usage === null) return undefined;
	const inputTokens = billedInput(usage);
	return {
		inputTokens: inputTokens ?? undefined,
		inputTokenDetails: {
			noCacheTokens: usage.input_tokens ?? undefined,
			cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
			cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
		},
		outputTokens: usage.output_tokens ?? undefined,
		outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
		totalTokens:
			inputTokens !== null && usage.output_tokens !== null
				? inputTokens + usage.output_tokens
				: undefined,
	};
}

// One tool part per call, evolved in place: input-available →
// output-available/output-error, matching how the client reducer folds
// the same chunks into a single part.
function evolveToolPart(run: RunState, toolCallId: string, part: Message["parts"][number]): void {
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

// A result that arrives while a pushed steer is still unacked means the
// CLI will answer it in a follow-up CLI turn (probed live 2026-11-15:
// a message queued after the final request opens a new turn). The
// engine reads on through at most this many follow-ups — a CLI that
// never acks must not hold the turn open; the steer returns to pending input.
const MAX_STEER_FOLLOW_UPS = 2;

// The CLI names MCP tools mcp__<server>__<tool>; goblin knows bare names.
function bareToolName(name: string): string {
	const prefix = `mcp__${MCP_SERVER_NAME}__`;
	return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

// ---------- the driver ----------

interface RunState {
	// wire + journal reconstruction
	parts: Message["parts"];
	// usage accumulation
	totalInput: number | null;
	totalOutput: number | null;
	totalCacheRead: number | null;
	totalCacheWrite: number | null;
	deltaUsage: Partial<ClaudeUsage> | null;
	// call tracking
	sawToolUse: boolean;
	lastStopReason: string | null;
	lastAssistantError: string | undefined;
	lastRetryStatus: number | null;
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
	const label = stepModelRef(step);
	const recorder = openAttemptRecorder(deps, label, (chunk) =>
		emitChunk(convId, members, live, chunk),
	);

	const run: RunState = {
		parts: [],
		totalInput: null,
		totalOutput: null,
		totalCacheRead: null,
		totalCacheWrite: null,
		deltaUsage: null,
		sawToolUse: false,
		lastStopReason: null,
		lastAssistantError: undefined,
		lastRetryStatus: null,
		streamedBlocks: new Set(),
		blockIds: new Map(),
		openTextBlocks: new Set(),
		openReasoningBlocks: new Set(),
		toolNameById: new Map(),
		pendingToolUse: new Map(),
	};
	// Overflow recovery withholds its error chunk and successors, not
	// prior partial output — the same rule the API lane applies.
	const emit = recorder.emit;

	// --- request identity: hash + observation parity with the API lane ---
	// Recomputed per attempt — the resume-failure retry sends the full
	// prompt, not the seq delta deps.messages carries.
	const toolDefs = serializeToolDefs(deps.tools);
	const hashesFor = (messages: PromptMessage[]) => {
		const prompt = serializePrompt(messages);
		const callPrompt = [
			{ role: "system", content: step.system },
			{ role: "user", content: promptText(prompt) },
		];
		const hashes = callHashes(callPrompt, toolDefs);
		return { ...hashes, headHash: callHashes(callPrompt, null).headHash };
	};
	const engineState = {
		sentMessages: deps.messages,
		hashes: hashesFor(deps.messages),
		callId: null as string | null,
		obs: undefined as ReturnType<CacheObservation["begin"]> | undefined,
		callOpen: false,
		segmentOutput: 0,
		curMessage: null as ClaudeMessage | null,
		curBlockOffset: 0,
		curParts: [] as AssistantPart[],
		channel: null as SteerChannel | null,
		// #418: the turn's head anchor — the last top-level assistant uuid
		// the query emitted (subagent sidechains never pin one).
		lastAssistantUuid: null as string | null,
		retriedFresh: false,
		landedSessionId: "",
		resultFrame: null as ClaudeResultEvent | null,
		streamError: null as string | null,
		rawError: null as unknown,
	};
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

	const beginCall = (): void => {
		// Context landing feeds the detector state even though this engine
		// cannot cut — parity with prepareStep's recording.
		state.noteContextLanding(
			recorder.lastInput ?? undefined,
			step.contextWindow,
			step.uncapped === true,
		);
		engineState.callOpen = true;
		engineState.callId = randomUUID();
		engineState.obs = observation?.begin({
			callId: engineState.callId,
			conversationId: convId,
			purpose: null,
			model: label,
			routeKey,
			headHash: engineState.hashes.headHash,
			requestHash: engineState.hashes.requestHash,
			settingsHash,
			promptHashes: engineState.hashes.promptHashes,
		});
		log.info("model call", {
			...baseFields,
			callId: engineState.callId,
			call: "stream",
			messages: engineState.sentMessages.length,
			headHash: engineState.hashes.headHash.slice(0, 16),
			requestHash: engineState.hashes.requestHash.slice(0, 16),
			settingsHash: settingsHash.slice(0, 16),
			...(engineState.obs
				? {
						idleMs: engineState.obs.idleMs,
						prefixRelation: engineState.obs.prefixRelation,
						sharedMessages: engineState.obs.sharedMessages,
					}
				: {}),
		});
		recorder.callStarted();
		emit({ type: "start-step" });
	};

	const failCall = (stage: "read" | "provider-error" | "no-finish", error?: unknown): void => {
		if (engineState.callId === null) return;
		engineState.callOpen = false;
		engineState.obs?.fail();
		log.error("model call failed", undefined, {
			...baseFields,
			callId: engineState.callId,
			stage,
			...(error === undefined
				? {}
				: { errorName: error instanceof Error ? error.name : "provider-error" }),
		});
		engineState.callId = null;
		engineState.obs = undefined;
	};

	const finishStep = (message: ClaudeMessage): void => {
		recorder.dropCall();
		engineState.callOpen = false;
		const usage: ClaudeUsage | null =
			run.deltaUsage === null
				? message.usage
				: {
						input_tokens: null,
						output_tokens: null,
						cache_read_input_tokens: null,
						cache_creation_input_tokens: null,
						...overlayUsage(message.usage, run.deltaUsage),
					};
		run.deltaUsage = null;
		const input = billedInput(usage);
		const cacheTtl = cacheTtlMs(usage);
		if (input !== null) run.totalInput = (run.totalInput ?? 0) + input;
		if (usage !== null) {
			run.totalOutput = (run.totalOutput ?? 0) + (usage.output_tokens ?? 0);
			if (usage.output_tokens !== null) engineState.segmentOutput += usage.output_tokens;
			run.totalCacheRead = (run.totalCacheRead ?? 0) + (usage.cache_read_input_tokens ?? 0);
			run.totalCacheWrite = (run.totalCacheWrite ?? 0) + (usage.cache_creation_input_tokens ?? 0);
		}
		if (engineState.callId !== null) {
			const finished = engineState.callId;
			engineState.obs?.finish(goblinUsage(usage), cacheTtl);
			log.info("model call usage", {
				...baseFields,
				callId: finished,
				inputTokens: input,
				cacheReadTokens: usage?.cache_read_input_tokens ?? null,
				cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
				cacheTtlMs: cacheTtl,
				outputTokens: usage?.output_tokens ?? null,
			});
			engineState.callId = null;
			engineState.obs = undefined;
		}
		emit({ type: "finish-step" });
		// The CLI owns the loop: no pre-call boundary for the pre-empt
		// fold, no per-call re-dispatch — but every completed call reports
		// its usage, so the shared context fill tracks the window.
		recorder.stepEnded({
			usage: {
				input,
				cacheRead: usage?.cache_read_input_tokens ?? null,
				cacheWrite: usage?.cache_creation_input_tokens ?? null,
				output: usage?.output_tokens ?? null,
			},
			failed: false,
		});
	};

	const blockId = (index: number, kind: "text" | "reasoning"): string => {
		const existing = run.blockIds.get(index);
		if (existing !== undefined && existing.startsWith(kind)) return existing;
		const id = `${kind}-${recorder.stepCount + 1}-${index}-${randomUUID().slice(0, 8)}`;
		run.blockIds.set(index, id);
		return id;
	};

	const spendPendingCall = (): void => {
		// Fail closed like the API lane: a call that produced nothing but
		// an error must leave modelCalls at 0 (it gates the retry ladder).
		recorder.spendCall();
	};

	const handleStreamEvent = (ev: ClaudeStreamEvent): void => {
		const noteFirstToken = (): void => {
			recorder.noteFirstToken();
		};
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
					noteFirstToken();
				}
				return;
			}
			case "content_block_delta": {
				const d = ev.delta;
				if (d.type === "text_delta" && typeof d.text === "string") {
					spendPendingCall();
					noteFirstToken();
					run.streamedBlocks.add(ev.index);
					const id = blockId(ev.index, "text");
					recorder.textDelta(id, d.text);
					emit({ type: "text-delta", id, delta: d.text });
				} else if (
					(d.type === "thinking_delta" || d.type === "signature_delta") &&
					typeof d.thinking === "string" &&
					d.thinking !== ""
				) {
					spendPendingCall();
					noteFirstToken();
					run.streamedBlocks.add(ev.index);
					recorder.reasoningDelta(d.thinking);
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
				if (ev.usage !== null) run.deltaUsage = overlayUsage(run.deltaUsage, ev.usage);
				return;
			case "message_stop":
				return;
		}
	};

	// The CLI sends one `assistant` frame per content block; frames of one
	// model reply share a message.id and usage. Group them: the step
	// closes (flushAssistant) when a new message starts, the id changes,
	// a tool-result echo arrives, or the stream ends — never per frame.
	const flushAssistant = (): void => {
		if (engineState.curMessage === null) return;
		const message = engineState.curMessage;
		const completedParts = engineState.curParts;
		engineState.curMessage = null;
		engineState.curBlockOffset = 0;
		engineState.curParts = [];
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
		recorder.appendPartial({ role: "assistant", content: completedParts });
		finishStep(message);
	};

	const handleAssistant = (message: ClaudeMessage, error: string | undefined): void => {
		run.lastAssistantError = error;
		if (engineState.curMessage !== null && engineState.curMessage.id !== message.id) flushAssistant();
		if (engineState.curMessage === null) {
			// A complete assistant message without preceding stream frames
			// (a call the CLI chose not to stream) still opens its model call.
			if (!engineState.callOpen) beginCall();
			engineState.curParts = [];
		}
		engineState.curMessage = message;
		if (message.content.length > 0) {
			spendPendingCall();
			// A call the CLI never streamed lands whole here — its first
			// content arrived at this moment; a streamed call already noted
			// its own first token, so this stays a no-op there.
			recorder.noteFirstToken();
		}
		for (const [i, block] of message.content.entries()) {
			const part = wireFromBlock(
				run,
				recorder,
				emit,
				head,
				block,
				run.streamedBlocks.has(engineState.curBlockOffset + i),
			);
			if (part !== null) engineState.curParts.push(part);
		}
		engineState.curBlockOffset += message.content.length;
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
				recorder.toolError(block.tool_use_id, errorText);
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
				recorder.toolOutput(block.tool_use_id, output);
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
		if (toolParts.length > 0) recorder.appendPartial({ role: "tool", content: toolParts });
	};

	// --- the run ---
	const abortController = new AbortController();
	const onAbort = (): void => {
		abortController.abort();
	};

	// --- steers: the open query input and pending batches ---
	const steers = recorder.steers;
	const sdkTools = toToolSet(deps.tools);
	const steeredMessages: PromptMessage[] = [];
	// Pushed to the CLI, not yet admitted by a `folded` acknowledgement.
	const unacked = new Map<string, SteerBatch<M>>();
	const foldIntoQuery = async (): Promise<void> => {
		if (engineState.channel === null) return;
		const batch = await claimSteerBatch(deps, sdkTools);
		if (batch === null || batch.members.length === 0) return;
		if (engineState.channel === null) {
			returnSteers(deps, batch, "query input closed");
			return;
		}
		const uuid = randomUUID();
		unacked.set(uuid, batch);
		engineState.channel.push({ uuid, prompt: serializeSteer(batch.messages) });
		log.info("claude steer sent", {
			conversation: convId,
			steer: uuid,
			messages: batch.messages.length,
		});
	};

	const childEnv = await claudeChildEnv(engine.auth, step.auth, engine.configDir);
	const makeBridge = engine.bridgeFactory ?? createToolBridge;
	const bridge = makeBridge({
		convId,
		tools: deps.tools,
		signal: deps.signal,
		afterCall: foldIntoQuery,
	});

	const messageId = randomUUID();
	emit({ type: "start", messageId });

	const sessionPlan = deps.claudeSession;
	const resumeSession = sessionPlan?.resume ?? null;

	// The retry only runs at zero effect, so every content accumulator is
	// already empty — this is belt-and-braces for the bookkeeping fields
	// (call identity, stream block maps, uuid anchors). The recorder
	// deliberately keeps its tool-event and steer ledgers.
	const resetForRetry = (): void => {
		run.parts.length = 0;
		run.totalInput = null;
		run.totalOutput = null;
		run.totalCacheRead = null;
		run.totalCacheWrite = null;
		run.deltaUsage = null;
		engineState.segmentOutput = 0;
		recorder.resetForRetry();
		run.sawToolUse = false;
		run.lastStopReason = null;
		run.lastAssistantError = undefined;
		run.lastRetryStatus = null;
		run.streamedBlocks.clear();
		run.blockIds.clear();
		run.openTextBlocks.clear();
		run.openReasoningBlocks.clear();
		run.toolNameById.clear();
		run.pendingToolUse.clear();
		steeredMessages.length = 0;
		engineState.curMessage = null;
		engineState.curParts = [];
		engineState.curBlockOffset = 0;
		engineState.callId = null;
		engineState.obs = undefined;
		engineState.callOpen = false;
		engineState.lastAssistantUuid = null;
	};

	// A resume that fails before any content reached the wire retries
	// once, fresh, in this same attempt — the record is already dropped
	// by onDrop so nothing resumes a dead session again.
	for (;;) {
		const useResume = resumeSession !== null && !engineState.retriedFresh;
		const sessionId = useResume ? resumeSession.sessionId : randomUUID();
		engineState.landedSessionId = sessionId;
		engineState.resultFrame = null;
		engineState.streamError = null;
		engineState.rawError = null;
		run.lastRetryStatus = null;
		let followUps = 0;
		const callChannel = steerChannel();
		engineState.channel = callChannel;

		deps.signal.addEventListener("abort", onAbort, { once: true });
		try {
			outer: for await (const ev of engine.query({
				prompt: serializePrompt(engineState.sentMessages),
				steers: callChannel,
				options: {
					model: step.modelId,
					systemPrompt: step.system,
					...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
					thinking:
						step.thinking !== undefined && step.thinking.disabled === true
							? { type: "disabled" }
							: { type: "adaptive", display: "summarized" },
					...(step.thinking?.effort !== undefined ? { effort: step.thinking.effort } : {}),
					mcpServers: { goblin: bridge.server() },
					allowedTools: bridge.allowedTools(),
					cwd: childEnv.workdir,
					env: childEnv.env,
					abortController,
					persistSession: true,
					...(useResume
						? {
								resume: resumeSession.sessionId,
								resumeSessionAt: resumeSession.headUuid,
							}
						: { sessionId }),
					stderr: (data) => {
						log.debug("claude-code child stderr", {
							conversation: convId,
							stderr: data.slice(0, 500),
						});
					},
				},
			})) {
				deps.assertAuthority();
				if (ev.type === "api_retry") {
					run.lastRetryStatus = ev.status;
				} else if (ev.type === "assistant" && ev.error === undefined) {
					run.lastRetryStatus = null;
				}
				if (ev.type === "assistant" && typeof ev.uuid === "string") {
					engineState.lastAssistantUuid = ev.uuid;
				}
				if (ev.type === "compact_boundary") {
					log.info("claude native compaction boundary", {
						conversation: convId,
						model: label,
						trigger: ev.trigger,
						preTokens: ev.preTokens,
						postTokens: ev.postTokens ?? null,
					});
				}
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
					case "folded":
						for (const uuid of ev.uuids) {
							const batch = unacked.get(uuid);
							if (batch !== undefined) {
								admitSteers(deps, steers, recorder.stepCount, batch);
								steeredMessages.push(...batch.messages);
								unacked.delete(uuid);
								log.info("claude steer folded", { conversation: convId, steer: uuid });
							}
						}
						break;
					case "api_retry":
						break;
					case "result":
						// The result frame is the turn-complete signal — stop
						// there (the vendor generator's return() cleans up the
						// child), never waiting on post-result chatter. An
						// unacked steer is the one exception: the CLI answers it
						// in a follow-up turn of this same query.
						flushAssistant();
						if (ev.usage?.output_tokens != null && ev.usage.output_tokens !== engineState.segmentOutput) {
							log.warn("claude usage mismatch", {
								conversation: convId,
								resultOutput: ev.usage.output_tokens,
								stepOutput: engineState.segmentOutput,
							});
						}
						engineState.segmentOutput = 0;
						engineState.resultFrame = ev;
						if (unacked.size > 0 && !ev.isError && followUps < MAX_STEER_FOLLOW_UPS) {
							followUps += 1;
							log.warn("claude result before steer fold — reading the follow-up turn", {
								conversation: convId,
								unacked: unacked.size,
								followUp: followUps,
							});
							break;
						}
						break outer;
				}
			}
			flushAssistant();
		} catch (err) {
			// A fenced/stopped turn must surface as the authority error, not a
			// provider failure — /stop and shutdown ride this path.
			deps.assertAuthority();
			engineState.rawError = err;
			if (deps.signal.aborted) throw err;
			failCall("read", err);
			log.error("model stream error", err, { conversation: convId, model: label });
			engineState.streamError =
				engineState.resultFrame !== null && engineState.resultFrame.isError
					? resultErrorText(engineState.resultFrame.result, run.lastAssistantError)
					: err instanceof Error
						? err.message
						: String(err);
		} finally {
			deps.signal.removeEventListener("abort", onAbort);
			engineState.channel = null;
			callChannel.close();
			for (const batch of unacked.values()) returnSteers(deps, batch, "never acked");
			unacked.clear();
		}

		// The result frame carries terminal truth even when the iterator
		// completed cleanly — an error result without a throw still fails.
		if (
			engineState.streamError === null &&
			engineState.resultFrame !== null &&
			engineState.resultFrame.isError
		) {
			engineState.streamError = resultErrorText(
				engineState.resultFrame.result,
				run.lastAssistantError,
			);
			engineState.rawError = engineState.rawError ?? new Error(engineState.streamError);
			failCall("provider-error", engineState.rawError);
			log.error("model stream error", engineState.rawError, { conversation: convId, model: label });
		}

		// Zero effect means nothing content-bearing reached the wire —
		// no finished step, no first token, no reconstructed parts. Only
		// then is a fresh-session retry safe (and honest: the fallback
		// zero-effect gate still sees modelCalls === 0).
		const zeroEffect =
			recorder.stepCount === 0 && recorder.firstTokenMs === null && run.parts.length === 0;
		if (
			useResume &&
			!engineState.retriedFresh &&
			engineState.streamError !== null &&
			zeroEffect &&
			sessionPlan?.fullPrompt !== undefined &&
			isResumeFailure(engineState.resultFrame, engineState.streamError, engineState.rawError)
		) {
			engineState.retriedFresh = true;
			log.warn("claude session resume failed — starting fresh", {
				conversation: convId,
				model: label,
				session: resumeSession.sessionId,
				error: engineState.streamError,
			});
			sessionPlan.onDrop?.();
			engineState.sentMessages = await sessionPlan.fullPrompt();
			engineState.hashes = hashesFor(engineState.sentMessages);
			resetForRetry();
			continue;
		}
		break;
	}

	const failure =
		engineState.streamError === null
			? null
			: claudeProviderError(
					engineState.streamError,
					engineState.resultFrame,
					run.lastAssistantError,
					run.lastRetryStatus,
					engineState.rawError ?? undefined,
				);
	if (
		failure !== null &&
		isContextOverflow(failure) &&
		deps.overflowRecoverable
	) {
		recorder.holdForRecovery();
	}

	const usageTotals: Usage | null =
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
		if (recorder.stepCount === 0) return null;
		const messages = [...engineState.sentMessages, ...steeredMessages];
		return {
			v: 1,
			system: step.system,
			tools: toolDefs,
			messages,
			segments: measurePrompt(step.system, deps.tools, messages),
		};
	};

	deps.assertAuthority();
	if (engineState.streamError !== null) {
		// Failed turns surface an error chunk on the wire, like the API
		// lane's error part — overflow recovery is the one holdback.
		// A zero-effect error with a fallback candidate waiting is held
		// too (design/model.md → Model fallback list); the runtime emits
		// it if the turn ends here.
		const errorHeld = recorder.holdsError();
		if (!recorder.holding && !errorHeld) emit({ type: "error", errorText: engineState.streamError });
		return recorder.failed({
			errorText: engineState.streamError,
			rawError: failure,
			partial: run.parts.length > 0 ? { id: messageId, role: "assistant", parts: run.parts } : null,
			window: windowCapture(),
			errorHeld,
		});
	}

	// The reply message the durable lane lands: metadata in the same
	// shape messageMetadata writes for the API lane.
	const finishReason = finishReasonOf(run.lastStopReason, run.sawToolUse);
	const segments = measurePrompt(
		step.system,
		deps.tools,
		[...engineState.sentMessages, ...steeredMessages],
	);
	const metadata = recorder.metadata({
		finishReason,
		forcedCompletion: null,
		usage: {
			input: run.totalInput,
			output: run.totalOutput,
			cacheRead: run.totalCacheRead,
			cacheWrite: run.totalCacheWrite,
		},
		promptChars: segments,
	});
	emit({ type: "finish", finishReason, messageMetadata: metadata });
	const responseMessage: Message | null =
		run.parts.length > 0 ? { id: messageId, role: "assistant", parts: run.parts, metadata } : null;

	return recorder.ok({
		responseMessage,
		usage: usageTotals,
		finishReason,
		window: windowCapture(),
		// #418: the session this attempt ran — the runtime persists the
		// record only after the reply lands durably.
		claudeSession: {
			sessionId: engineState.landedSessionId,
			headUuid: engineState.lastAssistantUuid ?? "",
		},
	});
}

// One content block of a completed assistant message → wire chunks,
// ledger entries, head notifications, and the reconstructed PromptMessage
// part. Streaming already covered text/thinking deltas; this is the
// canonical complete form (and the only form when the CLI does not
// stream partials for a block).
function wireFromBlock(
	run: RunState,
	recorder: AttemptRecorder,
	emit: (chunk: MessageChunk) => void,
	head: {
		onTextDelta(delta: string): void;
		onReasoningDelta(delta: string): void;
		onToolCall(toolName: string, input: unknown): void;
	},
	block: ClaudeContentBlock,
	streamed: boolean,
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
			recorder.toolInput(id, name, input);
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
