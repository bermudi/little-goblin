// Compaction: history is unbounded on disk, bounded in the window by
// pointer relocation.

import type { UIMessage } from "ai";
import { log } from "../log.ts";
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

export interface CompactionEvent {
	seq: number;
	anchorSeq: number | null;
	message: UIMessage;
}

export interface CompactionStore {
	historyDetail(id: string): CompactionEvent[];
	getCompaction(id: string): { boundarySeq: number; summary: string } | null;
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
		},
	): void;
}

// A cut after detail[i] is exchange-complete when nothing later anchors
// at or before it — no response is orphaned from its user message. The
// model view cuts on the same key, `(anchorSeq ?? seq) > boundarySeq` —
// keep them in sync. Consequence: an interleaved burst (operator
// messages arriving mid-turn) is atomic; the cut coarsens to whole
// bursts rather than splitting them.
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
export function chooseBoundary(
	detail: CompactionEvent[],
	opts: {
		tailTokenBudget: number;
		previousBoundary: number | null;
		minSpanTokens?: number;
		beforeSeq?: number | null;
	},
): number | null {
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
	if (cut !== null || fitStart === null || tailTokens <= opts.tailTokenBudget) return cut;
	return cutAt(detail, fitStart - 1, opts);
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
	try {
		const { noteCalls } = await flush(text, callSignal);
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
	},
	signal: AbortSignal,
): Promise<CompactionOutcome> {
	if (models.length === 0) throw new Error(`compaction for ${id} has no model to summarize with`);
	const detail = store.historyDetail(id);
	const previous = store.getCompaction(id);
	const boundary = chooseBoundary(detail, {
		tailTokenBudget: opts.tailTokenBudget,
		previousBoundary: previous?.boundarySeq ?? null,
		beforeSeq: opts.beforeSeq?.() ?? null,
	});
	if (boundary === null) {
		log.info("compaction skipped", { conversation: id, reason: "nothing worth compacting" });
		return { kind: "noop", reason: "nothing worth compacting" };
	}
	const boundaryIndex = detail.findIndex((e) => e.seq === boundary);
	if (boundaryIndex < 0) {
		log.info("compaction skipped", {
			conversation: id,
			reason: "boundary vanished — history changed mid-compaction",
		});
		return { kind: "noop", reason: "boundary vanished — history changed mid-compaction" };
	}
	// The span is the delta since the previous boundary — folded events
	// never re-enter the prompt, so calls stay bounded by one compaction
	// interval, not total history. The previous summary rides the first
	// call instead.
	const spanStart = (previous ? detail.findIndex((e) => e.seq === previous.boundarySeq) : -1) + 1;
	const span = detail.slice(spanStart, boundaryIndex + 1);
	const tokensBefore = span.reduce((sum, e) => sum + estimateMessageTokens(e.message), 0);
	const reason = opts.reason ?? "threshold";
	log.info("compaction summarizing", {
		conversation: id,
		boundary,
		events: span.length,
		estimatedTokens: tokensBefore,
		reason,
	});
	const callTimeoutMs = opts.callTimeoutMs ?? SUMMARY_CALL_TIMEOUT_MS;
	if (opts.flush !== undefined) {
		opts.assertAuthority?.();
		await runFlush(id, opts.flush, span, opts.inputTokenBudget, signal, callTimeoutMs);
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
				: "") + texts.join("\n\n");
		// One summary call down the sticky lane: a call failure advances to
		// the next candidate; exhausting the list propagates.
		const call = async (callPrompt: string): Promise<string> => {
			let raw: string | undefined;
			while (raw === undefined) {
				const model = models[lane]!;
				try {
					raw = await attemptSummary(summarize, callPrompt, model, signal, callTimeoutMs, chunks);
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
						chunk: chunks,
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
			if (out === "") throw new Error(`summarizer returned an empty summary (chunk ${chunks})`);
			return out;
		};
		let out = await call(prompt);
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
	// Code-made parts, never through a model: they cannot be paraphrased
	// away by this fold or any later one.
	summary = composeSummary(
		summary,
		mergeCodeMade(
			{
				quotes: span.flatMap((e) => operatorText(e.message) ?? []).reverse(),
				identifiers: extractIdentifiers(span.map(serializeEvent)),
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
		boundarySeq: boundary,
		summary,
		tokensBefore,
		model: servedBy,
		createdAt: new Date().toISOString(),
		tailEvents,
	});
	log.info("history compacted", {
		conversation: id,
		boundary,
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
		boundarySeq: boundary,
		eventsCompacted: span.length,
		tokensBefore,
		tailEvents,
		summary,
	};
}

