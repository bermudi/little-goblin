import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryDatabase } from "./db.ts";
import { MemoryBudget, DEFAULT_MEMORY_BUDGET_CHARS, MemoryOverflowError } from "./budget.ts";

describe("MemoryBudget", () => {
  let db: MemoryDatabase;

  beforeEach(() => {
    db = new MemoryDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function insertEntry(params: {
    id: string;
    scope: string;
    entryKind: string;
    text: string;
    origin: string;
    recallCount?: number;
    lastRecalledAt?: number | null;
    promotedAt?: number | null;
  }): void {
    const now = Date.now();
    db.database
      .query(
        `INSERT INTO memory_entries
         (id, scope, entry_kind, text, created_at, updated_at, origin, promoted_at, recall_count, last_recalled_at)
         VALUES ($id, $scope, $entry_kind, $text, $created_at, $updated_at, $origin, $promoted_at, $recall_count, $last_recalled_at)`,
      )
      .run({
        $id: params.id,
        $scope: params.scope,
        $entry_kind: params.entryKind,
        $text: params.text,
        $created_at: now,
        $updated_at: now,
        $origin: params.origin,
        $promoted_at: params.promotedAt ?? null,
        $recall_count: params.recallCount ?? 0,
        $last_recalled_at: params.lastRecalledAt ?? null,
      });
  }

  describe("constructor", () => {
    it("respects GOBLIN_MEMORY_BUDGET_CHARS", () => {
      const budget = new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "1234" });
      expect(budget.budgetChars).toBe(1234);
    });

    it("falls back to the default when the env variable is missing", () => {
      const budget = new MemoryBudget({});
      expect(budget.budgetChars).toBe(DEFAULT_MEMORY_BUDGET_CHARS);
    });

    it("falls back to the default for non-numeric or non-positive values", () => {
      expect(new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "abc" }).budgetChars).toBe(DEFAULT_MEMORY_BUDGET_CHARS);
      expect(new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "-1" }).budgetChars).toBe(DEFAULT_MEMORY_BUDGET_CHARS);
      expect(new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "0" }).budgetChars).toBe(DEFAULT_MEMORY_BUDGET_CHARS);
    });
  });

  describe("currentChars", () => {
    it("counts only memory and user entry kinds", () => {
      insertEntry({ id: "1", scope: "general", entryKind: "memory", text: "hello", origin: "dreaming" });
      insertEntry({ id: "2", scope: "user", entryKind: "user", text: "world", origin: "user" });
      insertEntry({ id: "3", scope: "transcript/session-1", entryKind: "transcript", text: "not counted", origin: "transcript" });

      const budget = new MemoryBudget({});
      expect(budget.currentChars(db)).toBe(10);
    });

    it("excludes archive scopes", () => {
      insertEntry({ id: "1", scope: "general", entryKind: "memory", text: "keep", origin: "dreaming" });
      insertEntry({ id: "2", scope: "archive/topics/-100/1", entryKind: "memory", text: "archived", origin: "dreaming" });

      const budget = new MemoryBudget({});
      expect(budget.currentChars(db)).toBe(4);
    });
  });

  describe("compact", () => {
    it("evicts never-recalled dreaming entries first, oldest promoted first", () => {
      insertEntry({ id: "old", scope: "general", entryKind: "memory", text: "a", origin: "dreaming", promotedAt: 100 });
      insertEntry({ id: "new", scope: "general", entryKind: "memory", text: "bb", origin: "dreaming", promotedAt: 200 });

      const budget = new MemoryBudget({});
      const result = budget.compact(db, 1);

      expect(result.deletedIds).toEqual(["old"]);
      expect(result.freed).toBe(1);
      expect(result.stillOver).toBe(false);
    });

    it("evicts recalled dreaming entries after never-recalled, least recently recalled first", () => {
      insertEntry({ id: "never", scope: "general", entryKind: "memory", text: "a", origin: "dreaming", promotedAt: 100 });
      insertEntry({ id: "recalled-recent", scope: "general", entryKind: "memory", text: "bb", origin: "dreaming", recallCount: 1, lastRecalledAt: 200, promotedAt: 300 });
      insertEntry({ id: "recalled-old", scope: "general", entryKind: "memory", text: "ccc", origin: "dreaming", recallCount: 2, lastRecalledAt: 50, promotedAt: 400 });

      const budget = new MemoryBudget({});
      const result = budget.compact(db, 4);

      expect(result.deletedIds).toEqual(["never", "recalled-old"]);
      expect(result.freed).toBe(4);
    });

    it("does not evict user-authored entries", () => {
      insertEntry({ id: "user", scope: "user", entryKind: "user", text: "precious", origin: "user" });
      insertEntry({ id: "dream", scope: "general", entryKind: "memory", text: "a", origin: "dreaming", promotedAt: 100 });

      const budget = new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "1" });
      const result = budget.compact(db, 1);

      expect(result.deletedIds).toEqual(["dream"]);
      expect(db.database.query<{ id: string }, []>("SELECT id FROM memory_entries WHERE id = 'user'").get()?.id).toBe("user");
    });
  });

  describe("enforce", () => {
    it("allows projected totals within the budget", () => {
      insertEntry({ id: "1", scope: "general", entryKind: "memory", text: "short", origin: "dreaming" });

      const budget = new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "100" });
      expect(() => budget.enforce(db, 50)).not.toThrow();
      expect(() => budget.enforce(db, 100)).not.toThrow();
      expect(budget.currentChars(db)).toBe(5);
    });

    it("throws MemoryOverflowError when compaction cannot free enough", () => {
      insertEntry({ id: "user", scope: "user", entryKind: "user", text: "x".repeat(70), origin: "user" });
      insertEntry({ id: "dream", scope: "general", entryKind: "memory", text: "x".repeat(10), origin: "dreaming", promotedAt: 100 });

      const budget = new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "100" });

      try {
        budget.enforce(db, 120);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(MemoryOverflowError);
        expect((err as MemoryOverflowError).current).toBe(110);
        expect((err as MemoryOverflowError).budget).toBe(100);
        expect((err as MemoryOverflowError).overflow).toBe(10);
      }
    });

    it("compacts dreaming entries to make room when possible", () => {
      insertEntry({ id: "user", scope: "user", entryKind: "user", text: "x".repeat(70), origin: "user" });
      insertEntry({ id: "dream", scope: "general", entryKind: "memory", text: "x".repeat(40), origin: "dreaming", promotedAt: 100 });

      const budget = new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "100" });
      budget.enforce(db, 110);

      expect(budget.currentChars(db)).toBe(70);
      expect(db.database.query<{ id: string }, []>("SELECT id FROM memory_entries WHERE id = 'dream'").get()).toBeNull();
    });

    it("excludes selected ids from compaction", () => {
      insertEntry({ id: "protected", scope: "general", entryKind: "memory", text: "aaa", origin: "dreaming", promotedAt: 100 });
      insertEntry({ id: "victim", scope: "general", entryKind: "memory", text: "bbbb", origin: "dreaming", promotedAt: 200 });

      const budget = new MemoryBudget({ GOBLIN_MEMORY_BUDGET_CHARS: "100" });
      budget.enforce(db, 104, ["protected"]);

      const remaining = db.database
        .query<{ id: string }, []>("SELECT id FROM memory_entries ORDER BY id")
        .all()
        .map((r) => r.id);
      expect(remaining).toEqual(["protected"]);
    });
  });
});
