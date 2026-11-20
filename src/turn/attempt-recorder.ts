import type { FinishReason, Message, MessageChunk, Usage } from "../message.ts";
import type { PromptMessage } from "../prompt-message.ts";
import type { AppLiveContext, AppQuota } from "../http/app-wire.ts";
import { log } from "../log.ts";
import type { WindowCapture } from "../window-capture.ts";
import { openSteerLedger, type SteerLedger, type StreamDeps, type StreamOutcome, type WireMember } from "./stream.ts";
import { replyMetadata } from "./reply-metadata.ts";
import { holdsZeroEffectError, type ForcedKind } from "./state.ts";
import type { PromptSegments } from "./itemize.ts";
import {
	noteToolError,
	noteToolInput,
	noteToolInputRejected,
	noteToolOutput,
	openToolEvents,
} from "./tool-events.ts";

type RecorderDeps<M extends WireMember> = Pick<
	StreamDeps<M>,
	| "convId"
	| "head"
	| "state"
	| "toolCalls"
	| "digest"
	| "seenText"
	| "steerMarkSeed"
	| "ownedInputSeqs"
	| "evidence"
	| "skillWatch"
	| "journal"
	| "runId"
	| "saveStep"
	| "turnStartMs"
	| "holdZeroEffectError"
	| "fallbackMisses"
	| "rules"
	| "holdsAuthority"
>;

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

export function openAttemptRecorder<M extends WireMember>(
	deps: RecorderDeps<M>,
	label: string,
	emit: (chunk: MessageChunk) => void,
): AttemptRecorder {
	let holding = false;
	let pendingCall = false;
	// First model-produced content this turn — the finish stamp reads it
	// for the TTFT field. Text/reasoning deltas and tool input count;
	// structural parts (start, start-step, finish-step) never do.
	let firstTokenMs: number | null = null;
	let seenText = deps.seenText;
	let lastTextPartId: string | null = null;
	let streamedTail = "";
	let lastTailCheckpointMs = 0;
	let stepCount = 0;
	let lastInput: number | null = null;
	let lastCacheRead: number | null = null;
	// Latest codex quota receipt — the stream's rate_limits event can be
	// fresher than the header read; keep the newest non-null snapshot.
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
	// #493-L10 — a death mid-step must not lose text already on the
	// wire: the in-flight step's streamed text rides the checkpoint as
	// one extra assistant message, throttled to at most one write per
	// second so a long stream costs a write per second, not per token.
	// Reset at each step end — the completed step's messages already
	// carry its text.
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
			firstTokenMs ??= Date.now() - deps.turnStartMs;
		},
		textDelta(partId, delta) {
			if (seenText && (lastTextPartId === null || partId !== lastTextPartId)) {
				deps.head.onTextDelta("\n\n");
			}
			lastTextPartId = partId;
			seenText = true;
			deps.head.onTextDelta(delta);
			streamedTail += delta;
			const now = Date.now();
			if (now - lastTailCheckpointMs >= 1_000) {
				lastTailCheckpointMs = now;
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
			// null = provider didn't report the split, 0 = reported-and-cold;
			// inputTokens includes the cached ones. Read-only caches (OpenRouter,
			// openai-compatible) leave cacheWrite null.
			log.info("model step usage", {
				conversation: deps.convId,
				inputTokens: input.usage.input,
				cacheReadTokens: input.usage.cacheRead,
				cacheWriteTokens: input.usage.cacheWrite,
				outputTokens: input.usage.output,
			});
			if (deps.holdsAuthority() && !holding) {
				// The composer's context gauge reads settled turns only — the
				// wire carries this step's window occupancy as a transient data
				// part so a streaming client can show it while the turn runs.
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
				now: Date.now(),
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
