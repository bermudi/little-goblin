/**
 * Integration tests for command sequences.
 *
 * These tests exercise multiple commands in sequence through the real
 * ConversationLifecycle and command helpers, verifying the end-to-end state
 * changes that unit tests on individual helpers cannot catch.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { dmSurface } from "../surface.ts";
import { executeNew } from "./new.ts";
import { executeArchive } from "./archive.ts";
import { executeName } from "./name.ts";
import { executeResume } from "./resume.ts";
import { sessionDir, sessionsDir } from "../sessions/paths.ts";
import { createConversationLifecycle, ConversationLifecycleManager, type ConversationLifecycle, type SurfaceSettings } from "../orchestration/conversation-lifecycle.ts";
import type { ConversationRuntimeHost } from "../orchestration/conversation-runtime-host.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import { runtimeSession, runtimeSessionWithPreferences } from "../sessions/conversation.ts";
import { FileBindingStore } from "../sessions/bindings.ts";
import { setModelName } from "../sessions/topic-settings.ts";
import { personalEnvironment, projectEnvironment } from "../sessions/environment.ts";
import type { ConversationId } from "../sessions/types.ts";

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

  class FakeRuntimeHost implements ConversationRuntimeHost {
    disposed: string[] = [];
    async disposeRuntime(id: ConversationId): Promise<void> {
      this.disposed.push(id);
    }
  }

  class ThrowingArchiveStore extends ConversationStore {
    throwOn: ConversationId | null = null;
    archive(id: ConversationId): void {
      if (this.throwOn === id) {
        throw new Error("archive move failed");
      }
      super.archive(id);
    }
  }

  function staticSettings(env: import("../sessions/environment.ts").ExecutionEnvironment): SurfaceSettings {
    return {
      effectiveEnvironment: () => env,
      getModelName: () => undefined,
      setModelName: () => {},
      getThinkingLevel: () => undefined,
      setThinkingLevel: () => {},
    };
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

  it("/resume reports an incompatible target without binding", async () => {
    const surface = dmSurface(123456);
    const projectRoot = join(tmpDir, "project");
    mkdirSync(projectRoot, { recursive: true });

    const projectConv = conversationStore.create(projectEnvironment(projectRoot), "project conv");
    const compatible = lifecycle.listResumable(surface).map((c) => runtimeSessionFor(c, surface));
    const all = conversationStore.list().map((c) => runtimeSession(c, surface));
    const compatibleIds = new Set(compatible.map((s) => s.id));
    const incompatible = all.filter((s) => !compatibleIds.has(s.id));

    const result = await executeResume({
      rawText: "/resume project conv",
      sessions: compatible,
      incompatibleSessions: incompatible,
      bindSession: async (sessionId) => runtimeSessionFor(await lifecycle.resume(surface, sessionId as ConversationId), surface),
    });

    expect(result.kind).toBe("incompatible");
    if (result.kind !== "incompatible") throw new Error("expected incompatible");
    expect(result.session.id).toBe(projectConv.id);
    expect(lifecycle.inspect(surface)).toBeNull();
  });

  it("/resume moves a conversation across compatible surfaces and adopts destination preferences", async () => {
    const runtimeHost = new FakeRuntimeHost();
    const manager = new ConversationLifecycleManager(
      tmpDir,
      conversationStore,
      new FileBindingStore(tmpDir),
      staticSettings(personalEnvironment()),
      runtimeHost,
    );
    const source = dmSurface(111);
    const destination = dmSurface(222);

    const target = await manager.resolveOrStart(source);
    const displaced = await manager.resolveOrStart(destination);
    setModelName(tmpDir, destination, "poe/DestinationModel");

    const compatible = manager.listResumable(destination).map((c) => runtimeSessionWithPreferences(c, destination, tmpDir));
    const all = conversationStore.list().map((c) => runtimeSession(c, destination));
    const compatibleIds = new Set(compatible.map((s) => s.id));
    const incompatible = all.filter((s) => !compatibleIds.has(s.id));

    const result = await executeResume({
      rawText: `/resume ${target.id}`,
      sessions: compatible,
      incompatibleSessions: incompatible,
      bindSession: async (sessionId) => runtimeSessionWithPreferences(
        await manager.resume(destination, sessionId as ConversationId),
        destination,
        tmpDir,
      ),
    });

    expect(result.kind).toBe("resumed");
    if (result.kind !== "resumed") throw new Error("expected resumed");
    expect(result.session.id).toBe(target.id);
    expect(result.session.modelName).toBe("poe/DestinationModel");
    expect(manager.inspect(source)).toBeNull();
    expect(manager.inspect(destination)?.id).toBe(target.id);
    expect(existsSync(sessionDir(tmpDir, displaced.id))).toBe(true);
    expect(existsSync(sessionDir(tmpDir, target.id))).toBe(true);
    expect(runtimeHost.disposed).toContain(displaced.id);
    expect(runtimeHost.disposed).toContain(target.id);
  });

  it("/archive leaves conversation unbound and resumable when the directory move fails", async () => {
    const runtimeHost = new FakeRuntimeHost();
    const throwingStore = new ThrowingArchiveStore(tmpDir);
    const manager = new ConversationLifecycleManager(
      tmpDir,
      throwingStore,
      new FileBindingStore(tmpDir),
      staticSettings(personalEnvironment()),
      runtimeHost,
    );
    const surface = dmSurface(123456);

    const conv = await manager.resolveOrStart(surface);
    throwingStore.throwOn = conv.id;

    const archiveResult = executeArchive({
      hasSession: true,
      sessionExists: true,
      archive: async () => {
        await manager.archive(surface);
      },
    });

    await expect(archiveResult).rejects.toThrow(/archive move failed/);
    expect(manager.inspect(surface)).toBeNull();
    expect(throwingStore.load(conv.id)).not.toBeNull();
    expect(existsSync(sessionDir(tmpDir, conv.id))).toBe(true);
    expect(existsSync(join(sessionsDir(tmpDir), "archive", conv.id))).toBe(false);
    expect(runtimeHost.disposed).toContain(conv.id);
  });
});
