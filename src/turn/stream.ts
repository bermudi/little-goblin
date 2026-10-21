import { randomUUID } from "node:crypto";
import {
	isLoopFinished,
	streamText,
	toUIMessageStream,
	type CallWarning,
	type FinishReason,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	type ToolSet,
	type UIMessage,
	type UIMessageChunk,
} from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { filterErrorStream } from "../agent/filter-stream.ts";
import {
	isContentFilter,
	isContextOverflow,
	ProviderContentFilterError,
} from "../agent/provider-errors.ts";
import { log } from "../log.ts";
import { summarize, toolOk, type EvidenceLimits, type ToolCallDigest } from "../reviewer.ts";
import type { TurnJournal } from "../turn-journal.ts";
import { measurePrompt, type PromptSegments } from "./itemize.ts";
import { attributedSkills, type SkillWatch } from "./skill-attribution.ts";
import type { AdmittedMember, LiveWire } from "./admission.ts";
import type { ForcedKind, LoopTurnState, TurnState } from "./state.ts";
import { convertSteeredMessage, type ViewContext } from "./view.ts";

const REPEAT_CUT =
	"Loop check: the same tool call kept returning the same result. Tools are disabled for this final step. Write your answer to the operator now from what you have, and say plainly what is unverified and what was blocking you.";
const WATCHDOG_CUT =
	"Progress check: your tool calls were judged stuck twice in a row. Tools are disabled for this final step. Write your answer to the operator now from what you have, and say plainly what is unverified and what was blocking you.";
const CONTEXT_CUT =
	'The context window is nearly full. Tools are disabled for this final step. Write your answer to the operator now: what you found, what is left, and what you would pick up next if they say "continue".';
const CUT_NUDGE: Record<ForcedKind, string> = {
	repeat: REPEAT_CUT,
	watchdog: WATCHDOG_CUT,
	context: CONTEXT_CUT,
};

const scriptOutputSchema = z.object({
	calls: z.array(
		z.object({
			tool: z.string(),
			args: z.string(),
			ok: z.boolean(),
			result: z.string(),
		}),
	),
});

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

// ---------- the wire: what the turn's clients see ----------

export type WireEnd =
	| { kind: "completed" }
	| { kind: "fenced" }
	| { kind: "error"; message: string };

export interface LiveSubscriber {
	onChunk(chunk: UIMessageChunk): void;
	onEnd(done: WireEnd): void;
}

export interface LiveChunks {
	chunks: UIMessageChunk[];
	subscribers: Set<LiveSubscriber>;
	ended: boolean;
}

export function openLive(): LiveChunks {
	return { chunks: [], subscribers: new Set(), ended: false };
}

export function endLive(live: LiveChunks, done: WireEnd, convId: string): void {
	if (live.ended) return;
	live.ended = true;
	for (const sub of live.subscribers) {
		try {
			sub.onEnd(done);
		} catch (err) {
			live.subscribers.delete(sub);
			log.warn("subscriber onEnd failed — stream detached", err, {
				conversation: convId,
			});
		}
	}
	live.subscribers.clear();
}

// ---------- the membership seam ----------

export interface WireMember extends AdmittedMember {
	streamFailed?: boolean;
}

export type MemberSettlement = { kind: "fenced" } | { kind: "error"; message: string };

function replayWire(convId: string, turn: WireMember, live: LiveWire): void {
	if (turn.sink.onStreamChunk === undefined) return;
	for (const c of live.chunks) {
		try {
			turn.sink.onStreamChunk(c);
		} catch (err) {
			turn.streamFailed = true;
			log.warn("sink onStreamChunk failed during replay — stream detached", err, {
				conversation: convId,
			});
			break;
		}
	}
}

export function emitChunk(
	convId: string,
	members: WireMember[],
	live: LiveChunks,
	chunk: UIMessageChunk,
): void {
	for (const m of members) {
		if (m.streamFailed === true) continue;
		try {
			m.sink.onStreamChunk?.(chunk);
		} catch (err) {
			m.streamFailed = true;
			log.warn("sink onStreamChunk failed — stream detached", err, {
				conversation: convId,
			});
		}
	}
	live.chunks.push(chunk);
	for (const sub of live.subscribers) {
		try {
			sub.onChunk(chunk);
		} catch (err) {
			live.subscribers.delete(sub);
			log.warn("subscriber onChunk failed — stream detached", err, {
				conversation: convId,
			});
		}
	}
}

export function claimMembers<M extends WireMember>(
	convId: string,
	claim: () => M[],
	live: LiveWire,
	members: M[],
): M[] {
	const claimed = claim();
	members.push(...claimed);
	for (const m of claimed) replayWire(convId, m, live);
	return claimed;
}

