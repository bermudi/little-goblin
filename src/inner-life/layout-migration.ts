/**
 * Offline migration step 6: inner-life wake layout, effect receipt storage,
 * and legacy light-sleep cursor conversion (issue #67, decisions 0035 and
 * 0038).
 *
 * The step adds the durable wake-record layout (`state/inner-life/wakes/`)
 * and applies the memory SQLite schema migration that creates the effect-
 * receipt table. It also converts legacy light-sleep cursor locations into
 * the sidecar `memory-dreaming-cursor.json` files the private-host cursor
 * adapter reads (the step is unreleased and extended pre-deployment, per the
 * decision 0038 pattern): the pre-sidecar DreamingPipeline read
 * `state/sessions/<id>/memory-reflection.json` and `memory_meta`
 * `dreaming_cursor:<id>` rows, and a deployment holding only those would
 * otherwise be re-seeded at transcript end, silently skipping unprocessed
 * lines. Existing memory rows and already-converted cursors are untouched;
 * converted conversations keep their legacy source rows and files.
 *
 * Per decision 0038, every transformation is computed and validated before any
 * write: existing wake records must parse as current-version records, the
 * inner-life layout must be unambiguous, an existing memory database must
 * be a readable database at a supported schema version, and every legacy
 * cursor value must parse strictly — a present-but-unusable legacy cursor is
 * ambiguity, not migration input, because ignoring it would silently skip
 * lines. Validation opens a private temp copy read-only, so the plan never
 * mutates the source files.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { log } from "../log.ts";
import { atomicWrite } from "../fs.ts";
import { copyStableMemoryFiles, MemoryDatabase } from "../memory/db.ts";
import { memoryDbPath } from "../memory/paths.ts";
import { memoryDreamingCursorPath, sessionsDir } from "../sessions/paths.ts";
import { innerLifeRoot, wakesDir } from "./paths.ts";
import { DEFAULT_MAX_WAKE_INPUT_LINES, parseWakeRecord } from "./wake-store.ts";

export interface InnerLifeLayoutPlan {
  readonly innerLifeRootExisted: boolean;
  readonly wakesRootExisted: boolean;
  readonly memoryDbExisted: boolean;
  readonly validatedWakeRecords: number;
  /** Legacy cursors planned for sidecar conversion; apply only writes these. */
  readonly legacyCursorConversions: ReadonlyArray<LegacyCursorConversion>;
}

/** One computed legacy-cursor conversion, fully resolved before any write. */
export interface LegacyCursorConversion {
  readonly conversationId: string;
  readonly processedLines: number;
  readonly lastDreamedAt: string;
}

export interface InnerLifeLayoutPlanOptions {
  /** Clock for the legacy-cursor timestamp fallback; defaults to wall time. */
  readonly now?: () => Date;
}

/**
 * Legacy pre-sidecar cursor locations, as read by the pre-unit-5
 * `DreamingPipeline.readCursor` (see git history of `src/memory/dreaming.ts`).
 */
const LEGACY_REFLECTION_CURSOR_FILENAME = "memory-reflection.json";
const LEGACY_META_CURSOR_KEY_PREFIX = "dreaming_cursor:";

/**
 * One legacy cursor value, parsed and validated.
 */
interface ParsedLegacyCursor {
  readonly processedLines: number;
  /** Resolved timestamp, or null when the source carried none. */
  readonly lastDreamedAt: string | null;
}

/**
 * Strict parse of a legacy reflection-file cursor
 * (`state/sessions/<id>/memory-reflection.json`): the old pipeline accepted
 * any JSON object with a numeric `processedLines` and an optional string
 * `lastReflectedAt`. A present-but-unusable file throws: ignoring it would
 * re-seed the conversation at transcript end and silently skip lines.
 */
function parseLegacyFileCursor(raw: string, path: string): ParsedLegacyCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`malformed legacy reflection cursor ${path}: not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`malformed legacy reflection cursor ${path}: not a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.processedLines !== "number") {
    throw new Error(`malformed legacy reflection cursor ${path}: processedLines is not a number`);
  }
  return {
    processedLines: record.processedLines,
    lastDreamedAt: typeof record.lastReflectedAt === "string" ? record.lastReflectedAt : null,
  };
}

