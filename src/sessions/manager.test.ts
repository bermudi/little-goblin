import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./manager.ts";
import { ConversationStore } from "./conversation-store.ts";
import { loadBindings, saveBindings } from "./bindings.ts";
import { savePendingProjectAssignment } from "./project-assignment.ts";
import type { Config } from "../config.ts";
import type { BindingsFile } from "./types.ts";
import { configPath, sessionDir, sessionsDir, statePath } from "./paths.ts";
import { dmSurface, guestSurface, surfaceId, type Surface } from "../surface.ts";
import { personalEnvironment, projectEnvironment } from "./environment.ts";
import { runtimeSessionWithPreferences } from "./conversation.ts";
import { bindProjectRoot } from "./topic-settings.ts";

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

function bindingFor(home: string): BindingsFile {
  return JSON.parse(readFileSync(configPath(home), "utf-8")) as BindingsFile;
}

describe("SessionManager", () => {
  let tmpDir: string;
  let manager: SessionManager;
  let store: ConversationStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-test-"));
    manager = new SessionManager(makeTestConfig(tmpDir));
    await manager.init();
    store = new ConversationStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createSession(surface: Surface, title?: string) {
    const env = manager.effectiveEnvironment(surface);
    const conv = store.create(env, title);
    const bindings = loadBindings(tmpDir);
    bindings.surfaces[surfaceId(surface)] = conv.id;
    saveBindings(tmpDir, bindings);
    return runtimeSessionWithPreferences(conv, surface, tmpDir);
  }

  describe("peekBinding", () => {
    it("returns bound session for an exact surface", async () => {
      const surface = dmSurface(42);
      const created = await createSession(surface);
      const peeked = await manager.peekBinding(surface);
      expect(peeked?.sessionId).toBe(created.id);
    });

    it("returns null for an unbound surface without creating", async () => {
      expect(await manager.peekBinding(dmSurface(999))).toBeNull();
      expect(readdirSync(sessionsDir(tmpDir))).toEqual([]);
    });

    it("returns null for a similar but different surface", async () => {
      await createSession(guestSurface(777));
      expect(await manager.peekBinding(dmSurface(777))).toBeNull();
    });

    it("returns null when bound state.json is missing", async () => {
      const surface = dmSurface(42);
      const created = await createSession(surface);
      unlinkSync(statePath(tmpDir, created.id));
      expect(await manager.peekBinding(surface)).toBeNull();
    });

    it("replays a pending project assignment before reading", async () => {
      const surface = dmSurface(42);
      const projectDir = join(tmpDir, "project");
      mkdirSync(projectDir, { recursive: true });
      const conv = store.create(projectEnvironment(projectDir));
      const key = surfaceId(surface);
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: key,
        plannedSessionId: conv.id,
        projectRoot: projectDir,
      });

      const peeked = await manager.peekBinding(surface);
      expect(peeked?.sessionId).toBe(conv.id);
      expect(bindingFor(tmpDir).surfaces[key]).toBe(conv.id);
    });
  });

  describe("list", () => {
    it("lists bound sessions sorted by creation time", async () => {
      const first = await createSession(dmSurface(1));
      const second = await createSession(dmSurface(2));
      const list = manager.list();
      expect(list.map((s) => s.id)).toEqual([first.id, second.id]);
    });

    it("skips sessions with missing state.json", async () => {
      const first = await createSession(dmSurface(1));
      await createSession(dmSurface(2));
      unlinkSync(statePath(tmpDir, first.id));
      const list = manager.list();
      expect(list).toHaveLength(1);
    });
  });

  describe("isArchived", () => {
    it("returns true when the session directory is in archive/", async () => {
      const conv = store.create(personalEnvironment());
      store.archive(conv.id);
      expect(manager.isArchived(conv.id)).toBe(true);
    });

    it("returns false for a non-archived session", async () => {
      const conv = store.create(personalEnvironment());
      expect(manager.isArchived(conv.id)).toBe(false);
    });
  });

  describe("setTitle", () => {
    it("sets and persists the conversation title", async () => {
      const conv = store.create(personalEnvironment());
      manager.setTitle(conv.id, "my title");
      const reloaded = store.load(conv.id);
      expect(reloaded?.title).toBe("my title");
    });
  });

  describe("ensureInternal", () => {
    it("creates an internal session with chatId 0", () => {
      const state = manager.ensureInternal("__internal_test__");
      expect(state.chatId).toBe(0);
      expect(state.executionEnvironment).toEqual(personalEnvironment());
      expect(existsSync(sessionDir(tmpDir, state.id))).toBe(true);
    });

    it("returns existing internal session", () => {
      const first = manager.ensureInternal("__internal_test__");
      const second = manager.ensureInternal("__internal_test__");
      expect(second.id).toBe(first.id);
    });
  });

  describe("effectiveEnvironment", () => {
    function makeProjectDir(name: string): string {
      const dir = join(tmpDir, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    it("returns personal for an unassigned surface", () => {
      expect(manager.effectiveEnvironment(dmSurface(123))).toEqual(personalEnvironment());
    });

    it("returns project for an assigned surface", () => {
      const surface = dmSurface(123);
      const projectDir = makeProjectDir("project");
      bindProjectRoot(tmpDir, surface, projectDir);
      expect(manager.effectiveEnvironment(surface)).toEqual(projectEnvironment(projectDir));
    });

    it("does not expose legacy bindProjectDir/getProjectDir/consumeProjectNotice", () => {
      expect("bindProjectDir" in manager).toBe(false);
      expect("getProjectDir" in manager).toBe(false);
      expect("consumeProjectNotice" in manager).toBe(false);
    });
  });
});
