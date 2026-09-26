// Compaction (DESIGN.md): history is unbounded on disk, bounded in the
// window by pointer relocation. This module owns the two decisions —
// where to cut, and what to ask the summarizer — plus the orchestration
// that turns them into a compactions-table row. The model call is
// injected; the store is a narrow interface so tests fake the edges,
// not the module.

import type { UIMessage } from "ai";
import { log } from "../log.ts";

// Rough chars-per-token for mixed chat text — enough to pick a cut, and
// the real number lands in the log line when the next turn reports
// utilization.
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
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
		},
	): void;
}

// A cut after detail[i] is exchange-complete when nothing later anchors
// at or before it — the causal-view rule, so no response is ever
// orphaned from its user message in the tail. The comparison is against
// the boundary's arrival seq, and the model view cuts on the same key —
// `(anchorSeq ?? seq) > boundarySeq` — so an event whose causal position
// precedes the cut folds into the summarized span rather than stranding
// in the tail. One ruled consequence: an interleaved burst — operator
// messages arriving mid-turn — is atomic; the cut coarsens to whole
// bursts rather than splitting them.
function exchangeComplete(detail: CompactionEvent[], boundaryIndex: number): boolean {
	const boundary = detail[boundaryIndex]!.seq;
	for (let j = boundaryIndex + 1; j < detail.length; j++) {
		const e = detail[j]!;
		if ((e.anchorSeq ?? e.seq) <= boundary) return false;
	}
	return true;
}

// Where to cut: keep a suffix (tail) whose estimated tokens stay within
// the budget, extending backward exchange-by-exchange. Returns the
// boundary seq (the last compacted event's seq) or null when there is
// nothing worth compacting — a span must exist beyond the previous
// boundary and carry at least `minSpanTokens` (compacting three
// messages into a summary buys nothing).
export function chooseBoundary(
	detail: CompactionEvent[],
	opts: { tailTokenBudget: number; previousBoundary: number | null; minSpanTokens?: number },
): number | null {
	if (detail.length < 2) return null;
	// Grow the tail from the newest event while it fits the budget; every
	// step re-checks exchange completeness, so an anchored response pulls
	// its user message into the tail rather than being stranded.
	let i = detail.length - 1;
	let tailTokens = estimateTokens(JSON.stringify(detail[i]!.message));
	while (i > 0) {
		const boundaryIndex = i - 1;
		if (!exchangeComplete(detail, boundaryIndex)) {
			i = boundaryIndex;
			tailTokens += estimateTokens(JSON.stringify(detail[boundaryIndex]!.message));
			continue;
		}
		if (tailTokens >= opts.tailTokenBudget) break;
		if (opts.previousBoundary !== null && detail[boundaryIndex]!.seq <= opts.previousBoundary) break;
		i = boundaryIndex;
		tailTokens += estimateTokens(JSON.stringify(detail[boundaryIndex]!.message));
	}
	const boundaryIndex = i - 1;
	if (boundaryIndex < 0) return null;
	const boundary = detail[boundaryIndex]!.seq;
	if (opts.previousBoundary !== null && boundary <= opts.previousBoundary) return null;
	let spanTokens = 0;
	for (let j = 0; j <= boundaryIndex; j++) {
		spanTokens += estimateTokens(JSON.stringify(detail[j]!.message));
	}
	if (spanTokens < (opts.minSpanTokens ?? 500)) return null;
	return boundary;
}

// ---------- summarizer prompt ----------

export const SUMMARY_SYSTEM = `You are summarizing your own conversation history so you can continue seamlessly with only this summary plus the recent messages that follow it. Write in the operator's dominant language. Preserve, tersely:
- What the operator asked for and what was done about it, including the current status of anything unfinished
- Decisions made and their rationale; commitments and follow-ups made on either side
- Standing instructions or preferences the operator expressed in this span
- Open questions, unresolved threads, and the state of any multi-step work
- File paths, attachment names, and identifiers that matter for continuity
Omit small talk and process chatter. Plain text with short labeled bullets. Never invent anything not present in the span.`;