export function joinMember<M extends WireMember>(
	convId: string,
	live: LiveWire,
	members: M[],
	member: M,
): void {
	members.push(member);
	replayWire(convId, member, live);
}

// ---------- the driver ----------

export interface DisplaySink {
	onTextDelta(delta: string): void;
	onReasoningDelta(delta: string): void;
	onToolCall(toolName: string, input: unknown): void;
}

export interface StreamStep {
	model: LanguageModel;
	system: string;
	providerOptions?: ProviderOptions;
	label?: string;
	contextWindow?: number;
}

export interface StreamDeps<M extends WireMember> {
	convId: string;
	epoch: number;
	head: DisplaySink;
	members: M[];
	live: LiveChunks;
	state: TurnState;
	assertAuthority(): void;
	holdsAuthority(): boolean;
	step: StreamStep;
	messages: ModelMessage[];
	tools: ToolSet;
	view: ViewContext;
	claimSteers(): M[];
	unrequeueSteers(steered: M[]): void;
	settle(m: M, done: MemberSettlement): void;
	steerMarkSeed: number;
	// The durable user-input seqs owned at admission; successfully folded
	// steers advance it and persist with the steer mark.
	ownedInputSeqs: number[];
	partial: UIMessage | null;
	seenText: boolean;
	toolCalls: string[];
	digest: { id: string; entry: ToolCallDigest }[];
	filterRetryUsed: boolean;
	overflowRecoverable: boolean;
	evidence: EvidenceLimits | undefined;
	skillWatch?: SkillWatch | undefined;
	journal?: TurnJournal | undefined;
	runId: string;
	turnStartMs: number;
	signal: AbortSignal;
}

export type StreamOutcome =
	| {
			kind: "ok";
			responseMessage: UIMessage | null;
			usage: LanguageModelUsage | null;
			finishReason: FinishReason | null;
			lastStepInputTokens: number | null;
			toolCalls: string[];
			digestRing: { id: string; entry: ToolCallDigest }[];
			steerMark: number;
	  }
	| {
			kind: "failed";
			errorText: string;
			rawError: unknown;
			holdForRecovery: boolean;
			partial: UIMessage | null;
			seenText: boolean;
			toolCalls: string[];
			digestRing: { id: string; entry: ToolCallDigest }[];
			loop: LoopTurnState;
			steerMark: number;
			filterRetryUsed: boolean;
	  };

