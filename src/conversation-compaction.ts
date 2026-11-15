// The compaction pointer trio: the active boundary read (the model
// view's cut), the transcript's fold-mark list, and the pointer write.
// Pure move from conversation.ts — openStore spreads these onto the
// store; getCompaction also feeds makeConversationHistory.

import type {
	Compaction,
	CompactionMark,
	CompactionSplit,
	CompactionWrite,
} from "./conversation-events.ts";
import type { ConversationQueries } from "./conversation-queries.ts";

// Split columns travel as one pointer: both set or both null — a lone
// split_seq/split_part is not a state a row can hold.
function splitOf(row: {
	split_seq: number | null;
	split_part: number | null;
}): CompactionSplit | null {
	return row.split_seq !== null && row.split_part !== null
		? { seq: row.split_seq, part: row.split_part }
		: null;
}

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
					split: splitOf(row),
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
			split: splitOf(row),
		}));
	}

	function setCompaction(id: string, compaction: CompactionWrite): void {
		// Derived text feeds memory-bound builders only when every event
		// the pointer folds (causal position ≤ boundary — the key
		// modelEntries cuts on) was eligible; a prior summary's span sits
		// below the new boundary, so one count covers repeated
		// compactions.
		const foldedIneligible = qIneligibleFolded.get(id, compaction.boundarySeq)?.n ?? 0;
		const split = compaction.split ?? null;
		qInsertCompaction.run(
			id,
			compaction.boundarySeq,
			compaction.summary,
			foldedIneligible === 0 ? 1 : 0,
			compaction.tokensBefore,
			compaction.model,
			compaction.createdAt,
			compaction.tailEvents ?? null,
			split === null ? null : split.seq,
			split === null ? null : split.part,
		);
	}

	return { getCompaction, listCompactions, setCompaction };
}
