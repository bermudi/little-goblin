// Compaction: history is unbounded on disk, bounded in the window by
// pointer relocation.

import type { UIMessage } from "ai";
import { log } from "../log.ts";
import type { CompactionSplit } from "../conversation-events.ts";
import { withoutReasoningCipher } from "./codex/replay-state.ts";
import { exhaustedMessage, type FallbackMiss, failureClass, missReason } from "./model-fallback.ts";
import {
	AUDIT_RETRIES,
	auditSummary,
	composeSummary,
	correctiveInstruction,
	extractIdentifiers,
	mergeCodeMade,
	operatorText,
	parseSummary,
	SUMMARY_SYSTEM,
} from "./compaction-summary.ts";
import { isTransientTurnFailure } from "./provider-errors.ts";

// Rough chars-per-token for mixed chat text — enough to pick a cut; the
// real number lands in the next turn's utilization log line.
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// Serialized-size estimate for budgeting — one exclusion: the codex
// namespace's reasoningEncryptedContent is opaque provider state, not
// visible content, so its bulk must not count toward the fold decision
// (a cipher-heavy turn would otherwise compact in a storm of its own
// state). Every other byte counts exactly as before.
export function estimateMessageTokens(message: UIMessage): number {
	return estimateTokens(JSON.stringify(withoutReasoningCipher(message)));
}

// Part-level twin of estimateMessageTokens (#403): the same formula —
// serialized size /4 with the codex cipher stripped — so the split walk
// counts a reply's parts exactly as whole-event estimates counted the
// message they belong to.
export function estimatePartTokens(part: UIMessage["parts"][number]): number {
	return estimateTokens(JSON.stringify(withoutReasoningCipher(part)));
}

export interface CompactionEvent {
	seq: number;
	anchorSeq: number | null;
	message: UIMessage;
}

export interface CompactionStore {
	historyDetail(id: string): CompactionEvent[];
	getCompaction(id: string): { boundarySeq: number; summary: string; split: CompactionSplit | null } | null;
	setCompaction(
		id: string,
		compaction: {
			boundarySeq: number;
			summary: string;
			tokensBefore: number;
			model: string;
			createdAt: string;
			// Events left unfolded at fold time — the mark's "kept the
			// last N" is recorded, never recomputed.
			tailEvents: number;
			// #403: set when this row halves one event (see splitBoundary).
			split?: CompactionSplit | null;
		},
	): void;
}

// A cut after detail[i] is exchange-complete when nothing later anchors
// at or before it — no response is orphaned from its user message. The
// model view cuts on the same key, `(anchorSeq ?? seq) > boundarySeq` —
// keep them in sync. Consequence for whole-event cuts: an interleaved
// burst (operator messages arriving mid-turn) coarsens to whole bursts
// rather than splitting them. The #403 split is the one sanctioned
// exception — it halves the burst's own reply at a step edge, never the
// user events.
function exchangeComplete(detail: CompactionEvent[], boundaryIndex: number): boolean {
	const boundary = detail[boundaryIndex]!.seq;
	for (let j = boundaryIndex + 1; j < detail.length; j++) {
		const e = detail[j]!;
		if ((e.anchorSeq ?? e.seq) <= boundary) return false;
	}
	return true;
}

// Keep a tail whose estimated tokens fit the budget, extending backward
// exchange-by-exchange. Returns the boundary seq (the last compacted
// event's seq) or null when nothing is worth compacting — a span must
// exist beyond the previous boundary and carry ≥ minSpanTokens
// (compacting a few messages into a summary buys nothing).
//
// beforeSeq is an exclusive ceiling marking where completed history ends:
// events at or after it belong to an exchange whose reply has not landed
// (a running turn's stored user event, or inputs queued behind it) and are
// never foldable. Without the ceiling such events inflate the tail walk
// and can push the boundary ONTO the running exchange — the reply then
// lands anchored at or below the boundary and modelEntries cuts it from
// every later request, unseen by the summary that replaced its context.
// The chosen cut: the boundary plus, for a split turn, the second
// pointer naming the one half-folded event (#403).
export interface BoundaryChoice {
	boundarySeq: number;
	split: CompactionSplit | null;
}

