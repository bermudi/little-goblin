/**
 * Integration tests for command sequences.
 *
 * These tests exercise multiple commands in sequence through the real
 * ConversationLifecycle and command helpers, verifying the end-to-end state
 * changes that unit tests on individual helpers cannot catch.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { dmSurface, surfaceId, type Surface } from "../surface.ts";
import { executeNew } from "./new.ts";
import { executeArchive } from "./archive.ts";
import { executeName } from "./name.ts";
import { executeResume } from "./resume.ts";
import { sessionDir, sessionsDir, surfaceHeartbeatPath } from "../sessions/paths.ts";
import { createConversationLifecycle, ConversationLifecycleManager, FileSurfaceSettings, type ConversationLifecycle, type SurfaceSettings } from "../orchestration/conversation-lifecycle.ts";
import type { ConversationRuntimeHostPort } from "../orchestration/conversation-runtime-host.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import { FileBindingStore } from "../sessions/bindings.ts";
import { setModelName } from "../sessions/topic-settings.ts";
import { personalEnvironment, projectEnvironment } from "../sessions/environment.ts";
import type { ConversationId } from "../sessions/types.ts";
import { ScheduleStore } from "../scheduler/store.ts";
import { DEFAULT_SKILL_POLICY } from "../agent/skills/mod.ts";

async function resolveConversation(lifecycle: ConversationLifecycle, surface: Surface) {
  const resolution = await lifecycle.resolveOrStart(surface);
  if (resolution.creationLease !== null) lifecycle.sealCreation(resolution.creationLease);
  return resolution.conversation;
}

function makeTestConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([123]),
    modelName: "poe/Claude-Sonnet-4.6",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "info",
    toolVisibility: "standard",
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
    const runtimeHost = { hasRuntime: () => false, disposeRuntime: async () => {} };
    lifecycle = createConversationLifecycle(tmpDir, runtimeHost);
    conversationStore = new ConversationStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function conversationFor(conv: import("../sessions/types.ts").ConversationState) {
    return conv;
  }

  class FakeRuntimeHost implements ConversationRuntimeHostPort {
    disposed: string[] = [];
    hasRuntime(_id: ConversationId): boolean {
      return false;
    }
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
      getRuntimeSettings: () => ({
        executionEnvironment: env,
        modelName: undefined,
        thinkingLevel: undefined,
        skillPolicy: DEFAULT_SKILL_POLICY,
        fingerprint: JSON.stringify({ environment: env, policy: DEFAULT_SKILL_POLICY }),
      }),
      getModelName: () => undefined,
      setModelName: () => {},
      getThinkingLevel: () => undefined,
      setThinkingLevel: () => {},
      setPreferences: () => {},
      getSkillPolicy: () => DEFAULT_SKILL_POLICY,
    };
  }

  it("/new then /archive leaves session archived and binding cleared (W2)", async () => {
    const surface = dmSurface(123456);

    const newResult = await executeNew({
      createConversation: async () => conversationFor(await lifecycle.rotate(surface)),
    });
    expect(newResult.kind).toBe("created");
    const sessionId = newResult.conversation.id;
    expect(existsSync(sessionDir(cfg.goblinHome, sessionId))).toBe(true);

    const afterNew = lifecycle.inspect(surface);
    expect(afterNew).not.toBeNull();
    expect(afterNew?.id).toBe(sessionId);

    const archiveResult = await executeArchive({
      archive: () => lifecycle.archive(surface),
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
      createConversation: async () => conversationFor(await lifecycle.rotate(surface)),
    });
    const firstId = first.conversation.id;

    const second = await executeNew({
      createConversation: async () => conversationFor(await lifecycle.rotate(surface)),
    });
    const secondId = second.conversation.id;
    expect(secondId).not.toBe(firstId);

    expect(existsSync(sessionDir(cfg.goblinHome, firstId))).toBe(true);
    expect(existsSync(join(sessionsDir(cfg.goblinHome), "archive", firstId))).toBe(false);
    expect(existsSync(sessionDir(cfg.goblinHome, secondId))).toBe(true);
    expect(lifecycle.inspect(surface)?.id).toBe(secondId);

    const archiveResult = await executeArchive({
      archive: () => lifecycle.archive(surface),
    });
    expect(archiveResult.kind).toBe("archived");

    expect(existsSync(sessionDir(cfg.goblinHome, firstId))).toBe(true);
    expect(existsSync(join(sessionsDir(cfg.goblinHome), "archive", secondId))).toBe(true);
    expect(lifecycle.inspect(surface)).toBeNull();
  });

  it("/name → /new → /resume switches back to the named prior session", async () => {
    const surface = dmSurface(123456);

    const first = await executeNew({
      createConversation: async () => conversationFor(await lifecycle.rotate(surface)),
    });
    const firstId = first.conversation.id;

    const nameResult = await executeName({
      rawText: "/name ttt",
      setTitle: (title) => lifecycle.setTitle(surface, title),
    });
    expect(nameResult.kind).toBe("renamed");

    const second = await executeNew({
      createConversation: async () => conversationFor(await lifecycle.rotate(surface)),
    });
    const secondId = second.conversation.id;
    expect(secondId).not.toBe(firstId);
    expect(lifecycle.inspect(surface)?.id).toBe(secondId);
    expect(existsSync(sessionDir(cfg.goblinHome, firstId))).toBe(true);

    const resumable = lifecycle.listResumable(surface).map((c) => conversationFor(c));
    const resumeResult = await executeResume({
      rawText: "/resume ttt",
      conversations: resumable,
      bindConversation: async (sessionId) => conversationFor(await lifecycle.resume(surface, sessionId as import("../sessions/types.ts").ConversationId)),
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
    const { compatible, incompatible } = await lifecycle.getResumeCandidates(surface);

    const result = await executeResume({
      rawText: "/resume project conv",
      conversations: compatible,
      incompatibleConversations: incompatible,
      bindConversation: async (sessionId) => conversationFor(await lifecycle.resume(surface, sessionId as ConversationId)),
    });

    expect(result.kind).toBe("incompatible");
    if (result.kind !== "incompatible") throw new Error("expected incompatible");
    expect(result.conversation.id).toBe(projectConv.id);
    expect(lifecycle.inspect(surface)).toBeNull();
  });

  it("/resume moves a conversation across compatible surfaces and adopts destination preferences", async () => {
    const runtimeHost = new FakeRuntimeHost();
    const manager = new ConversationLifecycleManager(
      tmpDir,
      conversationStore,
      new FileBindingStore(tmpDir),
      new FileSurfaceSettings(tmpDir),
      runtimeHost,
    );
    const source = dmSurface(111);
    const destination = dmSurface(222);

    const target = await resolveConversation(manager, source);
    const displaced = await resolveConversation(manager, destination);
    setModelName(tmpDir, destination, "poe/DestinationModel");

    const { compatible, incompatible } = await manager.getResumeCandidates(destination);

    const result = await executeResume({
      rawText: `/resume ${target.id}`,
      conversations: compatible,
      incompatibleConversations: incompatible,
      bindConversation: (conversationId) => manager.resume(destination, conversationId as ConversationId),
    });

    expect(result.kind).toBe("resumed");
    if (result.kind !== "resumed") throw new Error("expected resumed");
    expect(result.conversation.id).toBe(target.id);
    expect(manager.settings.getModelName(destination)).toBe("poe/DestinationModel");
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

    const conv = await resolveConversation(manager, surface);
    throwingStore.throwOn = conv.id;

    const archiveResult = executeArchive({
      archive: () => manager.archive(surface),
    });

    await expect(archiveResult).rejects.toThrow(/archive move failed/);
    expect(manager.inspect(surface)).toBeNull();
    expect(throwingStore.load(conv.id)).not.toBeNull();
    expect(existsSync(sessionDir(tmpDir, conv.id))).toBe(true);
    expect(existsSync(join(sessionsDir(tmpDir), "archive", conv.id))).toBe(false);
    expect(runtimeHost.disposed).toContain(conv.id);
  });

  it("surface heartbeat schedule and prompt survive /new and /archive", async () => {
    const surface = dmSurface(123456);
    const scheduleStore = new ScheduleStore(tmpDir);

    // Enable the surface-owned heartbeat and write a surface-scoped prompt.
    const heartbeat = scheduleStore.setHeartbeat({
      surface,
      enabled: true,
      now: new Date().toISOString(),
    });
    const heartbeatPath = surfaceHeartbeatPath(tmpDir, surfaceId(surface));
    mkdirSync(dirname(heartbeatPath), { recursive: true });
    writeFileSync(heartbeatPath, "custom surface pulse", "utf-8");

    // /new rotates to a fresh conversation.
    const newResult = await executeNew({
      createConversation: async () => conversationFor(await lifecycle.rotate(surface)),
    });
    expect(newResult.kind).toBe("created");
    expect(scheduleStore.getHeartbeat(surface)?.id).toBe(heartbeat.id);
    expect(scheduleStore.getHeartbeat(surface)?.enabled).toBe(true);
    expect(existsSync(heartbeatPath)).toBe(true);

    // /archive clears the binding and moves the conversation directory.
    const archiveResult = await executeArchive({
      archive: () => lifecycle.archive(surface),
    });
    expect(archiveResult.kind).toBe("archived");
    expect(scheduleStore.getHeartbeat(surface)?.enabled).toBe(true);
    expect(existsSync(heartbeatPath)).toBe(true);
    expect(lifecycle.inspect(surface)).toBeNull();
  });
});
