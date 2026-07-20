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
 * REM and deep sleep are scheduler-driven phases. For now they are placeholders
 * that log and return; the cursor and promotion machinery for light sleep is
 * fully wired.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { log } from "../log.ts";
import { atomicWrite } from "../fs.ts";
import { sessionDir, statePath } from "../sessions/paths.ts";
import { countTranscriptLines, readTranscriptAfter, type TranscriptLine } from "../sessions/transcript.ts";
import { MemoryStore } from "./store.ts";
import type { MetricsStore } from "../metrics/mod.ts";
import { checkMemorySafety } from "./safety.ts";
import { appendQuarantine } from "./quarantine.ts";
import {
  stripEntryMetadata,
  type EntrySourceRole,
} from "./entry.ts";
import { activeMemoryScopeFor, scopeTag, type ActiveScope, type MemoryScope } from "./scope.ts";
import { memoryDir } from "./paths.ts";
import { cosineSimilarity } from "./search.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { TranscriptLine } from "../sessions/transcript.ts";

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

function resolveScope(target: "user" | "memory" | "agent", activeScope: ActiveScope): MemoryScope | "user" {
  if (target === "user") return "user";
  if (target === "agent" && activeScope.namedAgent !== null) {
    return { agent: { name: activeScope.namedAgent.name } };
  }
  return activeMemoryScopeFor(activeScope);
}

function chatIdForScope(scope: MemoryScope | "user"): string | null {
  if (scope === "user" || scope === "general") return null;
  if ("topic" in scope) return String(scope.topic.chatId);
  return null;
}

function entryKindForScope(scope: MemoryScope | "user"): "memory" | "user" {
  return scope === "user" ? "user" : "memory";
}

/**
 * Resolve the curated memory scope a session belongs to by reading its
 * persisted `state.json`. DMs and sessions without topic bindings map to
 * `"general"`; topic sessions map to the corresponding topic scope.
 */
function resolveSessionScope(home: string, sessionId: string): MemoryScope | "general" {
  try {
    const raw = readFileSync(statePath(home, sessionId), "utf-8");
    const state = JSON.parse(raw) as { chatId?: number; topicId?: number } | undefined;
    if (state && typeof state.topicId === "number") {
      return { topic: { chatId: state.chatId ?? 0, topicId: state.topicId } };
    }
  } catch {
    // Missing or malformed state.json — fall through to general.
  }
  return "general";
}

