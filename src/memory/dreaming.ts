/**
 * Memory dreaming pipeline.
 *
 * A lightweight adaptation of the reflection concept: after a completed main
 * turn, light sleep scans the transcript tail for durable signal (preferences,
 * corrections, decisions, project facts, gotchas, conventions, commitments,
 * standing orders), filters noise and unsafe content, deduplicates against the
 * target scope, and promotes candidates as plain-text entries with metadata
 * stored in SQLite columns (never HTML comments in the body text).
 *
 * REM and deep sleep are scheduler-driven phases.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { log } from "../log.ts";
import { atomicWrite } from "../fs.ts";
import { sessionDir } from "../sessions/paths.ts";
import { countTranscriptLines, readTranscriptAfter, type TranscriptLine } from "../sessions/transcript.ts";
import { parseSurfaceId } from "../surface.ts";
import { MemoryStore } from "./store.ts";
import { MemoryOverflowError } from "./budget.ts";
import { MemoryArtifactStore } from "./artifacts.ts";
import type { MetricsStore } from "../metrics/mod.ts";
import { checkMemorySafety } from "./safety.ts";
import { appendQuarantine, type QuarantineReason } from "./quarantine.ts";
import { stripEntryMetadata, type EntrySourceRole } from "./entry.ts";
import { activeMemoryScopeFor, resolveActiveScope, scopeTag, toMemoryScopePair, type MemoryScope } from "./scope.ts";
import { cosineSimilarity } from "./search.ts";

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

export interface DreamingCursor {
  processedLines: number;
  lastDreamedAt: string;
}

export type CandidateExtractor = (
  entries: TranscriptLine[],
  ctx: { sessionId: string },
) => Candidate[] | Promise<Candidate[]>;

// ---------------------------------------------------------------------------
// Environment-driven configuration
// ---------------------------------------------------------------------------

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_DEDUP_COSINE_THRESHOLD = 0.85;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_MAX_MODEL_LINES = 100;

const CONFIDENCE_THRESHOLD = envFloat("GOBLIN_MEMORY_DREAM_CONFIDENCE_THRESHOLD", DEFAULT_CONFIDENCE_THRESHOLD);
const DEDUP_COSINE_THRESHOLD = envFloat("GOBLIN_MEMORY_DEDUP_SIMILARITY_THRESHOLD", DEFAULT_DEDUP_COSINE_THRESHOLD);
const LOOKBACK_HOURS = envInt("GOBLIN_MEMORY_DREAM_LOOKBACK_HOURS", DEFAULT_LOOKBACK_HOURS);
const MAX_MODEL_LINES = envInt("GOBLIN_MEMORY_DREAM_MAX_MODEL_LINES", DEFAULT_MAX_MODEL_LINES);

// ---------------------------------------------------------------------------
// Processed candidate tracking
// ---------------------------------------------------------------------------

const processedCandidates = new Map<string, Set<string>>();

function processedCandidateKey(home: string, sessionId: string, candidate: Candidate): string {
  const [start, end] = candidate.source.lineRange;
  return `${home}\x00${sessionId}\x00${start}:${end}:${candidate.text.slice(0, 64)}`;
}

function isProcessedCandidate(home: string, sessionId: string, candidate: Candidate): boolean {
  const set = processedCandidates.get(home);
  return set !== undefined && set.has(processedCandidateKey(home, sessionId, candidate));
}

function markCandidateProcessed(home: string, sessionId: string, candidate: Candidate): void {
  const key = processedCandidateKey(home, sessionId, candidate);
  let set = processedCandidates.get(home);
  if (set === undefined) {
    set = new Set();
    processedCandidates.set(home, set);
  }
  set.add(key);
}

function pruneProcessedCandidates(home: string, sessionId: string): void {
  const prefix = `${home}\x00${sessionId}\x00`;
  const set = processedCandidates.get(home);
  if (set === undefined) return;
  for (const key of Array.from(set)) {
    if (key.startsWith(prefix)) set.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Noise patterns
// ---------------------------------------------------------------------------

const NOISE_PATTERNS: RegExp[] = [
  /^\s*(run|do|try|check|show|list|tell me|explain|what|how|why|when|where|who|can you|could you|would you|please|help|fix|update|create|delete|remove|add|install|build|test|deploy|start|stop|restart|kill|send|write|read|open|close|edit|change|set|get)\b/i,
  /^\s*(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|yep|nope|cool|nice|great|lol|haha)\s*$/i,
];

function isProceduralNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  for (const re of NOISE_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Near-duplicate detection
// ---------------------------------------------------------------------------

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

interface ExistingEntry {
  id: string;
  text: string;
}

function textNearDuplicate(
  text: string,
  entries: ExistingEntry[],
): { id: string; existingText: string; preserveExisting: boolean } | null {
  const normalizedText = normalizeText(text);
  if (normalizedText.length === 0) return null;
  const textWords = new Set(normalizedText.split(" "));

  for (const entry of entries) {
    const body = stripEntryMetadata(entry.text);
    const normalizedBody = normalizeText(body);
    if (normalizedBody.length === 0) continue;

    if (normalizedBody === normalizedText) {
      return { id: entry.id, existingText: body, preserveExisting: false };
    }
    if (normalizedBody.includes(normalizedText) || normalizedText.includes(normalizedBody)) {
      const preserveExisting = normalizedBody.length > normalizedText.length;
      return { id: entry.id, existingText: body, preserveExisting };
    }
    const bodyWords = new Set(normalizedBody.split(" "));
    let intersection = 0;
    for (const w of textWords) {
      if (bodyWords.has(w)) intersection++;
    }
    const union = textWords.size + bodyWords.size - intersection;
    if (union > 0 && intersection / union > 0.6) {
      return { id: entry.id, existingText: body, preserveExisting: false };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

function legacyReflectionCursorPath(home: string, sessionId: string): string {
  return join(sessionDir(home, sessionId), "memory-reflection.json");
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

function surfaceProvenanceScope(sourceSurfaceId: string): MemoryScope | null {
  try {
    const surface = parseSurfaceId(sourceSurfaceId);
    return activeMemoryScopeFor(resolveActiveScope(surface));
  } catch {
    return null;
  }
}

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

interface SessionState {
  running: Promise<void> | null;
  pending: boolean;
}

// ---------------------------------------------------------------------------
// DreamingPipeline
// ---------------------------------------------------------------------------

export interface DreamingPipelineOptions {
  goblinHome: string;
  store: MemoryStore;
  metrics?: MetricsStore;
  extractor?: CandidateExtractor;
  confidenceThreshold?: number;
  /** How many hours of transcript to consider during light sleep. */
  lookbackHours?: number;
  /** Cosine similarity threshold above which a candidate is considered a duplicate. */
  dedupCosineThreshold?: number;
  /** Maximum lines to pass to a model-driven extractor. */
  maxModelLines?: number;
}

