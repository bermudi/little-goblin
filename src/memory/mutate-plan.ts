/**
 * Pure rows↔texts reconciliation for `MemoryStore.mutate`.
 *
 * Given the existing curated entry rows of a scope and the entry texts of the
 * next body, the planner emits the mutation plan the transaction applies:
 * which rows survive (with their new positions), which texts are inserted
 * (with positions), which rows are deleted, and the net character delta used
 * for budget projection.
 *
 * Matching is by identical text; duplicate texts consume old rows first-come.
 * Surviving rows are returned as-is so the transaction preserves id,
 * created_at, origin, recall_count, and embeddings; only display_order is
 * rewritten to the new position.
 */

/** Minimal row surface the planner needs: identity and text. */
export interface MutationRow {
  id: string;
  text: string;
}

export interface MutationPlan<Row extends MutationRow> {
  /** Surviving rows paired with their new position in the body. */
  toKeep: { row: Row; index: number }[];
  /** Texts with no surviving row, paired with their position in the body. */
  toInsert: { text: string; index: number }[];
  /** Old rows whose text does not appear in the next body. */
  toDelete: Row[];
  /** Sum of next-body text lengths minus sum of all old row text lengths. */
  netDelta: number;
}

export function planMutation<Row extends MutationRow>(
  oldRows: Row[],
  newTexts: string[],
): MutationPlan<Row> {
  const newTextLengthSum = newTexts.reduce((sum, text) => sum + text.length, 0);
  const oldTextLengthSum = oldRows.reduce((sum, row) => sum + row.text.length, 0);
  const netDelta = newTextLengthSum - oldTextLengthSum;

  // Map new texts to existing rows when the text is identical. Unmatched old
  // rows are deleted; new/changed rows are inserted. This preserves origin,
  // recall_count, promoted_at, and embeddings for entries that survive.
  const oldByText = new Map<string, Row[]>();
  for (const row of oldRows) {
    const list = oldByText.get(row.text) ?? [];
    list.push(row);
    oldByText.set(row.text, list);
  }

  const matchedOldIds = new Set<string>();
  const toKeep: { row: Row; index: number }[] = [];
  const toInsert: { text: string; index: number }[] = [];

  for (const [i, text] of newTexts.entries()) {
    const candidates = oldByText.get(text);
    if (candidates && candidates.length > 0) {
      const reused = candidates.shift()!;
      matchedOldIds.add(reused.id);
      toKeep.push({ row: reused, index: i });
    } else {
      toInsert.push({ text, index: i });
    }
  }

  const toDelete = oldRows.filter((r) => !matchedOldIds.has(r.id));
  return { toKeep, toInsert, toDelete, netDelta };
}