function messageText(message: UIMessage): string {
	const parts: string[] = [];
	for (const p of message.parts) {
		const part = p as { type: string; text?: string; filename?: string; path?: string; mimeType?: string };
		if (part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		} else if (part.type === "data-attachment") {
			parts.push(`[attachment: ${part.path ?? part.filename ?? "unnamed"}]`);
		} else if (part.type.startsWith("tool-")) {
			// Tool parts matter as actions taken; the input/output detail is
			// the summarizer's to compress from context, not to re-quote.
			parts.push(`[${part.type}]`);
		}
	}
	return parts.join("\n").trim();
}

export function serializeSpan(detail: CompactionEvent[]): string {
	return detail
		.map((e) => `${e.message.role === "assistant" ? "goblin" : e.message.role}: ${messageText(e.message)}`)
		.join("\n\n");
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

// The full compaction: choose the cut, summarize the span with the
// conversation's own model, persist the pointer. A summarizer failure
// propagates — the caller warns and leaves the view untouched; the next
// threshold crossing retries.
export async function runCompaction(
	id: string,
	store: CompactionStore,
	model: string,
	summarize: (system: string, prompt: string, signal: AbortSignal) => Promise<string>,
	opts: { tailTokenBudget: number },
	signal: AbortSignal,
): Promise<CompactionOutcome> {
	const detail = store.historyDetail(id);
	const previous = store.getCompaction(id);
	const boundary = chooseBoundary(detail, {
		tailTokenBudget: opts.tailTokenBudget,
		previousBoundary: previous?.boundarySeq ?? null,
	});
	if (boundary === null) {
		log.info("compaction skipped", { conversation: id, reason: "nothing worth compacting" });
		return { kind: "noop", reason: "nothing worth compacting" };
	}
	const boundaryIndex = detail.findIndex((e) => e.seq === boundary);
	if (boundaryIndex < 0) {
		log.info("compaction skipped", { conversation: id, reason: "boundary vanished — history changed mid-compaction" });
		return { kind: "noop", reason: "boundary vanished — history changed mid-compaction" };
	}
	// The span is the DELTA since the previous boundary (DESIGN.md,
	// Compaction) — already-folded events never re-enter the prompt, so
	// the summary call stays bounded by one compaction interval, not by
	// total history. The previous summary rides in the prompt instead.
	const spanStart =
		(previous ? detail.findIndex((e) => e.seq === previous.boundarySeq) : -1) + 1;
	const span = detail.slice(spanStart, boundaryIndex + 1);
	const tokensBefore = span.reduce((sum, e) => sum + estimateTokens(JSON.stringify(e.message)), 0);
	const prompt =
		(previous ? `[summary carried from the previous compaction — fold it in]\n${previous.summary}\n\n---\n\n` : "") +
		serializeSpan(span);
	log.info("compaction summarizing", {
		conversation: id,
		boundary,
		events: span.length,
		estimatedTokens: tokensBefore,
	});
	const summary = (await summarize(SUMMARY_SYSTEM, prompt, signal)).trim();
	if (summary === "") throw new Error("summarizer returned an empty summary");
	// A verbose summarizer can emit a summary comparable to the span —
	// compaction would buy nothing and re-fire every turn. Warn, don't
	// fail: the pointer still moves, the log explains the churn.
	const summaryTokens = estimateTokens(summary);
	if (summaryTokens > Math.max(2_000, tokensBefore / 2)) {
		log.warn("compaction summary unusually large — utilization may not drop", {
			conversation: id,
			summaryTokens,
			spanTokens: tokensBefore,
		});
	}
	store.setCompaction(id, {
		boundarySeq: boundary,
		summary,
		tokensBefore,
		model,
		createdAt: new Date().toISOString(),
	});
	log.info("history compacted", {
		conversation: id,
		boundary,
		eventsCompacted: span.length,
		tailEvents: detail.length - spanStart - span.length,
		estimatedTokensBefore: tokensBefore,
		summaryChars: summary.length,
		model,
	});
	return {
		kind: "compacted",
		boundarySeq: boundary,
		eventsCompacted: span.length,
		tokensBefore,
		tailEvents: detail.length - spanStart - span.length,
		summary,
	};
}
