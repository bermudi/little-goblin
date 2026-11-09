import { randomUUID } from "node:crypto";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
	type CallWarning,
	type FinishReason,
	isLoopFinished,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	streamText,
	type ToolSet,
	toUIMessageStream,
	type UIMessage,
	type UIMessageChunk,
} from "ai";
import { filterErrorStream, streamSurfaceErrors } from "../agent/filter-stream.ts";
import {
	isContentFilter,
	isContextOverflow,
	isTransientTurnFailure,
	ProviderContentFilterError,
} from "../agent/provider-errors.ts";
import { makeToolCallRepair } from "../agent/tool-repair.ts";
import { quotaFromMetadata } from "../agent/codex/receipts.ts";
import type { AppLiveContext, AppQuota } from "../http/app-wire.ts";
import { log } from "../log.ts";
import type { EvidenceLimits, ToolCallDigest } from "../reviewer.ts";
import type { TurnJournal } from "../turn-journal.ts";
import { serializeToolDefs, type WindowCapture } from "../window-capture.ts";
import type { AdmittedMember, LiveWire } from "./admission.ts";
import { estimateHistoryChars, measurePrompt, type PromptSegments } from "./itemize.ts";
import { PreemptSignal } from "./overflow.ts";
import type { SkillWatch } from "./skill-attribution.ts";
import type { ForcedKind, LoopTurnState, TurnState } from "./state.ts";
import {
	noteToolError,
	noteToolInput,
	noteToolInputRejected,
	noteToolOutput,
	openToolEvents,
} from "./tool-events.ts";
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
	// shutdown: the process is going down (deploy/restart), not a /stop.
	| { kind: "fenced"; shutdown?: true }
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
	// Provider retry rule for the call — 1min carries 0, absent keeps
	// the SDK default.
	maxRetries?: number;
	// Delay before the transient-transport step retry re-dispatches.
	// Absent keeps the SDK retry ladder's initial delay; tests zero it.
	transientRetryDelayMs?: number;
}

// The SDK retry ladder's initialDelayInMs default — one delay story for
// every retry goblin grants.
const TRANSIENT_RETRY_DELAY_MS = 2000;

