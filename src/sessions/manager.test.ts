import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./manager.ts";
import type { Config } from "../config.ts";
import type { ChatLocator, BindingsFile } from "./types.ts";

function makeTestConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([123]),
    modelName: "poe/Claude-Sonnet-4.6",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "info",
    toolVisibility: "standard",
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

    it("creates empty jsonl files", () => {
      const loc: ChatLocator = { chatId: 123456 };
      const state = manager.createForChat(loc);
      expect(existsSync(join(tmpDir, "sessions", state.id, "events.jsonl"))).toBe(true);
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
});
