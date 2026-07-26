import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
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

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-test-"));
    manager = new SessionManager(makeTestConfig(tmpDir));
    await manager.init();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("resolve", () => {
    it("returns null for unbound DM", async () => {
      expect(await manager.resolve(dmSurface(123456))).toBeNull();
    });

    it("returns existing DM session after createForSurface", async () => {
      const created = await manager.createForSurface(dmSurface(123456));
      const resolved = await manager.resolve(dmSurface(123456));
      expect(resolved?.id).toBe(created.id);
    });

    it("auto-creates and resolves topic surface", async () => {
      const surface = topicSurface("supergroup", 123456, 7);
      const first = await manager.resolve(surface);
      const second = await manager.resolve(surface);
      expect(first).not.toBeNull();
      expect(second?.id).toBe(first!.id);
      expect(first!.chatId).toBe(123456);
      expect(first!.topicId).toBe(7);
    });

    it("auto-creates and resolves supergroup surface", async () => {
      const surface = supergroupSurface(-100123);
      const state = await manager.resolve(surface);
      expect(state).not.toBeNull();
    });

    it("auto-creates and resolves guest surface", async () => {
      const surface = guestSurface(888);
      const state = await manager.resolve(surface);
      expect(state).not.toBeNull();
    });

    it("clears stale DM binding and returns null", async () => {
      const surface = dmSurface(123456);
      const first = await manager.createForSurface(surface);
      unlinkSync(statePath(tmpDir, first.id));

      expect(await manager.resolve(surface)).toBeNull();
      expect(bindingFor(tmpDir).surfaces[surfaceId(surface)]).toBeUndefined();
    });

    it("recreates stale topic/supergroup/guest binding", async () => {
      for (const surface of [
        topicSurface("supergroup", 123, 7),
        supergroupSurface(-100456),
        guestSurface(789),
      ] as Surface[]) {
        const first = await manager.createForSurface(surface);
        unlinkSync(statePath(tmpDir, first.id));

        const second = await manager.resolve(surface);
        expect(second).not.toBeNull();
        expect(second!.id).not.toBe(first.id);
        expect(bindingFor(tmpDir).surfaces[surfaceId(surface)]).toBe(second!.id);
      }
    });
  });

  describe("createForSurface", () => {
    it("creates session with correct metadata", async () => {
      const state = await manager.createForSurface(dmSurface(123456), { title: "Test" });
      expect(state.chatId).toBe(123456);
      expect(state.title).toBe("Test");
      expect(state.id).toHaveLength(10);
      expect(state.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("creates required files", async () => {
      const state = await manager.createForSurface(dmSurface(123456));
      expect(existsSync(transcriptPath(tmpDir, state.id))).toBe(true);
      expect(existsSync(metricsPath(tmpDir, state.id))).toBe(true);
      expect(existsSync(join(sessionDir(tmpDir, state.id), "events.jsonl"))).toBe(true);
      expect(existsSync(join(sessionDir(tmpDir, state.id), "workdir"))).toBe(true);
    });

    it("rebinding DM creates a new session and leaves the old one", async () => {
      const surface = dmSurface(123456);
      const first = await manager.createForSurface(surface);
      const second = await manager.createForSurface(surface);
      expect(first.id).not.toBe(second.id);
      expect(existsSync(statePath(tmpDir, first.id))).toBe(true);
      expect(bindingFor(tmpDir).surfaces[surfaceId(surface)]).toBe(second.id);
    });
  });

  describe("numeric collisions", () => {
    it("keeps DM, supergroup, and guest with the same chat id separate", async () => {
      const dm = await manager.createForSurface(dmSurface(888));
      const sg = await manager.createForSurface(supergroupSurface(888));
      const guest = await manager.createForSurface(guestSurface(888));

      expect(dm.id).not.toBe(sg.id);
      expect(sg.id).not.toBe(guest.id);

      expect((await manager.resolve(dmSurface(888)))?.id).toBe(dm.id);
      expect((await manager.resolve(supergroupSurface(888)))?.id).toBe(sg.id);
      expect((await manager.resolve(guestSurface(888)))?.id).toBe(guest.id);

      const bindings = bindingFor(tmpDir);
      expect(Object.keys(bindings.surfaces)).toHaveLength(3);
    });

    it("keeps topic containers separate for the same numeric ids", async () => {
      const privateTopic = await manager.createForSurface(topicSurface("private", 123, 7));
      const supergroupTopic = await manager.createForSurface(topicSurface("supergroup", 123, 7));

      expect(privateTopic.id).not.toBe(supergroupTopic.id);

      expect((await manager.resolve(topicSurface("private", 123, 7)))?.id).toBe(privateTopic.id);
      expect((await manager.resolve(topicSurface("supergroup", 123, 7)))?.id).toBe(supergroupTopic.id);
    });
  });

  describe("archive", () => {
    it("moves session dir and clears the surface binding", async () => {
      const surface = dmSurface(123456);
      const created = await manager.createForSurface(surface);

      await manager.archive(created.id);

      expect(existsSync(sessionDir(tmpDir, created.id))).toBe(false);
      expect(existsSync(join(sessionsDir(tmpDir), "archive", created.id, "state.json"))).toBe(true);
      expect(bindingFor(tmpDir).surfaces[surfaceId(surface)]).toBeUndefined();
    });

    it("clears every binding for a session archived on multiple surfaces", async () => {
      const dm = dmSurface(1);
      const topic = topicSurface("supergroup", 2, 7);
      const session = await manager.createForSurface(dm);
      await manager.bindExistingToSurface(session.id, topic);

      await manager.archive(session.id);

      const bindings = bindingFor(tmpDir);
      expect(Object.keys(bindings.surfaces)).toHaveLength(0);
    });

    it("throws for missing or already-archived session", async () => {
      await expect(manager.archive("0000000000")).rejects.toThrow(/not found or already archived/);
    });
  });

  describe("peekBinding", () => {
    it("returns bound session for an exact surface", async () => {
      const surface = dmSurface(42);
      const created = await manager.createForSurface(surface);
      const peeked = await manager.peekBinding(surface);
      expect(peeked?.sessionId).toBe(created.id);
    });

    it("returns null for an unbound surface without creating", async () => {
      expect(await manager.peekBinding(dmSurface(999))).toBeNull();
      expect(readdirSync(sessionsDir(tmpDir))).toEqual([]);
    });

    it("returns null for a similar but different surface", async () => {
      await manager.createForSurface(guestSurface(777));
      expect(await manager.peekBinding(dmSurface(777))).toBeNull();
    });

    it("returns null when bound state.json is missing", async () => {
      const surface = dmSurface(42);
      const created = await manager.createForSurface(surface);
      unlinkSync(statePath(tmpDir, created.id));
      expect(await manager.peekBinding(surface)).toBeNull();
    });
  });

  describe("bindExistingToSurface", () => {
    it("binds an existing session to a new surface", async () => {
      const session = await manager.createForSurface(dmSurface(1));
      const topic = topicSurface("supergroup", 2, 7);
      await manager.bindExistingToSurface(session.id, topic);

      expect((await manager.resolve(topic))?.id).toBe(session.id);
      expect(existsSync(statePath(tmpDir, session.id))).toBe(true);
    });

    it("throws when session does not exist", async () => {
      await expect(manager.bindExistingToSurface("0000000000", dmSurface(1))).rejects.toThrow(/session not found/);
    });
  });

  describe("project dir", () => {
    function makeProjectDir(name: string): string {
      const dir = join(tmpDir, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    it("binds and reads projectDir per surface", async () => {
      const surface = dmSurface(123);
      const projectDir = makeProjectDir("project");
      manager.bindProjectDir(surface, projectDir);
      expect(manager.getProjectDir(surface)).toBe(projectDir);
    });

    it("clears projectDir", async () => {
      const surface = dmSurface(123);
      manager.bindProjectDir(surface, makeProjectDir("project"));
      manager.bindProjectDir(surface, undefined);
      expect(manager.getProjectDir(surface)).toBeUndefined();
    });

    it("consumes pending project notice", async () => {
      const surface = topicSurface("supergroup", 123, 7);
      const projectDir = makeProjectDir("project");
      manager.bindProjectDir(surface, projectDir);
      expect(manager.consumeProjectNotice(surface)).toBe(`Project directory changed to \`${projectDir}\`.`);
      expect(manager.consumeProjectNotice(surface)).toBeUndefined();
    });
  });

  describe("assignProject", () => {
    function makeProjectDir(name: string): string {
      const dir = join(tmpDir, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    function makeRuntimeLifecycle(disposed: string[] = []): { disposeRuntime: (id: string) => Promise<void>; disposed: string[] } {
      return {
        disposeRuntime: async (id: string) => {
          disposed.push(id);
        },
        disposed,
      };
    }

    it("assigns a project environment and binds a new session", async () => {
      const surface = dmSurface(123);
      const projectDir = makeProjectDir("project");
      const lifecycle = makeRuntimeLifecycle();

      const result = await manager.assignProject(surface, projectDir, lifecycle);

      expect(result.kind).toBe("assigned");
      if (result.kind === "assigned") {
        expect(result.projectRoot).toBe(projectDir);
        expect(result.session.executionEnvironment).toEqual({ kind: "project", projectRoot: projectDir });
        expect((await manager.resolve(surface))?.id).toBe(result.session.id);
      }
      expect(lifecycle.disposed).toEqual([]);
    });

    it("returns already-assigned for the same canonical root", async () => {
      const surface = dmSurface(123);
      const projectDir = makeProjectDir("project");
      const lifecycle = makeRuntimeLifecycle();
      const first = await manager.assignProject(surface, projectDir, lifecycle);
      expect(first.kind).toBe("assigned");

      const second = await manager.assignProject(surface, projectDir, lifecycle);
      expect(second.kind).toBe("already-assigned");
    });

    it("returns conflict for a different canonical root", async () => {
      const surface = dmSurface(123);
      const firstDir = makeProjectDir("first");
      const secondDir = makeProjectDir("second");
      const lifecycle = makeRuntimeLifecycle();
      await manager.assignProject(surface, firstDir, lifecycle);

      const result = await manager.assignProject(surface, secondDir, lifecycle);
      expect(result.kind).toBe("conflict");
    });

    it("disposes the previous runtime before assigning", async () => {
      const surface = dmSurface(123);
      const prior = await manager.createForSurface(surface);
      const projectDir = makeProjectDir("project");
      const lifecycle = makeRuntimeLifecycle();

      const result = await manager.assignProject(surface, projectDir, lifecycle);

      expect(result.kind).toBe("assigned");
      expect(lifecycle.disposed).toContain(prior.id);
    });

    it("replays a pending assignment from a previous crash", async () => {
      const surface = dmSurface(123);
      const projectDir = makeProjectDir("project");
      const lifecycle = makeRuntimeLifecycle();

      const first = await manager.assignProject(surface, projectDir, lifecycle);
      expect(first.kind).toBe("assigned");

      // Simulate a fresh manager (e.g., after restart) that sees the cleared intent.
      const freshManager = new SessionManager(makeTestConfig(tmpDir));
      await freshManager.init();

      const second = await freshManager.assignProject(surface, projectDir, lifecycle);
      expect(second.kind).toBe("already-assigned");
      if (second.kind === "already-assigned") {
        expect(second.session?.id).toBe((first as { session: { id: string } }).session.id);
      }
    });
  });

});
