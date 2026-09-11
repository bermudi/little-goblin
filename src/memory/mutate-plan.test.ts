import { describe, expect, it } from "bun:test";
import { planMutation, type MutationPlan } from "./mutate-plan.ts";

interface TestRow {
  id: string;
  text: string;
  createdAt: number;
  origin: string;
  recallCount: number;
}

function row(id: string, text: string, extra: Partial<Omit<TestRow, "id" | "text">> = {}): TestRow {
  return { id, text, createdAt: 1_000, origin: "user", recallCount: 0, ...extra };
}

describe("planMutation", () => {
  it("keeps identical texts mapped to their surviving rows", () => {
    const a = row("a", "first entry", { createdAt: 111, origin: "dreaming", recallCount: 3 });
    const b = row("b", "second entry", { createdAt: 222, recallCount: 1 });

    const plan = planMutation([a, b], ["first entry", "second entry"]);

    expect(plan.toKeep).toHaveLength(2);
    expect(plan.toKeep[0]).toEqual({ row: a, index: 0 });
    expect(plan.toKeep[1]).toEqual({ row: b, index: 1 });
    expect(plan.toKeep[0]!.row).toBe(a);
    expect(plan.toKeep[1]!.row).toBe(b);
    expect(plan.toInsert).toEqual([]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.netDelta).toBe(0);
  });

  it("assigns new positions on reorder while returning rows untouched", () => {
    const a = row("a", "alpha", { createdAt: 111 });
    const b = row("b", "beta", { createdAt: 222 });
    const before = new Map([a, b].map((r) => [r.id, r.createdAt]));

    const plan = planMutation([a, b], ["beta", "alpha"]);

    expect(plan.toKeep).toEqual([
      { row: b, index: 0 },
      { row: a, index: 1 },
    ]);
    expect(plan.toInsert).toEqual([]);
    expect(plan.toDelete).toEqual([]);
    // The planner returns the original row objects; created_at cannot be
    // rewritten by the position update that consumes this plan.
    for (const { row: kept } of plan.toKeep) {
      expect(kept.createdAt).toBe(before.get(kept.id));
    }
    expect(plan.netDelta).toBe(0);
  });

  it("deletes every old row when the next body has no texts", () => {
    const a = row("a", "gone one");
    const b = row("b", "gone two");

    const plan = planMutation([a, b], []);

    expect(plan.toKeep).toEqual([]);
    expect(plan.toInsert).toEqual([]);
    expect(plan.toDelete).toEqual([a, b]);
    expect(plan.netDelta).toBe(-("gone one".length + "gone two".length));
  });

  it("consumes distinct old rows first-come for duplicate texts", () => {
    const x1 = row("x1", "same", { createdAt: 10 });
    const x2 = row("x2", "same", { createdAt: 20 });

    const plan = planMutation([x1, x2], ["same", "same", "same"]);

    expect(plan.toKeep).toEqual([
      { row: x1, index: 0 },
      { row: x2, index: 1 },
    ]);
    expect(plan.toInsert).toEqual([{ text: "same", index: 2 }]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.netDelta).toBe("same".length);
  });

  it("deletes surplus old rows when duplicates shrink", () => {
    const x1 = row("x1", "same", { createdAt: 10 });
    const x2 = row("x2", "same", { createdAt: 20 });
    const x3 = row("x3", "same", { createdAt: 30 });

    const plan = planMutation([x1, x2, x3], ["same", "same"]);

    expect(plan.toKeep).toEqual([
      { row: x1, index: 0 },
      { row: x2, index: 1 },
    ]);
    expect(plan.toInsert).toEqual([]);
    expect(plan.toDelete).toEqual([x3]);
    expect(plan.netDelta).toBe(-"same".length);
  });

  it("reports a positive net delta when inserts outweigh deletes", () => {
    const old = row("old", "aaaa");
    const kept = row("kept", "bb");

    const plan: MutationPlan<TestRow> = planMutation([old, kept], ["bb", "cccccccc"]);

    expect(plan.toKeep).toEqual([{ row: kept, index: 0 }]);
    expect(plan.toInsert).toEqual([{ text: "cccccccc", index: 1 }]);
    expect(plan.toDelete).toEqual([old]);
    expect(plan.netDelta).toBe(8 - 4);
    expect(plan.netDelta).toBeGreaterThan(0);
  });

  it("reports a negative net delta when deletes outweigh inserts", () => {
    const old = row("old", "aaaaaaaa");
    const kept = row("kept", "bb");

    const plan = planMutation([old, kept], ["bb", "cc"]);

    expect(plan.toKeep).toEqual([{ row: kept, index: 0 }]);
    expect(plan.toInsert).toEqual([{ text: "cc", index: 1 }]);
    expect(plan.toDelete).toEqual([old]);
    expect(plan.netDelta).toBe(2 - 8);
    expect(plan.netDelta).toBeLessThan(0);
  });

  it("plans an empty scope as pure inserts", () => {
    const plan = planMutation([], ["one", "two"]);

    expect(plan.toKeep).toEqual([]);
    expect(plan.toInsert).toEqual([
      { text: "one", index: 0 },
      { text: "two", index: 1 },
    ]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.netDelta).toBe("one".length + "two".length);
  });
});
