/**
 * Offline migration step 6: inner-life wake layout + effect receipt storage
 * (issue #67, decisions 0035 and 0038).
 *
 * The step adds the durable wake-record layout (`state/inner-life/wakes/`) and
 * applies the memory SQLite schema migration that creates the effect-receipt
 * table. It changes no existing memory rows, index rows, or cursors: the
 * schema migration only adds an empty table and stamps the schema version.
 *
 * Per decision 0038, every transformation is computed and validated before any
 * write: existing wake records must parse as current-version records, the
 * inner-life layout must be unambiguous, and an existing memory database must
 * be a readable database at a supported schema version. Validation opens a
 * private temp copy read-only, so the plan never mutates the source files.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { log } from "../log.ts";
import { copyStableMemoryFiles, MemoryDatabase } from "../memory/db.ts";
import { memoryDbPath } from "../memory/paths.ts";
import { innerLifeRoot, wakesDir } from "./paths.ts";
import { DEFAULT_MAX_WAKE_INPUT_LINES, parseWakeRecord } from "./wake-store.ts";

export interface InnerLifeLayoutPlan {
  readonly innerLifeRootExisted: boolean;
  readonly wakesRootExisted: boolean;
  readonly memoryDbExisted: boolean;
  readonly validatedWakeRecords: number;
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

/**
 * Validate the memory database before any write by copying it to a private
 * temp directory (WAL-aware, stable-source-set) and opening the copy
 * read-only. Corrupt files and unsupported schema versions fail here, before
 * the version advances. The source files are never touched.
 */
function validateMemoryDatabase(dbPath: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "goblin-migrate-memory-"));
  try {
    copyStableMemoryFiles(dbPath, tempDir);
    const copy = new MemoryDatabase(join(tempDir, basename(dbPath)), { readonly: true });
    copy.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function planInnerLifeLayout(home: string): InnerLifeLayoutPlan {
  const root = innerLifeRoot(home);
  const wakes = wakesDir(home);
  const innerLifeRootExisted = assertDirectory(root, "inner-life root");
  const wakesRootExisted = assertDirectory(wakes, "wake records root");

  const validatedWakeRecords = wakesRootExisted ? validateWakeRecords(wakes) : 0;

  const dbPath = memoryDbPath(home);
  const memoryDbExisted = existsSync(dbPath);
  if (memoryDbExisted) {
    validateMemoryDatabase(dbPath);
  }

  return { innerLifeRootExisted, wakesRootExisted, memoryDbExisted, validatedWakeRecords };
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
  log.info("inner-life layout applied", {
    wakesRootCreated: !plan.wakesRootExisted,
    receiptStorageApplied: plan.memoryDbExisted,
    validatedWakeRecords: plan.validatedWakeRecords,
  });
}
