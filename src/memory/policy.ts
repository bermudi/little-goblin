export const MEMORY_DEFAULTS = {
	recallTimeoutMs: 5_000,
	maxTokens: 2_048,
	budget: "mid",
	preferObservations: true,
	minScores: { semantic: 0.3 },
	searchMaxTokens: 4_096,
	searchBudget: "high",
	searchTimeoutMs: 30_000,
	searchMinScores: {},
	reflectMaxTokens: 4_096,
	reflectBudget: "high",
	reflectTimeoutMs: 120_000,
} as const;

export const BUDGET_ORDER = { low: 0, mid: 1, high: 2 } as const;

// The aggregate bound must keep the per-field caps within the response byte
// ceiling even when JSON escapes every character.
export const REFLECTION_LIMITS = {
	responseBytes: 16 * 1024 * 1024,
	totalCharacters: 2_000_000,
} as const;