export interface ChooseBoundaryOpts {
	tailTokenBudget: number;
	previousBoundary: number | null;
	// The previous row's split pointer when it was a split row: a
	// re-compaction at the same boundary must move the part forward.
	previousSplit?: CompactionSplit | null;
	minSpanTokens?: number;
	beforeSeq?: number | null;
}

// Keep a tail whose estimated tokens fit the budget, extending backward
// exchange-by-exchange. Returns the boundary (the last compacted event's
// seq) plus an optional split pointer, or null when nothing is worth
// compacting — a span must exist beyond the previous boundary and carry
// ≥ minSpanTokens (compacting a few messages into a summary buys nothing).
//
// beforeSeq is an exclusive ceiling marking where completed history ends:
// events at or after it belong to an exchange whose reply has not landed
// (a running turn's stored user event, or inputs queued behind it) and are
// never foldable — whole or split. Without the ceiling such events inflate
// the tail walk and can push the boundary ONTO the running exchange — the
// reply then lands anchored at or below the boundary and modelEntries cuts
// it from every later request, unseen by the summary that replaced its
// context.
export function chooseBoundary(
	detail: CompactionEvent[],
	opts: ChooseBoundaryOpts,
): BoundaryChoice | null {
	if (opts.beforeSeq !== null && opts.beforeSeq !== undefined) {
		detail = detail.filter((e) => e.seq < opts.beforeSeq!);
	}
	if (detail.length < 2) return null;
	// Grow the tail backward while it fits; each step re-checks exchange
	// completeness, so an anchored response pulls its user message into
	// the tail rather than being stranded.
	let i = detail.length - 1;
	let tailTokens = estimateMessageTokens(detail[i]!.message);
	// Last complete cut whose tail fit the budget — the fallback when the
	// walk's own cut folds nothing: one oversized exchange pulled whole
	// into the tail lands the cut on the previous boundary, and a huge
	// conversation reports "nothing worth compacting".
	let fitStart: number | null = null;
	while (i > 0) {
		const boundaryIndex = i - 1;
		if (!exchangeComplete(detail, boundaryIndex)) {
			i = boundaryIndex;
			tailTokens += estimateMessageTokens(detail[boundaryIndex]!.message);
			continue;
		}
		if (tailTokens <= opts.tailTokenBudget) fitStart = i;
		if (tailTokens >= opts.tailTokenBudget) break;
		if (opts.previousBoundary !== null && detail[boundaryIndex]!.seq <= opts.previousBoundary)
			break;
		i = boundaryIndex;
		tailTokens += estimateMessageTokens(detail[boundaryIndex]!.message);
	}
	const cut = cutAt(detail, i - 1, opts);
	// The #399 fallback: retry the cut at the last fitting position. Its
	// tail fits the budget by construction, so the head exchange cannot
	// need splitting when this fires.
	const fallback =
		cut === null && fitStart !== null && tailTokens > opts.tailTokenBudget
			? cutAt(detail, fitStart - 1, opts)
			: null;
	// #403: whole-exchange cuts leave one oversized turn riding verbatim
	// in the tail no matter where the boundary lands — it can never fold.
	// When the tail's head exchange alone exceeds the budget, split it:
	// fold through its trigger, half-fold its reply at a step edge.
	if (fallback === null) {
		const split = splitBoundary(detail, i, opts);
		if (split !== null) return split;
	}
	const base = cut !== null ? cut : fallback;
	return base === null ? null : { boundarySeq: base, split: null };
}

