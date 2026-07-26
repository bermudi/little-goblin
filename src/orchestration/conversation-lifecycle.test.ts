import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLifecycleManager } from "./conversation-lifecycle.ts";
import type { SurfaceSettings, ConversationLifecycle } from "./conversation-lifecycle.ts";
import type { ConversationRuntimeHost } from "./conversation-runtime-host.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import type { BindingStore } from "../sessions/bindings.ts";
import { validateBindings } from "../sessions/bindings.ts";
import type { BindingsFile } from "../sessions/types.ts";
import type { ConversationId } from "../sessions/types.ts";
import { savePendingProjectAssignment } from "../sessions/project-assignment.ts";
import { personalEnvironment, projectEnvironment, type ExecutionEnvironment } from "../sessions/environment.ts";
import { dmSurface, surfaceId } from "../surface.ts";

class InMemoryBindingStore implements BindingStore {
  bindings: BindingsFile = { version: 1, surfaces: {} };
  failNextSave = false;

  load(): BindingsFile {
    return this.bindings;
  }

  save(b: BindingsFile): void {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("binding save failed");
    }
    validateBindings(b);
    this.bindings = { version: 1, surfaces: { ...b.surfaces } } as BindingsFile;
  }
}

class FakeRuntimeHost implements ConversationRuntimeHost {
  disposed: ConversationId[] = [];
  throwOnNext: ConversationId | null = null;

  async disposeRuntime(id: ConversationId): Promise<void> {
    if (this.throwOnNext === id) {
      this.throwOnNext = null;
      throw new Error(`dispose failed for ${id}`);
    }
    this.disposed.push(id);
  }
}

function staticSettings(env: ExecutionEnvironment): SurfaceSettings {
  return { effectiveEnvironment: () => env };
}

type Deps = {
  home: string;
  store: ConversationStore;
  bindings: InMemoryBindingStore;
  runtimeHost: FakeRuntimeHost;
  lifecycle: ConversationLifecycle;
};

function makeLifecycle(env: ExecutionEnvironment, home: string): Deps {
  const store = new ConversationStore(home);
  const bindings = new InMemoryBindingStore();
  const runtimeHost = new FakeRuntimeHost();
  const lifecycle = new ConversationLifecycleManager(home, store, bindings, staticSettings(env), runtimeHost);
  return { home, store, bindings, runtimeHost, lifecycle };
}