// A stopped turn must not hold the lane for the full backoff.
function awaitRetryDelay(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(finish, ms);
		function finish(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		}
		signal.addEventListener("abort", finish, { once: true });
	});
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
	// The durable-wake seam: after a steer fold, the durable event seqs
	// that actually joined the membership (converted + replayed, not
	// merely claimed). The runtime wires it to the wake dispatcher's
	// run link; absent = no wake tracking.
	noteRunMembers?(memberSeqs: number[]): void;
	steerMarkSeed: number;
	// The durable user-input seqs owned at admission; successfully folded
	// steers advance it and persist with the steer mark.
	ownedInputSeqs: number[];
	onOwnedInputs?(seqs: readonly number[]): void;
	sourceInputSeq?(): number | null;
	partial: UIMessage | null;
	seenText: boolean;
	toolCalls: string[];
	digest: { id: string; entry: ToolCallDigest }[];
	filterRetryUsed: boolean;
	overflowRecoverable: boolean;
	// design/compaction.md → Timing: the pre-emption decision, evaluated
	// at the step boundary before every model call including the first
	// (after tools finish and their results are appended). Supplied by the
	// runtime, which owns the thresholds and the compaction state; an arm
	// returned means the next call must not dispatch — the turn folds and
	// resumes on the compacted view. Absent = pre-emption off. Only
	// consulted while the overflow rail is recoverable and authority holds
	// (one fold-resume per logical turn; a fenced turn takes the fence path).
	preemptCheck?(info: {
		projectedInputTokens: number | null;
		historyChars: number;
		stepNumber: number;
	}): "pressure" | "fidelity" | null;
	evidence: EvidenceLimits | undefined;
	skillWatch?: SkillWatch | undefined;
	journal?: TurnJournal | undefined;
	runId: string;
	turnStartMs: number;
	signal: AbortSignal;
	// design/model.md → Model fallback list. When the runtime has a next
	// candidate, an error that arrives before any model call completed
	// is held off the wire: the fallback attempt continues the same
	// stream, and the runtime emits the error itself if it ends the turn.
	holdZeroEffectError?: boolean | undefined;
	// Candidates that already failed this turn; non-empty stamps the
	// finish metadata (`fallback.from`) — the label names who served.
	fallbackMisses?: ReadonlyArray<{ ref: string; reason: string }> | undefined;
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
			// The final step's outbound prompt — null when no step ran.
			window: WindowCapture | null;
			// Window-row metadata: which model ran, how many steps.
			model: string;
			steps: number;
	  }
	| {
			kind: "failed";
			errorText: string;
			rawError: unknown;
			holdForRecovery: boolean;
			// The error chunk was withheld (holdZeroEffectError) — nothing
			// about this failure reached the wire.
			errorHeld?: boolean;
			// Set when the failure is a step-boundary pre-empt, not a provider
			// error: the recovery rail is the same, the compact reason and the
			// operator-facing story are not.
			preempt?: { arm: "pressure" | "fidelity"; step: number };
			partial: UIMessage | null;
			seenText: boolean;
			toolCalls: string[];
			digestRing: { id: string; entry: ToolCallDigest }[];
			loop: LoopTurnState;
			steerMark: number;
			filterRetryUsed: boolean;
			// The last completed step's prompt — the call went out even
			// when the turn failed on a later one.
			window: WindowCapture | null;
			model: string;
			steps: number;
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
	// Latest codex quota receipt — the stream's rate_limits event can be
	// fresher than the header read; keep the newest non-null snapshot.
	let turnQuota: AppQuota | null = null;
	let lastPromptChars: PromptSegments | null = null;
	// The window record, captured in two stages — prepareStep stages the
	// step's outbound prompt, onStepEnd promotes it. A staged prompt whose
	// call never dispatched (abort, a doStream throw) is a prompt nothing
	// saw and must never become the record; the promoted one is the last
	// completed step, on either outcome rail. References only;
	// serialization happens once, when the runtime records the turn.
	let stagedWindow: { messages: ModelMessage[]; segments: PromptSegments } | null = null;
	let lastWindow: { messages: ModelMessage[]; segments: PromptSegments } | null = null;
	let stepCount = 0;
	let rawError: unknown = null;
	let filterRetryPending = false;
	let filterRetryUsed = deps.filterRetryUsed;
	// The SDK grants one onError-requested retry per model step
	// (callbackStreamRetryCount), shared by every branch below —
	// retryGrantedStep mirrors that budget so a granted request is
	// always a real re-dispatch, never a logged wish. stepCount is the
	// ended-steps gauge; a retried step ends once, after its retry.
	let retryGrantedStep: number | null = null;
	let transientRetries = 0;
	let transientRetryPending = false;
	// Read inside streamText's onStepEnd, so it must be declared before
	// the factory call — an await inserted between the two leaves every
	// step end in the TDZ while still compiling.
	let holdForRecovery = false;
	// The pre-empt decision, captured when the signal surfaces so the
	// failed outcome can name the arm and step. Also read only after the
	// stream settles — declared here for the same TDZ reason.
	let preemptInfo: { arm: "pressure" | "fidelity"; step: number } | null = null;
	const partialMessages: ModelMessage[] = [];
	let steerMark = deps.steerMarkSeed;
	const ownedInputSeqs = new Set<number>(deps.ownedInputSeqs);
	// The finish metadata part is written after the final step, so the
	// last prepareStep capture is that step's outbound prompt — the
	// window the gauge itemizes.
	const notePrompt = (messages: readonly ModelMessage[], stepNumber: number) => {
		const segments = measurePrompt(deps.step.system, deps.tools, messages);
		lastPromptChars = segments;
		stagedWindow = { messages: [...messages], segments };
		// The pre-emption gate (design/compaction.md → Timing): decide
		// before the call dispatches. Gated on the overflow rail's budget —
		// the one-fold-resume-per-logical-turn invariant — and on live
		// authority: a fenced turn must take the fence path, not start a
		// fold.
		if (deps.preemptCheck !== undefined && deps.overflowRecoverable && deps.holdsAuthority()) {
			// The upcoming request, not the last one: the last completed
			// step's reported input plus everything appended since its
			// dispatch (assistant output, tool results, steers), at
			// chars/4. Null before the first completed step.
			// Media is charged a fixed cost (estimateHistoryChars), not its
			// base64 length — see itemize.ts.
			const historyEstimate = estimateHistoryChars(messages);
			const projectedInputTokens =
				lastStepInputTokens !== null && lastWindow !== null
					? lastStepInputTokens +
						Math.ceil(Math.max(0, historyEstimate - estimateHistoryChars(lastWindow.messages)) / 4)
					: null;
			const arm = deps.preemptCheck({
				projectedInputTokens,
				historyChars: historyEstimate,
				stepNumber,
			});
			if (arm !== null) {
				// A context landing that issued at this same boundary has not
				// driven its forced step (the throw stops the dispatch) — the
				// pre-empt supersedes it, and the resume must start unforced.
				state.retractContextLanding();
				log.warn("compaction pre-empt — folding at the step boundary", {
					conversation: convId,
					arm,
					step: stepNumber,
					projectedInputTokens,
					historyChars: historyEstimate,
				});
				throw new PreemptSignal(arm, stepNumber);
			}
		}
	};
	const result = streamText({
		model: filterErrorStream(deps.step.model, convId),
		instructions: deps.step.system,
		messages: deps.messages,
		tools: deps.tools,
		// Rule-based repairs only (JSON5 slips, stringified args) — a call
		// no rule fixes still surfaces as a tool error, never a re-ask.
		repairToolCall: makeToolCallRepair(convId),
		// Provider retry rules ride the step — 1min sends no SDK
		// retries (its one-shot content-filter re-ask is separate and
		// deliberate; model.md → Provider-filter recovery).
		...(deps.step.maxRetries !== undefined ? { maxRetries: deps.step.maxRetries } : {}),
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
					notePrompt(outbound, stepNumber);
					return { messages: outbound, ...(forced ? { toolChoice: "none" as const } : {}) };
				}
				notePrompt(stepMessages, stepNumber);
				return undefined;
			}
			if (!deps.holdsAuthority()) {
				deps.unrequeueSteers(steered);
				return undefined;
			}
			const injected: ModelMessage[] = [];
			// Claimed by event seq, never by message id — ids are
			// client-controlled and may repeat, so an id match could claim a
			// steer that failed conversion as owned input. The wake link's
			// identity is the same seq set.
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
			// Joined members are this run's input now — the wake link
			// lands before the request does, so a completion can't settle
			// a delivery it never owned.
			if (claimedSeqs.size > 0) deps.noteRunMembers?.([...claimedSeqs]);
			if (injected.length === 0) {
				if (forced || warnMsgs.length > 0) {
					const outbound = [...stepMessages, ...warnMsgs, ...nudge];
					notePrompt(outbound, stepNumber);
					return { messages: outbound, ...(forced ? { toolChoice: "none" as const } : {}) };
				}
				notePrompt(stepMessages, stepNumber);
				return undefined;
			}
			// Ownership and the mark persist together — a crash after the
			// fold must still name these steered inputs the attempt's own.
			// Each seq came through conversion with its event, so only the
			// steers this attempt actually folded are recorded as owned.
			// Ownership is the member's own durable seq, never a rediscovery
			// through app-controlled message ids.
			for (const seq of claimedSeqs) {
				if (seq > steerMark) steerMark = seq;
				ownedInputSeqs.add(seq);
			}
			deps.onOwnedInputs?.([...claimedSeqs]);
			deps.journal?.checkpoint(deps.runId, {
				ownedInputSeqs: [...ownedInputSeqs],
				steerMark,
				sourceInputSeq: deps.sourceInputSeq?.(),
			});
			log.info("steered into turn", {
				conversation: convId,
				submits: admittedCount,
				step: stepNumber,
			});
			const outbound = [...stepMessages, ...warnMsgs, ...injected, ...nudge];
			notePrompt(outbound, stepNumber);
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
		onError: async ({ error }) => {
			if (isContentFilter(error)) {
				deps.assertAuthority();
				if (!filterRetryUsed && retryGrantedStep !== stepCount) {
					filterRetryUsed = true;
					filterRetryPending = true;
					retryGrantedStep = stepCount;
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
			} else if (streamSurfaceErrors.has(error as object) && isTransientTurnFailure(error)) {
				// A transient transport failure (socket reset mid-stream) on one
				// model step — the failed step re-dispatches, earlier steps and
				// their tool results are preserved (SDK stream-retry contract).
				// Only stream-surface errors reach the retry machinery; the
				// pre-stream surface is the transport middleware's lane
				// (agent/providers.ts).
				deps.assertAuthority();
				const delayMs = deps.step.transientRetryDelayMs ?? TRANSIENT_RETRY_DELAY_MS;
				// Sleep only when a retry will actually be granted — the
				// budget-spent and aborted paths must not pay the delay.
				if (!deps.signal.aborted && retryGrantedStep !== stepCount) {
					await awaitRetryDelay(delayMs, deps.signal);
					if (!deps.signal.aborted) {
						retryGrantedStep = stepCount;
						transientRetries++;
						transientRetryPending = true;
						log.warn("transient model stream error — retrying the failed model step", error, {
							conversation: convId,
							epoch,
							model: modelLabel,
							attempt: transientRetries,
							delayMs,
						});
						return { retry: true };
					}
				}
				// An aborted turn takes the fence path below — one story, not two.
				if (!deps.signal.aborted) {
					log.warn("transient model stream error — step retry budget spent", error, {
						conversation: convId,
						epoch,
						model: modelLabel,
						attempt: transientRetries,
					});
				}
			}
			rawError = error;
			log.error("model stream error", error, { conversation: convId });
		},
		onStepEnd: (step) => {
			stepCount++;
			// The step's request was dispatched and consumed — its staged
			// prompt becomes the record ("last completed step"; an errored
			// dispatch still counts, the model saw the prompt).
			lastWindow = stagedWindow;
			if (filterRetryPending && step.finishReason !== "error") {
				filterRetryPending = false;
				log.info("provider content filter retry recovered", {
					conversation: convId,
					epoch,
				});
			}
			if (transientRetryPending && step.finishReason !== "error") {
				transientRetryPending = false;
				log.info("transient stream retry recovered", {
					conversation: convId,
					epoch,
					retries: transientRetries,
				});
			}
			lastStepInputTokens = step.usage.inputTokens ?? null;
			lastStepCacheRead = step.usage.inputTokenDetails?.cacheReadTokens ?? null;
			turnQuota = quotaFromMetadata(step.providerMetadata) ?? turnQuota;
			// Assistant steps only — tool-result messages re-derive from
			// the journal at resume, and carrying them doubles checkpoint
			// bulk for nothing.
			for (const m of step.response.messages) {
				if (m.role === "assistant") partialMessages.push(m);
			}
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
			// The composer's context gauge reads settled turns only — the
			// wire carries this step's window occupancy as a transient data
			// part so a streaming client can show it while the turn runs.
			if (deps.holdsAuthority() && !holdForRecovery) {
				const liveContext: AppLiveContext = {
					input: lastStepInputTokens,
					cacheRead: lastStepCacheRead,
					...(turnQuota !== null ? { quota: turnQuota } : {}),
				};
				emitChunk(convId, members, live, {
					type: "data-context",
					transient: true,
					data: liveContext,
				});
			}
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
	const evidence = deps.evidence;
	const events = openToolEvents({ toolCalls: deps.toolCalls, digest: deps.digest });
	const eventsDeps = {
		convId,
		evidence,
		skillWatch: deps.skillWatch,
		onCompleted: (tool: string, input: unknown, result: unknown, failed: boolean) =>
			state.noteCompletedCall(tool, input, result, failed),
	};
	let lastTextPartId: string | null = null;
	let seenText = deps.seenText;
	let pendingStep = false;
	let streamError: string | null = null;
	let errorHeld = false;
	// First model-produced content this turn — the finish stamp reads it
	// for the TTFT field. Text/reasoning deltas and tool input count;
	// structural parts (start, start-step, finish-step) never do.
	// Declared before the factory call — messageMetadata is invoked while
	// parts flow, so the capture must exist by then.
	let firstTokenMs: number | null = null;
	const uiStream = toUIMessageStream<ToolSet, UIMessage>({
		stream: result.stream,
		sendReasoning: true,
		...(deps.partial ? { originalMessages: [deps.partial] } : {}),
		generateMessageId: randomUUID,
		messageMetadata: ({ part }) => {
			if (
				firstTokenMs === null &&
				(part.type === "text-delta" ||
					part.type === "reasoning-delta" ||
					part.type === "tool-input-start" ||
					part.type === "tool-input-delta" ||
					part.type === "tool-call")
			) {
				firstTokenMs = Date.now() - deps.turnStartMs;
			}
			if (part.type !== "finish") return undefined;
			const forcedKind = state.forcedCompletion();
			return {
				model: modelLabel,
				finishReason: part.finishReason,
				durationMs: Date.now() - deps.turnStartMs,
				...(firstTokenMs !== null ? { ttftMs: firstTokenMs } : {}),
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
				...(turnQuota !== null ? { quota: turnQuota } : {}),
				...(deps.fallbackMisses !== undefined && deps.fallbackMisses.length > 0
					? {
							fallback: {
								from: deps.fallbackMisses.map(({ ref, reason }) => ({ ref, reason })),
							},
						}
					: {}),
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

	const toolCalls = events.toolCalls;
	const digestRing = events.digestRing;
	// Provider-executed calls (hosted web_search) ride the same wire
	// chunks but are not local actions — no journal rows, no retry
	// grants, no loop-detector evidence.
	const providerExecutedIds = new Set<string>();
	try {
		for await (const chunk of uiStream) {
			deps.assertAuthority();
			if (chunk.type === "error") {
				const overflow = isContextOverflow(chunk.errorText) || isContextOverflow(rawError);
				if (overflow && deps.overflowRecoverable) {
					holdForRecovery = true;
				}
				// A pre-empt signal surfacing as an error part: the next call
				// was stopped before dispatch — hold the rail for the fold-resume.
				if (rawError instanceof PreemptSignal && deps.overflowRecoverable) {
					holdForRecovery = true;
					preemptInfo = { arm: rawError.arm, step: rawError.stepNumber };
				}
			}
			if (
				chunk.type === "error" &&
				!holdForRecovery &&
				deps.holdZeroEffectError === true &&
				state.snapshot().modelCalls === 0
			) {
				errorHeld = true;
			} else if (!holdForRecovery) {
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
					if (chunk.providerExecuted === true) {
						providerExecutedIds.add(chunk.toolCallId);
						break;
					}
					noteToolInput(
						events,
						{
							convId,
							evidence,
							noteJournal: (callId, name, input) =>
								deps.journal?.noteToolInput(deps.runId, callId, name, input),
						},
						chunk.toolCallId,
						chunk.toolName,
						chunk.input,
					);
					break;
				case "tool-input-error":
					if (providerExecutedIds.has(chunk.toolCallId)) break;
					// tool-output-error carries only the id — the ledger keeps
					// name+input so the detector hashes a rejection under a
					// stable id instead of a random call id and never trips.
					noteToolInputRejected(
						events,
						{ convId },
						chunk.toolCallId,
						chunk.toolName,
						chunk.input,
						chunk.errorText,
					);
					break;
				case "tool-output-available":
					if (providerExecutedIds.has(chunk.toolCallId)) break;
					noteToolOutput(events, eventsDeps, chunk.toolCallId, chunk.output);
					break;
				case "tool-output-error":
					if (providerExecutedIds.has(chunk.toolCallId)) break;
					noteToolError(events, eventsDeps, chunk.toolCallId, chunk.errorText);
					break;
				case "error":
					pendingStep = false;
					streamError = chunk.errorText;
					break;
			}
		}
	} catch (err) {
		// A pre-empt signal may reject the iterator outright instead of
		// surfacing as an error part, depending on where the SDK catches the
		// prepareStep throw. Either surface lands on the same rail.
		if (err instanceof PreemptSignal && deps.overflowRecoverable) {
			holdForRecovery = true;
			preemptInfo = { arm: err.arm, step: err.stepNumber };
			streamError = err.message;
		} else {
			throw err;
		}
	}

	// The window record rides both outcome rails: an ok turn stores its
	// final step, a failed one its last completed step. Gated on
	// stepCount: a prompt built for a call that never completed a step
	// is not a window anything saw — steps: 0 must read null.
	const windowCapture = (): WindowCapture | null => {
		if (lastWindow === null || stepCount === 0) return null;
		return {
			v: 1,
			system: deps.step.system,
			tools: serializeToolDefs(deps.tools),
			messages: lastWindow.messages,
			segments: lastWindow.segments,
		};
	};

	deps.assertAuthority();
	if (streamError !== null) {
		return {
			kind: "failed",
			errorText: streamError,
			rawError,
			holdForRecovery,
			...(errorHeld ? { errorHeld: true } : {}),
			...(preemptInfo !== null ? { preempt: preemptInfo } : {}),
			partial: partialResponse as UIMessage | null,
			seenText,
			toolCalls,
			digestRing,
			loop: state.snapshot(),
			steerMark,
			filterRetryUsed,
			window: windowCapture(),
			model: modelLabel,
			steps: stepCount,
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
		window: windowCapture(),
		model: modelLabel,
		steps: stepCount,
	};
}
