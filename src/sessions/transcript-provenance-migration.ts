/**
 * Offline migration of legacy transcript files to provenance-aware storage.
 *
 * This is filesystem migration step 3. It runs after Surface and execution
 * environment migration and before Conversation lifecycle migration. The step
 * is conservative: in this deployment the only accepted historical evidence is
 * an entry's own valid `sourceSurfaceId`, so legacy entries without one remain
 * absent. Current bindings, creation metadata, shared scopes, execution
 * environments, and numeric chat similarity are not treated as proof.
 */

import { Dirent, existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "../log.ts";
import { sessionsDir, statePath } from "./paths.ts";
import {
  readTranscriptRawDocument,
  readTranscriptRawDocumentAtPath,
  writeTranscriptRawDocument,
  type TranscriptRawDocument,
  type TranscriptRawLine,
} from "./transcript.ts";
import { parseSurfaceId, surfaceId, type SurfaceId } from "../surface.ts";

export interface TranscriptFileMigrationPlan {
  readonly sessionId: string;
  readonly path: string;
  readonly archived: boolean;
  readonly changed: boolean;
  readonly candidateDoc?: TranscriptRawDocument;
  readonly unknownProvenanceCount: number;
  readonly invalidProvenanceCount: number;
  readonly preservedCount: number;
}

export interface TranscriptProvenanceMigrationPlan {
  readonly changed: boolean;
  readonly files: TranscriptFileMigrationPlan[];
  readonly unknownProvenanceCount: number;
  readonly invalidProvenanceCount: number;
  readonly preservedCount: number;
}

interface TranscriptFileRef {
  readonly sessionId: string;
  readonly path: string;
  readonly archived: boolean;
}

function readChatIdFromState(home: string, sessionId: string, archived: boolean): number | undefined {
  const path = archived
    ? join(sessionsDir(home), "archive", sessionId, "state.json")
    : statePath(home, sessionId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const chatId = (parsed as Record<string, unknown>).chatId;
  return typeof chatId === "number" ? chatId : undefined;
}

function listTranscriptFiles(home: string): TranscriptFileRef[] {
  const result: TranscriptFileRef[] = [];
  const sessionsRoot = sessionsDir(home);

  let activeEntries: Dirent[] = [];
  try {
    activeEntries = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const entry of activeEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "archive") continue;
    const sessionId = entry.name;
    const transcriptFile = join(sessionsRoot, sessionId, "transcript.jsonl");
    if (!existsSync(transcriptFile)) continue;
    if (readChatIdFromState(home, sessionId, false) === 0) continue;
    result.push({ sessionId, path: transcriptFile, archived: false });
  }

  const archiveRoot = join(sessionsRoot, "archive");
  let archiveEntries: Dirent[] = [];
  try {
    archiveEntries = readdirSync(archiveRoot, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const entry of archiveEntries) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const transcriptFile = join(archiveRoot, sessionId, "transcript.jsonl");
    if (!existsSync(transcriptFile)) continue;
    if (readChatIdFromState(home, sessionId, true) === 0) continue;
    result.push({ sessionId, path: transcriptFile, archived: true });
  }

  return result;
}

function findHistoricalEvidence(
  _line: TranscriptRawLine,
  _home: string,
  _sessionId: string,
): SurfaceId | null {
  // In this deployment the only accepted historical evidence is the entry's own
  // valid per-entry sourceSurfaceId. A named historical-evidence store would be
  // a separate change; until then, no backfill is performed.
  return null;
}

function attributeLine(line: TranscriptRawLine, home: string, sessionId: string): TranscriptRawLine {
  if (line.raw === null || line.entry === null) return line;
  if (line.entry.sourceSurfaceId !== undefined) return line;

  const evidence = findHistoricalEvidence(line, home, sessionId);
  if (evidence === null) return line;

  const surface = parseSurfaceId(evidence);
  const canonicalId = surfaceId(surface);
  if (canonicalId !== evidence) {
    throw new Error(`non-canonical SurfaceId candidate in ${sessionId}: ${evidence}`);
  }

  const nextRaw: Record<string, unknown> = { ...line.raw, sourceSurfaceId: canonicalId };
  return {
    ...line,
    line: JSON.stringify(nextRaw),
    raw: nextRaw,
    entry: { ...line.entry, sourceSurfaceId: canonicalId },
  };
}

function produceCandidateDoc(
  doc: TranscriptRawDocument,
  home: string,
  sessionId: string,
): { doc: TranscriptRawDocument; changed: boolean } {
  let changed = false;
  const nextLines: TranscriptRawLine[] = [];
  for (const line of doc.lines) {
    const nextLine = attributeLine(line, home, sessionId);
    if (nextLine !== line) changed = true;
    nextLines.push(nextLine);
  }
  if (!changed) return { doc, changed: false };
  return { doc: { lines: nextLines }, changed: true };
}

function countProvenance(line: TranscriptRawLine): {
  preserved: number;
  invalid: number;
  unknown: number;
} {
  if (line.entry === null) return { preserved: 0, invalid: 0, unknown: 0 };
  if (line.entry.sourceSurfaceId !== undefined) {
    return { preserved: 1, invalid: 0, unknown: 0 };
  }
  if (line.raw !== null && "sourceSurfaceId" in line.raw) {
    return { preserved: 0, invalid: 1, unknown: 0 };
  }
  return { preserved: 0, invalid: 0, unknown: 1 };
}

function planFile(home: string, file: TranscriptFileRef): TranscriptFileMigrationPlan {
  const doc = file.archived
    ? readTranscriptRawDocumentAtPath(file.path)
    : readTranscriptRawDocument(home, file.sessionId);

  let unknown = 0;
  let invalid = 0;
  let preserved = 0;
  for (const line of doc.lines) {
    const counts = countProvenance(line);
    unknown += counts.unknown;
    invalid += counts.invalid;
    preserved += counts.preserved;
  }

  const { doc: candidateDoc, changed } = produceCandidateDoc(doc, home, file.sessionId);

  return {
    sessionId: file.sessionId,
    path: file.path,
    archived: file.archived,
    changed,
    candidateDoc: changed ? candidateDoc : undefined,
    unknownProvenanceCount: unknown,
    invalidProvenanceCount: invalid,
    preservedCount: preserved,
  };
}

export function planTranscriptProvenanceMigration(home: string): TranscriptProvenanceMigrationPlan {
  const files = listTranscriptFiles(home).map((file) => planFile(home, file));
  let unknown = 0;
  let invalid = 0;
  let preserved = 0;
  for (const file of files) {
    unknown += file.unknownProvenanceCount;
    invalid += file.invalidProvenanceCount;
    preserved += file.preservedCount;
  }
  return {
    changed: files.some((f) => f.changed),
    files,
    unknownProvenanceCount: unknown,
    invalidProvenanceCount: invalid,
    preservedCount: preserved,
  };
}

export function applyTranscriptProvenanceMigration(
  _home: string,
  plan: TranscriptProvenanceMigrationPlan,
): void {
  for (const file of plan.files) {
    if (!file.changed) continue;
    const candidate = file.candidateDoc;
    if (candidate === undefined) {
      throw new Error(`changed file ${file.path} has no candidate document`);
    }

    const dir = dirname(file.path);
    const tmp = join(dir, `.prov-mig-${randomBytes(6).toString("hex")}.tmp`);
    try {
      writeTranscriptRawDocument(tmp, candidate);
      renameSync(tmp, file.path);
      log.info("migrated transcript provenance", {
        path: file.path,
        sessionId: file.sessionId,
        archived: file.archived,
      });
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // already gone or unrecoverable
      }
      throw err;
    }
  }

  log.info("transcript provenance migration complete", {
    files: plan.files.length,
    unknownProvenanceCount: plan.unknownProvenanceCount,
    invalidProvenanceCount: plan.invalidProvenanceCount,
    preservedCount: plan.preservedCount,
  });
}

export function migrateTranscriptProvenance(home: string): TranscriptProvenanceMigrationPlan {
  const plan = planTranscriptProvenanceMigration(home);
  applyTranscriptProvenanceMigration(home, plan);
  return plan;
}
