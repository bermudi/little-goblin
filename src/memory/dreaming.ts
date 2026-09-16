/**
 * Memory dreaming pipeline.
 *
 * REM and deep sleep are scheduler-driven phases: REM aggregates transcript
 * concept tags into recurring themes, deep sleep promotes qualified
 * short-term entries and expires the rest. Candidates are filtered for noise
 * and unsafe content, deduplicated against the target scope, and promoted as
 * plain-text entries with metadata stored in SQLite columns (never HTML
 * comments in the body text).
 *
 * Light sleep runs through the deployment-owned inner-life reflection host,
 * not this pipeline; light passes coordinate with REM/deep through the
 * global phase queue below.
 */

import { log } from "../log.ts";
import { readTranscriptAfter, type TranscriptLine } from "../sessions/transcript.ts";
import { MemoryStore } from "./store.ts";
import { MemoryOverflowError } from "./budget.ts";
import { MemoryArtifactStore } from "./artifacts.ts";
import type { MetricsStore } from "../metrics/mod.ts";
import { checkMemorySafety } from "./safety.ts";
import { appendQuarantine, type QuarantineReason } from "./quarantine.ts";
import { type EntrySourceRole } from "./entry.ts";
import {  CONFIDENCE_THRESHOLD,
  DEDUP_COSINE_THRESHOLD,
  findNearDuplicateWithEmbeddings,
  isProceduralNoise,
  surfaceProvenanceScope,
  textNearDuplicate,
  type DuplicateMatch,
  type ExistingEntry,
} from "./policy.ts";
import { scopeTag, toMemoryScopePair, type MemoryScope } from "./scope.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DreamingCategory =
  | "fact"
  | "short_term"
  | "theme"
  | "commitment"
  | "standing_order"
  | "skip";

export const DREAMING_CATEGORIES: readonly DreamingCategory[] = [
  "fact",
  "short_term",
  "theme",
  "commitment",
  "standing_order",
  "skip",
];

export interface Candidate {
  target: "user" | "memory" | "agent";
  category: DreamingCategory;
  confidence: number;
  text: string;
  rationale?: string;
  source: {
    sessionId: string;
    lineRange: [number, number];
    sourceRole: EntrySourceRole;
  };
}

// ---------------------------------------------------------------------------
// Environment-driven configuration
// ---------------------------------------------------------------------------

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_MAX_MODEL_LINES = 100;

// Policy thresholds (confidence, cosine dedup) live in the shared policy seam
// (src/memory/policy.ts) so the dreaming pipeline and the fact-effect
// application path cannot drift.
//
// LOOKBACK_HOURS and MAX_MODEL_LINES are exported: the private-reflection
// light-sleep wiring derives its identical backlog policy (lookback window
// and per-batch line limit, also passed as the wake store's `maxInputLines`)
// from the same configured values, so the two paths cannot diverge.
export const LOOKBACK_HOURS = envInt("GOBLIN_MEMORY_DREAM_LOOKBACK_HOURS", DEFAULT_LOOKBACK_HOURS);
export const MAX_MODEL_LINES = envInt("GOBLIN_MEMORY_DREAM_MAX_MODEL_LINES", DEFAULT_MAX_MODEL_LINES);

// ---------------------------------------------------------------------------
// Noise, near-duplicate, and provenance-scope policy live in the shared seam
// `src/memory/policy.ts`; the dreaming pipeline and MemoryStore's fact-effect
// application path consume the same functions.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

interface ProvenanceScopeResolution {
  kind: "scope";
  scope: MemoryScope | "user";
}

interface ProvenanceScopeQuarantine {
  kind: "quarantine";
  reason: QuarantineReason;
  targetScopeTag: string;
}

type ScopeResolution = ProvenanceScopeResolution | ProvenanceScopeQuarantine;

const REM_THEME_SESSION_THRESHOLD = 3;