// The #403 split candidate. headStart is the walk's break position — the
// trigger of the tail's head exchange. boundary_seq becomes the trigger's
// own causal position (the trigger, any app media anchored beside it, and
// everything earlier fold whole); the exchange's reply event is cut at a
// step-start edge — parts [0, part) fold into the summary, [part, end)
// stay verbatim in the tail. Cuts sit only on step edges, never inside a
// step, so a codex reasoning item keeps replaying ahead of its tool call.
// No valid edge, no oversized exchange, or no forward progress over the
// previous row → null, and the caller keeps today's whole-event result.
function splitBoundary(
	detail: CompactionEvent[],
	headStart: number,
	opts: ChooseBoundaryOpts,
): BoundaryChoice | null {
	const trigger = detail[headStart]!;
	// Only an unanchored user event heads an exchange; anything else is a
	// loose end (a trailing unanswered question, malformed order) — leave
	// it whole.
	if (trigger.message.role !== "user" || trigger.anchorSeq !== null) return null;
	// Exchange members: everything anchored to the trigger. Mid-turn
	// steers are their own user events (unanchored) and stay in the tail.
	let end = headStart;
	while (end + 1 < detail.length && detail[end + 1]!.anchorSeq === trigger.seq) end++;
	let exchangeTokens = 0;
	for (let j = headStart; j <= end; j++) {
		exchangeTokens += estimateMessageTokens(detail[j]!.message);
	}
	if (exchangeTokens <= opts.tailTokenBudget) return null;
	// The reply to split: the exchange's anchored assistant event that is
	// not app media (app media folds whole with the trigger); most parts
	// wins if several could claim the name.
	let reply: CompactionEvent | null = null;
	let replyParts = -1;
	for (let j = headStart + 1; j <= end; j++) {
		const e = detail[j]!;
		if (e.message.role !== "assistant") continue;
		if (e.message.parts[0]?.type === "data-attachment") continue;
		if (e.message.parts.length > replyParts) {
			reply = e;
			replyParts = e.message.parts.length;
		}
	}
	if (reply === null) return null;
	const parts = reply.message.parts;
	const stepStarts: number[] = [];
	for (let p = 1; p < parts.length; p++) {
		if ((parts[p] as { type: string }).type === "step-start") stepStarts.push(p);
	}
	if (stepStarts.length === 0) return null;
	// The suffix must fit beside everything kept after it — steers and
	// later exchanges — measured with the same part-level estimate.
	let newerTokens = 0;
	for (let j = end + 1; j < detail.length; j++) {
		newerTokens += estimateMessageTokens(detail[j]!.message);
	}
	const suffixTokens = (part: number): number => {
		let tokens = 0;
		for (let p = part; p < parts.length; p++) tokens += estimatePartTokens(parts[p]!);
		return tokens;
	};
	// Forward progress: a re-split of the same event must fold strictly
	// more than the previous row did — a larger part index.
	const resplit =
		opts.previousBoundary === trigger.seq && opts.previousSplit?.seq === reply.seq;
	const candidates = resplit ? stepStarts.filter((p) => p > opts.previousSplit!.part) : stepStarts;
	if (candidates.length === 0) return null;
	// Smallest edge whose suffix fits — the least prefix folded that
	// brings the tail under budget. If even the last step's suffix is
	// over, keep the last step-start anyway: maximum folding while the
	// final step stays verbatim.
	const part =
		candidates.find((p) => suffixTokens(p) + newerTokens <= opts.tailTokenBudget) ??
		candidates[candidates.length - 1]!;
	// The guards every cut passes. The boundary must advance past the
	// previous row (the equal case is the re-split handled above); the
	// folded span — events through the trigger plus the folded prefix —
	// clears the floor, counting the whole prefix including parts a
	// previous split already folded.
	if (opts.previousBoundary !== null && trigger.seq <= opts.previousBoundary && !resplit) {
		return null;
	}
	const spanStart =
		opts.previousBoundary === null
			? 0
			: detail.findIndex((e) => e.seq === opts.previousBoundary) + 1;
	const replyIndex = detail.findIndex((e) => e.seq === reply.seq);
	let spanTokens = 0;
	for (let j = spanStart; j < replyIndex; j++) {
		spanTokens += estimateMessageTokens(detail[j]!.message);
	}
	for (let p = 0; p < part; p++) spanTokens += estimatePartTokens(parts[p]!);
	if (spanTokens < (opts.minSpanTokens ?? 500)) return null;
	return { boundarySeq: trigger.seq, split: { seq: reply.seq, part } };
}

