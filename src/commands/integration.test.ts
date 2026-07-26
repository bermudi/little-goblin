/**
 * Integration tests for command sequences.
 *
 * These tests exercise multiple commands in sequence through the real
 * ConversationLifecycle and command helpers, verifying the end-to-end state
 * changes that unit tests on individual helpers cannot catch.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { dmSurface } from "../surface.ts";
import { executeNew } from "./new.ts";
import { executeArchive } from "./archive.ts";
import { executeName } from "./name.ts";
import { executeResume } from "./resume.ts";
import { sessionDir, sessionsDir } from "../sessions/paths.ts";
import { createConversationLifecycle, type ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import { runtimeSessionWithPreferences } from "../sessions/conversation.ts";

function makeTestConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([123]),
    modelName: "poe/Claude-Sonnet-4.6",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "info",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

describe("rapid command spam integration", () => {
  let tmpDir: string;
  let cfg: Config;
  let lifecycle: ConversationLifecycle;
  let conversationStore: ConversationStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-cmd-int-"));
    cfg = makeTestConfig(tmpDir);
    const runtimeHost = { disposeRuntime: async () => {} };
    lifecycle = createConversationLifecycle(tmpDir, runtimeHost);
    conversationStore = new ConversationStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runtimeSessionFor(conv: import("../sessions/types.ts").ConversationState, surface = dmSurface(123456)) {
    return runtimeSessionWithPreferences(conv, surface, cfg.goblinHome);
  }

  it("/new then /archive leaves session archived and binding cleared (W2)", async () => {
    const surface = dmSurface(123456);

    const newResult = await executeNew({
      createSession: async () => runtimeSessionFor(await lifecycle.rotate(surface)),
    });
    expect(newResult.kind).toBe("created");
    const sessionId = newResult.session.id;
    expect(existsSync(sessionDir(cfg.goblinHome, sessionId))).toBe(true);

    const afterNew = lifecycle.inspect(surface);
    expect(afterNew).not.toBeNull();
    expect(afterNew?.id).toBe(sessionId);

    const conv = lifecycle.inspect(surface);
    const archiveResult = await executeArchive({
      hasSession: conv !== null,
      sessionExists: conv !== null && conversationStore.load(conv.id) !== null,
      archive: async () => {
        await lifecycle.archive(surface);
      },
    });
    expect(archiveResult.kind).toBe("archived");

    expect(existsSync(sessionDir(cfg.goblinHome, sessionId))).toBe(false);
    expect(existsSync(join(sessionsDir(cfg.goblinHome), "archive", sessionId))).toBe(true);

    const afterArchive = lifecycle.inspect(surface);
    expect(afterArchive).toBeNull();
  });

  it("rapid /new → /new → /archive leaves prior sessions resumable and archives only the last", async () => {
    const surface = dmSurface(123456);

    const first = await executeNew({
      createSession: async () => runtimeSessionFor(await lifecycle.rotate(surface)),
    });
    const firstId = first.session.id;

    const second = await executeNew({
      createSession: async () => runtimeSessionFor(await lifecycle.rotate(surface)),
    });
    const secondId = second.session.id;
    expect(secondId).not.toBe(firstId);

    expect(existsSync(sessionDir(cfg.goblinHome, firstId))).toBe(true);
    expect(existsSync(join(sessionsDir(cfg.goblinHome), "archive", firstId))).toBe(false);
    expect(existsSync(sessionDir(cfg.goblinHome, secondId))).toBe(true);
    expect(lifecycle.inspect(surface)?.id).toBe(secondId);

    const conv = lifecycle.inspect(surface);
    const archiveResult = await executeArchive({
      hasSession: conv !== null,
      sessionExists: conv !== null && conversationStore.load(conv.id) !== null,
      archive: async () => lifecycle.archive(surface),
    });
    expect(archiveResult.kind).toBe("archived");

    expect(existsSync(sessionDir(cfg.goblinHome, firstId))).toBe(true);
    expect(existsSync(join(sessionsDir(cfg.goblinHome), "archive", secondId))).toBe(true);
    expect(lifecycle.inspect(surface)).toBeNull();
  });

  it("/name → /new → /resume switches back to the named prior session", async () => {
    const surface = dmSurface(123456);

    const first = await executeNew({
      createSession: async () => runtimeSessionFor(await lifecycle.rotate(surface)),
    });
    const firstId = first.session.id;

    const nameResult = executeName({
      hasSession: true,
      rawText: "/name ttt",
      session: first.session,
      setTitle: (title) => conversationStore.setTitle(firstId, title),
    });
    expect(nameResult.kind).toBe("renamed");

    const second = await executeNew({
      createSession: async () => runtimeSessionFor(await lifecycle.rotate(surface)),
    });
    const secondId = second.session.id;
    expect(secondId).not.toBe(firstId);
    expect(lifecycle.inspect(surface)?.id).toBe(secondId);
    expect(existsSync(sessionDir(cfg.goblinHome, firstId))).toBe(true);

    const resumable = lifecycle.listResumable(surface).map((c) => runtimeSessionFor(c, surface));
    const resumeResult = await executeResume({
      rawText: "/resume ttt",
      sessions: resumable,
      bindSession: async (sessionId) => runtimeSessionFor(await lifecycle.resume(surface, sessionId as import("../sessions/types.ts").ConversationId), surface),
    });

    expect(resumeResult.kind).toBe("resumed");
    expect(lifecycle.inspect(surface)?.id).toBe(firstId);
    expect(existsSync(sessionDir(cfg.goblinHome, secondId))).toBe(true);
  });
});
