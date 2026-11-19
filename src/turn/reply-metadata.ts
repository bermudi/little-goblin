import type { FinishReason } from "../message.ts";
import type { AppQuota } from "../http/app-wire.ts";
import type { PromptSegments } from "./itemize.ts";
import type { ForcedKind } from "./state.ts";

export interface ReplyMetadata {
	model: string;
	finishReason: FinishReason;
	durationMs: number;
	createdAt: string;
	ttftMs?: number;
	forcedCompletion?: ForcedKind;
	usage: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
		// input above sums every step's billed prompt across the tool
		// loop; the window gauge reads the final step — the current
		// occupancy, the number compaction math uses.
		lastInput: number | null;
		lastCacheRead: number | null;
	};
	// Itemization of the final step's prompt, in serialized characters
	// (turn/itemize.ts); scaled to tokens by /context. Absent when no
	// step ran.
	promptChars?: PromptSegments;
	quota?: AppQuota;
	fallback?: { from: { ref: string; reason: string }[] };
}

export function replyMetadata(input: {
	label: string;
	finishReason: FinishReason;
	turnStartMs: number;
	now: number;
	firstTokenMs: number | null;
	forcedCompletion: ForcedKind | null;
	usage: {
		input: number | null;
		output: number | null;
		cacheRead: number | null;
		cacheWrite: number | null;
		lastInput: number | null;
		lastCacheRead: number | null;
	};
	promptChars: PromptSegments | null;
	quota: AppQuota | null;
	fallbackMisses?: ReadonlyArray<{ ref: string; reason: string }> | undefined;
}): ReplyMetadata {
	const durationMs = input.now - input.turnStartMs;
	return {
		model: input.label,
		finishReason: input.finishReason,
		durationMs,
		// The finish instant, same clock read as durationMs — the reply's age stamp.
		createdAt: new Date(input.turnStartMs + durationMs).toISOString(),
		...(input.firstTokenMs !== null ? { ttftMs: input.firstTokenMs } : {}),
		...(input.forcedCompletion !== null ? { forcedCompletion: input.forcedCompletion } : {}),
		usage: input.usage,
		...(input.promptChars !== null ? { promptChars: { ...input.promptChars } } : {}),
		...(input.quota !== null ? { quota: input.quota } : {}),
		...(input.fallbackMisses !== undefined && input.fallbackMisses.length > 0
			? {
					fallback: {
						from: input.fallbackMisses.map(({ ref, reason }) => ({ ref, reason })),
					},
				}
			: {}),
	};
}
