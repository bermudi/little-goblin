import { randomUUID } from "node:crypto";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
	type CallWarning,
	isLoopFinished,
	type LanguageModel,
	streamText,
	type ToolSet,
	toUIMessageStream,
} from "ai";
import type {
	Message,
	MessageChunk,
} from "../message.ts";
import type { PromptMessage, ToolContent } from "../prompt-message.ts";
import { quotaFromMetadata } from "../agent/codex/receipts.ts";
import { toToolSet, ToolExecuteError } from "./ai-sdk-tools.ts";
import { filterErrorStream, streamSurfaceErrors } from "../agent/filter-stream.ts";
import { isContentFilter, isContextOverflow } from "../agent/provider-errors.ts";
import { fromSdkError } from "../agent/sdk-errors.ts";
import { makeToolCallRepair } from "../agent/tool-repair.ts";
import { log } from "../log.ts";
import type { EvidenceLimits, ToolCallDigest } from "../reviewer-evidence.ts";
import type { Tools } from "../tool.ts";
import type { TurnCheckpointPatch, TurnJournal } from "../turn-journal.ts";
import { serializeToolDefs, type WindowCapture } from "../window-capture.ts";
import type { AdmittedMember, LiveWire } from "./admission.ts";
import { measurePrompt, type PromptSegments } from "./itemize.ts";
import { stepModelRef } from "./model-ref.ts";
import { PreemptSignal, transportFailureText } from "./overflow.ts";
import type { SkillWatch } from "./skill-attribution.ts";
import type { StepRules } from "./step-rules.ts";
import { type ForcedKind, type TurnState } from "./state.ts";
import { convertSteeredMessage, type ViewContext } from "./view.ts";
import {
	openAttemptRecorder,
	type DisplaySink,
	type SteerLedger,
	type StreamOutcome,
} from "./attempt-recorder.ts";

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

function contextK(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}


export type WireEnd =
	| { kind: "completed" }
	| { kind: "fenced"; shutdown?: true }
	| { kind: "error"; message: string };

export interface LiveSubscriber {
	onChunk(chunk: MessageChunk): void;
	onEnd(done: WireEnd): void;
}

