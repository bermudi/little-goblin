export const COMPACT_TRIGGER_CAP_TOKENS = 272_000;
export const COMPACT_CAP_ABOVE_WINDOW_TOKENS = 300_000;
export const COMPACT_RESERVE_TOKENS = 16_384;

export function compactTriggerTokens(
	contextWindow: number | undefined | null,
	uncapped: boolean,
): number {
	if (contextWindow === undefined || contextWindow === null) {
		return COMPACT_TRIGGER_CAP_TOKENS;
	}
	if (!uncapped && contextWindow > COMPACT_CAP_ABOVE_WINDOW_TOKENS) {
		return COMPACT_TRIGGER_CAP_TOKENS;
	}
	return Math.max(contextWindow - COMPACT_RESERVE_TOKENS, Math.floor(contextWindow / 2));
}