function cutAt(
	detail: CompactionEvent[],
	boundaryIndex: number,
	opts: { previousBoundary: number | null; minSpanTokens?: number },
): number | null {
	if (boundaryIndex < 0) return null;
	const boundary = detail[boundaryIndex]!.seq;
	if (opts.previousBoundary !== null && boundary <= opts.previousBoundary) return null;
	// The floor gates the delta since the previous boundary — counting
	// from index 0 would fold already-compacted bulk into it and let a
	// tiny delta through on old conversations. An unfound previous
	// boundary falls back to 0, matching runCompaction's spanStart.
	const spanStart =
		opts.previousBoundary === null
			? 0
			: detail.findIndex((e) => e.seq === opts.previousBoundary) + 1;
	let spanTokens = 0;
	for (let j = spanStart; j <= boundaryIndex; j++) {
		spanTokens += estimateMessageTokens(detail[j]!.message);
	}
	if (spanTokens < (opts.minSpanTokens ?? 500)) return null;
	return boundary;
}

// ---------- summarizer prompt ----------

// Shared with history_search's context action — reading back a folded
// span must return the tool evidence the fold took.
export function renderEventText(message: UIMessage): string {
	const parts: string[] = [];
	const brief = (value: unknown): string => {
		if (value === undefined) return "(not recorded)";
		const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
		return text.length > 8_000 ? `${text.slice(0, 8_000)}… [truncated]` : text;
	};
	for (const p of message.parts) {
		const part = p as {
			type: string;
			text?: string;
			data?: unknown;
			input?: unknown;
			output?: unknown;
			errorText?: unknown;
		};
		if (part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		} else if (part.type === "data-attachment") {
			const data = part.data;
			const ref =
				typeof data === "object" && data !== null
					? (data as { path?: unknown; filename?: unknown; transcript?: unknown })
					: null;
			const path =
				typeof ref?.path === "string"
					? ref.path
					: typeof ref?.filename === "string"
						? ref.filename
						: "unnamed";
			// A stored transcript is durable operator speech — already
			// paid for at intake — so the fold keeps it next to the path.
			// Media bytes never ride — text only.
			parts.push(
				typeof ref?.transcript === "string"
					? `[attachment: ${path} — transcript: ${JSON.stringify(ref.transcript)}]`
					: `[attachment: ${path}]`,
			);
		} else if (part.type.startsWith("tool-")) {
			// Bounded evidence of what the tool did — naming it alone
			// loses the command and result after the cut.
			parts.push(
				`[${part.type}]\ninput: ${brief(part.input)}\n` +
					`result: ${brief(part.output ?? part.errorText)}`,
			);
		}
	}
	return parts.join("\n").trim();
}

export function serializeEvent(e: CompactionEvent): string {
	return `${e.message.role === "assistant" ? "goblin" : e.message.role}: ${renderEventText(e.message)}`;
}

export function serializeSpan(detail: CompactionEvent[]): string {
	return detail.map(serializeEvent).join("\n\n");
}

// ---------- orchestration ----------

export type CompactionOutcome =
	| {
			kind: "compacted";
			boundarySeq: number;
			eventsCompacted: number;
			tokensBefore: number;
			tailEvents: number;
			summary: string;
	  }
	| { kind: "noop"; reason: string };

// Per summary call — long enough for a large chunk on a slow endpoint;
// a wedged request must settle so it can't hold the conversation's lane
// forever.
export const SUMMARY_CALL_TIMEOUT_MS = 180_000;

// One summary call on one candidate. Its timeout is the attempt's own —
// the parent signal is never pre-armed with it, so a wedged candidate
// times out alone and the next one starts with a live signal. Combined
// signal AND raced await: a summarizer that ignores its abort still
// settles.
async function attemptSummary(
	summarize: Summarize,
	prompt: string,
	model: string,
	signal: AbortSignal,
	callTimeoutMs: number,
	chunk: number,
): Promise<string> {
	const callSignal = AbortSignal.any([signal, AbortSignal.timeout(callTimeoutMs)]);
	let abortRace: (err: unknown) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		abortRace = reject;
	});
	const onAbort = () => abortRace(callSignal.reason);
	callSignal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([summarize(SUMMARY_SYSTEM, prompt, callSignal, model), aborted]);
	} catch (err) {
		if (signal.aborted) throw err;
		if (callSignal.aborted) {
			throw new Error(`summary call timed out after ${callTimeoutMs / 1000}s (chunk ${chunk})`);
		}
		throw err;
	} finally {
		callSignal.removeEventListener("abort", onAbort);
	}
}

export type Summarize = (
	system: string,
	prompt: string,
	signal: AbortSignal,
	model: string,
) => Promise<string>;

