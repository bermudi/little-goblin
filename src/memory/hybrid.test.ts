import { describe, it, expect } from "bun:test";
import {
  tokenize,
  jaccardSimilarity,
  textSimilarity,
  bm25RankToScore,
  mergeHybridResults,
  applyTemporalDecay,
  applyMMR,
  type HybridResult,
} from "./hybrid.ts";

function makeHybridResult(overrides: Partial<HybridResult> = {}): HybridResult {
  return {
    entryId: "id",
    scope: "memory",
    entryKind: "memory",
    text: "",
    score: 0,
    vectorScore: 0,
    textScore: 0,
    conceptBoost: 0,
    updatedAt: null,
    ...overrides,
  };
}

function vectorResult(overrides: {
  entryId: string;
  text: string;
  vectorScore: number;
  scope?: string;
  entryKind?: string;
  updatedAt?: number | null;
}): { entryId: string; scope: string; entryKind: string; text: string; vectorScore: number; updatedAt: number | null } {
  return {
    scope: "memory",
    entryKind: "memory",
    updatedAt: null,
    ...overrides,
  };
}

function keywordResult(overrides: {
  entryId: string;
  text: string;
  textScore: number;
  scope?: string;
  entryKind?: string;
  updatedAt?: number | null;
}): { entryId: string; scope: string; entryKind: string; text: string; textScore: number; updatedAt: number | null } {
  return {
    scope: "memory",
    entryKind: "memory",
    updatedAt: null,
    ...overrides,
  };
}

describe("tokenize", () => {
  it("extracts lowercase ASCII tokens", () => {
    const tokens = tokenize("Hello, World! 123 foo_bar");
    expect(tokens.size).toBe(4);
    expect(tokens.has("hello")).toBe(true);
    expect(tokens.has("world")).toBe(true);
    expect(tokens.has("123")).toBe(true);
    expect(tokens.has("foo_bar")).toBe(true);
  });

  it("lowercases ASCII tokens", () => {
    const tokens = tokenize("UPPER CASE");
    expect(tokens.has("upper")).toBe(true);
    expect(tokens.has("case")).toBe(true);
  });

  it("returns CJK unigrams and adjacent bigrams", () => {
    const tokens = tokenize("日本語 test");
    expect(tokens.size).toBe(6);
    expect(tokens.has("日")).toBe(true);
    expect(tokens.has("本")).toBe(true);
    expect(tokens.has("語")).toBe(true);
    expect(tokens.has("日本")).toBe(true);
    expect(tokens.has("本語")).toBe(true);
    expect(tokens.has("test")).toBe(true);
  });

  it("does not create bigrams across non-CJK characters", () => {
    const tokens = tokenize("日 本");
    expect(tokens.has("日本")).toBe(false);
    expect(tokens.has("日")).toBe(true);
    expect(tokens.has("本")).toBe(true);
  });

  it("ignores punctuation", () => {
    const tokens = tokenize("!!! ???");
    expect(tokens.size).toBe(0);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical non-empty sets", () => {
    const setA = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(setA, setA)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    const setA = new Set(["a", "b"]);
    const setB = new Set(["c", "d"]);
    expect(jaccardSimilarity(setA, setB)).toBe(0);
  });

  it("returns 1 when both sets are empty", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when one set is empty and the other is not", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set(["a"]))).toBe(0);
  });

  it("computes intersection over union for partial overlap", () => {
    const setA = new Set(["a", "b"]);
    const setB = new Set(["b", "c"]);
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(1 / 3, 10);
  });
});

describe("textSimilarity", () => {
  it("returns 1 for identical ASCII text", () => {
    expect(textSimilarity("hello world", "hello world")).toBe(1);
  });

  it("is case-insensitive for ASCII tokens", () => {
    expect(textSimilarity("Hello WORLD", "hello world")).toBe(1);
  });

  it("returns 0 for disjoint text", () => {
    expect(textSimilarity("foo", "bar")).toBe(0);
  });

  it("computes token overlap for partial matches", () => {
    expect(textSimilarity("hello world", "hello goodbye")).toBeCloseTo(1 / 3, 10);
  });

  it("returns 1 for token-less strings that are identical after lowercasing", () => {
    expect(textSimilarity("!!!", "!!!")).toBe(1);
  });

  it("returns 0 for token-less strings that differ", () => {
    expect(textSimilarity("!!!", "???")).toBe(0);
  });
});

