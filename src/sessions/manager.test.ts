import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./manager.ts";
import type { Config } from "../config.ts";
import type { ChatLocator, BindingsFile } from "./types.ts";
import { topicSettingsPath } from "./paths.ts";

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

describe("SessionManager", () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-test-"));
    manager = new SessionManager(makeTestConfig(tmpDir));
    manager.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("resolve", () => {
    it("returns null for DM when no session exists", () => {
      const loc: ChatLocator = { chatId: 123456 };
      expect(manager.resolve(loc)).toBeNull();
    });

    it("auto-creates session for topic on first resolve", () => {
      const loc: ChatLocator = { chatId: 123456, topicId: 7 };
      const state = manager.resolve(loc);
      expect(state).not.toBeNull();
      expect(state?.chatId).toBe(123456);
      expect(state?.topicId).toBe(7);
    });

    it("returns existing session for topic on second resolve", () => {
      const loc: ChatLocator = { chatId: 123456, topicId: 7 };
      const first = manager.resolve(loc);
      const second = manager.resolve(loc);
      expect(first?.id).toBe(second?.id);
    });

    it("returns existing DM session after createForChat", () => {
      const loc: ChatLocator = { chatId: 123456 };
      const created = manager.createForChat(loc);
      const resolved = manager.resolve(loc);
      expect(resolved?.id).toBe(created.id);
    });

    it("auto-recreates topic session when state.json is missing (stale binding)", () => {
      const loc: ChatLocator = { chatId: 123456, topicId: 7 };
      // Create initial session
      const first = manager.createForChat(loc);
      // Delete state.json but leave binding intact
      unlinkSync(join(tmpDir, "sessions", first.id, "state.json"));

      // Resolve should auto-create new session and update binding
      const second = manager.resolve(loc);
      expect(second).not.toBeNull();
      expect(second!.id).not.toBe(first.id);
      expect(second!.chatId).toBe(123456);
      expect(second!.topicId).toBe(7);

      // Verify binding was updated in config.json
      const configRaw = readFileSync(join(tmpDir, "config.json"), "utf-8");
      const config = JSON.parse(configRaw) as BindingsFile;
      expect(config.topics?.["123456"]?.["7"]).toBe(second!.id);

      // Orphaned session dir should still exist (sessions persist forever)
      expect(existsSync(join(tmpDir, "sessions", first.id))).toBe(true);
      expect(existsSync(join(tmpDir, "sessions", second!.id))).toBe(true);
    });

    it("clears stale DM binding when state.json is missing", () => {
      const loc: ChatLocator = { chatId: 123456 };
      // Create initial session
      const first = manager.createForChat(loc);
      // Delete state.json but leave binding intact
      unlinkSync(join(tmpDir, "sessions", first.id, "state.json"));

      // Resolve should clear binding and return null
      const resolved = manager.resolve(loc);
      expect(resolved).toBeNull();

      // Verify binding was cleared in config.json
      const configRaw = readFileSync(join(tmpDir, "config.json"), "utf-8");
      const config = JSON.parse(configRaw) as BindingsFile;
      expect(config.dm?.["123456"]).toBeUndefined();
    });
  });

  describe("createForChat", () => {
    it("creates session with correct metadata", () => {
      const loc: ChatLocator = { chatId: 123456 };
      const state = manager.createForChat(loc, { title: "Test Session" });
      expect(state.chatId).toBe(123456);
      expect(state.title).toBe("Test Session");
      expect(state.id).toHaveLength(10);
      expect(state.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("creates empty transcript.jsonl", () => {
      const loc: ChatLocator = { chatId: 123456 };
      const state = manager.createForChat(loc);
      expect(existsSync(join(tmpDir, "sessions", state.id, "transcript.jsonl"))).toBe(true);
    });

    it("rebinding DM creates new session without deleting old", () => {
      const loc: ChatLocator = { chatId: 123456 };
      const first = manager.createForChat(loc);
      const second = manager.createForChat(loc);
      expect(first.id).not.toBe(second.id);
      // Both sessions should still exist on disk
      expect(existsSync(join(tmpDir, "sessions", first.id, "state.json"))).toBe(true);
      expect(existsSync(join(tmpDir, "sessions", second.id, "state.json"))).toBe(true);
    });
  });

  describe("reload", () => {
    it("preserves bindings when manager is recreated", () => {
      const loc: ChatLocator = { chatId: 123456 };
      const created = manager.createForChat(loc);

      // Create new manager pointing at same home
      const manager2 = new SessionManager(makeTestConfig(tmpDir));
      const resolved = manager2.resolve(loc);
      expect(resolved?.id).toBe(created.id);
    });
  });

  describe("archive", () => {
    it("moves session dir to sessions/archive/<id>/ and clears DM binding", () => {
      const loc: ChatLocator = { chatId: 123456 };
      const created = manager.createForChat(loc);
      expect(existsSync(join(tmpDir, "sessions", created.id, "state.json"))).toBe(true);

      manager.archive(created.id);

      expect(existsSync(join(tmpDir, "sessions", created.id))).toBe(false);
      expect(existsSync(join(tmpDir, "sessions", "archive", created.id, "state.json"))).toBe(true);

      const config = JSON.parse(readFileSync(join(tmpDir, "config.json"), "utf-8")) as BindingsFile;
      expect(config.dm?.["123456"]).toBeUndefined();
    });

    it("clears topic binding and prunes empty chat entry", () => {
      const loc: ChatLocator = { chatId: 999, topicId: 7 };
      const created = manager.createForChat(loc);

      manager.archive(created.id);

      const config = JSON.parse(readFileSync(join(tmpDir, "config.json"), "utf-8")) as BindingsFile;
      expect(config.topics?.["999"]).toBeUndefined();
    });

    it("clears supergroup binding", () => {
      const loc: ChatLocator = { chatId: 555 };
      const created = manager.createForChat(loc, { isSupergroup: true });

      manager.archive(created.id);

      const config = JSON.parse(readFileSync(join(tmpDir, "config.json"), "utf-8")) as BindingsFile;
      expect(config.supergroups?.["555"]).toBeUndefined();
    });

    it("throws when session dir does not exist", () => {
      expect(() => manager.archive("nonexistent")).toThrow(/not found or already archived/);
    });

    it("throws when called twice on the same session", () => {
      const created = manager.createForChat({ chatId: 1 });
      manager.archive(created.id);
      expect(() => manager.archive(created.id)).toThrow(/not found or already archived/);
    });

    it("list() ignores the archive subtree", () => {
      const a = manager.createForChat({ chatId: 1 });
      const b = manager.createForChat({ chatId: 2 });
      manager.archive(a.id);

      const ids = manager.list().map((s) => s.id);
      expect(ids).toEqual([b.id]);
    });
  });

  describe("isArchived", () => {
    it("returns true for a session archived via archive()", () => {
      const created = manager.createForChat({ chatId: 1 });
      expect(manager.isArchived(created.id)).toBe(false);
      manager.archive(created.id);
      expect(manager.isArchived(created.id)).toBe(true);
    });

    it("returns false for a live session", () => {
      const created = manager.createForChat({ chatId: 1 });
      expect(manager.isArchived(created.id)).toBe(false);
    });

    it("returns false for an unknown id (never existed)", () => {
      expect(manager.isArchived("never-existed")).toBe(false);
    });

    it("returns false for a session whose dir was removed without archive", () => {
      // Manually deleting a session dir (not via archive) MUST NOT be labeled
      // archived — the scheduler distinguishes archived (cleared binding +
      // moved dir) from a generic mismatch. This pins the precise semantics.
      const created = manager.createForChat({ chatId: 1 });
      rmSync(join(tmpDir, "sessions", created.id), { recursive: true, force: true });
      expect(manager.isArchived(created.id)).toBe(false);
    });
  });

  describe("list", () => {
    it("returns empty array when no sessions", () => {
      expect(manager.list()).toEqual([]);
    });

    it("returns sessions sorted by createdAt", () => {
      manager.createForChat({ chatId: 1 });
      // Small delay to ensure different timestamps
      Bun.sleepSync(10);
      manager.createForChat({ chatId: 2 });

      const list = manager.list();
      expect(list).toHaveLength(2);
      const [a, b] = list;
      expect(a!.createdAt < b!.createdAt).toBe(true);
    });

    it("includes orphaned sessions (no longer bound but dir exists)", () => {
      const loc: ChatLocator = { chatId: 123456 };
      // Create two sessions, second orphans first
      const first = manager.createForChat(loc);
      const second = manager.createForChat(loc);

      // Both should appear in list even though only second is bound
      const list = manager.list();
      const ids = list.map((s) => s.id).sort();
      expect(ids).toEqual([first.id, second.id].sort());
    });
  });

  describe("getProjectDir", () => {
    it("returns undefined when no topic settings exist", () => {
      const loc: ChatLocator = { chatId: 123456, topicId: 7 };
      expect(manager.getProjectDir(loc)).toBeUndefined();
    });

    it("returns projectDir from topic settings", () => {
      const loc: ChatLocator = { chatId: 123456, topicId: 7 };
      manager.bindProjectDir(loc, "/home/daniel/project");
      expect(manager.getProjectDir(loc)).toBe("/home/daniel/project");
    });

    it("returns projectDir for DM", () => {
      const loc: ChatLocator = { chatId: 123456 };
      manager.bindProjectDir(loc, "/home/daniel/dm-project");
      expect(manager.getProjectDir(loc)).toBe("/home/daniel/dm-project");
    });

    it("returns undefined after clearing", () => {
      const loc: ChatLocator = { chatId: 123456 };
      manager.bindProjectDir(loc, "/home/daniel/project");
      manager.bindProjectDir(loc, undefined);
      expect(manager.getProjectDir(loc)).toBeUndefined();
    });
  });

  describe("bindProjectDir", () => {
    it("persists projectDir to topic-settings.json", () => {
      const loc: ChatLocator = { chatId: 123456, topicId: 7 };
      manager.bindProjectDir(loc, "/home/daniel/project");

      const raw = readFileSync(topicSettingsPath(tmpDir), "utf-8");
      const settings = JSON.parse(raw);
      expect(settings.topics["123456"]["7"].projectDir).toBe("/home/daniel/project");
    });

    it("clears projectDir from topic-settings.json", () => {
      const loc: ChatLocator = { chatId: 123456, topicId: 7 };
      manager.bindProjectDir(loc, "/home/daniel/project");
      manager.bindProjectDir(loc, undefined);

      const raw = readFileSync(topicSettingsPath(tmpDir), "utf-8");
      const settings = JSON.parse(raw);
      expect(settings.topics?.["123456"]?.["7"]).toBeUndefined();
    });
  });

  describe("consumeProjectNotice", () => {
    it("returns and clears the pending notice via manager", () => {
      const loc: ChatLocator = { chatId: 123456, topicId: 7 };
      manager.bindProjectDir(loc, "/home/daniel/project");

      const notice = manager.consumeProjectNotice(loc);
      expect(notice).toBe("Project directory changed to `/home/daniel/project`.");

      // Consumed — second call returns undefined
      expect(manager.consumeProjectNotice(loc)).toBeUndefined();
    });

    it("returns undefined when no notice is pending", () => {
      const loc: ChatLocator = { chatId: 123456 };
      expect(manager.consumeProjectNotice(loc)).toBeUndefined();
    });
  });

  describe("setModelName", () => {
    it("sets modelName on an existing session", () => {
      const loc: ChatLocator = { chatId: 1 };
      const created = manager.createForChat(loc);
      expect(created.modelName).toBeUndefined();

      manager.setModelName(created.id, "poe/GPT-4o");
      const updated = manager.resolve(loc);
      expect(updated?.modelName).toBe("poe/GPT-4o");
    });

    it("clears modelName when passed undefined", () => {
      const loc: ChatLocator = { chatId: 1 };
      const created = manager.createForChat(loc);
      manager.setModelName(created.id, "poe/GPT-4o");

      manager.setModelName(created.id, undefined);
      const updated = manager.resolve(loc);
      expect(updated?.modelName).toBeUndefined();
    });

    it("throws when session does not exist", () => {
      expect(() => manager.setModelName("nonexistent", "poe/GPT-4o")).toThrow(
        /session not found/,
      );
    });
  });

  describe("setThinkingLevel", () => {
    it("sets thinkingLevel on an existing session", () => {
      const loc: ChatLocator = { chatId: 1 };
      const created = manager.createForChat(loc);
      expect(created.thinkingLevel).toBeUndefined();

      manager.setThinkingLevel(created.id, "high");
      const updated = manager.resolve(loc);
      expect(updated?.thinkingLevel).toBe("high");
    });

    it("clears thinkingLevel when passed undefined", () => {
      const loc: ChatLocator = { chatId: 1 };
      const created = manager.createForChat(loc);
      manager.setThinkingLevel(created.id, "high");

      manager.setThinkingLevel(created.id, undefined);
      const updated = manager.resolve(loc);
      expect(updated?.thinkingLevel).toBeUndefined();
    });

    it("throws when session does not exist", () => {
      expect(() => manager.setThinkingLevel("nonexistent", "high")).toThrow(
        /session not found/,
      );
    });
  });

  describe("setTitle", () => {
    it("sets title on an existing session", () => {
      const loc: ChatLocator = { chatId: 1 };
      const created = manager.createForChat(loc);

      manager.setTitle(created.id, "memory refactor");
      const updated = manager.resolve(loc);
      expect(updated?.title).toBe("memory refactor");
    });

    it("throws when session does not exist", () => {
      expect(() => manager.setTitle("nonexistent", "nope")).toThrow(/session not found/);
    });
  });

  describe("bindExistingToChat", () => {
    it("rebinds a DM to an existing session", () => {
      const first = manager.createForChat({ chatId: 1 });
      const second = manager.createForChat({ chatId: 2 });

      const rebound = manager.bindExistingToChat(first.id, { chatId: 2 });

      expect(rebound.id).toBe(first.id);
      expect(manager.resolve({ chatId: 2 })?.id).toBe(first.id);
      expect(existsSync(join(tmpDir, "sessions", second.id, "state.json"))).toBe(true);
    });

    it("throws when session does not exist", () => {
      expect(() => manager.bindExistingToChat("nonexistent", { chatId: 1 })).toThrow(/session not found/);
    });
  });

  describe("peekBinding", () => {
    it("returns the bound session id and state for a DM", () => {
      const loc: ChatLocator = { chatId: 42 };
      const created = manager.createForChat(loc);

      const peeked = manager.peekBinding(loc);
      expect(peeked).not.toBeNull();
      expect(peeked!.sessionId).toBe(created.id);
      expect(peeked!.state.id).toBe(created.id);
    });

    it("returns null on missing binding (DM with no session)", () => {
      expect(manager.peekBinding({ chatId: 999 })).toBeNull();
    });

    it("returns null for an unbound topic locator without auto-creating", () => {
      const loc: ChatLocator = { chatId: 5, topicId: 9 };
      expect(manager.peekBinding(loc)).toBeNull();

      // Critical: peekBinding MUST NOT auto-create. Assert no session
      // subdirectory and no binding entries appeared (manager.init() creates
      // the empty sessions/ dir, so we check its contents).
      expect(readdirSync(join(tmpDir, "sessions"))).toEqual([]);
      expect(existsSync(join(tmpDir, "config.json"))).toBe(false);
    });

    it("returns the bound session for a topic locator without mutating", () => {
      const loc: ChatLocator = { chatId: 5, topicId: 9 };
      const created = manager.createForChat(loc);

      const peeked = manager.peekBinding(loc);
      expect(peeked!.sessionId).toBe(created.id);

      // Second peek is idempotent — no new sessions created
      const peeked2 = manager.peekBinding(loc);
      expect(peeked2!.sessionId).toBe(created.id);
    });

    it("returns null for a supergroup locator without auto-creating", () => {
      const loc: ChatLocator = { chatId: 777 };
      expect(manager.peekBinding(loc)).toBeNull();
      expect(readdirSync(join(tmpDir, "sessions"))).toEqual([]);
    });

    it("returns null when the bound state is missing (archived session)", () => {
      const loc: ChatLocator = { chatId: 42 };
      const created = manager.createForChat(loc);
      manager.archive(created.id);

      // Archive clears the DM binding, so peekBinding sees nothing.
      expect(manager.peekBinding(loc)).toBeNull();
    });

    it("returns null when binding exists but state.json is missing", () => {
      const loc: ChatLocator = { chatId: 42 };
      const created = manager.createForChat(loc);
      // Leave the binding intact, delete state.json to simulate a dangling binding
      unlinkSync(join(tmpDir, "sessions", created.id, "state.json"));

      expect(manager.peekBinding(loc)).toBeNull();
    });

    it("does not auto-create on stale topic binding (unlike resolve)", () => {
      const loc: ChatLocator = { chatId: 100, topicId: 7 };
      const created = manager.createForChat(loc);
      unlinkSync(join(tmpDir, "sessions", created.id, "state.json"));

      // peekBinding must return null and MUST NOT recreate the session.
      expect(manager.peekBinding(loc)).toBeNull();

      // The topic binding still references the old (now-stateless) session,
      // and no new session directory was created — only the original (now
      // stateless) dir remains.
      const config = JSON.parse(readFileSync(join(tmpDir, "config.json"), "utf-8")) as BindingsFile;
      expect(config.topics?.["100"]?.["7"]).toBe(created.id);
      expect(readdirSync(join(tmpDir, "sessions"))).toEqual([created.id]);
    });
  });
});
