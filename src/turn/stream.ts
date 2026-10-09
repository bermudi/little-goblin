// Stream — one attempt's wire (design/runtime-turn.md → phases 4–5).
// The driver wires streamText/toUIMessageStream, folds steering input,
// warnings, and forced landings into each request in prepareStep, runs
// the chunk loop with its fan-out and wire log, and captures the
// reviewer's evidence while the stream still exists. Callbacks mutate
// only attempt-scoped locals here or drive TurnState methods — never a
// local of the calling runtime — and recovery-carried values ride deps
// in, the outcome out (the doc's lifetime buckets).
//
// The membership seam (#96) lives here too: claiming a streaming
// member and replaying the wire to it is one mechanism with one home,
// used by both call sites — the steer fold (joinMember, behind its
// conversion gate) and the overflow resume claim (claimMembers,
// injected into admission by the runtime).

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
import { filterErrorStream } from "../agent/filter-stream.ts";
import {
	isContentFilter,
	isContextOverflow,
	ProviderContentFilterError,
} from "../agent/provider-errors.ts";
import { log } from "../log.ts";
import { summarize, toolOk, type EvidenceLimits, type ToolCallDigest } from "../reviewer.ts";
import type { AdmittedMember, LiveWire } from "./admission.ts";
import type { ForcedKind, LoopTurnState, TurnState } from "./state.ts";
import { convertSteeredMessage, type ViewContext } from "./view.ts";

// The forced step's instruction, per landing kind. User-role like the
// machinery's warnings (turn/state.ts): request-only, accepted by every
// provider.
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

// Provider capability warnings are observability, not control — logged
// compact, never fatal. Kept as strings so a warning object carrying a
// full tool definition can't bloat the log line. (Spec v4 collapsed the
// per-setting/per-tool variants into feature strings.)
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

// The terminal outcome as the wire's subscribers see it — the
// structural shape of runtime's TurnDone this module needs. Delivery
// (onDone, the doneSent guard) stays the runtime's contract.
export type WireEnd =
	| { kind: "completed" }
	| { kind: "fenced" }
	| { kind: "error"; message: string };

// A live turn's wire log + subscribers — the resumable-stream half of
// the app channel (design/app.md → Streaming members): every chunk the
// wire has seen, appended at the single emission point, plus HTTP
// subscribers attached mid-flight (GET .../stream — a reload, a second
// screen). One object per logical turn, carried across an overflow
// resume by TurnRecovery.
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

// Fire each subscriber's onEnd exactly once and retire the log. The
// turn's outcome rides along — an attach stream needs the same terminal
// semantics a member sink gets (an error event on a non-completed
// outcome, then [DONE]).
export function endLive(live: LiveChunks, done: WireEnd): void {
	if (live.ended) return;
	live.ended = true;
	for (const sub of live.subscribers) {
		try {
			sub.onEnd(done);
		} catch {
			// The SSE writer self-guards; nothing to do.
		}
	}
	live.subscribers.clear();
}

// ---------- the membership seam (#96) ----------

// A turn member as the wire sees it: the streaming hook plus the
// detach flag. Runtime's QueuedTurn satisfies this structurally; the
// driver never sees onDone or the queue.
export interface WireMember extends AdmittedMember {
	// Set when this member's onStreamChunk threw — it is detached from
	// the fan-out; one dead client must not kill the turn for the rest.
	streamFailed?: boolean;
}

// A claimed submit this attempt cannot carry — the exactly-once
// terminal signal the runtime delivers on the driver's behalf.
// Structural subset of TurnDone: only the outcomes a drop takes.
export type MemberSettlement = { kind: "fenced" } | { kind: "error"; message: string };

// The replay half of the seam: a streaming member that joined late —
// claimed by a resume, or steered in mid-turn — sees the whole wire so
// far, not from mid-sentence. Sync code: nothing interleaves with the
// replay. A dead client is detached, not fatal.
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