/**
 * Strict parse of a legacy `memory_meta` cursor value: the old pipeline
 * required both `processedLines` (number) and `lastDreamedAt` (string).
 */
function parseLegacyMetaCursor(raw: string | null, conversationId: string): ParsedLegacyCursor {
  const what = `legacy memory_meta cursor ${LEGACY_META_CURSOR_KEY_PREFIX}${conversationId}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    throw new Error(`malformed ${what}: not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`malformed ${what}: not a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.processedLines !== "number") {
    throw new Error(`malformed ${what}: processedLines is not a number`);
  }
  if (typeof record.lastDreamedAt !== "string") {
    throw new Error(`malformed ${what}: lastDreamedAt is not a string`);
  }
  return { processedLines: record.processedLines, lastDreamedAt: record.lastDreamedAt };
}

/** Same tolerance the runtime cursor adapter applies to sidecar content. */
function isWellFormedSidecar(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.processedLines === "number" && typeof parsed.lastDreamedAt === "string";
  } catch {
    return false;
  }
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Compute the legacy-cursor conversions for one home. Every conversation
 * without a well-formed sidecar but with at least one parseable legacy value
 * converts to the most conservative position: the smallest `processedLines`
 * (oldest unprocessed line), so no span any legacy cursor held open is
 * silently skipped. Under the historical write order (file-era cursor before
 * the memory_meta era, positions moving forward) this coincides with the old
 * pipeline's file-over-meta precedence; equal positions prefer the file-era
 * source. A malformed sidecar behaves as absent, matching the runtime
 * adapter, and is replaced when a legacy value exists.
 */
function planLegacyCursorConversions(
  home: string,
  legacyMetaRows: ReadonlyMap<string, string | null>,
  now: () => Date,
): LegacyCursorConversion[] {
  const sessionsRoot = sessionsDir(home);
  if (!existsSync(sessionsRoot)) return [];
  if (!statSync(sessionsRoot).isDirectory()) {
    throw new Error(`sessions root exists but is not a directory: ${sessionsRoot}`);
  }
  const conversions: LegacyCursorConversion[] = [];
  for (const name of readdirSync(sessionsRoot).sort()) {
    if (name === "archive") continue;
    const dir = join(sessionsRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    // Validates the directory name as a session id: an unsafe name is an
    // ambiguous layout, not migration input.
    const sidecarPath = memoryDreamingCursorPath(home, name);
    const sidecarRaw = readIfPresent(sidecarPath);
    if (sidecarRaw !== null && isWellFormedSidecar(sidecarRaw)) continue;

    const candidates: ParsedLegacyCursor[] = [];
    const legacyPath = join(dir, LEGACY_REFLECTION_CURSOR_FILENAME);
    const legacyRaw = readIfPresent(legacyPath);
    if (legacyRaw !== null) candidates.push(parseLegacyFileCursor(legacyRaw, legacyPath));
    if (legacyMetaRows.has(name)) {
      candidates.push(parseLegacyMetaCursor(legacyMetaRows.get(name) ?? null, name));
    }
    if (candidates.length === 0) continue;

    let best = candidates[0]!;
    for (const candidate of candidates.slice(1)) {
      if (candidate.processedLines < best.processedLines) best = candidate;
    }
    conversions.push({
      conversationId: name,
      processedLines: best.processedLines,
      lastDreamedAt: best.lastDreamedAt ?? now().toISOString(),
    });
  }
  return conversions;
}

function assertDirectory(path: string, label: string): boolean {
  if (!existsSync(path)) return false;
  if (!statSync(path).isDirectory()) {
    throw new Error(`${label} exists but is not a directory: ${path}`);
  }
  return true;
}

/**
 * Validate every persisted wake record under the wakes root before any write.
 * Malformed JSON, unknown versions, and records failing the strict schema are
 * ambiguity, not migration input: the run aborts before mutating anything.
 */
function validateWakeRecords(wakes: string): number {
  let validated = 0;
  for (const name of readdirSync(wakes)) {
    if (!name.endsWith(".json")) continue;
    const path = join(wakes, name);
    if (!statSync(path).isFile()) {
      throw new Error(`wake record path is not a regular file: ${path}`);
    }
    const raw = readFileSync(path, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`malformed wake record ${path}: not valid JSON`);
    }
    parseWakeRecord(parsed, path, undefined, { maxInputLines: DEFAULT_MAX_WAKE_INPUT_LINES });
    validated++;
  }
  return validated;
}

interface MemoryDatabaseSurvey {
  /** Raw `dreaming_cursor:<conversationId>` meta values by conversation id. */
  readonly legacyCursorRows: ReadonlyMap<string, string | null>;
}

/**
 * Validate the memory database and survey its legacy cursor rows before any
 * write, by copying it to a private temp directory (WAL-aware,
 * stable-source-set) and opening the copy read-only. Corrupt files and
 * unsupported schema versions fail here, before the version advances. The
 * source files are never touched.
 */
function surveyMemoryDatabase(dbPath: string): MemoryDatabaseSurvey {
  const tempDir = mkdtempSync(join(tmpdir(), "goblin-migrate-memory-"));
  try {
    copyStableMemoryFiles(dbPath, tempDir);
    const copy = new MemoryDatabase(join(tempDir, basename(dbPath)), { readonly: true });
    try {
      const hasMetaTable = copy.selectOne<{ present: number }>(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'memory_meta'",
      );
      const rows = hasMetaTable
        ? copy.database
            .query<{ key: string; value: string | null }, { $prefix: string }>(
              "SELECT key, value FROM memory_meta WHERE key LIKE $prefix || '%'",
            )
            .all({ $prefix: LEGACY_META_CURSOR_KEY_PREFIX })
        : [];
      const legacyCursorRows = new Map<string, string | null>();
      for (const row of rows) {
        // LIKE is case-insensitive for ASCII; the historical writer used the
        // exact lowercase key, so anything else is not a legacy cursor row.
        if (!row.key.startsWith(LEGACY_META_CURSOR_KEY_PREFIX)) continue;
        legacyCursorRows.set(row.key.slice(LEGACY_META_CURSOR_KEY_PREFIX.length), row.value);
      }
      return { legacyCursorRows };
    } finally {
      copy.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function planInnerLifeLayout(
  home: string,
  options: InnerLifeLayoutPlanOptions = {},
): InnerLifeLayoutPlan {
  const now = options.now ?? (() => new Date());
  const root = innerLifeRoot(home);
  const wakes = wakesDir(home);
  const innerLifeRootExisted = assertDirectory(root, "inner-life root");
  const wakesRootExisted = assertDirectory(wakes, "wake records root");

  const validatedWakeRecords = wakesRootExisted ? validateWakeRecords(wakes) : 0;

  const dbPath = memoryDbPath(home);
  const memoryDbExisted = existsSync(dbPath);
  const legacyCursorRows = memoryDbExisted
    ? surveyMemoryDatabase(dbPath).legacyCursorRows
    : new Map<string, string | null>();
  const legacyCursorConversions = planLegacyCursorConversions(home, legacyCursorRows, now);

  return {
    innerLifeRootExisted,
    wakesRootExisted,
    memoryDbExisted,
    validatedWakeRecords,
    legacyCursorConversions,
  };
}

export function applyInnerLifeLayout(home: string, plan: InnerLifeLayoutPlan): void {
  if (!plan.wakesRootExisted) {
    mkdirSync(wakesDir(home), { recursive: true });
  }
  if (plan.memoryDbExisted) {
    // The memory SQLite schema retains its own in-process migration (decisions
    // 0015 and 0020; it is a database schema, not the state/ filesystem
    // layout). Opening the database once here applies that migration offline —
    // adding receipt storage — before the state version advances.
    const db = new MemoryDatabase(memoryDbPath(home));
    db.close();
  }
  // Write the planned legacy-cursor conversions only: the plan validated
  // every legacy value before any write, and apply is a pure function of it.
  for (const conversion of plan.legacyCursorConversions) {
    atomicWrite(
      memoryDreamingCursorPath(home, conversion.conversationId),
      JSON.stringify({
        processedLines: conversion.processedLines,
        lastDreamedAt: conversion.lastDreamedAt,
      }),
    );
  }
  log.info("inner-life layout applied", {
    wakesRootCreated: !plan.wakesRootExisted,
    receiptStorageApplied: plan.memoryDbExisted,
    validatedWakeRecords: plan.validatedWakeRecords,
    legacyCursorsConverted: plan.legacyCursorConversions.length,
  });
}
