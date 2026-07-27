import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  migrateTranscriptProvenance,
  planTranscriptProvenanceMigration,
  applyTranscriptProvenanceMigration,
  type TranscriptProvenanceMigrationPlan,
} from "./transcript-provenance-migration.ts";
import { readTranscriptRawDocumentAtPath, type TranscriptRawDocument } from "./transcript.ts";
import { runMigrations } from "../migrate.ts";
import { readStateVersion, stateVersionPath } from "../state-version.ts";
import { sessionsDir, sessionDir } from "./paths.ts";
import { dmSurface, surfaceId, type SurfaceId } from "../surface.ts";

const SESSION_ID = "abcd1234ef";
const CHAT_ID = 123456;
const SURFACE_ID: SurfaceId = surfaceId(dmSurface(CHAT_ID));

interface StateShape {
  id?: string;
  chatId?: number;
  createdAt?: string;
  executionEnvironment?: { kind: "personal" } | { kind: "project"; projectRoot: string };
}

function makeState(overrides?: Partial<StateShape>): StateShape {
  return {
    id: SESSION_ID,
    chatId: CHAT_ID,
    createdAt: "2024-01-01T00:00:00.000Z",
    executionEnvironment: { kind: "personal" },
    ...overrides,
  };
}

function writeState(home: string, id: string, state: StateShape, archived = false): void {
  const dir = archived ? join(sessionsDir(home), "archive", id) : sessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state), "utf-8");
}

function transcriptFile(home: string, id: string, archived = false): string {
  if (archived) return join(sessionsDir(home), "archive", id, "transcript.jsonl");
  return join(sessionDir(home, id), "transcript.jsonl");
}

function writeTranscript(home: string, id: string, text: string, archived = false): void {
  const path = transcriptFile(home, id, archived);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf-8");
}

function readTranscript(home: string, id: string, archived = false): string {
  return readFileSync(transcriptFile(home, id, archived), "utf-8");
}

function bindSession(home: string, surfaceIdValue: SurfaceId, sessionId: string): void {
  const bindings = { version: 1, surfaces: { [surfaceIdValue]: sessionId } };
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "bindings.json"), JSON.stringify(bindings), "utf-8");
}

