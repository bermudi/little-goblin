/**
 * Hybrid search scoring: fuses vector and BM25 scores, applies concept-tag
 * boost, temporal decay, and MMR re-ranking.
 *
 * Ported and inlined from the OpenClaw memory-core reference sources.
 *
 * Copyright (c) 2026 OpenClaw Foundation
 * SPDX-License-Identifier: MIT
 */

const CJK_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u1100-\u11ff]/;

export function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z0-9_]+/g) ?? [];
  const chars = Array.from(lower);
  const cjkData: { char: string; index: number }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (CJK_RE.test(ch)) {
      cjkData.push({ char: ch, index: i });
    }
  }
  const bigrams: string[] = [];
  for (let i = 0; i < cjkData.length - 1; i++) {
    const a = cjkData[i]!;
    const b = cjkData[i + 1]!;
    if (b.index === a.index + 1) {
      bigrams.push(a.char + b.char);
    }
  }
  const unigrams = cjkData.map((d) => d.char);
  return new Set([...ascii, ...bigrams, ...unigrams]);
}

export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersectionSize = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  for (const token of smaller) {
    if (larger.has(token)) {
      intersectionSize++;
    }
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

export function textSimilarity(contentA: string, contentB: string): number {
  const tokensA = tokenize(contentA);
  const tokensB = tokenize(contentB);
  if (tokensA.size === 0 && tokensB.size === 0) {
    return contentA.toLowerCase() === contentB.toLowerCase() ? 1 : 0;
  }
  return jaccardSimilarity(tokensA, tokensB);
}

export function buildFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const normalized = tokens.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (normalized.length === 0) return null;
  const quoted = normalized.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) {
    return 1 / (1 + 999);
  }
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}

export interface MMRConfig {
  enabled: boolean;
  lambda: number;
}

export const DEFAULT_MMR_CONFIG: MMRConfig = { enabled: false, lambda: 0.7 };

interface MMRItem {
  id: string;
  score: number;
  content: string;
}

function computeMMRScore(relevance: number, maxSimilarity: number, lambda: number): number {
  return lambda * relevance - (1 - lambda) * maxSimilarity;
}

function maxSimilarityToSelected(item: MMRItem, selectedItems: MMRItem[], tokenCache: Map<string, Set<string>>): number {
  if (selectedItems.length === 0) return 0;
  let maxSim = 0;
  const itemTokens = tokenCache.get(item.id) ?? tokenize(item.content);
  for (const selected of selectedItems) {
    const selectedTokens = tokenCache.get(selected.id) ?? tokenize(selected.content);
    const sim = jaccardSimilarity(itemTokens, selectedTokens);
    if (sim > maxSim) maxSim = sim;
  }
  return maxSim;
}

function mmrRerank<T extends MMRItem>(items: T[], config: Partial<MMRConfig> = {}): T[] {
  const { enabled = DEFAULT_MMR_CONFIG.enabled, lambda = DEFAULT_MMR_CONFIG.lambda } = config;
  if (!enabled || items.length <= 1) return [...items];
  const clampedLambda = Math.max(0, Math.min(1, lambda));
  if (clampedLambda === 1) {
    return [...items].toSorted((a, b) => b.score - a.score);
  }
  const tokenCache = new Map<string, Set<string>>();
  for (const item of items) {
    tokenCache.set(item.id, tokenize(item.content));
  }
  const maxScore = Math.max(...items.map((i) => i.score));
  const minScore = Math.min(...items.map((i) => i.score));
  const scoreRange = maxScore - minScore;
  const normalizeScore = (score: number): number => {
    if (scoreRange === 0) return 1;
    return (score - minScore) / scoreRange;
  };
  const selected: T[] = [];
  const remaining = new Set(items);
  while (remaining.size > 0) {
    let bestItem: T | null = null;
    let bestMMRScore = -Infinity;
    for (const candidate of remaining) {
      const normalizedRelevance = normalizeScore(candidate.score);
      const maxSim = maxSimilarityToSelected(candidate, selected, tokenCache);
      const mmrScore = computeMMRScore(normalizedRelevance, maxSim, clampedLambda);
      if (
        mmrScore > bestMMRScore ||
        (mmrScore === bestMMRScore && candidate.score > (bestItem?.score ?? -Infinity))
      ) {
        bestMMRScore = mmrScore;
        bestItem = candidate;
      }
    }
    if (bestItem) {
      selected.push(bestItem);
      remaining.delete(bestItem);
    } else {
      break;
    }
  }
  return selected;
}

export interface TemporalDecayConfig {
  enabled: boolean;
  halfLifeDays: number;
}

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = { enabled: true, halfLifeDays: 30 };

