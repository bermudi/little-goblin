/**
 * File-native lexical memory search.
 *
 * Pure read-only layer over the existing `MemoryStore`. Enumerates the
 * caller's eligible scopes, splits each memory body by the existing `\n§\n`
 * delimiter, parses/strips reflected-entry metadata, normalizes query and
 * entry text to lexical tokens, and ranks entries by a deterministic score.
 *
 * Spec contract (`Memory search ranks entries lexically`,
 * `Memory search defaults to current chat scopes`):
 *   - relative signal ordering is overlap > exact phrase > boosts > recency;
 *   - search defaults to the current chat's scopes plus `user.md` and
 *     eligible persona scopes, with `all_chats` broadening topic scope
 *     enumeration to every chat;
 *   - search never mutates any memory file.
 */

import type { MemoryStore } from "./store.ts";
import {
  parseEntryMetadata,
  stripEntryMetadata,
  type EntryMetadata,
} from "./entry.ts";
import { scopeTag, type ActiveScope, type MemoryScope } from "./scope.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a searched entry lives — mirrors the memory tool's `target` concept. */
export type MemorySearchTarget = "user" | "memory" | "agent";

export interface MemorySearchInput {
  /** Free-form query text. Whitespace-only/empty queries are rejected upstream. */
  query: string;
  /** Maximum results to return after ranking. Defaults to 10, clamped to [1, 50]. */
  limit?: number;
  /** When true, enumerate topic scopes from every chat. Default: current chat only. */
  allChats?: boolean;
}

/** A single ranked search result. */
export interface MemorySearchResultEntry {
  /** Stable scope identifier, e.g. `user`, `general`, `topics/-100/42`, `agents/researcher`. */
  scope: string;
  /** Memory tool target equivalent: `user`, `memory` (active/general/topic), or `agent` (persona). */
  target: MemorySearchTarget;
  /** Human-readable entry body with any metadata comment stripped. */
  text: string;
  /** Deterministic ranking score; higher is better. */
  score: number;
  /** Parsed reflected-entry metadata when present, else null. */
  metadata: EntryMetadata | null;
}