describe("transcript provenance migration", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-prov-mig-"));
    mkdirSync(join(home, "state"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("is a no-op when there are no sessions", () => {
    const plan = migrateTranscriptProvenance(home);
    expect(plan.files).toHaveLength(0);
    expect(plan.unknownProvenanceCount).toBe(0);
    expect(plan.invalidProvenanceCount).toBe(0);
    expect(plan.preservedCount).toBe(0);
    expect(plan.changed).toBe(false);
  });

  it("preserves valid per-entry sourceSurfaceId and counts it", () => {
    writeState(home, SESSION_ID, makeState());
    const entry = { ts: "2026-07-07T10:00:00.000Z", role: "user", content: "hi", sourceSurfaceId: SURFACE_ID };
    const original = `${JSON.stringify(entry)}\n`;
    writeTranscript(home, SESSION_ID, original);

    const plan = migrateTranscriptProvenance(home);

    expect(readTranscript(home, SESSION_ID)).toBe(original);
    expect(plan.files).toHaveLength(1);
    const file = plan.files[0]!;
    expect(file.changed).toBe(false);
    expect(file.preservedCount).toBe(1);
    expect(file.unknownProvenanceCount).toBe(0);
    expect(file.invalidProvenanceCount).toBe(0);
    expect(plan.preservedCount).toBe(1);
  });

  it("leaves invalid sourceSurfaceId unchanged and counts it as invalid", () => {
    writeState(home, SESSION_ID, makeState());
    const entry = { ts: "2026-07-07T10:00:00.000Z", role: "user", content: "hi", sourceSurfaceId: "not-valid" };
    const original = `${JSON.stringify(entry)}\n`;
    writeTranscript(home, SESSION_ID, original);

    const plan = migrateTranscriptProvenance(home);

    expect(readTranscript(home, SESSION_ID)).toBe(original);
    expect(plan.files[0]!.changed).toBe(false);
    expect(plan.files[0]!.invalidProvenanceCount).toBe(1);
    expect(plan.files[0]!.preservedCount).toBe(0);
    expect(plan.files[0]!.unknownProvenanceCount).toBe(0);
  });

  it("leaves absent provenance null and counts it as unknown", () => {
    writeState(home, SESSION_ID, makeState());
    const entry = { ts: "2026-07-07T10:00:00.000Z", role: "user", content: "hi" };
    const original = `${JSON.stringify(entry)}\n`;
    writeTranscript(home, SESSION_ID, original);

    const plan = migrateTranscriptProvenance(home);

    expect(readTranscript(home, SESSION_ID)).toBe(original);
    expect(plan.files[0]!.changed).toBe(false);
    expect(plan.files[0]!.unknownProvenanceCount).toBe(1);
    expect(plan.files[0]!.invalidProvenanceCount).toBe(0);
    expect(plan.files[0]!.preservedCount).toBe(0);
  });

  it("does not use the current binding to guess provenance", () => {
    writeState(home, SESSION_ID, makeState({ chatId: CHAT_ID }));
    bindSession(home, SURFACE_ID, SESSION_ID);
    const entry = { ts: "2026-07-07T10:00:00.000Z", role: "user", content: "hi" };
    const original = `${JSON.stringify(entry)}\n`;
    writeTranscript(home, SESSION_ID, original);

    const plan = migrateTranscriptProvenance(home);

    expect(readTranscript(home, SESSION_ID)).toBe(original);
    expect(plan.files[0]!.unknownProvenanceCount).toBe(1);
    expect(plan.files[0]!.preservedCount).toBe(0);
  });

  it("skips internal sessions (chatId 0)", () => {
    const internalId = "__goblin_dreaming__";
    writeState(home, internalId, { chatId: 0, executionEnvironment: { kind: "personal" } });
    const entry = { ts: "2026-07-07T10:00:00.000Z", role: "user", content: "hi" };
    writeTranscript(home, internalId, `${JSON.stringify(entry)}\n`);

    const plan = migrateTranscriptProvenance(home);

    expect(plan.files).toHaveLength(0);
    expect(readTranscript(home, internalId)).toBe(`${JSON.stringify(entry)}\n`);
  });

  it("processes archived sessions", () => {
    writeState(home, SESSION_ID, makeState(), true);
    const entry = { ts: "2026-07-07T10:00:00.000Z", role: "user", content: "hi", sourceSurfaceId: SURFACE_ID };
    const original = `${JSON.stringify(entry)}\n`;
    writeTranscript(home, SESSION_ID, original, true);

    const plan = migrateTranscriptProvenance(home);

    expect(plan.files).toHaveLength(1);
    const file = plan.files[0]!;
    expect(file.archived).toBe(true);
    expect(file.preservedCount).toBe(1);
    expect(readTranscript(home, SESSION_ID, true)).toBe(original);
  });

  it("preserves malformed lines, blank lines, and exact byte framing", () => {
    writeState(home, SESSION_ID, makeState());
    const good = JSON.stringify({ ts: "2026-07-07T10:00:00.000Z", role: "user", content: "first" });
    const whitespace = "   ";
    const malformed = "this is not json";
    const invalidProv = JSON.stringify({ ts: "2026-07-07T10:00:01.000Z", role: "assistant", content: [{ type: "text", text: "b" }], sourceSurfaceId: "oops" });
    const original = `${good}\n\n${whitespace}\n${malformed}\n${invalidProv}`;
    writeTranscript(home, SESSION_ID, original);

    const plan = migrateTranscriptProvenance(home);

    expect(readTranscript(home, SESSION_ID)).toBe(original);
    expect(plan.files[0]!.unknownProvenanceCount).toBe(1);
    expect(plan.files[0]!.invalidProvenanceCount).toBe(1);
    expect(plan.files[0]!.preservedCount).toBe(0);
  });

  it("fails on non-ENOENT transcript read errors before advancing state version", () => {
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: 2 }), "utf-8");
    writeState(home, SESSION_ID, makeState());
    // A directory at the transcript path causes readFileSync to throw EISDIR.
    const path = transcriptFile(home, SESSION_ID);
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(path, { recursive: true });

    expect(() => runMigrations(home)).toThrow();
    expect(readStateVersion(home)).toBe(2);
  });

  it("advances state version from 2 to 3 and is idempotent", () => {
    writeFileSync(stateVersionPath(home), JSON.stringify({ version: 2 }), "utf-8");
    writeState(home, SESSION_ID, makeState());
    const entry = { ts: "2026-07-07T10:00:00.000Z", role: "user", content: "hi", sourceSurfaceId: SURFACE_ID };
    writeTranscript(home, SESSION_ID, `${JSON.stringify(entry)}\n`);

    runMigrations(home);
    expect(readStateVersion(home)).toBe(3);

    const backups = readdirSync(home).filter((n) => n.startsWith(".migration-backup-"));
    expect(backups.length).toBe(1);

    runMigrations(home);
    expect(readStateVersion(home)).toBe(3);
    expect(readdirSync(home).filter((n) => n.startsWith(".migration-backup-")).length).toBe(1);
  });

  it("applies an atomic replacement when a candidate differs", () => {
    writeState(home, SESSION_ID, makeState());
    const original = `${JSON.stringify({ ts: "2026-07-07T10:00:00.000Z", role: "user", content: "hi" })}\n`;
    writeTranscript(home, SESSION_ID, original);

    const plan = planTranscriptProvenanceMigration(home);
    // Manually build a changed candidate to exercise the atomic write path.
    const file = plan.files[0]!;
    const originalDoc = readTranscriptRawDocumentAtPath(file.path);
    const line = originalDoc.lines[0]!;
    const nextRaw = { ...(line.raw as object), sourceSurfaceId: SURFACE_ID, addedByMigration: true };
    const candidateDoc: TranscriptRawDocument = {
      lines: [{ ...line, line: JSON.stringify(nextRaw), raw: nextRaw }],
    };

    const changedPlan: TranscriptProvenanceMigrationPlan = {
      ...plan,
      changed: true,
      files: [{ ...file, changed: true, candidateDoc }],
    };

    applyTranscriptProvenanceMigration(home, changedPlan);

    const rewritten = readTranscript(home, SESSION_ID);
    expect(rewritten).toContain(SURFACE_ID);
    expect(rewritten).toContain("addedByMigration");
  });
});
