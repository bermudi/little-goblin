import type { FinishReason, Message, MessageChunk, Usage } from "../message.ts";
import type { PromptMessage } from "../prompt-message.ts";
import type { AppLiveContext, AppQuota } from "../http/app-wire.ts";
import { log } from "../log.ts";
import type { EvidenceLimits, ToolCallDigest } from "../reviewer-evidence.ts";
import type { TurnCheckpointPatch, TurnJournal } from "../turn-journal.ts";
import type { WindowCapture } from "../window-capture.ts";
import type { SkillWatch } from "./skill-attribution.ts";
import { replyMetadata } from "./reply-metadata.ts";
import { holdsZeroEffectError, type ForcedKind, type LoopTurnState, type TurnState } from "./state.ts";
import type { PromptSegments } from "./itemize.ts";
import type { StepRules } from "./step-rules.ts";
import {
	noteToolError,
	noteToolInput,
	noteToolInputRejected,
	noteToolOutput,
	openToolEvents,
} from "./tool-events.ts";

export interface DisplaySink {
	onTextDelta(delta: string): void;
	onReasoningDelta(delta: string): void;
	onToolCall(toolName: string, input: unknown): void;
}

export interface SteerLedger {
	mark: number;
	owned: Set<number>;
}

export function openSteerLedger(deps: {
	steerMarkSeed: number;
	ownedInputSeqs: number[];
}): SteerLedger {
	return { mark: deps.steerMarkSeed, owned: new Set(deps.ownedInputSeqs) };
}

export type StreamOutcome =
	| {
			kind: "ok";
			responseMessage: Message | null;
			usage: Usage | null;
			finishReason: FinishReason | null;
			lastStepInputTokens: number | null;
			toolCalls: string[];
			digestRing: { id: string; entry: ToolCallDigest }[];
			steerMark: number;
			window: WindowCapture | null;
			model: string;
			steps: number;
			claudeSession?: { sessionId: string; headUuid: string } | undefined;
	  }
	| {
			kind: "failed";
			errorText: string;
			rawError: unknown;
			holdForRecovery: boolean;
			errorHeld?: boolean;
			preempt?: { arm: "pressure"; step: number };
			partial: Message | null;
			seenText: boolean;
			toolCalls: string[];
			digestRing: { id: string; entry: ToolCallDigest }[];
			loop: LoopTurnState;
			steerMark: number;
			filterRetryUsed: boolean;
			window: WindowCapture | null;
			model: string;
			steps: number;
	  };

export interface RecorderDeps {
	convId: string;
	head: DisplaySink;
	state: TurnState;
	toolCalls: string[];
	digest: { id: string; entry: ToolCallDigest }[];
	seenText: boolean;
	steerMarkSeed: number;
	ownedInputSeqs: number[];
	evidence: EvidenceLimits | undefined;
	skillWatch?: SkillWatch | undefined;
	journal?: TurnJournal | undefined;
	runId: string;
	saveStep(patch: TurnCheckpointPatch): void;
	turnStartMs: number;
	holdZeroEffectError?: boolean | undefined;
	fallbackMisses?: ReadonlyArray<{ ref: string; reason: string }> | undefined;
	rules: StepRules;
	holdsAuthority(): boolean;
}

export interface AttemptRecorder {
	readonly steers: SteerLedger;
	readonly stepCount: number;
	readonly firstTokenMs: number | null;
	readonly seenText: boolean;
	readonly lastInput: number | null;
	readonly lastCacheRead: number | null;
	readonly holding: boolean;
	emit(chunk: MessageChunk): void;
	holdForRecovery(): void;
	callStarted(): void;
	spendCall(): void;
	dropCall(): void;
	noteFirstToken(): void;
	textDelta(partId: string, delta: string): void;
	reasoningDelta(delta: string): void;
	appendPartial(message: PromptMessage): void;
	toolInput(id: string, name: string, input: unknown, opts: { journal: boolean }): void;
	toolInputRejected(name: string, input: unknown, errorText: string): void;
	toolOutput(id: string, output: unknown): void;
	toolError(id: string, errorText: string): void;
	stepEnded(input: {
		usage: { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null };
		failed: boolean;
		quota?: AppQuota | null;
	}): void;
	holdsError(): boolean;
	metadata(input: {
		finishReason: FinishReason;
		forcedCompletion: ForcedKind | null;
		usage: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
		promptChars: PromptSegments | null;
	}): ReturnType<typeof replyMetadata>;
	failed(input: {
		errorText: string;
		rawError: unknown;
		partial: Message | null;
		errorHeld?: boolean;
		preempt?: { arm: "pressure"; step: number };
		window: WindowCapture | null;
	}): StreamOutcome;
	ok(input: {
		responseMessage: Message | null;
		usage: Usage | null;
		finishReason: FinishReason | null;
		window: WindowCapture | null;
		claudeSession?: { sessionId: string; headUuid: string };
	}): StreamOutcome;
	resetForRetry(): void;
}