const REM_THEME_SESSION_THRESHOLD = 3;

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
    this.confidenceThreshold = opts.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
    this.lookbackHours = opts.lookbackHours ?? LOOKBACK_HOURS;
    this.dedupCosineThreshold = opts.dedupCosineThreshold ?? DEDUP_COSINE_THRESHOLD;
    this.maxModelLines = opts.maxModelLines ?? MAX_MODEL_LINES;
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
   * Advance the reflection cursor for a session to the current transcript end.
   * Called by AgentRunner after a completed main-agent turn.
   */
  advanceCursor(sessionId: string): void {
    const cursor = this.readCursor(sessionId);
    const total = countTranscriptLines(this.home, sessionId);
    if (cursor === null) {
      this.writeCursor(sessionId, { processedLines: total, lastDreamedAt: new Date().toISOString() });
    } else if (total > cursor.processedLines) {
      this.advanceCursorBy(sessionId, cursor, total - cursor.processedLines);
    }
  }

  /**
   * Run light sleep for a session: read new transcript lines, extract
   * candidates, and promote durable ones. Coalesces overlapping calls.
   */
  async runLightSleep(sessionId: string, activeScope: ActiveScope): Promise<void> {
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
    const p = this.lightSleepInner(sessionId, activeScope).finally(() => {
      const s = this.sessions.get(sessionId);
      if (s === undefined) return;
      s.running = null;
      if (s.pending) {
        s.pending = false;
        void this.runLightSleep(sessionId, activeScope);
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
        { tag: string; source_session: string; updated_at: number },
        { $cutoff: number }
      >(
        `SELECT t.tag, e.source_session, e.updated_at
         FROM memory_entry_tags t
         JOIN memory_entries e ON t.entry_id = e.id
         WHERE e.entry_kind = 'transcript' AND e.created_at >= $cutoff`,
      )
      .all({ $cutoff: cutoff });

    const tagSessions = new Map<string, Set<string>>();
    const tagSessionUpdated = new Map<string, Map<string, number>>();
    for (const row of rows) {
      let sessions = tagSessions.get(row.tag);
      if (sessions === undefined) {
        sessions = new Set();
        tagSessions.set(row.tag, sessions);
      }
      sessions.add(row.source_session);

      let updatedMap = tagSessionUpdated.get(row.tag);
      if (updatedMap === undefined) {
        updatedMap = new Map();
        tagSessionUpdated.set(row.tag, updatedMap);
      }
      const prev = updatedMap.get(row.source_session) ?? 0;
      if (row.updated_at > prev) {
        updatedMap.set(row.source_session, row.updated_at);
      }
    }

    let promoted = 0;
    for (const [tag, sessions] of tagSessions) {
      if (sessions.size < REM_THEME_SESSION_THRESHOLD) continue;

      const updatedMap = tagSessionUpdated.get(tag)!;
      const scopeScores = new Map<
        string,
        { scope: MemoryScope | "general"; scopeTag: string; count: number; maxUpdated: number }
      >();

      for (const sessionId of sessions) {
        const scope = resolveSessionScope(this.home, sessionId);
        const tagStr = scopeTag(scope);
        const existing = scopeScores.get(tagStr);
        const updated = updatedMap.get(sessionId) ?? 0;
        if (existing !== undefined) {
          existing.count++;
          if (updated > existing.maxUpdated) existing.maxUpdated = updated;
        } else {
          scopeScores.set(tagStr, { scope, scopeTag: tagStr, count: 1, maxUpdated: updated });
        }
      }

      const scored = Array.from(scopeScores.values()).sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        if (b.maxUpdated !== a.maxUpdated) return b.maxUpdated - a.maxUpdated;
        return a.scopeTag.localeCompare(b.scopeTag);
      });
      const chosen = scored[0];
      if (chosen === undefined) continue;

      const activeScope: ActiveScope =
        chosen.scope === "general" || !("topic" in chosen.scope)
          ? { chatId: 0, topicScope: "general", namedAgent: null }
          : {
              chatId: chosen.scope.topic.chatId,
              topicScope: { topicId: chosen.scope.topic.topicId },
              namedAgent: null,
            };

      const [firstSessionId] = sessions;
      const candidate: Candidate = {
        target: "memory",
        category: "theme",
        confidence: 0.8,
        text: `Recurring theme: ${tag} (seen across ${sessions.size} sessions)`,
        source: {
          sessionId: firstSessionId!,
          lineRange: [0, 0],
          sourceRole: "system",
        },
      };

      await this.processCandidate(candidate, activeScope);
      promoted++;
    }

    const { freed, stillOver } = this.store.compact();
    this.appendDreamDiarySummary("REM", `promoted ${promoted} recurring themes; freed ${freed} chars; over=${stillOver}`);
    log.info("dreaming REM sleep completed", { promoted, freed, stillOver });
  }

  /**
   * Deep sleep: promote all short-term entries to durable facts and compact.
   */
  async runDeepSleep(): Promise<void> {
    await this.runGlobalPhase(async () => this.deepSleepInner());
  }

  private async deepSleepInner(): Promise<void> {
    const now = Date.now();
    const promoted = this.store.db.database
      .query<{ changes: number }, { $now: number }>(
        `UPDATE memory_entries
         SET category = 'fact', promoted_at = $now, updated_at = $now
         WHERE category = 'short_term' AND entry_kind IN ('memory', 'user')`,
      )
      .run({ $now: now });

    const { freed, stillOver } = this.store.compact();
    this.appendDreamDiarySummary(
      "deep",
      `promoted ${promoted.changes} short_term entries; freed ${freed} chars; over=${stillOver}`,
    );
    log.info("dreaming deep sleep completed", { promoted: promoted.changes, freed, stillOver });
  }

  private async lightSleepInner(sessionId: string, activeScope: ActiveScope): Promise<void> {
    try {
      await this.runGlobalPhase(() => this.processSession(sessionId, activeScope));
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
        // malformed meta cursor; leave it to be overwritten later
      }
    }
    return null;
  }

  private writeCursor(sessionId: string, cursor: DreamingCursor): void {
    atomicWrite(this.dreamingCursorPath(sessionId), JSON.stringify(cursor));
  }

  private advanceCursorBy(sessionId: string, cursor: DreamingCursor, processedDelta: number): void {
    const advanced: DreamingCursor = {
      processedLines: cursor.processedLines + processedDelta,
      lastDreamedAt: new Date().toISOString(),
    };
    this.writeCursor(sessionId, advanced);
  }

  private filterLines(lines: TranscriptLine[]): TranscriptLine[] {
    if (this.lookbackHours <= 0) return lines;
    const cutoff = Date.now() - this.lookbackHours * 60 * 60 * 1000;
    const filtered = lines.filter((line) => new Date(line.ts).getTime() >= cutoff);
    if (filtered.length > this.maxModelLines) return filtered.slice(0, this.maxModelLines);
    return filtered;
  }

  private async processSession(sessionId: string, activeScope: ActiveScope): Promise<void> {
    if (this.extractor === null) return;

    const cursor = this.readCursor(sessionId);

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

    const rawLines = readTranscriptAfter(this.home, sessionId, cursor.processedLines);
    if (rawLines.length === 0) return;

    const newLines = this.filterLines(rawLines);
    if (newLines.length === 0) {
      this.advanceCursorBy(sessionId, cursor, rawLines.length);
      return;
    }

    const candidates = await this.extractor(newLines, { sessionId });
    const home = resolve(this.home);
    const newCandidates = candidates.filter((c) => !isProcessedCandidate(home, sessionId, c));

    for (const candidate of newCandidates) {
      await this.processCandidate(candidate, activeScope);
      markCandidateProcessed(home, sessionId, candidate);
      this.metrics?.incrementCounter("memory_dreaming_candidate_total", null, 1);
    }

    // Advance the cursor past the lines we actually processed, including any
    // leading lines that fell outside the lookback window. Unprocessed tail
    // lines (when the filtered window exceeded maxModelLines) remain for the
    // next pass.
    const lastIndex = newLines[newLines.length - 1]?.index;
    const processedDelta =
      lastIndex === undefined ? rawLines.length : lastIndex - cursor.processedLines + 1;
    this.advanceCursorBy(sessionId, cursor, processedDelta);
  }

  private async processCandidate(candidate: Candidate, activeScope: ActiveScope): Promise<void> {
    if (isProceduralNoise(candidate.text)) {
      this.metrics?.incrementCounter("memory_dreaming_quarantine_total", "procedural_noise", 1);
      return;
    }

    const scope = resolveScope(candidate.target, activeScope);
    const targetScopeTag = scopeTag(scope);

    if (candidate.category === "skip") {
      this.appendDreamDiary("skipped", candidate, targetScopeTag);
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
    const tag = scopeTag(scope);
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
        entryKind: entryKindForScope(scope),
        text: candidate.text,
        origin: "dreaming",
        category: candidate.category,
        confidence: candidate.confidence,
        sourceSession: candidate.source.sessionId,
        sourceRole: candidate.source.sourceRole,
        promotedAt: now,
        chatId: chatIdForScope(scope),
        createdAt: now,
        updatedAt: now,
      });
      this.metrics?.incrementCounter("memory_dreaming_persisted_total", null, 1);
      return "persisted:added";
    } catch (err) {
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
    const dir = join(memoryDir(this.home), "dreams");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const date = new Date().toISOString().slice(0, 10);
    const path = join(dir, `${date}.md`);
    const ts = new Date().toISOString();
    const line = `- ${ts} [${outcome}] scope=${targetScope} category=${candidate.category} confidence=${candidate.confidence.toFixed(2)} source=${candidate.source.sessionId} lines=${candidate.source.lineRange.join(":")} summary=${JSON.stringify(candidate.text)}\n`;
    this.writeDreamDiaryLine(path, line);
  }

  private appendDreamDiarySummary(phase: string, summary: string): void {
    const dir = join(memoryDir(this.home), "dreams");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const date = new Date().toISOString().slice(0, 10);
    const path = join(dir, `${date}.md`);
    const ts = new Date().toISOString();
    this.writeDreamDiaryLine(path, `- ${ts} [${phase}] ${summary}\n`);
  }

  private writeDreamDiaryLine(path: string, line: string): void {
    const previous = existsSync(path) ? readFileSync(path, "utf-8") : "";
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, previous + line, "utf-8");
    renameSync(tmp, path);
  }
}
