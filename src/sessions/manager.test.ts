import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./manager.ts";
import type { Config } from "../config.ts";
import type { BindingsFile } from "./types.ts";
import { configPath, metricsPath, sessionDir, sessionsDir, statePath, transcriptPath } from "./paths.ts";
import { dmSurface, guestSurface, supergroupSurface, topicSurface, surfaceId, type Surface } from "../surface.ts";

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

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-test-"));
    manager = new SessionManager(makeTestConfig(tmpDir));
    manager.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("resolve", () => {
    it("returns null for unbound DM", () => {
      expect(manager.resolve(dmSurface(123456))).toBeNull();
    });

    it("returns existing DM session after createForSurface", () => {
      const created = manager.createForSurface(dmSurface(123456));
      const resolved = manager.resolve(dmSurface(123456));
      expect(resolved?.id).toBe(created.id);
    });

    it("auto-creates and resolves topic surface", () => {
      const surface = topicSurface("supergroup", 123456, 7);
      const first = manager.resolve(surface);
      const second = manager.resolve(surface);
      expect(first).not.toBeNull();
      expect(second?.id).toBe(first!.id);
      expect(first!.chatId).toBe(123456);
      expect(first!.topicId).toBe(7);
    });

    it("auto-creates and resolves supergroup surface", () => {
      const surface = supergroupSurface(-100123);
      const state = manager.resolve(surface);
      expect(state).not.toBeNull();
    });

    it("auto-creates and resolves guest surface", () => {
      const surface = guestSurface(888);
      const state = manager.resolve(surface);
      expect(state).not.toBeNull();
    });

    it("clears stale DM binding and returns null", () => {
      const surface = dmSurface(123456);
      const first = manager.createForSurface(surface);
      unlinkSync(statePath(tmpDir, first.id));

      expect(manager.resolve(surface)).toBeNull();
      expect(bindingFor(tmpDir).surfaces[surfaceId(surface)]).toBeUndefined();
    });

    it("recreates stale topic/supergroup/guest binding", () => {
      for (const surface of [
        topicSurface("supergroup", 123, 7),
        supergroupSurface(-100456),
        guestSurface(789),
      ] as Surface[]) {
        const first = manager.createForSurface(surface);
        unlinkSync(statePath(tmpDir, first.id));

        const second = manager.resolve(surface);
        expect(second).not.toBeNull();
        expect(second!.id).not.toBe(first.id);
        expect(bindingFor(tmpDir).surfaces[surfaceId(surface)]).toBe(second!.id);
      }
    });
  });

  describe("createForSurface", () => {
    it("creates session with correct metadata", () => {
      const state = manager.createForSurface(dmSurface(123456), { title: "Test" });
      expect(state.chatId).toBe(123456);
      expect(state.title).toBe("Test");
      expect(state.id).toHaveLength(10);
      expect(state.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("creates required files", () => {
      const state = manager.createForSurface(dmSurface(123456));
      expect(existsSync(transcriptPath(tmpDir, state.id))).toBe(true);
      expect(existsSync(metricsPath(tmpDir, state.id))).toBe(true);
      expect(existsSync(join(sessionDir(tmpDir, state.id), "events.jsonl"))).toBe(true);
      expect(existsSync(join(sessionDir(tmpDir, state.id), "workdir"))).toBe(true);
    });

    it("rebinding DM creates a new session and leaves the old one", () => {
      const surface = dmSurface(123456);
      const first = manager.createForSurface(surface);
      const second = manager.createForSurface(surface);
      expect(first.id).not.toBe(second.id);
      expect(existsSync(statePath(tmpDir, first.id))).toBe(true);
      expect(bindingFor(tmpDir).surfaces[surfaceId(surface)]).toBe(second.id);
    });
  });

  describe("numeric collisions", () => {
    it("keeps DM, supergroup, and guest with the same chat id separate", () => {
      const dm = manager.createForSurface(dmSurface(888));
      const sg = manager.createForSurface(supergroupSurface(888));
      const guest = manager.createForSurface(guestSurface(888));

      expect(dm.id).not.toBe(sg.id);
      expect(sg.id).not.toBe(guest.id);

      expect(manager.resolve(dmSurface(888))?.id).toBe(dm.id);
      expect(manager.resolve(supergroupSurface(888))?.id).toBe(sg.id);
      expect(manager.resolve(guestSurface(888))?.id).toBe(guest.id);

      const bindings = bindingFor(tmpDir);
      expect(Object.keys(bindings.surfaces)).toHaveLength(3);
    });

    it("keeps topic containers separate for the same numeric ids", () => {
      const privateTopic = manager.createForSurface(topicSurface("private", 123, 7));
      const supergroupTopic = manager.createForSurface(topicSurface("supergroup", 123, 7));

      expect(privateTopic.id).not.toBe(supergroupTopic.id);

      expect(manager.resolve(topicSurface("private", 123, 7))?.id).toBe(privateTopic.id);
      expect(manager.resolve(topicSurface("supergroup", 123, 7))?.id).toBe(supergroupTopic.id);
    });
  });

  describe("archive", () => {
    it("moves session dir and clears the surface binding", () => {
      const surface = dmSurface(123456);
      const created = manager.createForSurface(surface);

      manager.archive(created.id);

      expect(existsSync(sessionDir(tmpDir, created.id))).toBe(false);
      expect(existsSync(join(sessionsDir(tmpDir), "archive", created.id, "state.json"))).toBe(true);
      expect(bindingFor(tmpDir).surfaces[surfaceId(surface)]).toBeUndefined();
    });

    it("clears every binding for a session archived on multiple surfaces", () => {
      const dm = dmSurface(1);
      const topic = topicSurface("supergroup", 2, 7);
      const session = manager.createForSurface(dm);
      manager.bindExistingToSurface(session.id, topic);

      manager.archive(session.id);

      const bindings = bindingFor(tmpDir);
      expect(Object.keys(bindings.surfaces)).toHaveLength(0);
    });

    it("throws for missing or already-archived session", () => {
      expect(() => manager.archive("0000000000")).toThrow(/not found or already archived/);
    });
  });

  describe("peekBinding", () => {
    it("returns bound session for an exact surface", () => {
      const surface = dmSurface(42);
      const created = manager.createForSurface(surface);
      const peeked = manager.peekBinding(surface);
      expect(peeked?.sessionId).toBe(created.id);
    });

    it("returns null for an unbound surface without creating", () => {
      expect(manager.peekBinding(dmSurface(999))).toBeNull();
      expect(readdirSync(sessionsDir(tmpDir))).toEqual([]);
    });

    it("returns null for a similar but different surface", () => {
      manager.createForSurface(guestSurface(777));
      expect(manager.peekBinding(dmSurface(777))).toBeNull();
    });

    it("returns null when bound state.json is missing", () => {
      const surface = dmSurface(42);
      const created = manager.createForSurface(surface);
      unlinkSync(statePath(tmpDir, created.id));
      expect(manager.peekBinding(surface)).toBeNull();
    });
  });

  describe("bindExistingToSurface", () => {
    it("binds an existing session to a new surface", () => {
      const session = manager.createForSurface(dmSurface(1));
      const topic = topicSurface("supergroup", 2, 7);
      manager.bindExistingToSurface(session.id, topic);

      expect(manager.resolve(topic)?.id).toBe(session.id);
      expect(existsSync(statePath(tmpDir, session.id))).toBe(true);
    });

    it("throws when session does not exist", () => {
      expect(() => manager.bindExistingToSurface("0000000000", dmSurface(1))).toThrow(/session not found/);
    });
  });

  describe("project dir", () => {
    it("binds and reads projectDir per surface", () => {
      const surface = dmSurface(123);
      manager.bindProjectDir(surface, "/home/daniel/project");
      expect(manager.getProjectDir(surface)).toBe("/home/daniel/project");
    });

    it("clears projectDir", () => {
      const surface = dmSurface(123);
      manager.bindProjectDir(surface, "/home/daniel/project");
      manager.bindProjectDir(surface, undefined);
      expect(manager.getProjectDir(surface)).toBeUndefined();
    });

    it("consumes pending project notice", () => {
      const surface = topicSurface("supergroup", 123, 7);
      manager.bindProjectDir(surface, "/home/daniel/project");
      expect(manager.consumeProjectNotice(surface)).toBe("Project directory changed to `/home/daniel/project`.");
      expect(manager.consumeProjectNotice(surface)).toBeUndefined();
    });
  });

});