describe("bm25RankToScore", () => {
  it("returns 1 for rank 0", () => {
    expect(bm25RankToScore(0)).toBe(1);
  });

  it("returns 0.5 for rank 1", () => {
    expect(bm25RankToScore(1)).toBe(0.5);
  });

  it("returns 0.1 for rank 9", () => {
    expect(bm25RankToScore(9)).toBe(0.1);
  });

  it("maps negative ranks to higher scores", () => {
    expect(bm25RankToScore(-1)).toBe(0.5);
    expect(bm25RankToScore(-9)).toBe(0.9);
  });

  it("returns a small fallback for non-finite ranks", () => {
    expect(bm25RankToScore(Infinity)).toBeCloseTo(0.001, 10);
    expect(bm25RankToScore(-Infinity)).toBeCloseTo(0.001, 10);
    expect(bm25RankToScore(NaN)).toBeCloseTo(0.001, 10);
  });
});

describe("mergeHybridResults", () => {
  it("combines a vector-only result", () => {
    const merged = mergeHybridResults({
      vector: [vectorResult({ entryId: "a", text: "alpha beta", vectorScore: 1.0 })],
      keyword: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
      queryTags: [],
      entryTagsById: new Map(),
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.entryId).toBe("a");
    expect(merged[0]!.vectorScore).toBe(1.0);
    expect(merged[0]!.textScore).toBe(0);
    expect(merged[0]!.score).toBeCloseTo(0.7, 10);
  });

  it("combines a keyword-only result", () => {
    const merged = mergeHybridResults({
      vector: [],
      keyword: [keywordResult({ entryId: "a", text: "alpha beta", textScore: 0.5 })],
      vectorWeight: 0.7,
      textWeight: 0.3,
      queryTags: [],
      entryTagsById: new Map(),
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.vectorScore).toBe(0);
    expect(merged[0]!.textScore).toBe(0.5);
    expect(merged[0]!.score).toBeCloseTo(0.15, 10);
  });

  it("merges vector and keyword scores for the same entry", () => {
    const merged = mergeHybridResults({
      vector: [vectorResult({ entryId: "a", text: "alpha beta", vectorScore: 1.0 })],
      keyword: [keywordResult({ entryId: "a", text: "alpha beta", textScore: 0.5 })],
      vectorWeight: 0.7,
      textWeight: 0.3,
      queryTags: [],
      entryTagsById: new Map(),
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.vectorScore).toBe(1.0);
    expect(merged[0]!.textScore).toBe(0.5);
    expect(merged[0]!.score).toBeCloseTo(0.85, 10);
  });

  it("applies concept boost for matching tags", () => {
    const entryTagsById = new Map<string, string[]>([["a", ["tag1", "tag2"]]]);
    const merged = mergeHybridResults({
      vector: [vectorResult({ entryId: "a", text: "alpha beta", vectorScore: 1.0 })],
      keyword: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
      queryTags: ["tag1", "tag2"],
      entryTagsById,
    });
    expect(merged[0]!.conceptBoost).toBe(0.2);
    expect(merged[0]!.score).toBeCloseTo(0.9, 10);
  });

  it("caps concept boost at 0.3", () => {
    const entryTagsById = new Map<string, string[]>([["a", ["a", "b", "c", "d", "e"]]]);
    const merged = mergeHybridResults({
      vector: [vectorResult({ entryId: "a", text: "alpha beta", vectorScore: 1.0 })],
      keyword: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
      queryTags: ["a", "b", "c", "d", "e"],
      entryTagsById,
    });
    expect(merged[0]!.conceptBoost).toBe(0.3);
    expect(merged[0]!.score).toBeCloseTo(1.0, 10);
  });

  it("sorts results by score descending", () => {
    const merged = mergeHybridResults({
      vector: [
        vectorResult({ entryId: "low", text: "z", vectorScore: 0.2 }),
        vectorResult({ entryId: "high", text: "a", vectorScore: 0.9 }),
      ],
      keyword: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
      queryTags: [],
      entryTagsById: new Map(),
    });
    expect(merged.map((r) => r.entryId)).toEqual(["high", "low"]);
  });

  it("applies temporal decay to merged scores", () => {
    const now = 1_000_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    const merged = mergeHybridResults({
      vector: [vectorResult({ entryId: "a", text: "alpha beta", vectorScore: 1.0, updatedAt: now - 30 * dayMs })],
      keyword: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
      queryTags: [],
      entryTagsById: new Map(),
      nowMs: now,
    });
    expect(merged[0]!.score).toBeCloseTo(0.35, 10);
  });

  it("applies MMR diversification when enabled", () => {
    const merged = mergeHybridResults({
      vector: [
        vectorResult({ entryId: "a", text: "alpha beta gamma", vectorScore: 1.0 }),
        vectorResult({ entryId: "b", text: "alpha beta gamma", vectorScore: 0.9 }),
        vectorResult({ entryId: "c", text: "delta epsilon zeta", vectorScore: 0.8 }),
      ],
      keyword: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
      queryTags: [],
      entryTagsById: new Map(),
      mmr: { enabled: true, lambda: 0.5 },
    });
    expect(merged.map((r) => r.entryId)).toEqual(["a", "c", "b"]);
  });

  it("returns an empty array when both inputs are empty", () => {
    const merged = mergeHybridResults({
      vector: [],
      keyword: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
      queryTags: [],
      entryTagsById: new Map(),
    });
    expect(merged).toEqual([]);
  });
});

describe("applyTemporalDecay", () => {
  it("returns the same array when disabled", () => {
    const results: HybridResult[] = [makeHybridResult({ entryId: "a", score: 1.0 })];
    expect(applyTemporalDecay(results, { enabled: false })).toBe(results);
  });

  it("leaves entries with no updatedAt unchanged", () => {
    const entry = makeHybridResult({ entryId: "a", score: 1.0, updatedAt: null });
    const out = applyTemporalDecay([entry]);
    expect(out[0]!.score).toBe(1.0);
    expect(out[0]!).toBe(entry);
  });

  it("reduces scores for older entries", () => {
    const now = 1_000_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    const entry = makeHybridResult({ entryId: "a", score: 1.0, updatedAt: now - 30 * dayMs });
    const out = applyTemporalDecay([entry], {}, now);
    expect(out[0]!.score).toBeCloseTo(0.5, 10);
  });

  it("halves the score after each half-life", () => {
    const now = 1_000_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    const entry = makeHybridResult({ entryId: "a", score: 1.0, updatedAt: now - 60 * dayMs });
    const out = applyTemporalDecay([entry], {}, now);
    expect(out[0]!.score).toBeCloseTo(0.25, 10);
  });

  it("clamps future updatedAt to age 0", () => {
    const now = 1_000_000_000_000;
    const entry = makeHybridResult({ entryId: "a", score: 1.0, updatedAt: now + 10_000 });
    const out = applyTemporalDecay([entry], {}, now);
    expect(out[0]!.score).toBeCloseTo(1.0, 10);
  });
});

describe("applyMMR", () => {
  it("returns an empty array for empty input", () => {
    expect(applyMMR([])).toEqual([]);
  });

  it("returns the same order when disabled", () => {
    const results: HybridResult[] = [
      makeHybridResult({ entryId: "a", score: 1.0, text: "alpha beta" }),
      makeHybridResult({ entryId: "b", score: 0.5, text: "gamma delta" }),
    ];
    const out = applyMMR(results, { enabled: false });
    expect(out.map((r) => r.entryId)).toEqual(["a", "b"]);
  });

  it("diversifies results when enabled", () => {
    const results: HybridResult[] = [
      makeHybridResult({ entryId: "a", score: 1.0, text: "alpha beta gamma" }),
      makeHybridResult({ entryId: "b", score: 0.9, text: "alpha beta gamma" }),
      makeHybridResult({ entryId: "c", score: 0.8, text: "delta epsilon zeta" }),
    ];
    const out = applyMMR(results, { enabled: true, lambda: 0.5 });
    expect(out.map((r) => r.entryId)).toEqual(["a", "c", "b"]);
  });

  it("sorts by relevance when lambda is 1", () => {
    const results: HybridResult[] = [
      makeHybridResult({ entryId: "low", score: 0.3, text: "x" }),
      makeHybridResult({ entryId: "high", score: 0.9, text: "y" }),
    ];
    const out = applyMMR(results, { enabled: true, lambda: 1.0 });
    expect(out.map((r) => r.entryId)).toEqual(["high", "low"]);
  });
});
