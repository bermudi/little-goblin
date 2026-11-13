// The compaction pointer trio: the active boundary read (the model
// view's cut), the transcript's fold-mark list, and the pointer write.
// Pure move from conversation.ts — openStore spreads these onto the
// store; getCompaction also feeds makeConversationHistory.

import type { Compaction, CompactionMark, CompactionWrite } from "./conversation-events.ts";
import type { ConversationQueries } from "./conversation-queries.ts";

export function makeConversationCompaction(
	queries: Pick<
		ConversationQueries,
		"qCompaction" | "qCompactions" | "qInsertCompaction" | "qIneligibleFolded"
	>,
) {
	const { qCompaction, qCompactions, qInsertCompaction, qIneligibleFolded } = queries;

	function getCompaction(id: string): Compaction | null {
		const row = qCompaction.get(id);
		return row
			? {
					boundarySeq: row.boundary_seq,
					summary: row.summary,
					summaryEligible: row.summary_eligible !== 0,
					tokensBefore: row.tokens_before,
					model: row.model,
					createdAt: row.created_at,
					tailEvents: row.tail_events,
				}
			: null;
	}

	function listCompactions(id: string): CompactionMark[] {
		return qCompactions.all(id).map((row) => ({
			boundarySeq: row.boundary_seq,
			summary: row.summary,
			tokensBefore: row.tokens_before,
			tailEvents: row.tail_events,
			model: row.model,
			createdAt: row.created_at,
		}));
	}

	function setCompaction(id: string, compaction: CompactionWrite): void {
		// Derived text feeds memory-bound builders only when every event
		// the pointer folds (causal position ≤ boundary — the key
		// modelEntries cuts on) was eligible; a prior summary's span sits
		// below the new boundary, so one count covers repeated
		// compactions.
		const foldedIneligible = qIneligibleFolded.get(id, compaction.boundarySeq)?.n ?? 0;
		qInsertCompaction.run(
			id,
			compaction.boundarySeq,
			compaction.summary,
			foldedIneligible === 0 ? 1 : 0,
			compaction.tokensBefore,
			compaction.model,
			compaction.createdAt,
			compaction.tailEvents ?? null,
		);
	}

	return { getCompaction, listCompactions, setCompaction };
}