function getOrCreateSet<K>(map: Map<K, Set<string>>, key: K): Set<string> {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

function getOrCreateMap<V>(map: Map<string, Map<string, V>>, key: string): Map<string, V> {
  let inner = map.get(key);
  if (inner === undefined) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

interface ScopeScore {
  scope: MemoryScope | "general";
  sessions: Set<string>;
  sessionUpdates: Map<string, number>;
}

function getOrCreateScopeScore(
  map: Map<string, ScopeScore>,
  key: string,
  scope: MemoryScope | "general",
): ScopeScore {
  let score = map.get(key);
  if (score === undefined) {
    score = { scope, sessions: new Set(), sessionUpdates: new Map() };
    map.set(key, score);
  }
  return score;
}

// ---------------------------------------------------------------------------
// DreamingPipeline
// ---------------------------------------------------------------------------

export interface DreamingPipelineOptions {
  goblinHome: string;
  store: MemoryStore;
  metrics?: MetricsStore;
  confidenceThreshold?: number;
  /** How many hours of transcript to consider during REM sleep. */
  lookbackHours?: number;
  /** Cosine similarity threshold above which a candidate is considered a duplicate. */
  dedupCosineThreshold?: number;
}

export class DreamingPipeline {
  private home: string;
  private store: MemoryStore;
  private metrics: MetricsStore | null;
  private artifacts: MemoryArtifactStore;
  private confidenceThreshold: number;
  private lookbackHours: number;
  private dedupCosineThreshold: number;
  /**
   * Global queue that serializes all dreaming phases (inner-life light
   * passes, REM, and deep) so they never overlap. Light-sleep work from the
   * deployment-owned reflection host enqueues through `runExclusivePhase`;
   * REM and deep sleep enqueue through their own entry points.
   */
  private globalPhaseQueue: Promise<void> = Promise.resolve();

  constructor(opts: DreamingPipelineOptions) {
    this.home = opts.goblinHome;
    this.store = opts.store;
    this.metrics = opts.metrics ?? null;
    this.artifacts = new MemoryArtifactStore(this.home);
    this.confidenceThreshold = opts.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
    this.lookbackHours = opts.lookbackHours ?? LOOKBACK_HOURS;
    this.dedupCosineThreshold = opts.dedupCosineThreshold ?? DEDUP_COSINE_THRESHOLD;
  }

  /** Close the dreaming store. Safe to call multiple times. */
  close(): void {
    this.store.close();
  }

  /**
   * Queue a dreaming phase on the global phase queue. All phases (inner-life
   * light passes, REM, and deep) serialize through this queue so they never
   * overlap. Errors propagate to the caller but do not block subsequent phases.
   */
  private async runGlobalPhase<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.globalPhaseQueue.then(fn, fn);
    this.globalPhaseQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Run one function on the global dreaming phase queue, serialized against
   * REM and deep sleep. The private-reflection host's per-Conversation light
   * passes enqueue through this seam so at most one dreaming phase runs at a
   * time across both pipelines.
   */
  runExclusivePhase<T>(fn: () => Promise<T>): Promise<T> {
    return this.runGlobalPhase(fn);
  }

  /**
   * REM sleep: aggregate concept tags across transcript entries in the lookback
   * window. When a tag appears in 3+ distinct sessions, promote a durable
   * "theme" entry to the scope with the most origin sessions, breaking ties
   * by most-recent update and then scope name ascending (per decision 0025).
   */
  async runRemSleep(): Promise<void> {
    await this.runGlobalPhase(async () => this.remSleepInner());
  }

  private async remSleepInner(): Promise<void> {
    const now = Date.now();
    const cutoff = this.lookbackHours > 0 ? now - this.lookbackHours * 60 * 60 * 1000 : 0;

    const rows = this.store.db.database
      .query<
        { tag: string; source_session: string; source_surface_id: string | null; updated_at: number },
        { $cutoff: number }
      >(
        `SELECT t.tag, e.source_session, e.source_surface_id, e.updated_at
         FROM memory_entry_tags t
         JOIN memory_entries e ON t.entry_id = e.id
         WHERE e.entry_kind = 'transcript' AND e.created_at >= $cutoff`,
      )
      .all({ $cutoff: cutoff });

    const tagAllSessions = new Map<string, Set<string>>();
    const tagProvenanceScopes = new Map<
      string,
      Map<string, { scope: MemoryScope | "general"; sessions: Set<string>; sessionUpdates: Map<string, number> }>
    >();

    for (const row of rows) {
      const allSessions = getOrCreateSet(tagAllSessions, row.tag);
      allSessions.add(row.source_session);

      if (row.source_surface_id === null) continue;
      const scope = surfaceProvenanceScope(row.source_surface_id);
      if (scope === null) continue;

      const scopeTagStr = scopeTag(scope);
      const tagScopes = getOrCreateMap(tagProvenanceScopes, row.tag);
      const scopeData = getOrCreateScopeScore(tagScopes, scopeTagStr, scope);
      scopeData.sessions.add(row.source_session);
      const prev = scopeData.sessionUpdates.get(row.source_session) ?? 0;
      if (row.updated_at > prev) {
        scopeData.sessionUpdates.set(row.source_session, row.updated_at);
      }
    }

    let promoted = 0;
    for (const [tag, allSessions] of tagAllSessions) {
      if (allSessions.size < REM_THEME_SESSION_THRESHOLD) continue;

      const provenanceScopes = tagProvenanceScopes.get(tag);
      let chosenScope: MemoryScope | "general" | null = null;
      let chosenSessionId = "";

      if (provenanceScopes !== undefined && provenanceScopes.size > 0) {
        const scored = Array.from(provenanceScopes.values())
          .map((v) => {
            let maxUpdated = 0;
            for (const updated of v.sessionUpdates.values()) {
              if (updated > maxUpdated) maxUpdated = updated;
            }
            return { scope: v.scope, scopeTag: scopeTag(v.scope), count: v.sessions.size, maxUpdated };
          })
          .sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            if (b.maxUpdated !== a.maxUpdated) return b.maxUpdated - a.maxUpdated;
            return a.scopeTag.localeCompare(b.scopeTag);
          });
        const chosen = scored[0];
        if (chosen !== undefined) {
          chosenScope = chosen.scope;
          // Use the session with the most recent update in the winning scope as the source.
          let bestSessionId = "";
          let bestUpdated = 0;
          for (const [sessionId, updated] of provenanceScopes.get(chosen.scopeTag)!.sessionUpdates) {
            if (updated > bestUpdated) {
              bestUpdated = updated;
              bestSessionId = sessionId;
            }
          }
          chosenSessionId = bestSessionId;
        }
      }

      if (chosenScope === null) {
        chosenScope = "general";
        chosenSessionId = allSessions.values().next().value ?? "";
      }

      const candidate: Candidate = {
        target: "memory",
        category: "theme",
        confidence: 0.8,
        text: `Recurring theme: ${tag} (seen across ${allSessions.size} sessions)`,
        source: {
          sessionId: chosenSessionId,
          lineRange: [0, 0],
          sourceRole: "system",
        },
      };

      await this.processCandidate(candidate, chosenScope);
      promoted++;
    }

    const { freed, stillOver } = this.store.compact();
    this.appendDreamDiarySummary("REM", `promoted ${promoted} recurring themes; freed ${freed} chars; over=${stillOver}`);
    log.info("dreaming REM sleep completed", { promoted, freed, stillOver });
  }

  /**
   * Deep sleep: promote qualified short-term entries to durable facts, expire
   * unqualified short-term entries older than 7 days, and compact.
   */
  async runDeepSleep(): Promise<void> {
    await this.runGlobalPhase(async () => this.deepSleepInner());
  }

  private async deepSleepInner(): Promise<void> {
    const now = Date.now();
    const { promoted, expired } = this.store.applyShortTermLifecycle(now);
    const { freed, stillOver } = this.store.compact();
    this.appendDreamDiarySummary(
      "deep",
      `promoted ${promoted} short_term entries; expired ${expired} unqualified rows; freed ${freed} chars; over=${stillOver}`,
    );
    log.info("dreaming deep sleep completed", { promoted, expired, freed, stillOver });
  }

  private readTranscriptLinesInRange(sessionId: string, start: number, end: number): TranscriptLine[] {
    const lines = readTranscriptAfter(this.home, sessionId, start);
    return lines.filter((line) => line.index >= start && line.index <= end);
  }

  private resolveLineRangeScope(sessionId: string, lineRange: [number, number]): ScopeResolution {
    const [start, end] = lineRange;
    const lines = this.readTranscriptLinesInRange(sessionId, start, end);
    const provenScopes = new Map<string, MemoryScope | "general">();
    for (const line of lines) {
      if (line.sourceSurfaceId === undefined) continue;
      const scope = surfaceProvenanceScope(line.sourceSurfaceId);
      if (scope !== null) {
        provenScopes.set(scopeTag(scope), scope);
      }
    }

    if (provenScopes.size === 0) {
      return { kind: "scope", scope: "general" };
    }
    if (provenScopes.size === 1) {
      const scope = provenScopes.values().next().value as MemoryScope | "general";
      return { kind: "scope", scope };
    }
    return {
      kind: "quarantine",
      reason: "ambiguous_source_scope",
      targetScopeTag: `transcript/${sessionId}`,
    };
  }

  private resolveCandidateScope(
    candidate: Candidate,
    forcedScope?: MemoryScope | "user",
  ): ScopeResolution {
    if (forcedScope !== undefined) {
      return { kind: "scope", scope: forcedScope };
    }
    if (candidate.target === "user") {
      return { kind: "scope", scope: "user" };
    }
    if (candidate.target === "agent") {
      return {
        kind: "quarantine",
        reason: "no_agent_authority",
        targetScopeTag: `transcript/${candidate.source.sessionId}`,
      };
    }
    return this.resolveLineRangeScope(candidate.source.sessionId, candidate.source.lineRange);
  }

  private async processCandidate(candidate: Candidate, forcedScope?: MemoryScope | "user"): Promise<void> {
    if (isProceduralNoise(candidate.text)) {
      const scopeResolution = this.resolveCandidateScope(candidate, forcedScope);
      const targetScopeTag = scopeResolution.kind === "scope" ? scopeTag(scopeResolution.scope) : scopeResolution.targetScopeTag;
      this.metrics?.incrementCounter("memory_dreaming_quarantine_total", "procedural_noise", 1);
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: candidate.source.sessionId,
        targetScope: targetScopeTag,
        category: candidate.category,
        reason: "procedural_noise",
        content: candidate.text,
      });
      this.appendDreamDiary("quarantine:procedural_noise", candidate, targetScopeTag);
      return;
    }

    const scopeResolution = this.resolveCandidateScope(candidate, forcedScope);
    if (scopeResolution.kind === "quarantine") {
      this.metrics?.incrementCounter("memory_dreaming_quarantine_total", scopeResolution.reason, 1);
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: candidate.source.sessionId,
        targetScope: scopeResolution.targetScopeTag,
        category: candidate.category,
        reason: scopeResolution.reason,
        content: candidate.text,
      });
      this.appendDreamDiary(`quarantine:${scopeResolution.reason}`, candidate, scopeResolution.targetScopeTag);
      return;
    }

    const scope = scopeResolution.scope;
    const targetScopeTag = scopeTag(scope);

    if (candidate.category === "skip") {
      this.metrics?.incrementCounter("memory_dreaming_quarantine_total", "skip", 1);
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: candidate.source.sessionId,
        targetScope: targetScopeTag,
        category: candidate.category,
        reason: "skip",
        content: candidate.text,
      });
      this.appendDreamDiary("quarantine:skip", candidate, targetScopeTag);
      return;
    }

    const safety = checkMemorySafety(candidate.text);
    if (!safety.ok) {
      this.metrics?.incrementCounter("memory_dreaming_quarantine_total", "unsafe", 1);
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: candidate.source.sessionId,
        targetScope: targetScopeTag,
        category: candidate.category,
        reason: "unsafe",
        content: candidate.text,
      });
      this.appendDreamDiary("quarantine:unsafe", candidate, targetScopeTag);
      return;
    }

    if (candidate.confidence < this.confidenceThreshold) {
      this.metrics?.incrementCounter("memory_dreaming_quarantine_total", "low_confidence", 1);
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: candidate.source.sessionId,
        targetScope: targetScopeTag,
        category: candidate.category,
        reason: "low_confidence",
        content: candidate.text,
      });
      this.appendDreamDiary("quarantine:low_confidence", candidate, targetScopeTag);
      return;
    }

    const outcome = await this.persistCandidate(candidate, scope);
    this.appendDreamDiary(outcome, candidate, targetScopeTag);
  }

  private async persistCandidate(
    candidate: Candidate,
    scope: MemoryScope | "user",
  ): Promise<string> {
    const now = Date.now();
    const { scope: tag, entry_kind: entryKind, chatId } = toMemoryScopePair(scope);
    const entries = this.store.readEntries(scope).map((e) => ({ id: e.entry_id, text: e.text }));

    const match = await this.findNearDuplicate(candidate.text, entries);
    if (match !== null) {
      const bodyText = match.preserveExisting ? match.existingText : candidate.text;
      const result = await this.store.updateEntry(match.id, {
        text: bodyText,
        category: candidate.category,
        confidence: candidate.confidence,
        updatedSourceSession: candidate.source.sessionId,
        sourceRole: candidate.source.sourceRole,
        promotedAt: now,
      });
      if (result.ok) {
        this.metrics?.incrementCounter("memory_dreaming_persisted_total", null, 1);
        return "persisted:updated";
      }
      if (result.reason === "budget_exhausted") {
        this.metrics?.incrementCounter("memory_dreaming_quarantine_total", "budget_exhausted", 1);
        appendQuarantine({
          goblinHome: this.home,
          sourceSession: candidate.source.sessionId,
          targetScope: tag,
          category: candidate.category,
          reason: "budget_exhausted",
          content: candidate.text,
        });
        log.warn("dreaming: update failed; quarantined as budget_exhausted", {
          scope: tag,
          error: result.error,
        });
        return "quarantine:budget_exhausted";
      }
      this.metrics?.incrementCounter("memory_dreaming_quarantine_total", "review", 1);
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: candidate.source.sessionId,
        targetScope: tag,
        category: candidate.category,
        reason: "review",
        content: candidate.text,
      });
      log.warn("dreaming: update failed; quarantined for review", {
        scope: tag,
        error: result.error,
      });
      return "quarantine:review";
    }

    try {
      await this.store.addEntry({
        scope: tag,
        entryKind,
        text: candidate.text,
        origin: "dreaming",
        category: candidate.category,
        confidence: candidate.confidence,
        sourceSession: candidate.source.sessionId,
        sourceRole: candidate.source.sourceRole,
        promotedAt: now,
        chatId,
        createdAt: now,
        updatedAt: now,
      });
      this.metrics?.incrementCounter("memory_dreaming_persisted_total", null, 1);
      return "persisted:added";
    } catch (err) {
      if (err instanceof MemoryOverflowError) {
        this.metrics?.incrementCounter("memory_dreaming_quarantine_total", "budget_exhausted", 1);
        appendQuarantine({
          goblinHome: this.home,
          sourceSession: candidate.source.sessionId,
          targetScope: tag,
          category: candidate.category,
          reason: "budget_exhausted",
          content: candidate.text,
        });
        log.warn("dreaming: add failed; quarantined as budget_exhausted", {
          scope: tag,
          error: err.message,
        });
        return "quarantine:budget_exhausted";
      }
      const error = err instanceof Error ? err.message : String(err);
      this.metrics?.incrementCounter("memory_dreaming_quarantine_total", "review", 1);
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: candidate.source.sessionId,
        targetScope: tag,
        category: candidate.category,
        reason: "review",
        content: candidate.text,
      });
      log.warn("dreaming: add failed; quarantined for review", {
        scope: tag,
        error,
      });
      return "quarantine:review";
    }
  }

  private async findNearDuplicate(
    text: string,
    entries: ExistingEntry[],
  ): Promise<DuplicateMatch | null> {
    const textMatch = textNearDuplicate(text, entries);
    if (textMatch !== null) return textMatch;

    const provider = this.store.embeddingProvider;
    if (!provider || provider.status().degraded) return null;

    return findNearDuplicateWithEmbeddings(text, entries, provider, this.dedupCosineThreshold);
  }

  private appendDreamDiary(outcome: string, candidate: Candidate, targetScope: string): void {
    const ts = new Date().toISOString();
    const line = `- ${ts} [${outcome}] scope=${targetScope} category=${candidate.category} confidence=${candidate.confidence.toFixed(2)} source=${candidate.source.sessionId} lines=${candidate.source.lineRange.join(":")} summary=${JSON.stringify(candidate.text)}\n`;
    this.artifacts.appendDreamDiary(line);
  }

  private appendDreamDiarySummary(phase: string, summary: string): void {
    const ts = new Date().toISOString();
    this.artifacts.appendDreamDiary(`- ${ts} [${phase}] ${summary}\n`);
  }
}
