import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "./state.ts";
import { sessionDir } from "./paths.ts";
import { personalEnvironment, projectEnvironment } from "./environment.ts";
import type { SessionState } from "./types.ts";

function makeState(env: SessionState["executionEnvironment"], overrides?: Partial<SessionState>): SessionState {
  return {
    id: "abc123def0",
    createdAt: "2024-01-01T00:00:00.000Z",
    chatId: 1,
    executionEnvironment: env,
    ...overrides,
  };
}

describe("state", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-state-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveState writes state and loadState reads it back", () => {
    const state = makeState(personalEnvironment());
    saveState(tmpDir, state);
    const loaded = loadState(tmpDir, state.id);
    expect(loaded).toEqual(state);
  });

  it("loadState returns null for a missing session", () => {
    expect(loadState(tmpDir, "0000000000")).toBeNull();
  });

  it("loadState throws for a session with a missing executionEnvironment", () => {
    const state = { ...makeState(personalEnvironment()), executionEnvironment: undefined as unknown as SessionState["executionEnvironment"] };
    saveState(tmpDir, state);
    expect(() => loadState(tmpDir, state.id)).toThrow(/invalid executionEnvironment/);
  });

  it("loadState throws for a project environment with an empty root", () => {
    const state = makeState({ kind: "project", projectRoot: "" });
    saveState(tmpDir, state);
    expect(() => loadState(tmpDir, state.id)).toThrow(/invalid executionEnvironment/);
  });

  it("loadState accepts a valid project environment", () => {
    const state = makeState(projectEnvironment("/srv/project"));
    saveState(tmpDir, state);
    expect(loadState(tmpDir, state.id)).toEqual(state);
  });

  it("saveState creates parent directories", () => {
    const state = makeState(personalEnvironment());
    saveState(tmpDir, state);
    expect(existsSync(sessionDir(tmpDir, state.id))).toBe(true);
  });
});
