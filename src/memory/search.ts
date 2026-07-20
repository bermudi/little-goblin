/**
 * Hybrid memory search: fuses vector cosine similarity, FTS5 BM25, concept-tag
 * boosts, temporal decay, and optional MMR re-ranking.
 *
 * The search is read-only and never mutates memory files. It operates over the
 * SQLite-backed store, using `memory_embeddings`, `memory_index_fts`, and
 * `memory_entry_tags`.
 */

import type { MemoryStore } from "./store.ts";
import type { MetricsStore } from "../metrics/mod.ts";
import { log } from "../log.ts";
import { deriveConceptTags } from "./concept-vocabulary.ts";
import { activeMemoryScopeFor, scopeTag, type ActiveScope, type MemoryScope } from "./scope.ts";
import {
  ENTRY_CATEGORIES,
  parseEntryMetadata,
  type EntryCategory,
  type EntryMetadata,
  type EntrySourceRole,
} from "./entry.ts";
import {
  applyMMR,
  bm25RankToScore,
  buildFtsQuery,
  mergeHybridResults,
  type HybridResult,
} from "./hybrid.ts";

export { stripEntryMetadata } from "./entry.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a searched entry lives — mirrors the memory tool's `target` concept. */
export type MemorySearchTarget = "user" | "memory" | "agent";

function temporalDecayFromEnv(): { halfLifeDays: number } | undefined {
  const raw = process.env.GOBLIN_MEMORY_TEMPORAL_HALFLIFE_DAYS;
  if (raw === undefined) return undefined;
  const days = Number.parseFloat(raw);
  return Number.isFinite(days) && days > 0 ? { halfLifeDays: days } : undefined;
}

export interface MemorySearchInput {
  /** Free-form query text. Whitespace-only/empty queries are rejected upstream. */
  query: string;
  /** Maximum results to return after ranking. Defaults to 10, clamped to [1, 50]. */
  limit?: number;
  /** When true, enumerate topic scopes from every chat. Default: current chat only. */
  allChats?: boolean;
  /**
   * Which corpora to search:
   * - `memory` (default): curated memory and user entries.
   * - `transcripts`: indexed transcript chunks.
   * - `all`: both.
   */
  corpus?: "memory" | "transcripts" | "all";
  /** Restrict search to a single memory scope. When provided, corpus is treated as `memory`. */
  scope?: MemoryScope | "user";
}

/** A single ranked search result. */
export interface MemorySearchResultEntry {
  /** Entry primary key in the SQLite store. */
  entryId: string;
  /** Stable scope identifier, e.g. `user`, `general`, `topics/-100/42`, `agents/researcher`. */
  scope: string;
  /** Raw entry_kind from the database: `memory`, `user`, or `transcript`. */
  entryKind: "memory" | "user" | "transcript";
  /** Memory tool target equivalent: `user`, `memory` (active/general/topic), or `agent` (persona). */
  target: MemorySearchTarget;
  /** Human-readable entry body, truncated to 500 chars with `...` suffix. */
  text: string;
  /** Deterministic ranking score; higher is better. */
  score: number;
  /** Vector component of the score, when available. */
  vectorScore: number;
  /** Keyword (BM25) component of the score, when available. */
  textScore: number;
  /** Concept-tag boost applied. */
  conceptBoost: number;
  /** Concept vocabulary tags attached to the entry. */
  tags: string[];
  /** Source corpus: `memory` for curated entries, `transcript` for transcript chunks. */
  source: "memory" | "transcript";
  /** Session id, present only for transcript results. */
  sessionId?: string;
  /** Approximate timestamp (unix ms), present only for transcript results. */
  timestamp?: number;
  /** Parsed reflected-entry metadata when present, else null. */
  metadata: EntryMetadata | null;
}

export interface MemorySearchOutput {
  query: string;
  /** Number of distinct scopes enumerated for the search (including empty/non-matching scopes). */
  searchedScopes: number;
  /** True when the embedding provider was unavailable and search fell back to BM25-only. */
  degraded: boolean;
  /** Optional warning describing why the search was degraded. */
  warning?: string;
  results: MemorySearchResultEntry[];
}

// ---------------------------------------------------------------------------
// Persona-eligibility policy
// ---------------------------------------------------------------------------

/**
 * Persona scope eligibility for the caller. Mirrors the `memory_read_index`
 * `agents` gating: the main goblin agent searches every persona scope; a
 * named subagent searches only its own; an anonymous subagent searches none.
 */