export interface MemorySearchOutput {
  query: string;
  /** Number of distinct scopes enumerated for the search (including empty/non-matching scopes). */
  searchedScopes: number;
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

export function personaPolicyFor(activeScope: ActiveScope): PersonaPolicy {
  if (activeScope.namedAgent === null) return { kind: "all" };
  return { kind: "own", name: activeScope.namedAgent.name };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize text to lexical tokens: ASCII-lowercase, then split on every run
 * of non-(letter-or-digit) code points. Unicode letters and digits are
 * preserved as token characters; everything else is a separator. No
 * stemming, no stop-word removal, no Unicode case folding beyond ASCII.
 *
 * Spec link: `Memory search ranks entries lexically`.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  // \p{L} = Unicode letters, \p{N} = Unicode numbers. Everything else is a
  // separator. The ASCII lowercasing above is the only case folding applied.
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/**
 * Concrete weights are implementation-defined; the spec pins only the
 * relative signal ordering (overlap > exact phrase > boosts > recency). The
 * unit tests in `search.test.ts` assert that ordering directly with crafted
 * entries that isolate each signal. These weights exist in one place so the
 * ordering is testable and adjustable.
 *
 * Signal buckets (each must dominate the next):
 *   1. Token overlap — encoded as the overlap ratio in [0, 1] scaled to the
 *      OVERLAP_SCALE band so it dominates boosts + recency.
 *   2. Exact phrase — a present/absent bonus.
 *   3. Boosts — target (active memory > user > other) and reflected category.
 *   4. Recency — tiny monotonic bump from `updated_at`/`created_at` age.
 */
const OVERLAP_SCALE = 1_000_000;
const EXACT_PHRASE_BONUS = 10_000;
const ACTIVE_SCOPE_BOOST = 1_000;
const USER_SCOPE_BOOST = 800;
const AGENT_SCOPE_BOOST = 200;
const CATEGORY_BOOST: Partial<Record<EntryMetadata["category"], number>> = {
  decision: 90,
  commitment: 90,
  standing_order: 85,
  convention: 80,
  gotcha: 70,
  preference: 60,
  project_fact: 50,
  profile: 40,
};
/** Maximum recency contribution. Small enough to never overtake a boost. */
const RECENCY_MAX = 50;
/** Recency decay half-life in days — older entries trend toward 0 recency. */
const RECENCY_HALF_LIFE_DAYS = 180;

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/** Compute the Jaccard-style overlap ratio between query and entry tokens. */
function overlapRatio(queryTokens: string[], entryTokens: string[]): number {
  if (queryTokens.length === 0 || entryTokens.length === 0) return 0;
  const entrySet = new Set(entryTokens);
  let intersection = 0;
  for (const t of queryTokens) {
    if (entrySet.has(t)) intersection++;
  }
  // Use query coverage (matched query tokens / query tokens) as the primary
  // signal — a query fully covered by an entry is more relevant than one
  // partially covered, regardless of entry length. This keeps short entries
  // with high coverage from being drowned out by long, token-heavy entries.
  return intersection / queryTokens.length;
}

/** Whether the lowercased query appears as a contiguous substring. */
function hasExactPhrase(lowerQuery: string, lowerEntry: string): boolean {
  const q = lowerQuery.trim();
  if (q.length === 0) return false;
  return lowerEntry.includes(q);
}

/** Recency contribution in [0, RECENCY_MAX] from an ISO timestamp age. */
function recencyScore(metadata: EntryMetadata | null, nowMs: number): number {
  if (metadata === null) return 0;
  // Prefer updated_at when present, else created_at.
  const ts = Date.parse(metadata.updated_at);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (nowMs - ts) / (24 * 60 * 60 * 1000));
  // Exponential decay toward 0; recent entries score highest.
  const factor = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return Math.round(factor * RECENCY_MAX);
}

/**
 * Compute a single entry's score. The bucketed structure (each signal
 * multiplied into a non-overlapping band) guarantees the spec's relative
 * ordering: overlap dominates exact phrase dominates boosts dominates
 * recency.
 */
export function scoreEntry(args: {
  queryTokens: string[];
  lowerQuery: string;
  lowerEntry: string;
  target: MemorySearchTarget;
  scopeTag: string;
  activeScopeTag: string;
  metadata: EntryMetadata | null;
  nowMs: number;
}): number {
  const overlap = overlapRatio(args.queryTokens, tokenize(args.lowerEntry));
  // Overlap dominates: scale into the top band. Entries with zero overlap
  // are filtered out before scoring, but the scale keeps partial-overlap
  // entries well above any boost/recency sum.
  let score = overlap * OVERLAP_SCALE;

  if (hasExactPhrase(args.lowerQuery, args.lowerEntry)) {
    score += EXACT_PHRASE_BONUS;
  }

  // Scope/target boost. Active memory scope ranks highest; user.md next;
  // persona/agent scopes last. General memory uses the memory boost only
  // when it is the active scope (handled via activeScopeTag equality).
  if (args.scopeTag === args.activeScopeTag) {
    score += ACTIVE_SCOPE_BOOST;
  } else if (args.target === "user") {
    score += USER_SCOPE_BOOST;
  } else if (args.target === "agent") {
    score += AGENT_SCOPE_BOOST;
  }

  if (args.metadata !== null) {
    const cat = CATEGORY_BOOST[args.metadata.category];
    if (cat !== undefined) score += cat;
  }

  score += recencyScore(args.metadata, args.nowMs);

  return score;
}

// ---------------------------------------------------------------------------
// Scope enumeration
// ---------------------------------------------------------------------------

interface EnumeratedScope {
  scope: MemoryScope | "user";
  tag: string;
  target: MemorySearchTarget;
}

/**
 * Enumerate the scopes eligible for search given the active scope, the
 * persona-eligibility policy, and the `all_chats` flag. Always includes
 * `user.md`, the active scope, and general memory. Topic scopes default to
 * the active chat; `all_chats` broadens to every chat. Persona scopes
 * follow the policy.
 */
async function enumerateScopes(
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
  scopes.push({
    scope: activeMemory,
    tag: scopeTag(activeMemory),
    target: "memory",
  });

  // 3. General memory (always in scope; dedup with active when active IS general).
  if (activeMemory !== "general") {
    scopes.push({ scope: "general", tag: "general", target: "memory" });
  }

  // 4. Same-chat (or all-chat) topic scopes from the index, excluding the
  //    active topic to avoid double-scanning.
  const index = await store.listIndex({
    chatId: allChats ? undefined : activeScope.chatId,
    includeAgents: false,
  });
  const activeTopicId =
    activeScope.topicScope === "general" ? null : activeScope.topicScope.topicId;
  for (const topic of index.topics) {
    if (!allChats && topic.chatId !== activeScope.chatId) continue;
    if (topic.chatId === activeScope.chatId && topic.topicId === activeTopicId) {
      continue;
    }
    const scope: MemoryScope = { topic: { chatId: topic.chatId, topicId: topic.topicId } };
    scopes.push({ scope, tag: scopeTag(scope), target: "memory" });
  }

  // 5. Persona scopes per the eligibility policy.
  if (persona.kind === "all") {
    const agentIndex = await store.listIndex({
      chatId: activeScope.chatId,
      includeAgents: true,
    });
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

function activeMemoryScopeFor(activeScope: ActiveScope): MemoryScope {
  if (activeScope.topicScope === "general") return "general";
  return {
    topic: {
      chatId: activeScope.chatId,
      topicId: activeScope.topicScope.topicId,
    },
  };
}

// ---------------------------------------------------------------------------
// Limit clamping
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Clamp the requested limit per spec: values <= 0 collapse to the default
 * (10); values > 50 collapse to 50; otherwise the requested value. Fractional
 * values are floored first, so a value like 0.5 floors to 0 and then collapses
 * to the default (rather than producing an empty result slice).
 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored <= 0) return DEFAULT_LIMIT;
  if (floored > MAX_LIMIT) return MAX_LIMIT;
  return floored;
}

// ---------------------------------------------------------------------------
// Entry-level search
// ---------------------------------------------------------------------------

const DELIMITER = "\n§\n";

/**
 * Search curated memory entries lexically and return ranked matches.
 *
 * Never mutates any memory file. Returns at most `limit` (default 10, clamped
 * to [1, 50]) entries ranked by the deterministic scorer. Entries with zero
 * token overlap are excluded.
 */
export async function searchMemoryEntries(args: {
  store: MemoryStore;
  activeScope: ActiveScope;
  persona?: PersonaPolicy;
  query: string;
  limit?: number;
  allChats?: boolean;
  /** Override the wall clock for deterministic recency tests. */
  nowMs?: number;
}): Promise<MemorySearchOutput> {
  const persona = args.persona ?? personaPolicyFor(args.activeScope);
  const limit = clampLimit(args.limit);
  const nowMs = args.nowMs ?? Date.now();
  const queryTokens = tokenize(args.query);
  const lowerQuery = args.query.toLowerCase();
  const activeMemoryTag = scopeTag(activeMemoryScopeFor(args.activeScope));

  const scopes = await enumerateScopes(args.store, args.activeScope, persona, args.allChats ?? false);

  const results: MemorySearchResultEntry[] = [];
  for (const { scope, tag, target } of scopes) {
    const body = args.store.readBody(scope);
    if (body.length === 0) continue;
    const rawEntries = body.split(DELIMITER);
    for (const raw of rawEntries) {
      const parsed = parseEntryMetadata(raw);
      const metadata = parsed === null ? null : parsed.metadata;
      const displayText = parsed === null ? raw : parsed.body;
      const lowerEntry = displayText.toLowerCase();
      const entryTokens = tokenize(lowerEntry);
      // Skip entries with zero lexical overlap — they are never relevant.
      if (overlapRatio(queryTokens, entryTokens) === 0) continue;

      const score = scoreEntry({
        queryTokens,
        lowerQuery,
        lowerEntry,
        target,
        scopeTag: tag,
        activeScopeTag: activeMemoryTag,
        metadata,
        nowMs,
      });

      results.push({
        scope: tag,
        target,
        text: displayText,
        score,
        metadata,
      });
    }
  }

  // Deterministic ranking: higher score first; ties broken by scope tag then
  // entry text so the order is stable across runs.
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.scope !== b.scope) return a.scope < b.scope ? -1 : 1;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  });

  const ranked = results.slice(0, limit);

  return {
    query: args.query,
    searchedScopes: scopes.length,
    results: ranked,
  };
}

// Re-export for callers that need the stripped body form.
export { stripEntryMetadata };