export interface LiveChunks {
	chunks: MessageChunk[];
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


export interface WireMember extends AdmittedMember {
	streamFailed?: boolean;
}

export function stubSupersededFrames(messages: PromptMessage[]): PromptMessage[] {
	const spots: { mi: number; pi: number }[] = [];
	messages.forEach((m, mi) => {
		if (m.role !== "tool" || typeof m.content === "string") return;
		m.content.forEach((part, pi) => {
			const p = part as { type?: unknown; output?: unknown };
			if (p.type !== "tool-result") return;
			const out = p.output as { type?: unknown; value?: unknown } | null;
			if (
				typeof out !== "object" ||
				out === null ||
				out.type !== "content" ||
				!Array.isArray(out.value)
			)
				return;
			const hasImage = out.value.some((v) => {
				const vp = v as { type?: unknown; mediaType?: unknown };
				return (
					vp.type === "file" &&
					typeof vp.mediaType === "string" &&
					vp.mediaType.startsWith("image/")
				);
			});
			if (hasImage) spots.push({ mi, pi });
		});
	});
	if (spots.length < 2) return messages;
	const drop = new Set(spots.slice(0, -1).map((s) => `${s.mi}:${s.pi}`));
	let changed = false;
	const next = messages.map((m, mi) => {
		if (m.role !== "tool" || typeof m.content === "string") return m;
		let touched = false;
		const content = m.content.map((part, pi): ToolContent[number] => {
			if (!drop.has(`${mi}:${pi}`)) return part;
			if (part.type !== "tool-result") return part;
			touched = true;
			const out = (part as { output?: { value?: unknown } }).output;
			const texts = Array.isArray(out?.value)
				? out.value
						.map((v) => v as { type?: unknown; text?: unknown })
						.filter((v) => v.type === "text")
						.map((v) => String(v.text ?? ""))
				: [];
			return {
				...part,
				output: {
					type: "text",
					value: [
						...texts,
						"[frame omitted — a newer screenshot superseded it; call screenshot for a fresh view]",
					].join("\n"),
				},
			};
		});
		if (!touched) return m;
		changed = true;
		return { ...m, content };
	});
	return changed ? next : messages;
}

export type MemberSettlement = { kind: "fenced" } | { kind: "error"; message: string };

function replayWire(convId: string, turn: WireMember, live: LiveWire): void {
	if (turn.sink.delivery !== "stream") return;
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
	chunk: MessageChunk,
): void {
	for (const m of members) {
		if (m.streamFailed === true) continue;
		try {
			if (m.sink.delivery === "stream") m.sink.onStreamChunk(chunk);
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


type SteerDeps<M extends WireMember> = Pick<
	StreamDeps<M>,
	| "convId"
	| "live"
	| "members"
	| "view"
	| "holdsAuthority"
	| "claimSteers"
	| "unrequeueSteers"
	| "settle"
>;

export interface SteerBatch<M extends WireMember> {
	members: M[];
	messages: PromptMessage[];
}

export async function claimSteerBatch<M extends WireMember>(
	deps: SteerDeps<M>,
	sdkTools: ToolSet = toToolSet(deps.view.tools),
): Promise<SteerBatch<M> | null> {
	const { convId } = deps;
	const steered = deps.claimSteers();
	if (steered.length === 0) return { members: [], messages: [] };
	if (!deps.holdsAuthority()) {
		deps.unrequeueSteers(steered);
		return null;
	}
	const members: M[] = [];
	const messages: PromptMessage[] = [];
	for (const t of steered) {
		try {
			const converted = await convertSteeredMessage(deps.view, t.message, sdkTools);
			if (!deps.holdsAuthority()) {
				deps.settle(t, { kind: "fenced" });
				continue;
			}
			if (t.seq === null) throw new Error("unmaterialized pending turn");
			messages.push(...converted);
			members.push(t);
		} catch (err) {
			if (!deps.holdsAuthority()) {
				deps.settle(t, { kind: "fenced" });
				continue;
			}
			log.warn("steer conversion failed — submit errored, message degrades in later views", err, {
				conversation: convId,
				message: t.message.id,
			});
			deps.settle(t, {
				kind: "error",
				message: `that message could not be prepared for the model: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}
	return { members, messages };
}

export function admitSteers<M extends WireMember>(
	deps: SteerDeps<M> & Pick<StreamDeps<M>, "noteRunMembers" | "onOwnedInputs" | "saveStep" | "sourceInputSeq">,
	ledger: SteerLedger,
	step: number,
	batch: SteerBatch<M>,
): void {
	if (batch.members.length === 0) return;
	const claimedSeqs = new Set<number>();
	for (const member of batch.members) {
		joinMember(deps.convId, deps.live, deps.members, member);
		if (member.seq === null) throw new Error("unmaterialized pending turn");
		claimedSeqs.add(member.seq);
	}
	if (claimedSeqs.size > 0) deps.noteRunMembers?.([...claimedSeqs]);
	for (const seq of claimedSeqs) {
		if (seq > ledger.mark) ledger.mark = seq;
		ledger.owned.add(seq);
	}
	deps.onOwnedInputs?.([...claimedSeqs]);
	deps.saveStep({
		ownedInputSeqs: [...ledger.owned],
		steerMark: ledger.mark,
		sourceInputSeq: deps.sourceInputSeq?.(),
	});
	log.info("steered into turn", {
		conversation: deps.convId,
		submits: batch.members.length,
		step,
	});
}

export function returnSteers<M extends WireMember>(
	deps: Pick<SteerDeps<M>, "convId" | "holdsAuthority" | "unrequeueSteers" | "settle">,
	batch: SteerBatch<M>,
	reason: string,
): void {
	if (batch.members.length === 0) return;
	const requeued = deps.holdsAuthority();
	if (requeued) deps.unrequeueSteers(batch.members);
	else for (const member of batch.members) deps.settle(member, { kind: "fenced" });
	log.warn("steers returned unsent", {
		conversation: deps.convId,
		steers: batch.members.length,
		reason,
		requeued,
	});
}


export interface StreamStep {
	model: LanguageModel;
	system: string;
	providerOptions?: ProviderOptions;
	label?: string;
	contextWindow?: number;
	maxRetries?: number;
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
	messages: PromptMessage[];
	tools: Tools;
	view: ViewContext;
	claimSteers(): M[];
	unrequeueSteers(steered: M[]): void;
	settle(m: M, done: MemberSettlement): void;
	noteRunMembers?(memberSeqs: number[]): void;
	steerMarkSeed: number;
	ownedInputSeqs: number[];
	onOwnedInputs?(seqs: readonly number[]): void;
	sourceInputSeq?(): number | null;
	partial: Message | null;
	seenText: boolean;
	toolCalls: string[];
	digest: { id: string; entry: ToolCallDigest }[];
	overflowRecoverable: boolean;
	rules: StepRules;
	evidence: EvidenceLimits | undefined;
	skillWatch?: SkillWatch | undefined;
	journal?: TurnJournal | undefined;
	runId: string;
	saveStep(patch: TurnCheckpointPatch): void;
	turnStartMs: number;
	signal: AbortSignal;
	holdZeroEffectError?: boolean | undefined;
	fallbackMisses?: ReadonlyArray<{ ref: string; reason: string }> | undefined;
}

export async function driveStream<M extends WireMember>(
	deps: StreamDeps<M>,
): Promise<StreamOutcome> {
	const { convId, head, members, live, state } = deps;
	const sdkTools = toToolSet(deps.tools);
	const modelLabel = stepModelRef(deps.step);
	const recorder = openAttemptRecorder(deps, modelLabel, (chunk) =>
		emitChunk(convId, members, live, chunk),
	);
	const attempt = {
		lastPromptChars: null as PromptSegments | null,
		stagedWindow: null as { messages: PromptMessage[]; segments: PromptSegments } | null,
		lastWindow: null as { messages: PromptMessage[]; segments: PromptSegments } | null,
		rawError: null as unknown,
		preemptInfo: null as { arm: "pressure"; step: number } | null,
		streamError: null as string | null,
		sawErrorPart: false,
		errorHeld: false,
		partialResponse: null as Message | null,
		responseMessage: null as Message | null,
	};
	const rules = deps.rules;
	const steers = recorder.steers;
	const notePrompt = (messages: readonly PromptMessage[], stepNumber: number) => {
		const segments = measurePrompt(deps.step.system, deps.tools, messages);
		attempt.lastPromptChars = segments;
		const staged = [...messages];
		attempt.stagedWindow = { messages: staged, segments };
		const arm = rules.beforeCall(stepNumber, staged);
		if (arm !== null) throw new PreemptSignal(arm, stepNumber);
	};
	const result = streamText({
		tools: sdkTools,
		model: filterErrorStream(deps.step.model, convId),
		instructions: deps.step.system,
		messages: deps.messages,
		repairToolCall: makeToolCallRepair(convId),
		...(deps.step.maxRetries !== undefined ? { maxRetries: deps.step.maxRetries } : {}),
		prepareStep: async ({ messages: stepMessages, steps, stepNumber }) => {
			const prevInput = steps.at(-1)?.usage.inputTokens;
			const contextUsed = rules.contextFill()?.used ?? null;
			state.noteContextLanding(prevInput, deps.step.contextWindow);
			const contextLimit = deps.step.contextWindow;
			const contextPct =
				contextUsed !== null && contextLimit !== undefined
					? Math.round((contextUsed / contextLimit) * 100)
					: null;
			const contextNote: PromptMessage[] =
				contextLimit !== undefined &&
				(stepNumber === 0 || (contextPct !== null && contextPct >= 50))
					? contextUsed !== null
						? [
							{
								role: "user",
								content: `[context: ${contextK(contextUsed)} of ${contextK(contextLimit)} tokens used (${contextPct}%)]`,
							},
							]
						: [{ role: "user", content: `[context: ${contextK(contextLimit)} token window]` }]
					: [];
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
			const warnMsgs: PromptMessage[] = state
				.drainWarnings()
				.map((content): PromptMessage => ({ role: "user", content }));
			const nudge: PromptMessage[] = cut !== null ? [{ role: "user", content: CUT_NUDGE[cut] }] : [];
			const base = stubSupersededFrames(stepMessages);
			const batch = await claimSteerBatch(deps, sdkTools);
			if (batch === null) {
				if (
					base === stepMessages &&
					warnMsgs.length === 0 &&
					contextNote.length === 0 &&
					!forced
				)
					return undefined;
				const outbound =
					forced || warnMsgs.length > 0 || contextNote.length > 0
						? [...base, ...warnMsgs, ...contextNote, ...nudge]
						: base;
				notePrompt(outbound, stepNumber);
				return { messages: outbound, ...(forced ? { toolChoice: "none" as const } : {}) };
			}
			admitSteers(deps, steers, stepNumber, batch);
			const { messages: injected } = batch;
			if (injected.length === 0) {
				if (forced || warnMsgs.length > 0 || contextNote.length > 0 || base !== stepMessages) {
					const outbound = [...base, ...warnMsgs, ...contextNote, ...nudge];
					notePrompt(outbound, stepNumber);
					return { messages: outbound, ...(forced ? { toolChoice: "none" as const } : {}) };
				}
				notePrompt(stepMessages, stepNumber);
				return undefined;
			}
			const outbound = [...base, ...warnMsgs, ...injected, ...contextNote, ...nudge];
			notePrompt(outbound, stepNumber);
			return {
				messages: outbound,
				...(forced ? { toolChoice: "none" as const } : {}),
			};
		},
		...(deps.step.providerOptions ? { providerOptions: deps.step.providerOptions } : {}),
		stopWhen: [isLoopFinished(), () => state.isLandingIssued()],
		abortSignal: deps.signal,
		streamRetries: 0,
		onError: async ({ error }) => {
			const failure = fromSdkError(error);
			const retry = await rules.callFailed(failure, {
				step: recorder.stepCount,
				midStream: streamSurfaceErrors.has(error as object),
			});
			if (retry) return { retry: true };
			attempt.rawError = failure;
			log.error("model stream error", error, { conversation: convId });
		},
		onStepEnd: (step) => {
			attempt.lastWindow = attempt.stagedWindow;
			for (const m of step.response.messages) {
				if (m.role === "assistant") recorder.appendPartial(m);
			}
			recorder.stepEnded({
				usage: {
					input: step.usage.inputTokens ?? null,
					cacheRead: step.usage.inputTokenDetails?.cacheReadTokens ?? null,
					cacheWrite: step.usage.inputTokenDetails?.cacheWriteTokens ?? null,
					output: step.usage.outputTokens ?? null,
				},
				failed: step.finishReason === "error",
				quota: quotaFromMetadata(step.providerMetadata),
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

	const uiStream = toUIMessageStream<ToolSet, Message>({
		stream: result.stream,
		sendReasoning: true,
		...(deps.partial ? { originalMessages: [deps.partial] } : {}),
		generateMessageId: randomUUID,
		messageMetadata: ({ part }) => {
			if (
				(part.type === "text-delta" ||
					part.type === "reasoning-delta" ||
					part.type === "tool-input-start" ||
					part.type === "tool-input-delta" ||
					part.type === "tool-call")
			) {
				recorder.noteFirstToken();
			}
			if (part.type !== "finish") return undefined;
			return recorder.metadata({
				finishReason: part.finishReason,
				forcedCompletion: state.forcedCompletion(),
				usage: {
					input: part.totalUsage.inputTokens ?? null,
					output: part.totalUsage.outputTokens ?? null,
					cacheRead: part.totalUsage.inputTokenDetails?.cacheReadTokens ?? null,
					cacheWrite: part.totalUsage.inputTokenDetails?.cacheWriteTokens ?? null,
				},
				promptChars: attempt.lastPromptChars,
			});
		},
		onError: (error) =>
			error instanceof ToolExecuteError
				? error.message
				: isContentFilter(fromSdkError(error))
					? "Provider blocked this request again after one retry."
					: (transportFailureText(error) ??
						(error instanceof Error ? error.message : String(error))),
		onFinish: ({ responseMessage: rm, isAborted, outcome }) => {
			if (isAborted) return;
			if (outcome.status === "failed") {
				attempt.partialResponse = rm;
				attempt.streamError ??=
					outcome.error instanceof Error
						? outcome.error.message
						: outcome.error != null
							? String(outcome.error)
							: "model stream failed";
				return;
			}
			attempt.responseMessage = rm;
		},
	});

	const providerExecutedIds = new Set<string>();
	try {
		for await (const chunk of uiStream) {
			deps.assertAuthority();
			if (chunk.type === "error") {
				attempt.sawErrorPart = true;
				const overflow = isContextOverflow(chunk.errorText) || isContextOverflow(attempt.rawError);
				if (overflow && deps.overflowRecoverable) {
					recorder.holdForRecovery();
				}
				if (attempt.rawError instanceof PreemptSignal && deps.overflowRecoverable) {
					recorder.holdForRecovery();
					attempt.preemptInfo = { arm: attempt.rawError.arm, step: attempt.rawError.stepNumber };
				}
			}
			if (
				chunk.type === "error" &&
				recorder.holdsError()
			) {
				attempt.errorHeld = true;
			} else if (!recorder.holding) {
				if (chunk.type === "finish" && attempt.sawErrorPart) {
					const metadata = chunk.messageMetadata;
					recorder.emit({
						...chunk,
						finishReason: "error",
						...(typeof metadata === "object" && metadata !== null
							? { messageMetadata: { ...metadata, finishReason: "error" } }
							: {}),
					});
				} else {
					recorder.emit(chunk);
				}
			}
			if (chunk.type !== "error") recorder.spendCall();
			switch (chunk.type) {
				case "start-step":
					recorder.callStarted();
					break;
				case "text-delta":
					recorder.textDelta(chunk.id, chunk.delta);
					break;
				case "reasoning-delta":
					recorder.reasoningDelta(chunk.delta);
					break;
				case "tool-input-available":
					head.onToolCall(chunk.toolName, chunk.input);
					if (chunk.providerExecuted === true) {
						providerExecutedIds.add(chunk.toolCallId);
						break;
					}
					recorder.toolInput(chunk.toolCallId, chunk.toolName, chunk.input, { journal: true });
					break;
				case "tool-input-error":
					if (providerExecutedIds.has(chunk.toolCallId)) break;
					recorder.toolInputRejected(chunk.toolName, chunk.input, chunk.errorText);
					break;
				case "tool-output-available":
					if (providerExecutedIds.has(chunk.toolCallId)) break;
					recorder.toolOutput(chunk.toolCallId, chunk.output);
					break;
				case "tool-output-error":
					if (providerExecutedIds.has(chunk.toolCallId)) break;
					recorder.toolError(chunk.toolCallId, chunk.errorText);
					break;
				case "error":
					recorder.dropCall();
					attempt.streamError = chunk.errorText;
					break;
			}
		}
	} catch (err) {
		if (err instanceof PreemptSignal && deps.overflowRecoverable) {
			recorder.holdForRecovery();
			attempt.preemptInfo = { arm: err.arm, step: err.stepNumber };
			attempt.streamError = err.message;
		} else {
			throw fromSdkError(err);
		}
	}

	const windowCapture = (): WindowCapture | null => {
		if (attempt.lastWindow === null || recorder.stepCount === 0) return null;
		return {
			v: 1,
			system: deps.step.system,
			tools: serializeToolDefs(deps.tools),
			messages: attempt.lastWindow.messages,
			segments: attempt.lastWindow.segments,
		};
	};

	deps.assertAuthority();
	if (attempt.streamError !== null) {
		return recorder.failed({
			errorText: attempt.streamError,
			rawError: attempt.rawError,
			partial: attempt.partialResponse,
			errorHeld: attempt.errorHeld,
			...(attempt.preemptInfo !== null ? { preempt: attempt.preemptInfo } : {}),
			window: windowCapture(),
		});
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
	return recorder.ok({
		responseMessage: attempt.responseMessage,
		usage,
		finishReason,
		window: windowCapture(),
	});
}