export type PersonaPolicy =
  | { kind: "all" }
  | { kind: "own"; name: string }
  | { kind: "none" };

// ---------------------------------------------------------------------------
// Limit clamping
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored <= 0) return DEFAULT_LIMIT;
  if (floored > MAX_LIMIT) return MAX_LIMIT;
  return floored;
}

// ---------------------------------------------------------------------------
// Scope enumeration
// ---------------------------------------------------------------------------

interface EnumeratedScope {
  scope: MemoryScope | "user";
  tag: string;
  target: MemorySearchTarget;
}

async function enumerateMemoryScopes(
  store: MemoryStore,
  activeScope: ActiveScope,
  persona: PersonaPolicy,
  allChats: boolean,
): Promise<EnumeratedScope[]> {
  const scopes: EnumeratedScope[] = [];

  // 1. user.md
  scopes.push({ scope: "user", tag: "user", target: "user" });

  // 2. Active scope (topic or general).
  const activeMemory = activeMemoryScopeFor(activeScope);
  scopes.push({ scope: activeMemory, tag: scopeTag(activeMemory), target: "memory" });

  // 3. General memory (always in scope; dedup with active when active IS general).
  if (activeMemory !== "general") {
    scopes.push({ scope: "general", tag: "general", target: "memory" });
  }

  // 4. Same-chat (or all-chat) topic scopes from the index, excluding the active topic.
  const index = await store.listIndex({
    chatId: allChats ? undefined : activeScope.chatId,
    includeAgents: false,
  });
  const activeTopicId = activeScope.topicScope === "general" ? null : activeScope.topicScope.topicId;
  for (const topic of index.topics) {
    if (topic.chatId === activeScope.chatId && topic.topicId === activeTopicId) continue;
    const scope: MemoryScope = { topic: { chatId: topic.chatId, topicId: topic.topicId } };
    scopes.push({ scope, tag: scopeTag(scope), target: "memory" });
  }

  // 5. Persona scopes per the eligibility policy.
  if (persona.kind === "all") {
    const agentIndex = await store.listIndex({ chatId: activeScope.chatId, includeAgents: true });
    for (const agent of agentIndex.agents) {
      const scope: MemoryScope = { agent: { name: agent.name } };
      scopes.push({ scope, tag: scopeTag(scope), target: "agent" });
    }
  } else if (persona.kind === "own") {
    const scope: MemoryScope = { agent: { name: persona.name } };
    scopes.push({ scope, tag: scopeTag(scope), target: "agent" });
  }

  return scopes;
}

async function enumerateTranscriptScopes(
  store: MemoryStore,
  activeScope: ActiveScope,
  allChats: boolean,
): Promise<string[]> {
  const chatId = activeScope.chatId;
  const rows = store.db.database
    .query<{ scope: string }, { $chatId: string | null }>(
      `SELECT DISTINCT scope FROM memory_entries
       WHERE entry_kind = 'transcript'
         AND ($chatId IS NULL OR chat_id = $chatId)`,
    )
    .all({ $chatId: allChats ? null : String(chatId) });
  return rows.map((r) => r.scope);
}

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  const cosine = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // OpenAI embeddings are normalized and non-negative for most practical text;
  // clamp to [0, 1] so the score stays a standard similarity.
  return Math.max(0, Math.min(1, cosine));
}

function normalizeVectorScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}

interface VectorCandidate {
  entryId: string;
  scope: string;
  entryKind: string;
  text: string;
  updatedAt: number | null;
  createdAt: number | null;
  category: string | null;
  confidence: number | null;
  sourceSession: string | null;
  updatedSourceSession: string | null;
  sourceRole: string | null;
  origin: string | null;
  vectorScore: number;
  embedding: Float32Array;
}

