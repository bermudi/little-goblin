/**
 * Memory reflection pipeline.
 *
 * After a main-agent turn reaches `agent_end`, the runner schedules a
 * non-blocking reflection pass. The reflector reads transcript entries
 * after a persisted cursor, extracts deterministic candidates, runs them
 * through the shared safety filter and procedural-noise filter, and
 * either persists safe candidates to the active memory scope / `user.md`
 * (consolidating against existing entries) or quarantines rejected
 * candidates for audit.
 *
 * The cursor lives at `sessions/<id>/memory-reflection.json` and makes
 * reflection resumable: a pass processes only entries after the cursor,
 * and advances the cursor only after the pass completes without an
 * unrecoverable error. On first observation of a session with no cursor,
 * the cursor is seeded to the current transcript end — no automatic
 * backfill of historical entries.
 *
 * Reflection passes for the same session are serialized in-process.
 * Overlapping schedules coalesce into at most one follow-up pass.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../fs.ts";
import { log } from "../log.ts";
import { sessionDir, transcriptPath } from "../sessions/paths.ts";
import { MemoryStore } from "./store.ts";
import { checkMemorySafety } from "./safety.ts";
import { appendQuarantine } from "./quarantine.ts";
import {
  formatReflectedEntry,
  parseEntryMetadata,
  stripEntryMetadata,
  type EntryCategory,
  type EntryMetadata,
  type EntrySourceRole,
} from "./entry.ts";
import { scopeTag, type ActiveScope, type MemoryScope } from "./scope.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single simplified transcript line extracted from `transcript.jsonl`. */
export interface TranscriptLine {
  /** Zero-based index in the transcript file. */
  index: number;
  role: "user" | "assistant" | "toolResult" | "unknown";
  /** Concatenated text content (text blocks joined; non-text blocks ignored). */
  text: string;
  /** ISO timestamp from the transcript entry. */
  ts: string;
}

/** A structured memory candidate extracted from transcript entries. */
export interface Candidate {
  /** Target file: `user.md` or the active memory scope. */
  target: "user" | "memory";
  category: EntryCategory;
  /** Confidence score in [0, 1]. Candidates below the threshold are quarantined. */
  confidence: number;
  /** Proposed memory entry body text. */
  summary: string;
  source: {
    sessionId: string;
    /** Zero-based transcript line range that produced this candidate. */
    lineRange: [number, number];
    sourceRole: EntrySourceRole;
  };
}

/** Persisted reflection progress for a session. */
export interface ReflectionCursor {
  /** Number of transcript lines already processed. */
  processedLines: number;
  /** ISO timestamp of the last successful pass. */
  lastReflectedAt: string;
}

/**
 * Candidate extractor — maps transcript lines to structured candidates.
 *
 * The default implementation is deterministic (regex-based). Tests inject
 * custom extractors to control candidate production without live model
 * calls. MAY be async to allow test-controlled timing for coalescing tests.
 */
export type CandidateExtractor = (
  entries: TranscriptLine[],
  ctx: { sessionId: string },
) => Candidate[] | Promise<Candidate[]>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Candidates with confidence below this threshold are quarantined. */
const CONFIDENCE_THRESHOLD = 0.5;

/** Jaccard word-overlap ratio above which two entries are near-duplicates. */
const NEAR_DUPLICATE_THRESHOLD = 0.6;

const DELIMITER = "\n§\n";

// ---------------------------------------------------------------------------
// Procedural noise patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a candidate is procedural noise (one-off commands,
 * small talk) rather than a durable memory. Matched candidates are skipped
 * without quarantine.
 */
const NOISE_PATTERNS: RegExp[] = [
  /^\s*(run|do|try|check|show|list|tell me|explain|what|how|why|when|where|who|can you|could you|would you|please|help|fix|update|create|delete|remove|add|install|build|test|deploy|start|stop|restart|kill|send|write|read|open|close|edit|change|set|get)\b/i,
  /^\s*(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|yep|nope|cool|nice|great|lol|haha)\s*$/i,
];