export function openAttemptRecorder(
	deps: RecorderDeps,
	label: string,
	emit: (chunk: MessageChunk) => void,
	now: () => number = Date.now,
): AttemptRecorder {
	let holding = false;
	let pendingCall = false;
	let firstTokenMs: number | null = null;
	let seenText = deps.seenText;
	let lastTextPartId: string | null = null;
	let streamedTail = "";
	let lastTailCheckpointMs = 0;
	let stepCount = 0;
	let lastInput: number | null = null;
	let lastCacheRead: number | null = null;
	let quota: AppQuota | null = null;
	const partial: PromptMessage[] = [];
	const steers = openSteerLedger(deps);
	const events = openToolEvents({ toolCalls: deps.toolCalls, digest: deps.digest });
	const eventsDeps = {
		convId: deps.convId,
		evidence: deps.evidence,
		skillWatch: deps.skillWatch,
		onCompleted: (tool: string, input: unknown, result: unknown, failed: boolean) =>
			deps.state.noteCompletedCall(tool, input, result, failed),
	};
	const appendTail = (): void => {
		deps.saveStep({
			partial: [
				...partial,
				{ role: "assistant", content: [{ type: "text", text: streamedTail }] },
			],
		});
	};
	return {
		steers,
		get stepCount() {
			return stepCount;
		},
		get firstTokenMs() {
			return firstTokenMs;
		},
		get seenText() {
			return seenText;
		},
		get lastInput() {
			return lastInput;
		},
		get lastCacheRead() {
			return lastCacheRead;
		},
		get holding() {
			return holding;
		},
		emit(chunk) {
			if (!holding) emit(chunk);
		},
		holdForRecovery() {
			holding = true;
		},
		callStarted() {
			pendingCall = true;
			lastTextPartId = null;
		},
		spendCall() {
			if (!pendingCall) return;
			deps.state.noteModelCall();
			pendingCall = false;
		},
		dropCall() {
			pendingCall = false;
		},
		noteFirstToken() {
			firstTokenMs ??= now() - deps.turnStartMs;
		},
		textDelta(partId, delta) {
			if (seenText && (lastTextPartId === null || partId !== lastTextPartId)) {
				deps.head.onTextDelta("\n\n");
			}
			lastTextPartId = partId;
			seenText = true;
			deps.head.onTextDelta(delta);
			streamedTail += delta;
			const at = now();
			if (at - lastTailCheckpointMs >= 1_000) {
				lastTailCheckpointMs = at;
				appendTail();
			}
		},
		reasoningDelta(delta) {
			deps.head.onReasoningDelta(delta);
		},
		appendPartial(message) {
			partial.push(message);
		},
		toolInput(id, name, input, opts) {
			noteToolInput(
				events,
				{
					convId: deps.convId,
					evidence: deps.evidence,
					...(opts.journal
						? {
								noteJournal: (callId, toolName, toolInput) =>
									deps.journal?.noteToolInput(deps.runId, callId, toolName, toolInput),
							}
						: {}),
				},
				id,
				name,
				input,
			);
		},
		toolInputRejected(name, input, errorText) {
			noteToolInputRejected(eventsDeps, name, input, errorText);
		},
		toolOutput(id, output) {
			noteToolOutput(events, eventsDeps, id, output);
		},
		toolError(id, errorText) {
			noteToolError(events, eventsDeps, id, errorText);
		},
		stepEnded(input) {
			stepCount += 1;
			lastInput = input.usage.input;
			lastCacheRead = input.usage.cacheRead;
			deps.rules.afterCall({ inputTokens: input.usage.input, failed: input.failed });
			quota = input.quota ?? quota;
			streamedTail = "";
			deps.saveStep({
				loopState: deps.state.snapshot(),
				filterRetryUsed: deps.rules.filterRetryUsed(),
				...(partial.length > 0 ? { partial } : {}),
			});
			log.info("model step usage", {
				conversation: deps.convId,
				inputTokens: input.usage.input,
				cacheReadTokens: input.usage.cacheRead,
				cacheWriteTokens: input.usage.cacheWrite,
				outputTokens: input.usage.output,
			});
			if (deps.holdsAuthority() && !holding) {
				const liveContext: AppLiveContext = {
					input: lastInput,
					cacheRead: lastCacheRead,
					...(quota !== null ? { quota } : {}),
				};
				emit({ type: "data-context", transient: true, data: liveContext });
			}
		},
		holdsError() {
			return holdsZeroEffectError(deps.holdZeroEffectError, deps.state, holding);
		},
		metadata(input) {
			return replyMetadata({
				label,
				finishReason: input.finishReason,
				turnStartMs: deps.turnStartMs,
				now: now(),
				firstTokenMs,
				forcedCompletion: input.forcedCompletion,
				usage: { ...input.usage, lastInput, lastCacheRead },
				promptChars: input.promptChars,
				quota,
				fallbackMisses: deps.fallbackMisses,
			});
		},
		failed(input) {
			return {
				kind: "failed",
				errorText: input.errorText,
				rawError: input.rawError,
				holdForRecovery: holding,
				...(input.errorHeld ? { errorHeld: true } : {}),
				...(input.preempt ? { preempt: input.preempt } : {}),
				partial: input.partial,
				seenText,
				toolCalls: events.toolCalls,
				digestRing: events.digestRing,
				loop: deps.state.snapshot(),
				steerMark: steers.mark,
				filterRetryUsed: deps.rules.filterRetryUsed(),
				window: stepCount === 0 ? null : input.window,
				model: label,
				steps: stepCount,
			};
		},
		ok(input) {
			return {
				kind: "ok",
				responseMessage: input.responseMessage,
				usage: input.usage,
				finishReason: input.finishReason,
				lastStepInputTokens: lastInput,
				toolCalls: events.toolCalls,
				digestRing: events.digestRing,
				steerMark: steers.mark,
				window: stepCount === 0 ? null : input.window,
				model: label,
				steps: stepCount,
				...(input.claudeSession ? { claudeSession: input.claudeSession } : {}),
			};
		},
		resetForRetry() {
			holding = false;
			pendingCall = false;
			firstTokenMs = null;
			seenText = deps.seenText;
			lastTextPartId = null;
			streamedTail = "";
			lastTailCheckpointMs = 0;
			stepCount = 0;
			lastInput = null;
			lastCacheRead = null;
			quota = null;
			partial.length = 0;
		},
	};
}