async function vectorSearch(args: {
  store: MemoryStore;
  query: string;
  scopes: string[];
  kinds: string[];
  chatId: string | null;
}): Promise<{ rows: Array<Omit<HybridResult, "score" | "textScore" | "conceptBoost"> & { vectorScore: number }>; degraded: boolean }> {
  const provider = args.store.embeddingProvider;
  if (!provider) {
    return { rows: [], degraded: false };
  }

  // Embed the query with the model recorded in memory_meta. During a model-
  // change reindex that meta key still points to the old model until the
  // reindex completes, so vector comparisons stay dimension-compatible and use
  // the existing (potentially stale) embeddings rather than the new model.
  const configuredModel = provider.modelName;
  const storedModel = args.store.db.getMeta("embedding_model");
  const queryModel = storedModel ?? configuredModel;

  const { embedding, degraded } = await provider.embedQuery(args.query, queryModel);
  if (embedding === null) {
    return { rows: [], degraded };
  }

  const placeholders = args.scopes.map(() => "?").join(",");
  const kindPlaceholders = args.kinds.map(() => "?").join(",");
  const modelFilter = " AND em.model = ?";
  const params: (string | null)[] = [...args.scopes, ...args.kinds, args.chatId, queryModel];
  const rows = args.store.db.database
    .query<
      { id: string; scope: string; entry_kind: string; text: string; updated_at: number | null; created_at: number | null; category: string | null; confidence: number | null; source_session: string | null; updated_source_session: string | null; source_role: string | null; origin: string | null; embedding: Uint8Array; dims: number },
      (string | null)[]
    >(
      `SELECT e.id, e.scope, e.entry_kind, e.text, e.updated_at, e.created_at, e.category, e.confidence, e.source_session, e.updated_source_session, e.source_role, e.origin, em.embedding, em.dims
       FROM memory_entries e
       JOIN memory_embeddings em ON e.id = em.entry_id
       WHERE e.scope IN (${placeholders})
         AND e.entry_kind IN (${kindPlaceholders})
         AND ($chatId IS NULL OR e.chat_id = $chatId OR (e.chat_id IS NULL AND e.entry_kind IN ('memory', 'user')))
         ${modelFilter}`,
    )
    .all(...params);

  const results: VectorCandidate[] = [];
  for (const row of rows) {
    const bytes = new Uint8Array(row.embedding);
    const candidate = new Float32Array(bytes.buffer, bytes.byteOffset, row.dims);
    const cosine = cosineSimilarity(embedding, candidate);
    results.push({
      entryId: row.id,
      scope: row.scope,
      entryKind: row.entry_kind,
      text: row.text,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      category: row.category,
      confidence: row.confidence,
      sourceSession: row.source_session,
      updatedSourceSession: row.updated_source_session,
      sourceRole: row.source_role,
      origin: row.origin,
      vectorScore: normalizeVectorScore(cosine),
      embedding: candidate,
    });
  }

  return {
    rows: results.map(({ embedding, ...r }) => r),
    degraded,
  };
}

// ---------------------------------------------------------------------------
// Keyword search
// ---------------------------------------------------------------------------

function keywordSearch(args: {
  store: MemoryStore;
  query: string;
  scopes: string[];
  kinds: string[];
  chatId: string | null;
}): Array<Omit<HybridResult, "score" | "vectorScore" | "conceptBoost"> & { textScore: number }> {
  const ftsQuery = buildFtsQuery(args.query);
  if (ftsQuery === null) return [];

  const scopePlaceholders = args.scopes.map(() => "?").join(",");
  const kindPlaceholders = args.kinds.map(() => "?").join(",");
  const rows = args.store.db.database
    .query<
      { entry_id: string; text: string; scope: string; entry_kind: string; updated_at: number | null; created_at: number | null; category: string | null; confidence: number | null; source_session: string | null; updated_source_session: string | null; source_role: string | null; origin: string | null; rank: number },
      (string | null)[]
    >(
      `SELECT e.id AS entry_id, e.text, e.scope, e.entry_kind, e.updated_at, e.created_at, e.category, e.confidence, e.source_session, e.updated_source_session, e.source_role, e.origin, rank
       FROM memory_index_fts
       JOIN memory_entries e ON memory_index_fts.entry_id = e.id
       WHERE memory_index_fts MATCH ?
         AND e.scope IN (${scopePlaceholders})
         AND e.entry_kind IN (${kindPlaceholders})
         AND ($chatId IS NULL OR e.chat_id = $chatId OR (e.chat_id IS NULL AND e.entry_kind IN ('memory', 'user')))
       ORDER BY rank ASC`,
    )
    .all(ftsQuery, ...args.scopes, ...args.kinds, args.chatId);

  return rows.map((row) => {
    return {
      entryId: row.entry_id,
      scope: row.scope,
      entryKind: row.entry_kind,
      text: row.text,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      category: row.category,
      confidence: row.confidence,
      sourceSession: row.source_session,
      updatedSourceSession: row.updated_source_session,
      sourceRole: row.source_role,
      origin: row.origin,
      textScore: bm25RankToScore(row.rank),
    };
  });
}

