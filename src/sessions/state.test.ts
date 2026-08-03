import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConversationState,
  loadInternalSessionState,
  saveConversationState,
  saveInternalSessionState,
} from "./state.ts";
import { sessionDir, statePath } from "./paths.ts";
import { personalEnvironment } from "./environment.ts";
import type { ConversationState } from "./types.ts";
import { createInternalSessionState } from "./internal-session.ts";

describe("internal session state", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-state-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips the explicit Surface-free internal record", () => {
    const state = createInternalSessionState("__state_test__");
    saveInternalSessionState(tmpDir, state);
    expect(loadInternalSessionState(tmpDir, state.id)).toEqual(state);
  });

  it("returns null when the internal record is absent", () => {
    expect(loadInternalSessionState(tmpDir, "__missing__")).toBeNull();
  });

  it("rejects an invalid internal ID before filesystem access", () => {
    expect(() => loadInternalSessionState(tmpDir, "../escape")).toThrow(/reserved __…__ identity/);
  });

  it("rejects routing and preference compatibility fields", () => {
    const id = "__invalid__";
    mkdirSync(sessionDir(tmpDir, id), { recursive: true });
    writeFileSync(statePath(tmpDir, id), JSON.stringify({
      ...createInternalSessionState(id),
      modelName: "poe/legacy",
    }));
    expect(() => loadInternalSessionState(tmpDir, id)).toThrow(/forbidden field: modelName/);
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

  it("rejects legacy routing fields in current-version state, including chatId: 0", () => {
    const legacy = {
      id: "abc123def0",
      createdAt: "2024-01-01T00:00:00.000Z",
      chatId: 0,
      topicId: 7,
      title: "legacy",
      modelName: "poe/test",
      thinkingLevel: "medium",
      executionEnvironment: personalEnvironment(),
    };
    mkdirSync(sessionDir(tmpDir, "abc123def0"), { recursive: true });
    writeFileSync(statePath(tmpDir, "abc123def0"), JSON.stringify(legacy));

    // A reserved internal record can exist only under a reserved internal ID.
    // A chatId:0 record at a ten-hex Conversation path is corrupt authority,
    // never an absent Conversation that lifecycle code may replace.
    expect(() => loadConversationState(tmpDir, "abc123def0")).toThrow(/unexpected state field: chatId/);
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
