// The model fallback list's pure half (design/model.md → Model fallback
// list): the walk order, the short miss reasons, and the operator-facing
// notice. The runtime owns when to advance (zero-effect failures only);
// this module owns what "next" and "why" mean.

import { isTransientTurnFailure, quotaExhausted } from "./provider-errors.ts";

// One candidate that failed before doing anything.
export interface FallbackMiss {
	ref: string;
	reason: string;
	transient: boolean;
}

// The turn's fallback bookkeeping, carried across attempts: the
// conversation's own selection (what the run row compares on resume)
// and every candidate that already failed this turn.
export interface FallbackTrail {
	configured: string;
	tried: FallbackMiss[];
}

// What a turn served by a fallback reports: who answered and who didn't.
export interface FallbackNote {
	servedBy: string;
	misses: Array<{ ref: string; reason: string }>;
}

// The conversation's model first, then the operator's list in order —
// duplicates (including the conversation's own model) collapse to their
// first position.
export function candidateRefs(configured: string, fallbacks: readonly string[]): string[] {
	const out: string[] = [];
	for (const ref of [configured, ...fallbacks]) if (!out.includes(ref)) out.push(ref);
	return out;
}

export function nextCandidate(
	candidates: readonly string[],
	tried: readonly string[],
): string | undefined {
	return candidates.find((ref) => !tried.includes(ref));
}

const REASON_MAX = 120;

// A short, single-line reason for the notice: quota walls by name, the
// rest as the error's first line, capped.
export function missReason(err: unknown): string {
	if (quotaExhausted(err) !== null) return "quota exhausted";
	const text = err instanceof Error ? err.message : String(err);
	const line = (text.split("\n")[0] ?? "").trim();
	if (line === "") return "failed";
	return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}

// "via zai/glm-5.3 — codex/gpt-6.1-terra: quota exhausted" — search's
// served_by line, applied to models.
export function fallbackNotice(note: FallbackNote): string {
	const why = note.misses.map((m) => `${m.ref}: ${m.reason}`).join("; ");
	return `via ${note.servedBy} — ${why}`;
}

// The terminal message when every candidate failed.
export function exhaustedMessage(misses: readonly FallbackMiss[]): string {
	return `every model failed — ${misses.map((m) => `${m.ref}: ${m.reason}`).join("; ")}`;
}

export type FailureClass = "quota" | "transient" | "other";

// The `failureClass` every `model fallback` and `turn failed` line
// carries (design/model.md → Visibility). Quota wins: the scheduler
// ladder only re-fires transient failures, so a quota wall must not
// read as one.
export function failureClass(err: unknown): FailureClass {
	if (quotaExhausted(err) !== null) return "quota";
	return isTransientTurnFailure(err) ? "transient" : "other";
}