// ---------------------------------------------------------------------------
// Concept tags
// ---------------------------------------------------------------------------

function loadEntryTags(store: MemoryStore, entryIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (entryIds.length === 0) return map;
  const placeholders = entryIds.map(() => "?").join(",");
  const rows = store.db.database
    .query<{ entry_id: string; tag: string }, string[]>(
      `SELECT entry_id, tag FROM memory_entry_tags WHERE entry_id IN (${placeholders})`,
    )
    .all(...entryIds);
  for (const row of rows) {
    const list = map.get(row.entry_id) ?? [];
    list.push(row.tag);
    map.set(row.entry_id, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

export const RESULT_TEXT_MAX = 500;

export function truncateResultText(text: string): string {
  if (text.length <= RESULT_TEXT_MAX) return text;
  return text.slice(0, RESULT_TEXT_MAX) + "...";
}

function sessionIdFromTranscriptScope(scope: string): string | undefined {
  const prefix = "transcript/";
  if (!scope.startsWith(prefix)) return undefined;
  const id = scope.slice(prefix.length);
  return id.length > 0 ? id : undefined;
}

function targetForScope(scope: string): MemorySearchTarget {
  if (scope === "user") return "user";
  if (scope.startsWith("agents/")) return "agent";
  return "memory";
}

function buildEntryMetadata(result: HybridResult): EntryMetadata | null {
  if (
    result.category === null ||
    result.category === undefined ||
    result.confidence === null ||
    result.confidence === undefined ||
    result.createdAt === null ||
    result.createdAt === undefined ||
    result.updatedAt === null ||
    result.updatedAt === undefined
  ) {
    return null;
  }
  if (!(ENTRY_CATEGORIES as readonly string[]).includes(result.category)) {
    return null;
  }
  const sourceRole: EntrySourceRole =
    result.sourceRole === "user" || result.sourceRole === "assistant" || result.sourceRole === "tool"
      ? result.sourceRole
      : "system";
  const metadata: EntryMetadata = {
    category: result.category as EntryCategory,
    confidence: result.confidence,
    created_at: new Date(result.createdAt).toISOString(),
    updated_at: new Date(result.updatedAt).toISOString(),
    source_session: result.sourceSession ?? "",
    source_role: sourceRole,
  };
  if (result.updatedSourceSession !== null && result.updatedSourceSession !== undefined) {
    metadata.updated_source_session = result.updatedSourceSession;
  }
  return metadata;
}

function buildMemoryResult(result: HybridResult, tags: string[]): MemorySearchResultEntry {
  const parsedFromText = parseEntryMetadata(result.text);
  const body = parsedFromText?.body ?? result.text;
  const metadata = buildEntryMetadata(result) ?? parsedFromText?.metadata ?? null;
  const entry: MemorySearchResultEntry = {
    entryId: result.entryId,
    scope: result.scope,
    entryKind: result.entryKind as "memory" | "user" | "transcript",
    target: targetForScope(result.scope),
    text: truncateResultText(body),
    score: Number.isFinite(result.score) ? result.score : 0,
    vectorScore: Number.isFinite(result.vectorScore) ? result.vectorScore : 0,
    textScore: Number.isFinite(result.textScore) ? result.textScore : 0,
    conceptBoost: Number.isFinite(result.conceptBoost) ? result.conceptBoost : 0,
    tags,
    source: result.entryKind === "transcript" ? "transcript" : "memory",
    metadata,
  };
  if (result.entryKind === "transcript") {
    const sessionId = sessionIdFromTranscriptScope(result.scope);
    if (sessionId) entry.sessionId = sessionId;
    if (result.updatedAt !== null && Number.isFinite(result.updatedAt)) {
      entry.timestamp = result.updatedAt;
    }
  }
  return entry;
}

function updateRecallStats(store: MemoryStore, entryIds: string[]): void {
  if (entryIds.length === 0) return;
  try {
    const placeholders = entryIds.map(() => "?").join(",");
    const now = Date.now();
    store.db.database
      .query(
        `UPDATE memory_entries
         SET recall_count = COALESCE(recall_count, 0) + 1,
             last_recalled_at = $now
         WHERE id IN (${placeholders})`,
      )
      .run(now, ...entryIds);
  } catch (err) {
    log.warn("memory search: failed to update recall stats", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Public search
// ---------------------------------------------------------------------------

export async function searchMemoryEntries(args: {
  store: MemoryStore;
  activeScope: ActiveScope;
  persona: PersonaPolicy;
  query: string;
  limit?: number;
  allChats?: boolean;
  corpus?: "memory" | "transcripts" | "all";
  /** Restrict search to a single memory scope. When provided, corpus is treated as `memory`. */
  scope?: MemoryScope | "user";
  /** Override the wall clock for deterministic recency tests. */
  nowMs?: number;
  /** Optional metrics store to record the search event. */
  metrics?: MetricsStore;
}): Promise<MemorySearchOutput> {
  const limit = clampLimit(args.limit);
  const corpus = args.corpus ?? "all";
  const allChats = args.allChats ?? false;
  const noChatId = args.activeScope.chatId === 0;
  const transcriptAllChats = allChats || noChatId;
  const nowMs = args.nowMs ?? Date.now();
  const weights = args.store.db.weights;

  const queryTags = deriveConceptTags({ snippet: args.query, limit: 8 });

  const memoryKinds = ["memory", "user"];
  const transcriptKinds = ["transcript"];
  const allKinds = corpus === "all" ? [...memoryKinds, ...transcriptKinds] : corpus === "memory" ? memoryKinds : transcriptKinds;

  let memoryScopes: string[] = [];
  if (corpus === "memory" || corpus === "all") {
    if (args.scope !== undefined) {
      memoryScopes = [scopeTag(args.scope)];
    } else {
      const enumerated = await enumerateMemoryScopes(args.store, args.activeScope, args.persona, allChats);
      memoryScopes = enumerated.map((s) => s.tag);
    }
  }

  let transcriptScopes: string[] = [];
  if (corpus === "transcripts" || corpus === "all" && args.scope === undefined) {
    transcriptScopes = await enumerateTranscriptScopes(args.store, args.activeScope, transcriptAllChats);
  }

  const scopes = [...memoryScopes, ...transcriptScopes];
  const searchedScopes = scopes.length;

  if (scopes.length === 0) {
    args.metrics?.record({
      type: "event",
      name: "memory_search",
      scope: null,
      extra: { query: args.query, scopes: 0, resultCount: 0, limit, degraded: false },
    });
    return { query: args.query, searchedScopes: 0, degraded: false, results: [] };
  }

  const activeChatId = ((): string | null => {
    if (allChats || noChatId) return null;
    if (args.scope === undefined) return String(args.activeScope.chatId);
    if (args.scope === "user") return null;
    if (typeof args.scope === "object" && "topic" in args.scope) return String(args.scope.topic.chatId);
    return null; // general or agent scope
  })();

  const [vector, keywordRows] = await Promise.all([
    vectorSearch({ store: args.store, query: args.query, scopes, kinds: allKinds, chatId: activeChatId }),
    Promise.resolve(keywordSearch({ store: args.store, query: args.query, scopes, kinds: allKinds, chatId: activeChatId })),
  ]);

  const candidateIds = new Set<string>();
  for (const r of vector.rows) candidateIds.add(r.entryId);
  for (const r of keywordRows) candidateIds.add(r.entryId);
  const entryTagsById = loadEntryTags(args.store, Array.from(candidateIds));

  let merged = mergeHybridResults({
    vector: vector.rows,
    keyword: keywordRows,
    vectorWeight: weights.vectorWeight,
    textWeight: weights.textWeight,
    queryTags,
    entryTagsById,
    nowMs,
    temporalDecay: temporalDecayFromEnv(),
  });

  // Apply MMR re-ranking when the candidate pool is more than twice the requested limit.
  if (merged.length > limit * 2) {
    merged = applyMMR(merged, { enabled: true, lambda: 0.7 });
  }

  const ranked = merged.slice(0, limit);

  // Update recall stats for curated memory entries only (transcripts are not
  // eligible for recall-aware compaction).
  const memoryIds = ranked.filter((r) => r.entryKind === "memory" || r.entryKind === "user").map((r) => r.entryId);
  updateRecallStats(args.store, memoryIds);

  const degraded = vector.degraded;
  const warning = degraded ? args.store.embeddingProvider?.status().lastError : undefined;

  args.metrics?.record({
    type: "event",
    name: "memory_search",
    scope: null,
    extra: {
      query: args.query,
      scopes: searchedScopes,
      resultCount: ranked.length,
      limit,
      degraded,
    },
  });

  return {
    query: args.query,
    searchedScopes,
    degraded,
    warning,
    results: ranked.map((r) => buildMemoryResult(r, entryTagsById.get(r.entryId) ?? [])),
  };
}