export class DreamingPipeline {
  private home: string;
  private store: MemoryStore;
  private metrics: MetricsStore | null;
  private extractor: CandidateExtractor | null;
  private artifacts: MemoryArtifactStore;
  private confidenceThreshold: number;
  private lookbackHours: number;
  private dedupCosineThreshold: number;
  private maxModelLines: number;
  private sessions = new Map<string, SessionState>();
  /**
   * Global queue that serializes all dreaming phases (light sleep per session,
   * REM, and deep) so they never overlap. This satisfies the spec requirement
   * that at most one dreaming phase runs at a time for the internal dreaming
   * session.
   */
  private globalPhaseQueue: Promise<void> = Promise.resolve();

  constructor(opts: DreamingPipelineOptions) {
    this.home = opts.goblinHome;
    this.store = opts.store;
    this.metrics = opts.metrics ?? null;
    this.extractor = opts.extractor ?? null;
    this.artifacts = new MemoryArtifactStore(this.home);
    this.confidenceThreshold = opts.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
    this.lookbackHours = opts.lookbackHours ?? LOOKBACK_HOURS;
    this.dedupCosineThreshold = opts.dedupCosineThreshold ?? DEDUP_COSINE_THRESHOLD;
    this.maxModelLines = opts.maxModelLines ?? MAX_MODEL_LINES;
  }

  /** Close the dreaming store. Safe to call multiple times. */
  close(): void {
    this.store.close();
  }

  /** Replace the candidate extractor at runtime (e.g. to wire a model-driven extractor). */
  setExtractor(extractor: CandidateExtractor): void {
    this.extractor = extractor;
  }