// Model chunks and synthetic completion text share the same wire: a dead
// streaming client detaches without changing the turn's outcome.
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
			// The SSE writer self-guards; a throwing subscriber is
			// dead weight until the turn ends.
			live.subscribers.delete(sub);
			log.warn("subscriber onChunk failed — stream detached", err, {
				conversation: convId,
			});
		}
	}
}

// The claim shape — the overflow resume claim. Claiming a streaming
// member and replaying the wire to it is one operation with one home
// here, so a join window can never forget the replay (#96: a client
// submitting during the recovery window used to see the resumed answer
// only from mid-sentence). Registering into `members` is part of the
// claim too: a claimed member must sit on the attempt's settlement
// surface (notifyAll, the drain crash guard — both walk that list)
// from the splice itself, or an admission failure between claim and
// snapshot — a store read throwing — orphans it with its onDone never
// firing (#114). The queue splice itself is injected — queue policy
// (claimableCount) never leaves runtime.ts.
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

// The join shape — the steer fold's success path. Membership and
// replay are one step: a converted submit joins the member list and
// sees the wire so far; a submit that cannot convert joins nothing
// (the caller settles its delivery).
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

// The delivery hooks the chunk loop drives on the turn's head member —
// Telegram display (deltas, tool status). Runtime's TurnSink satisfies
// this structurally; raw chunk pass-through rides WireMember instead.
export interface DisplaySink {
	onTextDelta(delta: string): void;
	onReasoningDelta(delta: string): void;
	onToolCall(toolName: string, input: unknown): void;
}

// The model call as the driver sees it — runtime's ModelStep satisfies
// this structurally (label, context window, provider options).
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
	// The turn's delivery head (the first member) plus the membership
	// itself — mutated in place when a steer joins, so the runtime's
	// notifyAll and crash guard keep seeing every member.
	head: DisplaySink;
	members: M[];
	// The logical turn's wire log (openLive at the turn's start, carried
	// across an overflow resume).
	live: LiveChunks;
	// The attempt's loop machinery (turn/state.ts): landings, warnings,
	// the detector. Callbacks call methods; nothing reaches around them.
	state: TurnState;
	// The authority rule's two arrangements for this module: the
	// throwing check around every await, and the non-throwing compares
	// prepareStep uses on its way out (a fenced steer goes back to the
	// queue, never thrown — a thrown prepareStep fails the stream as an
	// error instead of a fence).
	assertAuthority(): void;
	holdsAuthority(): boolean;
	step: StreamStep;
	messages: ModelMessage[];
	tools: ToolSet;
	// The steer fold converts through the attempt's view gates
	// (turn/view.ts) so a steered message materializes exactly as it
	// would have in the next turn's view.
	view: ViewContext;
	// The membership seam's runtime half: the queue splice (injected —
	// policy never leaves runtime.ts), the fenced claim's way back into
	// the queue, and the settlement for a claimed submit that cannot
	// join.
	claimSteers(): M[];
	unrequeueSteers(steered: M[]): void;
	settle(m: M, done: MemberSettlement): void;
	modelEntries(): { seq: number; message: UIMessage }[];
	steerMarkSeed: number;
	// Recovery-carried inputs (the doc's whitelist): a resume continues
	// the partial as one message, inherits the display seam's seenText,
	// the reviewer's gate state, and the filter retry budget.
	partial: UIMessage | null;
	seenText: boolean;
	toolCalls: string[];
	digest: { id: string; entry: ToolCallDigest }[];
	filterRetryUsed: boolean;
	// True only on a first attempt with compaction wired: an overflow
	// then holds its failure off the wire for a compact-and-resume.
	overflowRecoverable: boolean;
	// Reviewer evidence capture — undefined = the feature is off, zero
	// cost.
	evidence: EvidenceLimits | undefined;
	// The logical turn's clock — finish metadata durationMs.
	turnStartMs: number;
	// The abort handle — the runtime pins it on the lane; /stop pulls
	// it.
	signal: AbortSignal;
}