function isProceduralNoise(summary: string): boolean {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return true;
  for (const re of NOISE_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Default deterministic candidate extractor
// ---------------------------------------------------------------------------

interface ExtractionRule {
  category: EntryCategory;
  confidence: number;
  target: "user" | "memory";
  patterns: RegExp[];
}

const EXTRACTION_RULES: ExtractionRule[] = [
  {
    category: "commitment",
    confidence: 0.85,
    target: "memory",
    patterns: [
      /\bI commit(?:ment)? to\b/i,
      /\bI promise to\b/i,
      /\bI will (?:make sure to|ensure|always)\b/i,
      /\bcommitment:\s/i,
    ],
  },
  {
    category: "standing_order",
    confidence: 0.85,
    target: "memory",
    patterns: [
      /\bstanding order:\s/i,
      /\brecurring reminder:\s/i,
      /\balways (?:remind me to|check|verify)\b/i,
      /\bevery\s+\w+\s+(?:remind me to|I(?:'ll| will)\s+(?:check|verify|review))\b/i,
    ],
  },
  {
    category: "preference",
    confidence: 0.8,
    target: "user",
    patterns: [
      /\bI prefer\b/i,
      /\bI like\b/i,
      /\bI'd rather\b/i,
      /\bI always\b/i,
      /\bremember that I\b/i,
      /\bmy preference\b/i,
      /\bI tend to\b/i,
    ],
  },
  {
    category: "preference",
    confidence: 0.75,
    target: "user",
    patterns: [
      /\bno,?\s*actually\b/i,
      /\bcorrection[:\s]/i,
      /\bthat'?s wrong\b/i,
      /\bI meant\b/i,
    ],
  },
  {
    category: "decision",
    confidence: 0.85,
    target: "memory",
    patterns: [
      /\blet'?s decide\b/i,
      /\bdecision[:\s]/i,
      /\bwe'?ll go with\b/i,
      /\bI'?ve decided\b/i,
      /\bwe should use\b/i,
      /\bwe'?re going with\b/i,
    ],
  },
  {
    category: "project_fact",
    confidence: 0.7,
    target: "memory",
    patterns: [
      /\bthe project uses\b/i,
      /\bthe codebase\b/i,
      /\bbuilt with\b/i,
      /\bthis repo\b/i,
      /\bthe code uses\b/i,
    ],
  },
  {
    category: "gotcha",
    confidence: 0.7,
    target: "memory",
    patterns: [
      /\bwatch out for\b/i,
      /\bgotcha[:\s]/i,
      /\bbe careful\b/i,
      /\btricky because\b/i,
      /\bmakes? sure to\b/i,
    ],
  },
  {
    category: "convention",
    confidence: 0.75,
    target: "memory",
    patterns: [
      /\bwe always\b/i,
      /\bthe convention\b/i,
      /\bby convention\b/i,
      /\bin this project,?\s*we\b/i,
      /\bour standard\b/i,
    ],
  },
];

function mapRole(role: TranscriptLine["role"]): EntrySourceRole {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tool";
    default:
      return "system";
  }
}

/**
 * Default deterministic candidate extractor.
 *
 * Scans user and assistant transcript entries for durable-signal patterns
 * (preferences, corrections, decisions, project facts, gotchas, conventions).
 * Each match produces a candidate with the full entry text as the summary.
 */
export function defaultCandidateExtractor(
  entries: TranscriptLine[],
  ctx: { sessionId: string },
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    const text = entry.text.trim();
    if (text.length < 3) continue;
    for (const rule of EXTRACTION_RULES) {
      let matched = false;
      for (const re of rule.patterns) {
        if (re.test(text)) {
          matched = true;
          break;
        }
      }
      if (!matched) continue;
      candidates.push({
        target: rule.target,
        category: rule.category,
        confidence: rule.confidence,
        summary: text,
        source: {
          sessionId: ctx.sessionId,
          lineRange: [entry.index, entry.index],
          sourceRole: mapRole(entry.role),
        },
      });
      // One candidate per entry — first matching rule wins.
      break;
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Near-duplicate detection
// ---------------------------------------------------------------------------

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Find the existing entry that is a near-duplicate of the candidate
 * summary. Returns the matched index and whether the existing body should
 * be preserved (kept as-is) instead of being overwritten by the candidate
 * summary. Returns null when no match is found.
 *
 * Matching is deterministic:
 * 1. Exact normalized match.
 * 2. One normalized text contains the other.
 * 3. Jaccard word-overlap ratio exceeds the near-duplicate threshold.
 *
 * `preserveExistingBody` is true on a containment match where the existing
 * body is the longer/containing text. Overwriting a detailed entry with a
 * shorter near-duplicate summary would silently lose detail, so the
 * longer text is kept and only entry metadata is refreshed.
 */
function findNearDuplicate(
  summary: string,
  entries: string[],
): { index: number; preserveExistingBody: boolean } | null {
  const normalizedSummary = normalizeText(summary);
  if (normalizedSummary.length === 0) return null;
  const summaryWords = new Set(normalizedSummary.split(" "));

  for (let i = 0; i < entries.length; i++) {
    const body = stripEntryMetadata(entries[i]!);
    const normalizedBody = normalizeText(body);
    if (normalizedBody.length === 0) continue;

    // Exact match.
    if (normalizedBody === normalizedSummary) {
      return { index: i, preserveExistingBody: false };
    }
    // Containment: preserve the longer text.
    if (normalizedBody.includes(normalizedSummary) || normalizedSummary.includes(normalizedBody)) {
      const preserveExistingBody = normalizedBody.length > normalizedSummary.length;
      return { index: i, preserveExistingBody };
    }
    // Jaccard word overlap.
    const bodyWords = new Set(normalizedBody.split(" "));
    let intersection = 0;
    for (const w of summaryWords) {
      if (bodyWords.has(w)) intersection++;
    }
    const union = summaryWords.size + bodyWords.size - intersection;
    if (union > 0 && intersection / union > NEAR_DUPLICATE_THRESHOLD) {
      return { index: i, preserveExistingBody: false };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transcript reading
// ---------------------------------------------------------------------------

interface RawTranscriptEntry {
  ts?: string;
  role?: string;
  content?: unknown;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

function readTranscript(sessionId: string, home: string): TranscriptLine[] {
  const path = transcriptPath(home, sessionId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const lines = raw.split("\n");
  const result: TranscriptLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    let entry: RawTranscriptEntry;
    try {
      entry = JSON.parse(line) as RawTranscriptEntry;
    } catch {
      // Skip malformed lines — the cursor tracks line indices, not byte offsets,
      // so a skipped line still counts toward processedLines.
      result.push({ index: result.length, role: "unknown", text: "", ts: new Date().toISOString() });
      continue;
    }
    const role = entry.role === "user" || entry.role === "assistant" || entry.role === "toolResult"
      ? entry.role
      : "unknown";
    result.push({
      index: result.length,
      role,
      text: extractText(entry.content),
      ts: entry.ts ?? new Date().toISOString(),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cursor read/write
// ---------------------------------------------------------------------------

function cursorPath(home: string, sessionId: string): string {
  return join(sessionDir(home, sessionId), "memory-reflection.json");
}

function readCursor(home: string, sessionId: string): ReflectionCursor | null {
  const path = cursorPath(home, sessionId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReflectionCursor>;
    if (typeof parsed.processedLines === "number" && typeof parsed.lastReflectedAt === "string") {
      return { processedLines: parsed.processedLines, lastReflectedAt: parsed.lastReflectedAt };
    }
  } catch {
    // Fall through — malformed cursor is treated as absent.
  }
  return null;
}

function writeCursor(home: string, sessionId: string, cursor: ReflectionCursor): void {
  atomicWrite(cursorPath(home, sessionId), JSON.stringify(cursor, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

function activeMemoryScopeFor(activeScope: ActiveScope): MemoryScope {
  if (activeScope.topicScope === "general") return "general";
  return {
    topic: {
      chatId: activeScope.chatId,
      topicId: activeScope.topicScope.topicId,
    },
  };
}

function resolveScope(
  target: "user" | "memory",
  activeScope: ActiveScope,
): MemoryScope | "user" {
  return target === "user" ? "user" : activeMemoryScopeFor(activeScope);
}

// ---------------------------------------------------------------------------
// Session scheduler state
// ---------------------------------------------------------------------------

interface SessionState {
  running: Promise<void> | null;
  pending: boolean;
}

// ---------------------------------------------------------------------------
// MemoryReflector
// ---------------------------------------------------------------------------

export interface MemoryReflectorOptions {
  goblinHome: string;
  store: MemoryStore;
  /** Override the candidate extractor (defaults to deterministic). */
  extractor?: CandidateExtractor;
}

export class MemoryReflector {
  private home: string;
  private store: MemoryStore;
  private extractor: CandidateExtractor;
  private sessions = new Map<string, SessionState>();

  constructor(opts: MemoryReflectorOptions) {
    this.home = opts.goblinHome;
    this.store = opts.store;
    this.extractor = opts.extractor ?? defaultCandidateExtractor;
  }

  /**
   * Schedule a fire-and-log reflection pass for a session. Coalesces
   * overlapping schedules into at most one follow-up pass. Returns
   * immediately — the pass runs in the background and errors are logged.
   */
  scheduleReflection(sessionId: string, activeScope: ActiveScope): void {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = { running: null, pending: false };
      this.sessions.set(sessionId, state);
    }
    if (state.running !== null) {
      // Coalesce: a follow-up pass will run after the current one completes.
      state.pending = true;
      return;
    }
    state.pending = false;
    const p = this.reflect(sessionId, activeScope).finally(() => {
      const s = this.sessions.get(sessionId);
      if (s === undefined) return;
      s.running = null;
      if (s.pending) {
        s.pending = false;
        this.scheduleReflection(sessionId, activeScope);
      } else {
        this.sessions.delete(sessionId);
      }
    });
    state.running = p;
  }

  /**
   * Wait for all pending reflection passes for a session to settle.
   * Useful for tests and graceful shutdown.
   */
  async awaitSettled(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.running === null) return;
    await state.running;
    // The finally callback may have scheduled a follow-up — recurse.
    const next = this.sessions.get(sessionId);
    if (next !== undefined && next.running !== null) {
      await this.awaitSettled(sessionId);
    }
  }

  /**
   * Run a single reflection pass. Fire-and-log: errors are caught and
   * logged, never thrown. The cursor advances only after the pass
   * completes without an unrecoverable error.
   */
  async reflect(sessionId: string, activeScope: ActiveScope): Promise<void> {
    try {
      await this.reflectInner(sessionId, activeScope);
    } catch (err) {
      log.warn("memory reflection failed", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async reflectInner(sessionId: string, activeScope: ActiveScope): Promise<void> {
    const cursor = readCursor(this.home, sessionId);
    const lines = readTranscript(sessionId, this.home);

    // First observation: seed cursor to current transcript end, do not
    // process historical entries (no automatic backfill).
    if (cursor === null) {
      const seeded: ReflectionCursor = {
        processedLines: lines.length,
        lastReflectedAt: new Date().toISOString(),
      };
      writeCursor(this.home, sessionId, seeded);
      log.debug("memory reflection: seeded cursor", { sessionId, processedLines: lines.length });
      return;
    }

    const newLines = lines.slice(cursor.processedLines);
    if (newLines.length === 0) return;

    // Extract candidates from the new transcript range.
    const candidates = await this.extractor(newLines, { sessionId });

    // Process each candidate through the filtering pipeline.
    for (const candidate of candidates) {
      await this.processCandidate(candidate, activeScope);
    }

    // Advance cursor only after the full range is processed.
    const advanced: ReflectionCursor = {
      processedLines: lines.length,
      lastReflectedAt: new Date().toISOString(),
    };
    writeCursor(this.home, sessionId, advanced);
  }

  /**
   * Run a single candidate through noise → safety → confidence filtering
   * and either persist it (with consolidation) or quarantine it.
   */
  private async processCandidate(
    candidate: Candidate,
    activeScope: ActiveScope,
  ): Promise<void> {
    // 1. Procedural noise: skip without quarantine.
    if (isProceduralNoise(candidate.summary)) return;

    const scope = resolveScope(candidate.target, activeScope);
    const targetScopeTag = candidate.target === "user"
      ? "user"
      : scopeTag(activeMemoryScopeFor(activeScope));

    // 2. Safety filter: quarantine unsafe candidates.
    const safety = checkMemorySafety(candidate.summary);
    if (!safety.ok) {
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: candidate.source.sessionId,
        targetScope: targetScopeTag,
        category: candidate.category,
        reason: "unsafe",
        content: candidate.summary,
      });
      return;
    }

    // 3. Confidence filter: quarantine low-confidence candidates.
    if (candidate.confidence < CONFIDENCE_THRESHOLD) {
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: candidate.source.sessionId,
        targetScope: targetScopeTag,
        category: candidate.category,
        reason: "low_confidence",
        content: candidate.summary,
      });
      return;
    }

    // 4. Consolidate and write.
    await this.consolidateAndWrite(candidate, scope);
  }

  /**
   * Compare the candidate against the target file. Near-duplicates update
   * the existing entry (preserving original `created_at` and
   * `source_session`, updating `updated_at` and `updated_source_session`).
   * Distinct candidates append as new entries.
   *
   * The read-consolidate-write runs atomically under the scope lock via
   * `store.consolidate`, so an explicit `memory_write` (or a second
   * reflection pass) landing on the same scope between the read and the
   * write cannot be silently overwritten by a stale body.
   */
  private async consolidateAndWrite(
    candidate: Candidate,
    scope: MemoryScope | "user",
  ): Promise<void> {
    const now = new Date().toISOString();
    const result = await this.store.consolidate(scope, (currentBody) => {
      const entries = currentBody.length === 0 ? [] : currentBody.split(DELIMITER);
      const match = findNearDuplicate(candidate.summary, entries);

      if (match !== null) {
        const existing = entries[match.index]!;
        const parsed = parseEntryMetadata(existing);
        let metadata: EntryMetadata;
        if (parsed !== null) {
          // Preserve original creation provenance; update the rest.
          metadata = {
            category: candidate.category,
            confidence: candidate.confidence,
            created_at: parsed.metadata.created_at,
            updated_at: now,
            source_session: parsed.metadata.source_session,
            updated_source_session: candidate.source.sessionId,
            source_role: parsed.metadata.source_role,
          };
        } else {
          // Legacy entry without metadata — wrap with full metadata.
          metadata = {
            category: candidate.category,
            confidence: candidate.confidence,
            created_at: now,
            updated_at: now,
            source_session: candidate.source.sessionId,
            updated_source_session: candidate.source.sessionId,
            source_role: candidate.source.sourceRole,
          };
        }
        // On a containment match where the existing body is the longer
        // text, keep it and only refresh metadata — do not let a shorter
        // near-duplicate summary overwrite a more detailed entry.
        const bodyText = match.preserveExistingBody
          ? stripEntryMetadata(existing)
          : candidate.summary;
        entries[match.index] = formatReflectedEntry(metadata, bodyText);
        return entries.join(DELIMITER);
      }

      // Distinct candidate — append as a new entry.
      const metadata: EntryMetadata = {
        category: candidate.category,
        confidence: candidate.confidence,
        created_at: now,
        updated_at: now,
        source_session: candidate.source.sessionId,
        source_role: candidate.source.sourceRole,
      };
      const entry = formatReflectedEntry(metadata, candidate.summary);
      return currentBody.length === 0 ? entry : currentBody + DELIMITER + entry;
    });

    if (!result.ok) {
      // Cap overflow or other write failure — quarantine for review
      // instead of silently dropping the candidate.
      appendQuarantine({
        goblinHome: this.home,
        sourceSession: candidate.source.sessionId,
        targetScope: scopeTag(scope),
        category: candidate.category,
        reason: "review",
        content: candidate.summary,
      });
      log.warn("memory reflection: consolidation write failed; quarantined for review", {
        scope: scopeTag(scope),
        error: result.error,
      });
    }
  }
}