export type Flush = (spanText: string, signal: AbortSignal) => Promise<{ noteCalls: number }>;

// The flush sees one bounded slice of the span — the newest events, since a
// span bigger than one call already loses its head to the summary chunks
// alone. Abort propagates (a /stop cancels the fold too); any other failure,
// a timeout included, is a warning.
async function runFlush(
	id: string,
	flush: Flush,
	span: CompactionEvent[],
	inputTokenBudget: number,
	signal: AbortSignal,
	callTimeoutMs: number,
): Promise<void> {
	const full = serializeSpan(span);
	const keptChars = Math.max(inputTokenBudget * 4 - 4000, 4000);
	const text =
		full.length > keptChars
			? `[… ${full.length - keptChars} older chars omitted]\n${full.slice(-keptChars)}`
			: full;
	const callSignal = AbortSignal.any([signal, AbortSignal.timeout(callTimeoutMs)]);
	// Raced like attemptSummary: a flush that ignores its abort still settles.
	let abortRace: (err: unknown) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		abortRace = reject;
	});
	const onAbort = () => abortRace(callSignal.reason);
	callSignal.addEventListener("abort", onAbort, { once: true });
	try {
		const { noteCalls } = await Promise.race([flush(text, callSignal), aborted]);
		log.info("compaction flush", {
			conversation: id,
			events: span.length,
			chars: text.length,
			truncated: text !== full,
			noteCalls,
		});
	} catch (err) {
		if (signal.aborted) throw err;
		log.warn("compaction flush failed; folding anyway", {
			conversation: id,
			events: span.length,
			error: callSignal.aborted
				? `flush call timed out after ${callTimeoutMs / 1000}s`
				: err instanceof Error
					? err.message
					: String(err),
		});
	} finally {
		callSignal.removeEventListener("abort", onAbort);
	}
}