// The attempt's output. `ok` hands the finish phase its inputs; the
// runtime translates `failed` into the throws its rails know (the
// ContextOverflowError for a held failure, a plain Error otherwise).
export type StreamOutcome =
	| {
			kind: "ok";
			// Null only if the stream ended with neither a finish nor an
			// error — unreachable in practice, honest in the type.
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
			// The raw provider error behind the stream's error chunk — the
			// overflow classifier needs the body/cause chain too.
			rawError: unknown;
			// The overflow handoff: what a resume continues.
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
	// The last step's input is the fullest prompt this turn sent —
	// the honest numerator for window utilization.
	let lastStepInputTokens: number | null = null;
	// The raw provider error behind the stream's `error` chunk —
	// the chunk carries only the serialized message, and the
	// overflow classifier needs the body/cause chain too.
	let rawError: unknown = null;
	let filterRetryPending = false;
	let filterRetryUsed = deps.filterRetryUsed;
	// The ownership high-water mark — seeded at admission, advanced by
	// claimed steers below (by identity, never position).
	let steerMark = deps.steerMarkSeed;
	const result = streamText({
		model: filterErrorStream(deps.step.model, convId),
		// `instructions` is the v7 primary; the internal ModelStep keeps
		// its own `system` field name — the seam stays one property deep.
		instructions: deps.step.system,
		messages: deps.messages,
		tools: deps.tools,
		// Steering (DESIGN.md, Turn): prepareStep runs before every
		// model call inside the tool loop — including the first, so a
		// submit landing during the turn's startup (recall, attachments)
		// steers in too. Submits that arrived while this turn runs sit
		// in the lane queue; each boundary folds them into the next
		// request as an appended tail. Prefix bytes are untouched, so
		// the provider cache stays warm (DESIGN.md, Cache stability),
		// and the override carries forward to later steps.
		prepareStep: async ({ messages: stepMessages, steps, stepNumber }) => {
			// The context landing (design/model.md): the previous step's
			// reported input at the fill line makes THIS step the tools-off
			// landing — the physical bound on a turn, since an overflow
			// resume can't compact the in-flight reply.
			const prevInput = steps.at(-1)?.usage.inputTokens;
			state.noteContextLanding(prevInput, deps.step.contextWindow);
			// A cut is the tools-off landing: lock toolChoice to none,
			// append the kind's nudge, and let stopWhen end the loop after
			// exactly this one step. The cut logs once, where the landing
			// fires.
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
			// Warnings issued since the last boundary append once — the
			// override carries forward, so a warning rides exactly one
			// request per attempt.
			const warnMsgs: ModelMessage[] = state
				.drainWarnings()
				.map((content): ModelMessage => ({ role: "user", content }));
			const nudge: ModelMessage[] = cut !== null ? [{ role: "user", content: CUT_NUDGE[cut] }] : [];
			// Steering folds pending submits into the live request —
			// but a headless head (no onStreamChunk) must not absorb
			// a streaming submit; it stays queued to head its own
			// turn (claimableCount, bound into the injected claim).
			const steered = deps.claimSteers();
			if (steered.length === 0) {
				return forced || warnMsgs.length > 0
					? {
							messages: [...stepMessages, ...warnMsgs, ...nudge],
							...(forced ? { toolChoice: "none" as const } : {}),
						}
					: undefined;
			}
			if (!deps.holdsAuthority()) {
				// Fenced on the way out (/stop bumped the epoch): put the
				// input back — stop() owns the queue and drops it. Never
				// throw here: a thrown prepareStep fails the stream as an
				// error instead of a fence.
				deps.unrequeueSteers(steered);
				return undefined;
			}
			const injected: ModelMessage[] = [];
			const claimedIds = new Set<string>();
			let admittedCount = 0;
			for (const t of steered) {
				try {
					// Same treatment as the admission snapshot: media
					// materializes against this turn's model or degrades
					// to a path reference.
					const converted = await convertSteeredMessage(deps.view, t.message);
					// The conversion awaited, so authority is re-checked before
					// its side effects — joining, wire replay, and folding the
					// content into a request the epoch already killed (#115).
					// Settled fenced like the failure branch, never requeued:
					// the splice already moved this submit out of stop()'s
					// reach, so putting it back would resurrect dropped input.
					if (!deps.holdsAuthority()) {
						deps.settle(t, { kind: "fenced" });
						continue;
					}
					injected.push(...converted);
					joinMember(convId, live, members, t);
					claimedIds.add(t.message.id);
					admittedCount++;
				} catch (err) {
					// A fence landing mid-conversion (/stop or a settings toggle
					// bumping the epoch during the materialize await) is not a
					// preparation failure — reporting "could not be prepared"
					// for a message the operator deliberately stopped would be
					// a mislabel. The fenced verdict is the honest one.
					if (!deps.holdsAuthority()) {
						deps.settle(t, { kind: "fenced" });
						continue;
					}
					// The message is durable history but this turn cannot
					// carry it. Error that submit's own delivery — never
					// requeue: the message would sit in history and fail
					// every successor turn's admission conversion the same
					// way, a poison pill. Later model views degrade it to a
					// placeholder at the admission boundary (the view
					// builder's conversion), so the conversation stays
					// answerable.
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
			// A claimed steer whose every conversion failed (the poison-pill
			// path) must not eat the forced landing: forcedKind is already
			// set and this is the landing's only shot (review 2026-10-07, m1).
			if (injected.length === 0) {
				return forced || warnMsgs.length > 0
					? {
							messages: [...stepMessages, ...warnMsgs, ...nudge],
							...(forced ? { toolChoice: "none" as const } : {}),
						}
					: undefined;
			}
			// Advance the ownership mark by identity, not position. The
			// lane is serial but the queue is not this turn's: a submit
			// landing mid-conversion sits pending (never spliced), and a
			// failed steer is dropped above — neither may anchor this
			// reply (DESIGN.md, causal view).
			for (const e of deps.modelEntries()) {
				if (e.seq > steerMark && claimedIds.has(e.message.id)) steerMark = e.seq;
			}
			log.info("steered into turn", {
				conversation: convId,
				submits: admittedCount,
				step: stepNumber,
			});
			return {
				messages: [...stepMessages, ...warnMsgs, ...injected, ...nudge],
				...(forced ? { toolChoice: "none" as const } : {}),
			};
		},
		...(deps.step.providerOptions ? { providerOptions: deps.step.providerOptions } : {}),
		// No step count: the loop runs until the model stops calling
		// tools (isLoopFinished never trips) or a landing was issued —
		// the forced tools-off step is exactly one step even if a
		// provider defies toolChoice none.
		stopWhen: [isLoopFinished(), () => state.isLandingIssued()],
		abortSignal: deps.signal,
		// Opt into callback-directed step retries, not blanket retries.
		// The SDK buffers tool parts until the attempt ends cleanly;
		// completed prior steps/results remain in the identical prompt.
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
			// Kept for classification: the ui stream's error chunk
			// carries only the message string, but the overflow check
			// needs the provider's body/cause chain too.
			rawError = error;
			log.error("model stream error", error, { conversation: convId });
		},
		onStepEnd: ({ usage, finishReason }) => {
			if (filterRetryPending && finishReason !== "error") {
				filterRetryPending = false;
				log.info("provider content filter retry recovered", {
					conversation: convId,
					epoch,
				});
			}
			lastStepInputTokens = usage.inputTokens ?? null;
			// The cached split is how cache health is read off the log:
			// null means the provider didn't report it, 0 means
			// reported-and-cold. inputTokens includes the cached ones.
			// Spec v4 splits reads from writes — Anthropic-style caches
			// bill both; read-only caches (OpenRouter, openai-compatible)
			// leave write null.
			log.info("model step usage", {
				conversation: convId,
				inputTokens: usage.inputTokens ?? null,
				cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
				cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? null,
				outputTokens: usage.outputTokens ?? null,
			});
		},
	});

	// The SDK hands provider capability warnings back on the result —
	// previously the one fail-quiet seam in the model path: an ignored
	// setting or an inexpressible tool vanished. Observability only;
	// the turn proceeds regardless. (v7 exposes result promises as
	// bare PromiseLikes — Promise.resolve buys back .catch.)
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
			// An aborted stream's warnings promise rejects with it —
			// expected on /stop, not worth a warn line.
			log.debug("model warnings unavailable", {
				conversation: convId,
				error: String(err),
			});
		});

	let responseMessage: UIMessage | null = null;
	// The failed attempt's accumulated reply — stashed on a failed
	// finish so an overflow recovery can continue it as the same
	// message instead of starting the answer over.
	let partialResponse: UIMessage | null = null;
	// Every tool call this turn, in order — the reviewer's gate
	// state (count + names) and its fallback rule read this. A
	// resume inherits the failed attempt's: the gate sees the
	// whole turn.
	const toolCalls: string[] = [...deps.toolCalls];
	// Reviewer evidence, captured while the stream still exists: the
	// last `evidence.calls` calls with truncated args/result/status.
	// Ring order = call order; an entry whose result never arrives
	// (stream ended) reads "(no result)".
	const evidence = deps.evidence;
	const digestRing: { id: string; entry: ToolCallDigest }[] = [...deps.digest];
	// Block-boundary tracking for the live stream: last text part id
	// within a step, plus whether any text has streamed at all (see
	// the text-delta and start-step cases). A resume inherits the
	// failed attempt's flag so a continued text block doesn't get a
	// phantom "\n\n" before its first delta.
	let lastTextPartId: string | null = null;
	let seenText = deps.seenText;
	// Stream errors arrive as `error` chunks — they don't throw. The
	// authoritative signal is the finish outcome: "failed" means the
	// turn must surface an error, not commit partial output as a
	// clean completion.
	let streamError: string | null = null;
	// Set when the stream died on a classified context overflow and
	// a compact-and-resume can still run: the failed attempt's error
	// — and every chunk after it — stays off the client's stream
	// because the resumed attempt continues the same message.
	let holdForRecovery = false;
	const uiStream = toUIMessageStream<ToolSet, UIMessage>({
		stream: result.stream,
		sendReasoning: true,
		// Continuing a partial: the SDK seeds the response message
		// from the last assistant original — its id, its parts — so
		// the resumed stream's chunks merge into ONE message, and the
		// start chunk carries the id the client already saw.
		...(deps.partial ? { originalMessages: [deps.partial] } : {}),
		// Retention keys documents and source refs to the assistant
		// message identity — without a generator the SDK leaves it
		// blank, so every completed turn mints one here.
		generateMessageId: randomUUID,
		// Finish metadata lands on the wire finish chunk AND the
		// stored response message — the app client reads live
		// stats and history reloads carry the same numbers.
		messageMetadata: ({ part }) => {
			if (part.type !== "finish") return undefined;
			// Forced landings stamp themselves — the operator's UI must
			// never present a forced answer as natural (design/model.md).
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
				},
			};
		},
		// The default serializer emits "An error occurred." — meant
		// for public HTTP clients. This stream feeds the operator's
		// own chat; the real message is what they need.
		onError: (error) =>
			isContentFilter(error)
				? "Provider blocked this request again after one retry."
				: error instanceof Error
					? error.message
					: String(error),
		onFinish: ({ responseMessage: rm, isAborted, outcome }) => {
			if (isAborted) return;
			if (outcome.status === "failed") {
				// rm is the accumulated message even on failure (the
				// SDK ends the stream with its state) — the overflow
				// recovery continues exactly this reply.
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

	// call id → {tool, input}: output/error chunks carry only the
	// id — the failure line needs the name, and the repeat detector
	// and watchdog ring need the input back.
	const callById = new Map<string, { tool: string; input: unknown }>();
	// One completed tool call feeds the loop machinery. The id→call
	// lookup (name + input for the detector and the ring) stays here
	// with callById; verdicts, ring growth, and the watchdog cadence
	// are TurnState's.
	const noteCompletedCall = (toolCallId: string, result: unknown, failed: boolean): void => {
		const call = callById.get(toolCallId);
		state.noteCompletedCall(call?.tool ?? toolCallId, call?.input, result, failed);
	};
	for await (const chunk of uiStream) {
		deps.assertAuthority();
		if (chunk.type === "error") {
			// A classified overflow on an attempt that may still
			// recover (first attempt, compaction wired): hold the
			// failure off the wire. The resumed stream continues the
			// same message, so an error event now would lie — and if
			// recovery later gives up, onDone reports it.
			const overflow = isContextOverflow(chunk.errorText) || isContextOverflow(rawError);
			if (overflow && deps.overflowRecoverable) {
				holdForRecovery = true;
			}
		}
		// The app channel's sinks ride the raw stream — each chunk is
		// serialized to the SSE wire verbatim (DESIGN.md, App channel).
		// Fan-out: every streaming member receives it (audit #4 — a
		// second client's stream used to run dry), a throwing sink is
		// detached rather than allowed to kill the turn, and the wire
		// log records exactly what the wire saw for late joiners and
		// resumers. The fence above is the app stream's back-pressure-
		// free cut: a fenced turn stops streaming to the client too. A
		// held failure takes its error chunk — and everything after —
		// with it.
		if (!holdForRecovery) {
			emitChunk(convId, members, live, chunk);
		}
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
				if (evidence !== undefined) {
					digestRing.push({
						id: chunk.toolCallId,
						entry: {
							tool: chunk.toolName,
							args: summarize(chunk.input, evidence.argChars),
							result: "(no result)",
							// A result that never arrives (cut stream) stays neutral.
							ok: true,
						},
					});
					if (digestRing.length > evidence.calls) digestRing.shift();
				}
				// Side-effecting boundary — the chat shows a status
				// line, the log gets the durable record. Args are
				// truncated metadata, not payloads.
				log.info("tool call", {
					conversation: convId,
					tool: chunk.toolName,
					arg: JSON.stringify(chunk.input).slice(0, 200),
				});
				break;
			case "tool-input-error":
				// A schema-rejected call never executes, so the "tool
				// call" line never fires — and without this case the
				// only trace of a provider that cannot fill a schema is
				// the model's own complaints. Mail went dark for two
				// days exactly like that (Sep 28).
				// Its output still arrives as tool-output-error carrying
				// only the id — record name+input here or the detector
				// hashes each rejection under its random call id and
				// never trips.
				callById.set(chunk.toolCallId, { tool: chunk.toolName, input: chunk.input });
				log.warn("tool call rejected", {
					conversation: convId,
					tool: chunk.toolName,
					arg: JSON.stringify(chunk.input ?? null).slice(0, 200),
					error: chunk.errorText.slice(0, 300),
				});
				break;
			case "tool-output-available":
				// Reviewer evidence: what the call actually returned.
				if (evidence !== undefined) {
					for (let i = digestRing.length - 1; i >= 0; i--) {
						if (digestRing[i]!.id !== chunk.toolCallId) continue;
						digestRing[i]!.entry.result = summarize(chunk.output, evidence.outChars);
						digestRing[i]!.entry.ok = toolOk(chunk.output);
						break;
					}
				}
				noteCompletedCall(chunk.toolCallId, chunk.output, false);
				break;
			case "tool-output-error":
				// A throw out of execute surfaces to the model as a
				// retryable error and to nobody else — without this line
				// it only lives in the reviewer's evidence ring, when
				// one is open at all.
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
			// (const alias — partialResponse is only assigned inside the
			// stream's onFinish callback, which flow analysis can't see,
			// so here it still narrows as never-assigned null; the cast
			// restores the declared union.)
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
		// Totals are observability, not control — but a dropped usage
		// promise must be visible, not a silent null on the log line.
		log.warn("turn usage unavailable — totals skipped", err, {
			conversation: convId,
		});
		return null;
	});
	// The stop reason is a signal, not noise: "length" means the
	// reply was cut off mid-flight, "content-filter" that the
	// provider withheld it.
	const finishReason = await Promise.resolve(result.finishReason).catch((err) => {
		log.warn("turn finish reason unavailable", err, {
			conversation: convId,
		});
		return null;
	});
	// The last await before control returns to the finish phase's
	// history write — a /stop landing while usage settles must not
	// deliver an unstamped reply into history.
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