describe("ConversationLifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-lifecycle-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("inspect", () => {
    it("returns null for an unbound surface", () => {
      const { lifecycle } = makeLifecycle(personalEnvironment(), tmpDir);
      expect(lifecycle.inspect(dmSurface(1))).toBeNull();
    });

    it("returns the bound compatible conversation", async () => {
      const { lifecycle } = makeLifecycle(personalEnvironment(), tmpDir);
      const created = await lifecycle.resolveOrStart(dmSurface(1));
      const lookedUp = lifecycle.inspect(dmSurface(1));
      expect(lookedUp?.id).toBe(created.id);
      expect(lookedUp?.executionEnvironment).toEqual(personalEnvironment());
    });

    it("returns null when the bound conversation is incompatible with the surface environment", async () => {
      const { lifecycle, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });
      const conv = new ConversationStore(tmpDir).create(projectEnvironment(projectRoot));
      bindings.bindings = { version: 1, surfaces: { [surfaceId(dmSurface(1))]: conv.id } } as BindingsFile;
      expect(lifecycle.inspect(dmSurface(1))).toBeNull();
    });
  });

  describe("resolveOrStart", () => {
    it("creates and binds a conversation for an unbound DM surface", async () => {
      const { lifecycle, store, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const conv = await lifecycle.resolveOrStart(surface);
      expect(conv.executionEnvironment).toEqual(personalEnvironment());
      expect(store.load(conv.id)?.id).toBe(conv.id);
      expect(bindings.bindings.surfaces[surfaceId(dmSurface(1))]).toBe(conv.id);
    });

    it("returns an existing bound compatible conversation", async () => {
      const { lifecycle, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const first = await lifecycle.resolveOrStart(surface);
      const second = await lifecycle.resolveOrStart(surface);
      expect(second.id).toBe(first.id);
      expect(Object.keys(bindings.bindings.surfaces)).toHaveLength(1);
    });

    it("serializes concurrent unbound creation attempts", async () => {
      const { lifecycle, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const [a, b] = await Promise.all([
        lifecycle.resolveOrStart(surface),
        lifecycle.resolveOrStart(surface),
      ]);
      expect(a.id).toBe(b.id);
      expect(Object.keys(bindings.bindings.surfaces)).toHaveLength(1);
    });

    it("replaces a stale binding with a fresh conversation and drops the stale runner", async () => {
      const { lifecycle, store, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      bindings.bindings = { version: 1, surfaces: { [surfaceId(dmSurface(1))]: "0000000000" } } as BindingsFile;
      const conv = await lifecycle.resolveOrStart(dmSurface(1));
      expect(conv.id).not.toBe("0000000000");
      expect(bindings.bindings.surfaces[surfaceId(dmSurface(1))]).toBe(conv.id);
      expect(store.load(conv.id)).not.toBeNull();
      expect(runtimeHost.disposed).toEqual(["0000000000"]);
    });

    it("disposes a bound runtime and rotates when the environment mismatches", async () => {
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });
      const personal = makeLifecycle(personalEnvironment(), tmpDir);
      const projectConv = personal.store.create(projectEnvironment(projectRoot));
      personal.bindings.bindings = { version: 1, surfaces: { [surfaceId(dmSurface(1))]: projectConv.id } } as BindingsFile;

      const conv = await personal.lifecycle.resolveOrStart(dmSurface(1));
      expect(conv.executionEnvironment).toEqual(personalEnvironment());
      expect(personal.runtimeHost.disposed).toEqual([projectConv.id]);
      expect(personal.bindings.bindings.surfaces[surfaceId(dmSurface(1))]).toBe(conv.id);
      expect(personal.store.load(projectConv.id)).not.toBeNull();
    });
  });

  describe("rotate", () => {
    it("creates a fresh conversation and leaves the prior one resumable", async () => {
      const { lifecycle, store, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const prior = await lifecycle.resolveOrStart(surface);
      const next = await lifecycle.rotate(surface);
      expect(next.id).not.toBe(prior.id);
      expect(bindings.bindings.surfaces[surfaceId(dmSurface(1))]).toBe(next.id);
      expect(store.load(prior.id)).not.toBeNull();
      expect(store.load(next.id)).not.toBeNull();
    });

    it("does not create a fresh conversation when quiescence fails", async () => {
      const { lifecycle, store, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const prior = await lifecycle.resolveOrStart(surface);
      runtimeHost.throwOnNext = prior.id;
      const before = store.list().length;
      await expect(lifecycle.rotate(surface)).rejects.toThrow(/dispose failed/);
      expect(store.list().length).toBe(before);
      expect(bindings.bindings.surfaces[surfaceId(dmSurface(1))]).toBe(prior.id);
    });

    it("leaves the fresh conversation resumable when the binding write fails", async () => {
      const { lifecycle, store, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const prior = await lifecycle.resolveOrStart(surface);
      bindings.failNextSave = true;
      const before = store.list().length;
      await expect(lifecycle.rotate(surface)).rejects.toThrow(/binding save failed/);
      expect(bindings.bindings.surfaces[surfaceId(dmSurface(1))]).toBe(prior.id);
      const conversations = store.list();
      expect(conversations.length).toBe(before + 1);
      const fresh = conversations.find((c) => c.id !== prior.id);
      expect(fresh).toBeDefined();
    });
  });

  describe("archive", () => {
    it("disposes the runtime, archives the directory, and clears the binding", async () => {
      const { lifecycle, store, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const conv = await lifecycle.resolveOrStart(surface);
      await lifecycle.archive(surface);
      expect(runtimeHost.disposed).toEqual([conv.id]);
      expect(bindings.bindings.surfaces[surfaceId(dmSurface(1))]).toBeUndefined();
      expect(store.load(conv.id)).toBeNull();
      expect(store.list()).toEqual([]);
    });

    it("throws when no conversation is bound", async () => {
      const { lifecycle } = makeLifecycle(personalEnvironment(), tmpDir);
      await expect(lifecycle.archive(dmSurface(1))).rejects.toThrow(/no active conversation/);
    });

    it("throws without clearing a stale binding", async () => {
      const { lifecycle, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      bindings.bindings = { version: 1, surfaces: { [surfaceId(dmSurface(1))]: "0000000000" } } as BindingsFile;
      await expect(lifecycle.archive(dmSurface(1))).rejects.toThrow(/no active conversation/);
      expect(bindings.bindings.surfaces[surfaceId(dmSurface(1))]).toBe("0000000000");
      expect(runtimeHost.disposed).toEqual(["0000000000"]);
    });
  });

  describe("resume", () => {
    it("is idempotent when the target is already bound to the destination surface", async () => {
      const { lifecycle, store, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const conv = await lifecycle.resolveOrStart(surface);
      const result = await lifecycle.resume(surface, conv.id);
      expect(result.id).toBe(conv.id);
      expect(runtimeHost.disposed).toEqual([]);
      expect(bindings.bindings.surfaces[surfaceId(dmSurface(1))]).toBe(conv.id);
      expect(store.load(conv.id)).not.toBeNull();
    });

    it("moves a bound conversation across compatible surfaces and disposes both runtimes", async () => {
      const { lifecycle, store, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      const source = dmSurface(1);
      const destination = dmSurface(2);
      const target = await lifecycle.resolveOrStart(source);
      const displaced = await lifecycle.resolveOrStart(destination);

      const result = await lifecycle.resume(destination, target.id);

      expect(result.id).toBe(target.id);
      expect(runtimeHost.disposed).toEqual([displaced.id, target.id]);
      expect(bindings.bindings.surfaces[surfaceId(source)]).toBeUndefined();
      expect(bindings.bindings.surfaces[surfaceId(destination)]).toBe(target.id);
      expect(store.load(target.id)).not.toBeNull();
      expect(store.load(displaced.id)).not.toBeNull();
    });

    it("fails without effects when the target environment is incompatible", async () => {
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });
      const personal = makeLifecycle(personalEnvironment(), tmpDir);
      const projectConv = personal.store.create(projectEnvironment(projectRoot));

      await expect(personal.lifecycle.resume(dmSurface(1), projectConv.id)).rejects.toThrow(/environment mismatch/);
      expect(personal.runtimeHost.disposed).toEqual([]);
      expect(personal.bindings.bindings.surfaces[surfaceId(dmSurface(1))]).toBeUndefined();
    });

    it("binds an unbound target to the destination surface", async () => {
      const { lifecycle, store, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      const destination = dmSurface(2);
      const displaced = await lifecycle.resolveOrStart(destination);
      const target = store.create(personalEnvironment());

      const result = await lifecycle.resume(destination, target.id);
      expect(result.id).toBe(target.id);
      expect(runtimeHost.disposed).toEqual([displaced.id]);
      expect(bindings.bindings.surfaces[surfaceId(dmSurface(2))]).toBe(target.id);
    });
  });

  describe("assignProject", () => {
    it("assigns a project environment and binds a new session", async () => {
      const { lifecycle, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });

      const result = await lifecycle.assignProject(surface, projectRoot);

      expect(result.kind).toBe("assigned");
      if (result.kind === "assigned") {
        expect(result.projectRoot).toBe(projectRoot);
        expect(result.session.executionEnvironment).toEqual(projectEnvironment(projectRoot));
        expect(bindings.bindings.surfaces[surfaceId(surface)]).toBe(result.session.id);
      }
    });

    it("returns already-assigned for the same canonical root", async () => {
      const { lifecycle } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });

      const first = await lifecycle.assignProject(surface, projectRoot);
      expect(first.kind).toBe("assigned");

      const second = await lifecycle.assignProject(surface, projectRoot);
      expect(second.kind).toBe("already-assigned");
      if (second.kind === "already-assigned" && first.kind === "assigned") {
        expect(second.session?.id).toBe(first.session.id);
      }
    });

    it("returns conflict for a different canonical root", async () => {
      const { lifecycle } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const firstRoot = join(tmpDir, "first");
      const secondRoot = join(tmpDir, "second");
      mkdirSync(firstRoot, { recursive: true });
      mkdirSync(secondRoot, { recursive: true });

      await lifecycle.assignProject(surface, firstRoot);
      const result = await lifecycle.assignProject(surface, secondRoot);

      expect(result.kind).toBe("conflict");
      if (result.kind === "conflict") {
        expect(result.currentRoot).toBe(firstRoot);
      }
    });

    it("disposes the previous runtime before assigning", async () => {
      const { lifecycle, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const prior = await lifecycle.resolveOrStart(surface);
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });

      const result = await lifecycle.assignProject(surface, projectRoot);

      expect(result.kind).toBe("assigned");
      expect(runtimeHost.disposed).toContain(prior.id);
    });

    it("does not persist anything when prior runtime quiescence fails", async () => {
      const { lifecycle, store, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const prior = await lifecycle.resolveOrStart(surface);
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });
      runtimeHost.throwOnNext = prior.id;

      await expect(lifecycle.assignProject(surface, projectRoot)).rejects.toThrow(/dispose failed/);
      expect(bindings.bindings.surfaces[surfaceId(surface)]).toBe(prior.id);
      expect(store.list().filter((c) => c.executionEnvironment.kind === "project")).toHaveLength(0);
    });

    it("replays a pending assignment before committing", async () => {
      const { store, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });
      const conv = store.create(projectEnvironment(projectRoot));
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: surfaceId(surface),
        plannedSessionId: conv.id,
        projectRoot,
      });

      const freshLifecycle = new ConversationLifecycleManager(
        tmpDir,
        store,
        bindings,
        staticSettings(personalEnvironment()),
        { disposeRuntime: async () => {} },
      );
      const result = await freshLifecycle.assignProject(surface, projectRoot);

      expect(result.kind).toBe("already-assigned");
      if (result.kind === "already-assigned") {
        expect(result.session?.id).toBe(conv.id);
      }
      expect(bindings.bindings.surfaces[surfaceId(surface)]).toBe(conv.id);
    });
  });

  describe("listResumable", () => {
    it("returns compatible conversations sorted by creation time", async () => {
      const { lifecycle, store } = makeLifecycle(personalEnvironment(), tmpDir);
      const projectRoot = join(tmpDir, "project");
      mkdirSync(projectRoot, { recursive: true });
      store.create(personalEnvironment(), "personal");
      store.create(projectEnvironment(projectRoot), "project");
      const list = lifecycle.listResumable(dmSurface(1));
      expect(list.map((c) => c.title)).toEqual(["personal"]);
    });
  });
});