function toDecayLambda(halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
  return Math.LN2 / halfLifeDays;
}

export function calculateTemporalDecayMultiplier(ageInDays: number, halfLifeDays: number): number {
  const lambda = toDecayLambda(halfLifeDays);
  const clampedAge = Math.max(0, ageInDays);
  if (lambda <= 0 || !Number.isFinite(clampedAge)) return 1;
  return Math.exp(-lambda * clampedAge);
}

export interface HybridResult {
  entryId: string;
  scope: string;
  entryKind: string;
  text: string;
  score: number;
  vectorScore: number;
  textScore: number;
  conceptBoost: number;
  updatedAt: number | null;
}

export function applyTemporalDecay(
  results: HybridResult[],
  config: Partial<TemporalDecayConfig> = {},
  nowMs = Date.now(),
): HybridResult[] {
  const { enabled = DEFAULT_TEMPORAL_DECAY_CONFIG.enabled, halfLifeDays = DEFAULT_TEMPORAL_DECAY_CONFIG.halfLifeDays } = config;
  if (!enabled) return results;
  const dayMs = 24 * 60 * 60 * 1000;
  return results.map((entry) => {
    if (!entry.updatedAt) return entry;
    const ageMs = Math.max(0, nowMs - entry.updatedAt);
    const multiplier = calculateTemporalDecayMultiplier(ageMs / dayMs, halfLifeDays);
    return { ...entry, score: entry.score * multiplier };
  });
}

export function applyMMR(results: HybridResult[], config: Partial<MMRConfig> = {}): HybridResult[] {
  if (results.length === 0) return results;
  const mmrItems: MMRItem[] = results.map((r, index) => ({
    id: `${r.entryId}:${index}`,
    score: r.score,
    content: r.text,
  }));
  const reranked = mmrRerank(mmrItems, config);
  const byId = new Map<string, HybridResult>();
  for (const r of results) {
    byId.set(`${r.entryId}:${results.indexOf(r)}`, r);
  }
  // Map back preserving the original ordering stable id: index match.
  const resultById = new Map<string, HybridResult>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    resultById.set(`${r.entryId}:${i}`, r);
  }
  return reranked.map((item) => resultById.get(item.id)!);
}

export function mergeHybridResults(params: {
  vector: Array<Omit<HybridResult, "score" | "textScore" | "conceptBoost"> & { vectorScore: number }>;
  keyword: Array<Omit<HybridResult, "score" | "vectorScore" | "conceptBoost"> & { textScore: number }>;
  vectorWeight: number;
  textWeight: number;
  queryTags: string[];
  entryTagsById: Map<string, string[]>;
  mmr?: Partial<MMRConfig>;
  temporalDecay?: Partial<TemporalDecayConfig>;
  nowMs?: number;
}): HybridResult[] {
  const byId = new Map<string, HybridResult>();
  for (const r of params.vector) {
    const tags = params.entryTagsById.get(r.entryId) ?? [];
    const matchingTagCount = params.queryTags.filter((t) => tags.includes(t)).length;
    const conceptBoost = Math.min(0.1 * matchingTagCount, 0.3);
    const vectorScore = r.vectorScore;
    const textScore = 0;
    const score = params.vectorWeight * vectorScore + params.textWeight * textScore + conceptBoost;
    byId.set(r.entryId, { ...r, score, vectorScore, textScore, conceptBoost, updatedAt: r.updatedAt ?? null });
  }
  for (const r of params.keyword) {
    const existing = byId.get(r.entryId);
    const tags = params.entryTagsById.get(r.entryId) ?? [];
    const matchingTagCount = params.queryTags.filter((t) => tags.includes(t)).length;
    const conceptBoost = Math.min(0.1 * matchingTagCount, 0.3);
    if (existing) {
      existing.textScore = r.textScore;
      existing.score = params.vectorWeight * existing.vectorScore + params.textWeight * r.textScore + conceptBoost;
      existing.conceptBoost = conceptBoost;
    } else {
      byId.set(r.entryId, {
        ...r,
        score: params.vectorWeight * 0 + params.textWeight * r.textScore + conceptBoost,
        vectorScore: 0,
        textScore: r.textScore,
        conceptBoost,
        updatedAt: r.updatedAt ?? null,
      });
    }
  }
  let merged = Array.from(byId.values());
  merged = applyTemporalDecay(merged, params.temporalDecay, params.nowMs);
  merged = merged.toSorted((a, b) => b.score - a.score);
  if (params.mmr?.enabled) {
    merged = applyMMR(merged, params.mmr);
  }
  return merged;
}