// The span folds through sequential calls bounded by inputTokenBudget —
// each carries the running summary forward, so the last call's output
// is the stored summary and no call sees the whole past.
//
// `models` is the summarizer's lane list (design/model.md → Model
// fallback list → Compaction): the conversation's model, then the
// operator's fallbacks. Every summary call is single, tools-off and
// non-streamed, so any non-abort throw — a per-attempt timeout
// included — is zero effect and advances. The walk is sticky within
// one pass: a candidate that failed a chunk is not retried on the
// next (a wedged primary would otherwise cost a full timeout per
// chunk). The stored pointer names the ref that wrote the final
// chunk. Exhausting the list propagates: the caller warns, the view
// stays untouched, and the next threshold crossing retries.
export async function runCompaction(
	id: string,
	store: CompactionStore,
	models: readonly string[],
	summarize: Summarize,
	opts: {
		tailTokenBudget: number;
		inputTokenBudget: number;
		callTimeoutMs?: number;
		reason?: "threshold" | "manual" | "overflow" | "preempt";
		// Exclusive fold ceiling over stored history, evaluated when history
		// is read (the lane may gain queued work while earlier awaits ran):
		// events at or after it — a running turn's members, inputs queued
		// behind them — have no landed reply and must never be folded.
		// Null (or absent) folds over the whole stored history.
		beforeSeq?: () => number | null;
		// The authority fence (wired from runtime.ts checkAuthority):
		// throws when the conversation's epoch advanced since this
		// compaction captured it. Checked before each chunk and right
		// before the pointer commits — a settings fence must land
		// exactly like the abort signal.
		assertAuthority?: () => void;
		// design/compaction.md → Memory flush: one tools-limited call that
		// may save durable facts from the span to notes before it folds.
		// The caller owns the gate; a failure warns and the fold goes on.
		flush?: Flush;
		// Manual-only operator focus (/compact <focus>, app focus body):
		// repeated in every chunk prompt so it outlives the carried
		// summary's shrinking budget share.
		focus?: string;
	},
	signal: AbortSignal,
): Promise<CompactionOutcome> {
	if (models.length === 0) throw new Error(`compaction for ${id} has no model to summarize with`);
	const detail = store.historyDetail(id);
	const previous = store.getCompaction(id);
	const boundary = chooseBoundary(detail, {
		tailTokenBudget: opts.tailTokenBudget,
		previousBoundary: previous?.boundarySeq ?? null,
		previousSplit: previous?.split ?? null,
		beforeSeq: opts.beforeSeq?.() ?? null,
	});
	if (boundary === null) {
		log.info("compaction skipped", { conversation: id, reason: "nothing worth compacting" });
		return { kind: "noop", reason: "nothing worth compacting" };
	}
	const { boundarySeq, split } = boundary;
	const boundaryIndex = detail.findIndex((e) => e.seq === boundarySeq);
	if (boundaryIndex < 0) {
		log.info("compaction skipped", {
			conversation: id,
			reason: "boundary vanished — history changed mid-compaction",
		});
		return { kind: "noop", reason: "boundary vanished — history changed mid-compaction" };
	}
	// With a split, the folded span runs past the boundary event to the
	// split event itself: the trigger, any app media anchored beside it,
	// and everything earlier fold whole; the split event's prefix folds
	// separately (the turn-prefix call below).
	const splitIndex = split === null ? -1 : detail.findIndex((e) => e.seq === split.seq);
	if (split !== null && (splitIndex < 0 || splitIndex <= boundaryIndex)) {
		log.info("compaction skipped", {
			conversation: id,
			reason: "split event vanished — history changed mid-compaction",
		});
		return { kind: "noop", reason: "split event vanished — history changed mid-compaction" };
	}
	// The span is the delta since the previous boundary — folded events
	// never re-enter the prompt, so calls stay bounded by one compaction
	// interval, not total history. The previous summary rides the first
	// call instead.
	const spanStart = (previous ? detail.findIndex((e) => e.seq === previous.boundarySeq) : -1) + 1;
	const span = detail.slice(spanStart, split === null ? boundaryIndex + 1 : splitIndex);
	// The split event's folded prefix as its own message-shaped slice — it
	// rides the flush, the identifier index, and the turn-prefix summary.
	const prefixMessage: UIMessage | null =
		split === null || splitIndex < 0
			? null
			: {
					...detail[splitIndex]!.message,
					parts: detail[splitIndex]!.message.parts.slice(0, split.part),
				};
	const tokensBefore =
		span.reduce((sum, e) => sum + estimateMessageTokens(e.message), 0) +
		(prefixMessage === null ? 0 : estimateMessageTokens(prefixMessage));
	const reason = opts.reason ?? "threshold";
	log.info("compaction summarizing", {
		conversation: id,
		boundary: boundarySeq,
		splitSeq: split === null ? null : split.seq,
		splitPart: split === null ? null : split.part,
		events: span.length,
		estimatedTokens: tokensBefore,
		reason,
	});
	const callTimeoutMs = opts.callTimeoutMs ?? SUMMARY_CALL_TIMEOUT_MS;
	if (opts.flush !== undefined) {
		opts.assertAuthority?.();
		// A split turn's folded prefix rides the flush too — its facts
		// fold exactly like the whole events' do.
		await runFlush(
			id,
			opts.flush,
			prefixMessage === null
				? span
				: [...span, { seq: split!.seq, anchorSeq: boundarySeq, message: prefixMessage }],
			opts.inputTokenBudget,
			signal,
			callTimeoutMs,
		);
	}
	const systemTokens = estimateTokens(SUMMARY_SYSTEM);
	const carriedParsed = previous !== null ? parseSummary(previous.summary) : null;
	let carried = carriedParsed?.modelText ?? null;
	// The newest real operator message consumed so far — what the audit
	// checks each chunk's summary reflects.
	let latestAsk: string | null = null;
	let carriedHeader =
		previous !== null ? "[summary carried from the previous compaction — fold it in]" : null;
	let summary: string | null = null;
	let chunks = 0;
	// The walk's position (sticky across chunks), its misses, and who
	// wrote the latest chunk.
	let lane = 0;
	const misses: FallbackMiss[] = [];
	let servedBy: string | null = null;
	// One summary call down the sticky lane: a call failure advances to
	// the next candidate; exhausting the list propagates. Shared by the
	// chunk walk and the split turn's prefix call (#403) — one lane,
	// one set of timeouts, abort and authority checks.
	const call = async (callPrompt: string, chunk: number): Promise<string> => {
		let raw: string | undefined;
		while (raw === undefined) {
			const model = models[lane]!;
			try {
				raw = await attemptSummary(summarize, callPrompt, model, signal, callTimeoutMs, chunk);
				servedBy = model;
			} catch (err) {
				if (signal.aborted) throw err;
				misses.push({
					ref: model,
					reason: missReason(err),
					transient: isTransientTurnFailure(err),
				});
				const next = models[lane + 1];
				if (next === undefined) {
					if (misses.length === 1) throw err;
					throw new Error(exhaustedMessage(misses), { cause: err });
				}
				log.warn("model fallback", {
					conversation: id,
					purpose: "compaction",
					chunk,
					from: model,
					to: next,
					failureClass: failureClass(err),
					attempt: misses.length,
					error: err instanceof Error ? err.message : String(err),
				});
				lane++;
				// Authority before spend — the next candidate is new spend.
				opts.assertAuthority?.();
			}
		}
		// Providers may resolve successfully even after an abort — the
		// pointer must never commit a summary minted under revoked
		// authority. Same for settings fences.
		signal.throwIfAborted();
		opts.assertAuthority?.();
		const out = raw.trim();
		if (out === "") throw new Error(`summarizer returned an empty summary (chunk ${chunk})`);
		return out;
		};

	for (let i = 0; i < span.length; ) {
		// Authority before spend — a fenced compaction must not keep
		// paying the summarizer for a pointer it may no longer write.
		opts.assertAuthority?.();
		chunks++;
		// The allowance shrinks as the running summary grows; the floor
		// keeps a degenerate budget from zeroing the chunk — better an
		// oversized call than none at all.
		const allowance = Math.max(
			opts.inputTokenBudget - systemTokens - (carried === null ? 0 : estimateTokens(carried)) - 200,
			1000,
			Math.floor(opts.inputTokenBudget / 4),
		);
		const texts: string[] = [];
		let chunkTokens = 0;
		let events = 0;
		while (i < span.length) {
			const e = span[i]!;
			let text = serializeEvent(e);
			let seenChars = Number.POSITIVE_INFINITY;
			if (events === 0) {
				// Always take ≥1 event — a message bigger than the
				// allowance is cut down rather than stalling the
				// compaction on it.
				if (estimateTokens(text) > allowance) {
					const keptChars = allowance * 4;
					log.warn("compaction event truncated for summarizer", {
						conversation: id,
						seq: e.seq,
						chars: text.length,
						keptChars,
					});
					seenChars = keptChars;
					text = `${text.slice(0, keptChars)}\n[… ${text.length - keptChars} chars truncated for summarization]`;
				}
			} else if (chunkTokens + estimateTokens(text) > allowance) {
				break;
			}
			texts.push(text);
			// The audit checks the ask as the summarizer saw it — a
			// truncated event's cut tail is not the model's to restate.
			const ask = operatorText(e.message);
			if (ask !== null) latestAsk = ask.slice(0, seenChars);
			chunkTokens += estimateTokens(text);
			events++;
			i++;
		}
		const prompt =
			(carried !== null && carriedHeader !== null
				? `${carriedHeader}\n${carried}\n\n---\n\n`
				: "") +
			(opts.focus !== undefined
				? `[operator asked this compaction to emphasize: ${opts.focus}]\n\n`
				: "") +
			texts.join("\n\n");
		let out = await call(prompt, chunks);
		// The quality audit: a deficient summary retries with a corrective
		// instruction; still failing, the fold writes nothing.
		for (let attempt = 0; ; attempt++) {
			const reasons = auditSummary(out, latestAsk);
			if (reasons.length === 0) break;
			log.warn("compaction summary failed audit", {
				conversation: id,
				chunk: chunks,
				attempt,
				reasons,
			});
			if (attempt >= AUDIT_RETRIES) {
				throw new Error(
					`compaction summary failed the quality audit after ${AUDIT_RETRIES} retries: ${reasons.join("; ")}`,
				);
			}
			opts.assertAuthority?.();
			out = await call(
				`${prompt}\n\n---\n\n[your previous summary]\n${out}\n\n${correctiveInstruction(reasons, latestAsk)}`,
				chunks,
			);
		}
		log.info("compaction chunk summarized", {
			conversation: id,
			chunk: chunks,
			events,
			estimatedTokens: chunkTokens,
			summaryChars: out.length,
		});
		carried = out;
		carriedHeader = "[running summary of the earlier part of this span — fold it in]";
		summary = out;
	}
	if (summary === null || servedBy === null) {
		// Unreachable — chooseBoundary only returns a boundary with a
		// non-empty span; fail loud, never write a blank pointer.
		throw new Error("compaction produced no summary");
	}
	// #403 split turns, like pi: a second summarizer call checkpoints the
	// split turn's own prefix — the trigger's request plus the reply's
	// folded steps (adapted from pi's TURN_PREFIX_SUMMARIZATION_PROMPT,
	// packages/coding-agent/src/core/compaction/compaction.ts) — and the
	// checkpoint is appended to the history summary. Without it the kept
	// suffix continues mid-turn with no frame for what came before it.
	if (split !== null && prefixMessage !== null) {
		opts.assertAuthority?.();
		const triggerEvent = detail[boundaryIndex]!;
		const prefixPrompt =
			`${serializeSpan([
				triggerEvent,
				{ seq: split.seq, anchorSeq: boundarySeq, message: prefixMessage },
			])}\n\n---\n\n` +
			"The messages above are the beginning of one long turn that compaction split; the turn's later messages follow this summary verbatim and do not need to be reconstructed.\n\n" +
			"Create a concise checkpoint of the user's request and the progress shown above, in the operator's dominant language. This checkpoint will be placed before the later messages so the turn can continue with the necessary context.\n\n" +
			"## Original Request\n[What did the user ask for?]\n\n" +
			"## Progress So Far\n- [Key decisions and work completed in these messages]\n\n" +
			"## Context Needed to Continue\n- [Information from these messages needed to understand the later work]\n\n" +
			"Only summarize information explicitly present above. Do not infer or recreate later messages.";
		const prefixOut = await call(prefixPrompt, chunks + 1);
		log.info("compaction turn-prefix summarized", {
			conversation: id,
			seq: split.seq,
			part: split.part,
			summaryChars: prefixOut.length,
		});
		summary = `${summary}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixOut}`;
	}
	// Code-made parts, never through a model: they cannot be paraphrased
	// away by this fold or any later one.
	summary = composeSummary(
		summary,
		mergeCodeMade(
			{
				quotes: span.flatMap((e) => operatorText(e.message) ?? []).reverse(),
				// The split prefix's identifiers ride along too — its content
				// folded exactly like the span's whole events.
				identifiers: extractIdentifiers([
					...span.map(serializeEvent),
					...(prefixMessage === null
						? []
						: [
								serializeEvent({
									seq: split!.seq,
									anchorSeq: boundarySeq,
									message: prefixMessage,
								}),
							]),
				]),
			},
			carriedParsed?.parts ?? { quotes: [], identifiers: [] },
		),
	);
	// A summary comparable to the span buys nothing and re-fires every
	// turn — warn, don't fail; the pointer still moves, the log explains.
	const summaryTokens = estimateTokens(summary);
	if (summaryTokens > Math.max(2_000, tokensBefore / 2)) {
		log.warn("compaction summary unusually large — utilization may not drop", {
			conversation: id,
			summaryTokens,
			spanTokens: tokensBefore,
		});
	}
	const tailEvents = detail.length - spanStart - span.length;
	store.setCompaction(id, {
		boundarySeq,
		summary,
		tokensBefore,
		model: servedBy,
		createdAt: new Date().toISOString(),
		tailEvents,
		split,
	});
	log.info("history compacted", {
		conversation: id,
		boundary: boundarySeq,
		splitSeq: split === null ? null : split.seq,
		splitPart: split === null ? null : split.part,
		eventsCompacted: span.length,
		tailEvents,
		estimatedTokensBefore: tokensBefore,
		summaryChars: summary.length,
		chunks,
		reason,
		model: servedBy,
		...(misses.length > 0 ? { fallbacksTried: misses.map((m) => m.ref) } : {}),
	});
	return {
		kind: "compacted",
		boundarySeq,
		eventsCompacted: span.length,
		tokensBefore,
		tailEvents,
		summary,
	};
}

