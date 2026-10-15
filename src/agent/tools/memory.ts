// The memory-search tool — deeper recall on demand (DESIGN.md, Recall).
// Read-only against the shared bank; zod-validated bounds. Excluded
// topics recall nothing, including through this tool.

import { tool } from "ai";
import { z } from "zod";
import { HindsightClient, HindsightError, type RecallMinScores } from "../../hindsight.ts";
import { renderRecallEvidence } from "../../memory.ts";
import { log } from "../../log.ts";
import { BUDGET_ORDER, MEMORY_DEFAULTS } from "../../memory-policy.ts";

export interface MemorySearchDeps {
	client: HindsightClient;
	// Bounds from the boot-time memory config — the tool input may narrow
	// them, never widen past the wire cap.
	maxTokens: number;
	budget: "low" | "mid" | "high";
	timeoutMs?: number;
	preferObservations?: boolean;
	minScores?: RecallMinScores;
	// Topic exclusion governs inflow too: excluded conversations may not
	// recall shared memories by any path.
	isExcluded: () => boolean;
	// Records the outcome for /memory status alongside turn recalls.
	noteRecall: (ok: boolean) => void;
}

export const memorySearchTool = (deps: MemorySearchDeps) =>
	tool({
		description:
			"Search long-term memory for past preferences, decisions, commitments, people, and ongoing work. " +
			"Returns dated evidence with source references — current operator statements outrank anything recalled. " +
			"Results may be stale; verify before acting on them.",
		inputSchema: z.object({
			query: z.string().min(1).max(8000).describe("What to search memory for"),
			maxTokens: z
				.number()
				.int()
				.min(1)
				.max(8192)
				.optional()
				.describe("Cap on recall output (defaults to the configured bound)"),
			budget: z
				.enum(["low", "mid", "high"])
				.optional()
				.describe("Search effort (defaults to the configured budget)"),
		}),
		execute: async ({ query, maxTokens, budget }, options) => {
			if (deps.isExcluded()) {
				return { error: "memory is excluded in this conversation" };
			}
			try {
				const facts = await deps.client.recall(query, {
					timeoutMs: deps.timeoutMs ?? MEMORY_DEFAULTS.searchTimeoutMs,
					...(options?.abortSignal ? { signal: options.abortSignal } : {}),
					...(deps.minScores ? { minScores: deps.minScores } : {}),
					preferObservations: deps.preferObservations ?? true,
					// exactOptionalPropertyTypes: never pass an explicit undefined.
					...(maxTokens !== undefined
						? { maxTokens: Math.min(maxTokens, deps.maxTokens) }
						: { maxTokens: deps.maxTokens }),
					...(budget !== undefined
						? { budget: BUDGET_ORDER[budget] > BUDGET_ORDER[deps.budget] ? deps.budget : budget }
						: { budget: deps.budget }),
				});
				if (deps.isExcluded()) return { error: "memory is excluded in this conversation" };
				const bound = Math.min(maxTokens ?? deps.maxTokens, deps.maxTokens);
				const rendered = renderRecallEvidence(
					facts,
					facts.length > 0 ? "results" : "empty",
					bound,
					true,
				);
				deps.noteRecall(true);
				log.info("memory searched", { facts: facts.length });
				return {
					memory: rendered.memory,
					sources: rendered.sources,
					...(rendered.omitted > 0 ? { omitted: rendered.omitted } : {}),
				};
			} catch (err) {
				if (err instanceof HindsightError) {
					if (err.kind !== "cancelled") deps.noteRecall(false);
					return {
						error: "memory unavailable",
						retryable: err.retryable,
					};
				}
				throw err;
			}
		},
	});