  /**
   * Queue a dreaming phase on the global phase queue. All phases (light sleep
   * work, REM, and deep) serialize through this queue so they never overlap.
   * Errors propagate to the caller but do not block subsequent phases.
   */
  private async runGlobalPhase(fn: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      await fn();
    };
    const next = this.globalPhaseQueue.then(run, run);
    this.globalPhaseQueue = next.catch(() => {});
    await next;
  }

  /**
   * Run light sleep for a session: read new transcript lines, extract
   * candidates, and promote durable ones. Coalesces overlapping calls.
   * Promotion scope is derived from the transcript source Surface provenance
   * carried by each candidate's line range, not from a session-level binding.
   */
  async runLightSleep(sessionId: string): Promise<void> {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = { running: null, pending: false };
      this.sessions.set(sessionId, state);
    }
    if (state.running !== null) {
      state.pending = true;
      return;
    }
    if (this.extractor === null) {
      log.debug("dreaming: no extractor configured, skipping light sleep", { sessionId });
      return;
    }
    state.pending = false;
    const p = this.lightSleepInner(sessionId).finally(() => {
      const s = this.sessions.get(sessionId);
      if (s === undefined) return;
      s.running = null;
      if (s.pending) {
        s.pending = false;
        void this.runLightSleep(sessionId);
      } else {
        this.sessions.delete(sessionId);
      }
    });
    state.running = p;
    await p;
  }

  /**
   * Wait for all pending light sleep work for a session to settle.
   */
  async awaitSettled(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.running === null) return;
    await state.running;
    const next = this.sessions.get(sessionId);
    if (next !== undefined && next.running !== null) {
      await this.awaitSettled(sessionId);
    }
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

  private async lightSleepInner(sessionId: string): Promise<void> {
    try {
      await this.runGlobalPhase(() => this.processSession(sessionId));
    } catch (err) {
      log.warn("dreaming light sleep failed", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private dreamingCursorPath(sessionId: string): string {
    return join(sessionDir(this.home, sessionId), "memory-dreaming-cursor.json");
  }

  private readCursor(sessionId: string): DreamingCursor | null {
    const sidecar = this.dreamingCursorPath(sessionId);
    if (existsSync(sidecar)) {
      try {
        const raw = readFileSync(sidecar, "utf-8");
        const parsed = JSON.parse(raw) as Partial<DreamingCursor>;
        if (typeof parsed.processedLines === "number" && typeof parsed.lastDreamedAt === "string") {
          return { processedLines: parsed.processedLines, lastDreamedAt: parsed.lastDreamedAt };
        }
      } catch {
        // malformed sidecar; fall through to migrate legacy sources
      }
    }

    // Migrate a legacy reflection cursor if present.
    const legacy = legacyReflectionCursorPath(this.home, sessionId);
    if (existsSync(legacy)) {
      try {
        const legacyRaw = readFileSync(legacy, "utf-8");
        const parsed = JSON.parse(legacyRaw) as { processedLines?: number; lastReflectedAt?: string };
        if (typeof parsed.processedLines === "number") {
          const migrated: DreamingCursor = {
            processedLines: parsed.processedLines,
            lastDreamedAt: typeof parsed.lastReflectedAt === "string" ? parsed.lastReflectedAt : new Date().toISOString(),
          };
          this.writeCursor(sessionId, migrated);
          try {
            rmSync(legacy);
          } catch {
            // best-effort removal of migrated cursor
          }
          return migrated;
        }
      } catch {
        // ignore malformed legacy cursor
      }
    }

    // Migrate any cursor left in the legacy memory_meta key by earlier builds.
    const metaKey = `dreaming_cursor:${sessionId}`;
    const metaRaw = this.store.db.getMeta(metaKey);
    if (metaRaw !== undefined) {
      try {
        const parsed = JSON.parse(metaRaw) as Partial<DreamingCursor>;
        if (typeof parsed.processedLines === "number" && typeof parsed.lastDreamedAt === "string") {
          const migrated: DreamingCursor = { processedLines: parsed.processedLines, lastDreamedAt: parsed.lastDreamedAt };
          this.writeCursor(sessionId, migrated);
          this.store.db.database
            .query("DELETE FROM memory_meta WHERE key = $key")
            .run({ $key: metaKey });
          return migrated;
        }
      } catch {
        // malformed legacy meta cursor
      }
    }
    return null;
  }

  private writeCursor(sessionId: string, cursor: DreamingCursor): void {
    atomicWrite(this.dreamingCursorPath(sessionId), JSON.stringify(cursor));
  }

  private async processSession(sessionId: string): Promise<void> {
    if (this.extractor === null) return;

    let cursor = this.readCursor(sessionId);

    if (cursor === null) {
      const total = countTranscriptLines(this.home, sessionId);
      const seeded: DreamingCursor = {
        processedLines: total,
        lastDreamedAt: new Date().toISOString(),
      };
      this.writeCursor(sessionId, seeded);
      log.debug("dreaming: seeded cursor", { sessionId, processedLines: total });
      return;
    }

    const home = resolve(this.home);
    const snapshot = readTranscriptAfter(this.home, sessionId, cursor.processedLines);
    const cutoff = this.lookbackHours > 0
      ? Date.now() - this.lookbackHours * 60 * 60 * 1000
      : null;
    const configuredBatchLimit = Math.floor(this.maxModelLines);
    const batchLimit = Number.isFinite(configuredBatchLimit) && configuredBatchLimit > 0
      ? configuredBatchLimit
      : 1;
    let snapshotOffset = 0;

    while (snapshotOffset < snapshot.length) {
      const newLines: TranscriptLine[] = [];
      let skippedExpired = 0;
      while (snapshotOffset < snapshot.length && newLines.length < batchLimit) {
        const line = snapshot[snapshotOffset++]!;
        if (cutoff !== null && !(new Date(line.ts).getTime() >= cutoff)) {
          skippedExpired++;
        } else {
          newLines.push(line);
        }
      }

      const batchEndIndex = snapshot[snapshotOffset - 1]!.index + 1;
      if (skippedExpired > 0) {
        this.emitExpiredLinesWarning(sessionId, skippedExpired);
      }
      if (newLines.length === 0) {
        cursor = { processedLines: batchEndIndex, lastDreamedAt: new Date().toISOString() };
        this.writeCursor(sessionId, cursor);
        break;
      }

      const candidates = await this.extractor(newLines, { sessionId });
      const newCandidates = candidates.filter((c) => !isProcessedCandidate(home, sessionId, c));

      for (const candidate of newCandidates) {
        await this.processCandidate(candidate);
        markCandidateProcessed(home, sessionId, candidate);
        this.metrics?.incrementCounter("memory_dreaming_candidate_total", null, 1);
      }

      cursor = { processedLines: batchEndIndex, lastDreamedAt: new Date().toISOString() };
      this.writeCursor(sessionId, cursor);
    }

    pruneProcessedCandidates(home, sessionId);
  }

  private emitExpiredLinesWarning(sessionId: string, count: number): void {
    log.warn("dreaming: skipped transcript lines outside lookback window", {
      sessionId,
      count,
      lookbackHours: this.lookbackHours,
    });
    this.metrics?.incrementCounter("memory_dreaming_expired_lines_total", null, count);
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
  ): Promise<{ id: string; existingText: string; preserveExisting: boolean } | null> {
    const textMatch = textNearDuplicate(text, entries);
    if (textMatch !== null) return textMatch;

    const provider = this.store.embeddingProvider;
    if (!provider || provider.status().degraded) return null;

    const allTexts = [text, ...entries.map((e) => stripEntryMetadata(e.text))];
    const embeddings = await provider.embedBatch(allTexts);
    const candidateEmbedding = embeddings[0]?.embedding;
    if (!candidateEmbedding) return null;

    let bestId: string | null = null;
    let bestText = "";
    let bestScore = 0;
    for (let i = 0; i < entries.length; i++) {
      const embedding = embeddings[i + 1]?.embedding;
      if (!embedding) continue;
      const score = cosineSimilarity(candidateEmbedding, embedding);
      if (score > bestScore) {
        bestScore = score;
        bestId = entries[i]!.id;
        bestText = entries[i]!.text;
      }
    }
    if (bestScore >= this.dedupCosineThreshold && bestId !== null) {
      const existingText = stripEntryMetadata(bestText);
      const preserveExisting = existingText.length > text.length;
      return { id: bestId, existingText, preserveExisting };
    }
    return null;
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