export async function driveStream<M extends WireMember>(
	deps: StreamDeps<M>,
): Promise<StreamOutcome> {
	const { convId, epoch, head, members, live, state } = deps;
	const modelLabel =
		deps.step.label ??
		(typeof deps.step.model === "string" ? deps.step.model : deps.step.model.modelId);
	let lastStepInputTokens: number | null = null;
	let lastStepCacheRead: number | null = null;
	let lastPromptChars: PromptSegments | null = null;
	let rawError: unknown = null;
	let filterRetryPending = false;
	let filterRetryUsed = deps.filterRetryUsed;
	const partialMessages: ModelMessage[] = [];
	let steerMark = deps.steerMarkSeed;
	const ownedInputSeqs = new Set<number>(deps.ownedInputSeqs);
	// The finish metadata part is written after the final step, so the
	// last prepareStep capture is that step's outbound prompt — the
	// window the gauge itemizes.
	const notePrompt = (messages: readonly ModelMessage[]) => {
		lastPromptChars = measurePrompt(deps.step.system, deps.tools, messages);
	};
	const result = streamText({
		model: filterErrorStream(deps.step.model, convId),
		instructions: deps.step.system,
		messages: deps.messages,
		tools: deps.tools,
		prepareStep: async ({ messages: stepMessages, steps, stepNumber }) => {
			const prevInput = steps.at(-1)?.usage.inputTokens;
			state.noteContextLanding(prevInput, deps.step.contextWindow);
			const issued = state.issueLanding();
			if (issued !== null) {
				if (issued === "repeat") {
					log.warn("loop detector cut — forcing tools-off completion", {
						conversation: convId,
						step: stepNumber,
					});
				} else if (issued === "watchdog") {
					log.warn("loop watchdog cut — forcing tools-off completion", {
						conversation: convId,
						step: stepNumber,
					});
				} else {
					log.warn("context landing — forcing tools-off completion", {
						conversation: convId,
						input: prevInput ?? null,
						limit: deps.step.contextWindow ?? null,
					});
				}
			}
			const cut = state.decidedCut();
			const forced = cut !== null;
			const warnMsgs: ModelMessage[] = state
				.drainWarnings()
				.map((content): ModelMessage => ({ role: "user", content }));
			const nudge: ModelMessage[] = cut !== null ? [{ role: "user", content: CUT_NUDGE[cut] }] : [];
			const steered = deps.claimSteers();
			if (steered.length === 0) {
				if (forced || warnMsgs.length > 0) {
					const outbound = [...stepMessages, ...warnMsgs, ...nudge];
					notePrompt(outbound);
					return { messages: outbound, ...(forced ? { toolChoice: "none" as const } : {}) };
				}
				notePrompt(stepMessages);
				return undefined;
			}
			if (!deps.holdsAuthority()) {
				deps.unrequeueSteers(steered);
				return undefined;
			}
			const injected: ModelMessage[] = [];
			// Claimed by event seq, never by message id — ids are
			// client-controlled and may repeat, so an id match could claim a
			// steer that failed conversion as owned input.
			const claimedSeqs = new Set<number>();
			let admittedCount = 0;
			for (const t of steered) {
				try {
					const converted = await convertSteeredMessage(deps.view, t.message);
					if (!deps.holdsAuthority()) {
						deps.settle(t, { kind: "fenced" });
						continue;
					}
					injected.push(...converted);
					joinMember(convId, live, members, t);
					claimedSeqs.add(t.seq);
					admittedCount++;
				} catch (err) {
					if (!deps.holdsAuthority()) {
						deps.settle(t, { kind: "fenced" });
						continue;
					}
					log.warn(
						"steer conversion failed — submit errored, message degrades in later views",
						err,
						{ conversation: convId, message: t.message.id },
					);
					deps.settle(t, {
						kind: "error",
						message: `that message could not be prepared for the model: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			}
			if (injected.length === 0) {
				if (forced || warnMsgs.length > 0) {
					const outbound = [...stepMessages, ...warnMsgs, ...nudge];
					notePrompt(outbound);
					return { messages: outbound, ...(forced ? { toolChoice: "none" as const } : {}) };
				}
				notePrompt(stepMessages);
				return undefined;
			}
			// Ownership and the mark persist together — a crash after the
			// fold must still name these steered inputs the attempt's own.
			// Each seq came through conversion with its event, so only the
			// steers this attempt actually folded are recorded as owned.
			for (const seq of claimedSeqs) {
				if (seq > steerMark) steerMark = seq;
				ownedInputSeqs.add(seq);
			}
			deps.journal?.checkpoint(deps.runId, {
				ownedInputSeqs: [...ownedInputSeqs],
				steerMark,
			});
			log.info("steered into turn", {
				conversation: convId,
				submits: admittedCount,
				step: stepNumber,
			});
			const outbound = [...stepMessages, ...warnMsgs, ...injected, ...nudge];
			notePrompt(outbound);
			return {
				messages: outbound,
				...(forced ? { toolChoice: "none" as const } : {}),
			};
		},
		...(deps.step.providerOptions ? { providerOptions: deps.step.providerOptions } : {}),
		stopWhen: [isLoopFinished(), () => state.isLandingIssued()],
		abortSignal: deps.signal,
		// Callback-directed retries only (onError): the SDK buffers tool parts until the attempt ends cleanly, so blanket step retries would redo completed work against the identical prompt.
		streamRetries: 0,
		onError: ({ error }) => {
			if (isContentFilter(error)) {
				deps.assertAuthority();
				if (!filterRetryUsed) {
					filterRetryUsed = true;
					filterRetryPending = true;
					log.warn("provider content filter — retrying unchanged model call once", error, {
						conversation: convId,
						epoch,
						model: modelLabel,
						blockedUsage:
							error instanceof ProviderContentFilterError ? (error.usage ?? null) : null,
					});
					return { retry: true };
				}
				log.warn("provider content filter — retry budget exhausted", error, {
					conversation: convId,
					epoch,
					blockedUsage: error instanceof ProviderContentFilterError ? (error.usage ?? null) : null,
				});
			}
			rawError = error;
			log.error("model stream error", error, { conversation: convId });
		},
		onStepEnd: (step) => {
			if (filterRetryPending && step.finishReason !== "error") {
				filterRetryPending = false;
				log.info("provider content filter retry recovered", {
					conversation: convId,
					epoch,
				});
			}
			lastStepInputTokens = step.usage.inputTokens ?? null;
			lastStepCacheRead = step.usage.inputTokenDetails?.cacheReadTokens ?? null;
			partialMessages.push(...step.response.messages);
			deps.journal?.checkpoint(deps.runId, {
				loopState: state.snapshot(),
				filterRetryUsed,
				...(partialMessages.length > 0 ? { partial: partialMessages } : {}),
			});
			// null = provider didn't report the split, 0 = reported-and-cold; inputTokens includes the cached ones. Read-only caches (OpenRouter, openai-compatible) leave cacheWrite null.
			log.info("model step usage", {
				conversation: convId,
				inputTokens: step.usage.inputTokens ?? null,
				cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens ?? null,
				cacheWriteTokens: step.usage.inputTokenDetails?.cacheWriteTokens ?? null,
				outputTokens: step.usage.outputTokens ?? null,
			});
		},
	});

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
			log.debug("model warnings unavailable", {
				conversation: convId,
				error: String(err),
			});
		});

	let responseMessage: UIMessage | null = null;
	let partialResponse: UIMessage | null = null;
	const toolCalls: string[] = [...deps.toolCalls];
	const evidence = deps.evidence;
	const digestRing: { id: string; entry: ToolCallDigest }[] = [...deps.digest];
	let lastTextPartId: string | null = null;
	let seenText = deps.seenText;
	let pendingStep = false;
	let streamError: string | null = null;
	let holdForRecovery = false;
	const uiStream = toUIMessageStream<ToolSet, UIMessage>({
		stream: result.stream,
		sendReasoning: true,
		...(deps.partial ? { originalMessages: [deps.partial] } : {}),
		generateMessageId: randomUUID,
		messageMetadata: ({ part }) => {
			if (part.type !== "finish") return undefined;
			const forcedKind = state.forcedCompletion();
			return {
				model: modelLabel,
				finishReason: part.finishReason,
				durationMs: Date.now() - deps.turnStartMs,
				...(forcedKind !== null ? { forcedCompletion: forcedKind } : {}),
				usage: {
					input: part.totalUsage.inputTokens ?? null,
					output: part.totalUsage.outputTokens ?? null,
					cacheRead: part.totalUsage.inputTokenDetails?.cacheReadTokens ?? null,
					cacheWrite: part.totalUsage.inputTokenDetails?.cacheWriteTokens ?? null,
					// input above sums every step's billed prompt across the
					// tool loop; the window gauge reads the final step — the
					// current occupancy, the number compaction math uses.
					lastInput: lastStepInputTokens,
					lastCacheRead: lastStepCacheRead,
				},
				// Itemization of the final step's prompt, in serialized
				// characters (turn/itemize.ts); scaled to tokens by /context.
				// Absent when no step ran.
				...(lastPromptChars !== null ? { promptChars: { ...lastPromptChars } } : {}),
			};
		},
		onError: (error) =>
			isContentFilter(error)
				? "Provider blocked this request again after one retry."
				: error instanceof Error
					? error.message
					: String(error),
		onFinish: ({ responseMessage: rm, isAborted, outcome }) => {
			if (isAborted) return;
			if (outcome.status === "failed") {
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

	const callById = new Map<string, { tool: string; input: unknown }>();
	const noteCompletedCall = (toolCallId: string, result: unknown, failed: boolean): void => {
		const call = callById.get(toolCallId);
		state.noteCompletedCall(call?.tool ?? toolCallId, call?.input, result, failed);
	};
	for await (const chunk of uiStream) {
		deps.assertAuthority();
		if (chunk.type === "error") {
			const overflow = isContextOverflow(chunk.errorText) || isContextOverflow(rawError);
			if (overflow && deps.overflowRecoverable) {
				holdForRecovery = true;
			}
		}
		if (!holdForRecovery) {
			emitChunk(convId, members, live, chunk);
		}
		// The SDK emits start-step before an error part, so an error-only step must leave modelCalls at 0. Fail closed on anything else — modelCalls gates the retry ladder, so an unrecognized chunk type spends the call, never permits a retry.
		if (pendingStep && chunk.type !== "error") {
			state.noteModelCall();
			pendingStep = false;
		}
		switch (chunk.type) {
			case "start-step":
				// openai-compatible providers synthesize part ids per request, so step 2 can reuse step 1's id verbatim — reset instead of trusting ids.
				lastTextPartId = null;
				pendingStep = true;
				break;
			case "text-delta":
				if (seenText && (lastTextPartId === null || chunk.id !== lastTextPartId)) {
					head.onTextDelta("\n\n");
				}
				lastTextPartId = chunk.id;
				seenText = true;
				head.onTextDelta(chunk.delta);
				break;
			case "reasoning-delta":
				head.onReasoningDelta(chunk.delta);
				break;
			case "tool-input-available":
				head.onToolCall(chunk.toolName, chunk.input);
				toolCalls.push(chunk.toolName);
				callById.set(chunk.toolCallId, { tool: chunk.toolName, input: chunk.input });
				deps.journal?.noteToolInput(deps.runId, chunk.toolCallId, chunk.toolName, chunk.input);
				if (evidence !== undefined) {
					digestRing.push({
						id: chunk.toolCallId,
						entry: {
							tool: chunk.toolName,
							args: summarize(chunk.input, evidence.argChars),
							result: "(no result)",
							ok: true,
						},
					});
					if (digestRing.length > evidence.calls) digestRing.shift();
				}
				log.info("tool call", {
					conversation: convId,
					tool: chunk.toolName,
					arg: JSON.stringify(chunk.input).slice(0, 200),
				});
				break;
			case "tool-input-error":
				// tool-output-error carries only the id — record name+input here or the detector hashes each rejection under a random call id and never trips.
				callById.set(chunk.toolCallId, { tool: chunk.toolName, input: chunk.input });
				log.warn("tool call rejected", {
					conversation: convId,
					tool: chunk.toolName,
					arg: JSON.stringify(chunk.input ?? null).slice(0, 200),
					error: chunk.errorText.slice(0, 300),
				});
				break;
			case "tool-output-available": {
				if (evidence !== undefined) {
					for (let i = digestRing.length - 1; i >= 0; i--) {
						if (digestRing[i]!.id !== chunk.toolCallId) continue;
						digestRing[i]!.entry.result = summarize(chunk.output, evidence.outChars);
						digestRing[i]!.entry.ok = toolOk(chunk.output);
						break;
					}
				}
				if (callById.get(chunk.toolCallId)?.tool === "script") {
					const parsed = scriptOutputSchema.safeParse(chunk.output);
					if (parsed.success) {
						for (const [i, call] of parsed.data.calls.entries()) {
							toolCalls.push(`script.${call.tool}`);
							if (evidence !== undefined) {
								digestRing.push({
									id: `${chunk.toolCallId}/${i + 1}`,
									entry: {
										tool: `script.${call.tool}`,
										args: summarize(call.args, evidence.argChars),
										result: summarize(call.result, evidence.outChars),
										ok: call.ok,
									},
								});
								if (digestRing.length > evidence.calls) digestRing.shift();
							}
						}
					} else {
						log.warn("script call record unreadable — nested calls not expanded", {
							conversation: convId,
							toolCallId: chunk.toolCallId,
						});
					}
				}
				if (deps.skillWatch !== undefined) {
					const tool = callById.get(chunk.toolCallId)?.tool ?? "";
					if (tool === "write_file" || tool === "edit_file" || tool === "script") {
						for (const skill of attributedSkills(deps.skillWatch, tool, chunk.output)) {
							try {
								deps.skillWatch.record(convId, skill);
								log.info("skill write attributed", { conversation: convId, tool, skill });
							} catch (err) {
								log.error("skill provenance record failed — turn continues", err, {
									conversation: convId,
									tool,
									skill,
								});
							}
						}
					}
				}
				noteCompletedCall(chunk.toolCallId, chunk.output, false);
				break;
			}
			case "tool-output-error":
				log.warn("tool execute failed", {
					conversation: convId,
					tool: callById.get(chunk.toolCallId)?.tool ?? chunk.toolCallId,
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
				noteCompletedCall(chunk.toolCallId, chunk.errorText, true);
				break;
			case "error":
				pendingStep = false;
				streamError = chunk.errorText;
				break;
		}
	}

	deps.assertAuthority();
	if (streamError !== null) {
		return {
			kind: "failed",
			errorText: streamError,
			rawError,
			holdForRecovery,
			partial: partialResponse as UIMessage | null,
			seenText,
			toolCalls,
			digestRing,
			loop: state.snapshot(),
			steerMark,
			filterRetryUsed,
		};
	}
	const usage = await Promise.resolve(result.usage).catch((err) => {
		log.warn("turn usage unavailable — totals skipped", err, {
			conversation: convId,
		});
		return null;
	});
	const finishReason = await Promise.resolve(result.finishReason).catch((err) => {
		log.warn("turn finish reason unavailable", err, {
			conversation: convId,
		});
		return null;
	});
	deps.assertAuthority();
	return {
		kind: "ok",
		responseMessage: responseMessage as UIMessage | null,
		usage,
		finishReason,
		lastStepInputTokens,
		toolCalls,
		digestRing,
		steerMark,
	};
}
