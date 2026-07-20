import type { MemoryDatabase } from "./db.ts";

export const DEFAULT_MEMORY_BUDGET_CHARS = 50_000;

export interface MemoryOverflowDetails {
  current: number;
  budget: number;
  overflow: number;
}

export class MemoryOverflowError extends Error {
  current: number;
  budget: number;
  overflow: number;

  constructor({ current, budget, overflow }: MemoryOverflowDetails) {
    super(
      `memory overflow: ${current} characters exceeds the ${budget} character budget by ${overflow}`,
    );
    this.current = current;
    this.budget = budget;
    this.overflow = overflow;
  }
}

interface CompactionCandidate {
  id: string;
  text: string;
  recallCount: number;
  lastRecalledAt: number | null;
  promotedAt: number | null;
}

/**
 * Recall-aware memory budget manager.
 *
 * The budget counts only `memory_entries.text` for rows with
 * `entry_kind` of "memory" or "user". Descriptions in `memory_scopes`
 * are not counted.
 *
 * Compaction evicts `origin = "dreaming"` entries in this order:
 * 1. Never-recalled dreaming entries (`recall_count = 0`), oldest promoted first.
 * 2. Recalled dreaming entries, least-recently recalled first, ties by oldest promoted.
 *
 * User-authored entries (`origin = "user"`) are never eligible for eviction.
 */
export class MemoryBudget {
  readonly budgetChars: number;

  constructor(env: { GOBLIN_MEMORY_BUDGET_CHARS?: string } = process.env as Record<string, string>) {
    const raw = env.GOBLIN_MEMORY_BUDGET_CHARS;
    const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_MEMORY_BUDGET_CHARS;
    this.budgetChars = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MEMORY_BUDGET_CHARS;
  }

  /**
   * Total characters across all curated (memory + user) entries.
   */
  currentChars(db: MemoryDatabase): number {
    const row = db.database
      .query<{ total: number }, []>(
        "SELECT COALESCE(SUM(LENGTH(text)), 0) AS total FROM memory_entries WHERE entry_kind IN ('memory', 'user') AND scope NOT LIKE 'archive/%'",
      )
      .get();
    return row?.total ?? 0;
  }

  usage(db: MemoryDatabase): { current: number; budget: number } {
    return { current: this.currentChars(db), budget: this.budgetChars };
  }

  /**
   * Delete dreaming entries until at least `neededChars` of text have been
   * removed from `memory_entries`. Returns the ids that were removed and the
   * characters freed. If there are not enough dreaming entries to free the
   * requested amount, `stillOver` is true and the returned `freed` is the
   * maximum possible.
   *
   * Optional `excludeIds` prevents specific entries from being selected for
   * eviction; this is used when an entry is being updated in place.
   */
  compact(
    db: MemoryDatabase,
    neededChars = 0,
    excludeIds: string[] = [],
  ): { deletedIds: string[]; freed: number; stillOver: boolean } {
    if (neededChars <= 0) {
      return { deletedIds: [], freed: 0, stillOver: this.currentChars(db) > this.budgetChars };
    }

    const candidates = this.selectCompactionCandidates(db, excludeIds);
    const deletedIds: string[] = [];
    let freed = 0;
    let total = this.currentChars(db);

    for (const candidate of candidates) {
      if (freed >= neededChars) break;
      this.deleteEntry(db, candidate.id);
      deletedIds.push(candidate.id);
      freed += candidate.text.length;
      total -= candidate.text.length;
    }

    return { deletedIds, freed, stillOver: total > this.budgetChars };
  }

  /**
   * Enforce the budget for a projected total. If the projected total is over,
   * compact first. Throws `MemoryOverflowError` if compaction cannot make
   * enough room.
   *
   * `projectedTotal` is the caller's estimate of the size after the write is
   * applied: `currentChars(db) + delta`. `compact` may evict other dreaming
   * entries, freeing `freed` characters; the final size is then
   * `projectedTotal - freed`.
   *
   * Optional `excludeIds` keeps specific ids from being evicted during
   * compaction (e.g. an entry currently being updated).
   */
  enforce(db: MemoryDatabase, projectedTotal: number, excludeIds: string[] = []): void {
    if (projectedTotal <= this.budgetChars) return;

    const needed = projectedTotal - this.budgetChars;
    const { freed } = this.compact(db, needed, excludeIds);
    const finalTotal = projectedTotal - freed;
    if (finalTotal > this.budgetChars) {
      const overflow = finalTotal - this.budgetChars;
      throw new MemoryOverflowError({ current: finalTotal, budget: this.budgetChars, overflow });
    }
  }

  private selectCompactionCandidates(db: MemoryDatabase, excludeIds: string[] = []): CompactionCandidate[] {
    let where =
      "entry_kind IN ('memory', 'user') AND origin = 'dreaming' AND scope NOT LIKE 'archive/%'";
    const params: string[] = [];
    if (excludeIds.length > 0) {
      const placeholders = excludeIds.map(() => "?").join(",");
      where += ` AND id NOT IN (${placeholders})`;
      params.push(...excludeIds);
    }

    const rows = db.database
      .query<
        { id: string; text: string; recall_count: number; last_recalled_at: number | null; promoted_at: number | null },
        string[]
      >(
        `SELECT id, text, recall_count, last_recalled_at, promoted_at
         FROM memory_entries
         WHERE ${where}
         ORDER BY
           CASE WHEN recall_count = 0 THEN 0 ELSE 1 END ASC,
           CASE WHEN recall_count = 0 THEN promoted_at ELSE last_recalled_at END ASC,
           promoted_at ASC`,
      )
      .all(...params);
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      recallCount: r.recall_count,
      lastRecalledAt: r.last_recalled_at,
      promotedAt: r.promoted_at,
    }));
  }

  private deleteEntry(db: MemoryDatabase, entryId: string): void {
    db.database.query("DELETE FROM memory_entry_tags WHERE entry_id = $entryId").run({ $entryId: entryId });
    db.database.query("DELETE FROM memory_embeddings WHERE entry_id = $entryId").run({ $entryId: entryId });
    db.database.query("DELETE FROM memory_index_fts WHERE entry_id = $entryId").run({ $entryId: entryId });
    db.database.query("DELETE FROM memory_entries WHERE id = $entryId").run({ $entryId: entryId });
  }
}
