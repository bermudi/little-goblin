import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConversationState, loadState, saveConversationState, saveState } from "./state.ts";
import { sessionDir, statePath } from "./paths.ts";
import { personalEnvironment, projectEnvironment } from "./environment.ts";
import type { ConversationState, SessionState } from "./types.ts";

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

describe("conversation state", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-conversation-state-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadConversationState returns null for a missing conversation", () => {
    expect(loadConversationState(tmpDir, "0000000000")).toBeNull();
  });

  it("loadConversationState drops legacy fields when loading a legacy record", () => {
    const legacy = {
      id: "abc123def0",
      createdAt: "2024-01-01T00:00:00.000Z",
      chatId: 123,
      topicId: 7,
      title: "legacy",
      modelName: "poe/test",
      thinkingLevel: "medium",
      executionEnvironment: personalEnvironment(),
    };
    mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
    writeFileSync(statePath(tmpDir, "abc123def0"), JSON.stringify(legacy));

    const loaded = loadConversationState(tmpDir, "abc123def0");
    expect(loaded).toEqual({
      id: "abc123def0",
      createdAt: "2024-01-01T00:00:00.000Z",
      title: "legacy",
      executionEnvironment: personalEnvironment(),
    });
  });

  it("loadConversationState throws for a missing createdAt", () => {
    mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
    writeFileSync(
      statePath(tmpDir, "abc123def0"),
      JSON.stringify({ id: "abc123def0", executionEnvironment: personalEnvironment() }),
    );
    expect(() => loadConversationState(tmpDir, "abc123def0")).toThrow(/missing or invalid createdAt/);
  });

  it("loadConversationState throws for an unparseable createdAt", () => {
    mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
    writeFileSync(
      statePath(tmpDir, "abc123def0"),
      JSON.stringify({ id: "abc123def0", createdAt: "not-a-date", executionEnvironment: personalEnvironment() }),
    );
    expect(() => loadConversationState(tmpDir, "abc123def0")).toThrow(/missing or invalid createdAt/);
  });

  it("loadConversationState throws for a non-string title", () => {
    mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
    writeFileSync(
      statePath(tmpDir, "abc123def0"),
      JSON.stringify({
        id: "abc123def0",
        createdAt: "2024-01-01T00:00:00.000Z",
        title: 123,
        executionEnvironment: personalEnvironment(),
      }),
    );
    expect(() => loadConversationState(tmpDir, "abc123def0")).toThrow(/invalid title/);
  });

  it("loadConversationState throws for a non-object state file", () => {
    mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
    writeFileSync(statePath(tmpDir, "abc123def0"), JSON.stringify("not an object"));
    expect(() => loadConversationState(tmpDir, "abc123def0")).toThrow(/state is not an object/);
  });

  it("loadConversationState throws when state.json id field is wrong", () => {
    mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
    writeFileSync(
      statePath(tmpDir, "abc123def0"),
      JSON.stringify({
        id: "0000000000",
        createdAt: "2024-01-01T00:00:00.000Z",
        executionEnvironment: personalEnvironment(),
      }),
    );
    expect(() => loadConversationState(tmpDir, "abc123def0")).toThrow(/state file id mismatch/);
  });

  it("saveConversationState validates required fields", () => {
    const bad = { id: "abc123def0", executionEnvironment: personalEnvironment() } as ConversationState;
    expect(() => saveConversationState(tmpDir, bad)).toThrow(/missing or invalid createdAt/);
  });

  it("saveConversationState writes only canonical fields", () => {
    const state: ConversationState = {
      id: "abc123def0",
      createdAt: "2024-01-01T00:00:00.000Z",
      title: "test",
      executionEnvironment: personalEnvironment(),
    };
    mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
    saveConversationState(tmpDir, state);
    const raw = JSON.parse(readFileSync(statePath(tmpDir, "abc123def0"), "utf-8"));
    expect(raw).toEqual(state);
    expect(raw).not.toHaveProperty("chatId");
  });
});
