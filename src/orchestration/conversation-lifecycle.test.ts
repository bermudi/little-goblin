import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLifecycleManager } from "./conversation-lifecycle.ts";
import type { SurfaceSettings, ConversationLifecycle } from "./conversation-lifecycle.ts";
import type { ConversationRuntimeHost } from "./conversation-runtime-host.ts";
import { createTurnDispatcherRuntimeHost } from "./conversation-runtime-host.ts";
import { TurnDispatcher, type TurnSink } from "./dispatcher.ts";
import { ConversationStore } from "../sessions/conversation-store.ts";
import { runtimeSessionWithPreferences } from "../sessions/conversation.ts";
import type { BindingStore } from "../sessions/bindings.ts";
import { validateBindings } from "../sessions/bindings.ts";
import type { BindingsFile } from "../sessions/types.ts";
import type { ConversationId } from "../sessions/types.ts";
import { loadPendingProjectAssignment, savePendingProjectAssignment } from "../sessions/project-assignment.ts";
import { getProjectRoot, getModelName, getThinkingLevelValidated, setModelName, setThinkingLevel } from "../sessions/topic-settings.ts";
import { sessionDir, statePath } from "../sessions/paths.ts";
import { environmentFromProjectRoot, personalEnvironment, projectEnvironment, type ExecutionEnvironment } from "../sessions/environment.ts";
import { dmSurface, surfaceId, supergroupSurface, topicSurface, type Surface } from "../surface.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import { MemoryStore } from "../memory/mod.ts";
import type { CapturedMemoryContext, InternalMemoryContext } from "../memory/mod.ts";
import type { AgentRunner } from "../agent/mod.ts";
import type { Config } from "../config.ts";
import type { TranscriptWriterContext } from "../sessions/transcript.ts";

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

class ThrowingArchiveStore extends ConversationStore {
  throwOn: ConversationId | null = null;

  archive(id: ConversationId): void {
    if (this.throwOn === id) {
      throw new Error("archive move failed");
    }
    super.archive(id);
  }
}

class FakeAgentRunner {
  disposeCalled = false;
  memoryContext: CapturedMemoryContext | InternalMemoryContext;
  transcriptWriterContext: TranscriptWriterContext;

  constructor(opts: ConstructorParameters<typeof AgentRunner>[0]) {
    this.memoryContext = opts.memoryContext;
    this.transcriptWriterContext =
      this.memoryContext.kind === "surface"
        ? { kind: "surface", sourceSurfaceId: this.memoryContext.authority.sourceSurfaceId }
        : { kind: "internal" };
  }

  get isStreaming() {
    return false;
  }
  get isPrompting() {
    return false;
  }
  get isAbortTimedOut() {
    return false;
  }
  get modelName() {
    return "poe/test-model";
  }

  async prompt() {}
  async abort() {}
  async followUp() {}
  async compact() {
    return {};
  }
  async setModel() {}
  setThinkingLevel() {}
  async dispose() {
    this.disposeCalled = true;
  }
}

function staticSettings(env: ExecutionEnvironment): SurfaceSettings {
  return {
    effectiveEnvironment: () => env,
    getModelName: () => undefined,
    setModelName: () => {},
    getThinkingLevel: () => undefined,
    setThinkingLevel: () => {},
  };
}

function fileBasedSettings(home: string): SurfaceSettings {
  return {
    effectiveEnvironment: (surface: Surface) => environmentFromProjectRoot(getProjectRoot(home, surface)),
    getModelName: (surface) => getModelName(home, surface),
    setModelName: (surface, modelName) => setModelName(home, surface, modelName),
    getThinkingLevel: (surface) => getThinkingLevelValidated(home, surface),
    setThinkingLevel: (surface, thinkingLevel) => setThinkingLevel(home, surface, thinkingLevel),
  };
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

function makeFileLifecycle(home: string): Deps {
  const store = new ConversationStore(home);
  const bindings = new InMemoryBindingStore();
  const runtimeHost = new FakeRuntimeHost();
  const lifecycle = new ConversationLifecycleManager(home, store, bindings, fileBasedSettings(home), runtimeHost);
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

    it("creates and binds a conversation for an unbound topic surface", async () => {
      const { lifecycle, store, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = topicSurface("supergroup", -100123, 5);
      const conv = await lifecycle.resolveOrStart(surface);
      expect(conv.executionEnvironment).toEqual(personalEnvironment());
      expect(store.load(conv.id)?.id).toBe(conv.id);
      expect(bindings.bindings.surfaces[surfaceId(surface)]).toBe(conv.id);
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

    it("fails closed rather than rebinding a chatId:0 record at a Conversation ID", async () => {
      const { lifecycle, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const corruptId = "abc123def0";
      mkdirSync(sessionDir(tmpDir, corruptId), { recursive: true });
      writeFileSync(statePath(tmpDir, corruptId), JSON.stringify({
        id: corruptId,
        createdAt: new Date().toISOString(),
        chatId: 0,
        executionEnvironment: personalEnvironment(),
      }));
      bindings.bindings = { version: 1, surfaces: { [surfaceId(surface)]: corruptId } } as BindingsFile;

      await expect(lifecycle.resolveOrStart(surface)).rejects.toThrow(/unexpected state field: chatId/);
      expect(bindings.bindings.surfaces[surfaceId(surface)]).toBe(corruptId);
      expect(runtimeHost.disposed).toEqual([]);
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

    it("leaves the conversation unbound, unarchived, and resumable when the directory move fails after the binding is cleared", async () => {
      const store = new ThrowingArchiveStore(tmpDir);
      const bindings = new InMemoryBindingStore();
      const runtimeHost = new FakeRuntimeHost();
      const lifecycle = new ConversationLifecycleManager(tmpDir, store, bindings, staticSettings(personalEnvironment()), runtimeHost);
      const surface = dmSurface(1);
      const conv = await lifecycle.resolveOrStart(surface);
      store.throwOn = conv.id;

      await expect(lifecycle.archive(surface)).rejects.toThrow(/archive move failed/);

      expect(runtimeHost.disposed).toContain(conv.id);
      expect(bindings.bindings.surfaces[surfaceId(surface)]).toBeUndefined();
      expect(store.load(conv.id)).not.toBeNull();
      expect(store.list()).toHaveLength(1);
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

  describe("surface preference ownership", () => {
    it("exposes model and thinking preferences on the lifecycle settings seam", () => {
      const { lifecycle } = makeFileLifecycle(tmpDir);
      const surface = dmSurface(1);
      lifecycle.settings.setModelName(surface, "poe/SurfaceModel");
      lifecycle.settings.setThinkingLevel(surface, "high");
      expect(lifecycle.settings.getModelName(surface)).toBe("poe/SurfaceModel");
      expect(lifecycle.settings.getThinkingLevel(surface)).toBe("high");
    });

    it("survives rotation: a fresh conversation keeps the surface model and thinking", async () => {
      const { lifecycle } = makeFileLifecycle(tmpDir);
      const surface = dmSurface(1);
      lifecycle.settings.setModelName(surface, "poe/SurfaceModel");
      lifecycle.settings.setThinkingLevel(surface, "high");

      const first = await lifecycle.resolveOrStart(surface);
      const rotated = await lifecycle.rotate(surface);
      expect(rotated.id).not.toBe(first.id);
      expect(lifecycle.settings.getModelName(surface)).toBe("poe/SurfaceModel");
      expect(lifecycle.settings.getThinkingLevel(surface)).toBe("high");
    });

    it("adopts the destination surface preferences on cross-surface resume", async () => {
      const { lifecycle } = makeFileLifecycle(tmpDir);
      const source = dmSurface(1);
      const destination = dmSurface(2);

      const target = await lifecycle.resolveOrStart(source);
      lifecycle.settings.setModelName(destination, "poe/DestinationModel");
      lifecycle.settings.setThinkingLevel(destination, "low");

      const resumed = await lifecycle.resume(destination, target.id);
      expect(resumed.id).toBe(target.id);
      expect(lifecycle.settings.getModelName(destination)).toBe("poe/DestinationModel");
      expect(lifecycle.settings.getThinkingLevel(destination)).toBe("low");
      expect(lifecycle.inspect(source)).toBeNull();
    });

    it("preserves preferences after archive", async () => {
      const { lifecycle } = makeFileLifecycle(tmpDir);
      const surface = dmSurface(1);
      lifecycle.settings.setModelName(surface, "poe/SurfaceModel");
      lifecycle.settings.setThinkingLevel(surface, "high");

      await lifecycle.resolveOrStart(surface);
      await lifecycle.archive(surface);
      expect(lifecycle.settings.getModelName(surface)).toBe("poe/SurfaceModel");
      expect(lifecycle.settings.getThinkingLevel(surface)).toBe("high");
      expect(lifecycle.inspect(surface)).toBeNull();
    });
  });

  describe("assignment replay and transition locking", () => {
    function makeProjectDir(name: string): string {
      const dir = join(tmpDir, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    it("fences an unbound Surface behind pending assignment replay", async () => {
      const { store, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const projectRoot = makeProjectDir("project");
      const plannedId = store.allocateId();
      savePendingProjectAssignment(tmpDir, {
        version: 1,
        surfaceId: surfaceId(surface),
        plannedSessionId: plannedId,
        projectRoot,
      });

      const lifecycle = new ConversationLifecycleManager(
        tmpDir,
        store,
        bindings,
        fileBasedSettings(tmpDir),
        { disposeRuntime: async () => {} },
      );
      const result = await lifecycle.resolveOrStart(surface);

      expect(result.id).toBe(plannedId);
      expect(result.executionEnvironment).toEqual(projectEnvironment(projectRoot));
      expect(bindings.bindings.surfaces[surfaceId(surface)]).toBe(plannedId);
      expect(store.list(personalEnvironment())).toHaveLength(0);
    });

    it("serializes unbound creation against first project assignment", async () => {
      const { store, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const projectRoot = makeProjectDir("project");
      const lifecycle = new ConversationLifecycleManager(
        tmpDir,
        store,
        bindings,
        fileBasedSettings(tmpDir),
        runtimeHost,
      );

      const [, assignResult] = await Promise.all([
        lifecycle.resolveOrStart(surface),
        lifecycle.assignProject(surface, projectRoot),
      ]);

      expect(assignResult.kind).toBe("assigned");
      const finalId = bindings.bindings.surfaces[surfaceId(surface)];
      expect(finalId).toBeDefined();
      const bound = store.load(finalId as ConversationId);
      expect(bound?.executionEnvironment).toEqual(projectEnvironment(projectRoot));
      // One of the two operations may have created a transient personal
      // conversation, but the final binding is project and there are no
      // duplicate Surface bindings.
      expect(Object.keys(bindings.bindings.surfaces)).toHaveLength(1);
    });

    it("serializes cross-surface resume against first project assignment", async () => {
      const { store, bindings, runtimeHost } = makeLifecycle(personalEnvironment(), tmpDir);
      const surfaceA = dmSurface(1);
      const surfaceB = dmSurface(2);
      const projectRoot = makeProjectDir("project");

      const lifecycleA = new ConversationLifecycleManager(
        tmpDir,
        store,
        bindings,
        fileBasedSettings(tmpDir),
        runtimeHost,
      );
      const personalP = await lifecycleA.resolveOrStart(surfaceA);

      const lifecycleB = new ConversationLifecycleManager(
        tmpDir,
        store,
        bindings,
        fileBasedSettings(tmpDir),
        runtimeHost,
      );

      const [resumeResult, assignResult] = await Promise.all([
        lifecycleB.resume(surfaceB, personalP.id),
        lifecycleB.assignProject(surfaceA, projectRoot),
      ]);

      expect(resumeResult.id).toBe(personalP.id);
      expect(assignResult.kind).toBe("assigned");
      const boundA = bindings.bindings.surfaces[surfaceId(surfaceA)];
      const boundB = bindings.bindings.surfaces[surfaceId(surfaceB)];
      expect(store.load(boundA as ConversationId)?.executionEnvironment).toEqual(projectEnvironment(projectRoot));
      expect(store.load(boundB as ConversationId)?.executionEnvironment).toEqual(personalEnvironment());
    });

    it("keeps separate Surfaces with the same project root isolated", async () => {
      const { lifecycle, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surfaceA = dmSurface(1);
      const surfaceB = supergroupSurface(-100);
      const projectRoot = makeProjectDir("project");

      const resultA = await lifecycle.assignProject(surfaceA, projectRoot);
      const resultB = await lifecycle.assignProject(surfaceB, projectRoot);

      expect(resultA.kind).toBe("assigned");
      expect(resultB.kind).toBe("assigned");
      if (resultA.kind === "assigned" && resultB.kind === "assigned") {
        expect(resultA.session.id).not.toBe(resultB.session.id);
        expect(resultA.session.executionEnvironment).toEqual(projectEnvironment(projectRoot));
        expect(resultB.session.executionEnvironment).toEqual(projectEnvironment(projectRoot));
      }
      expect(bindings.bindings.surfaces[surfaceId(surfaceA)]).not.toBe(bindings.bindings.surfaces[surfaceId(surfaceB)]);
    });

    it("does not mutate the previous conversation environment on assignment", async () => {
      const { lifecycle, store, bindings } = makeLifecycle(personalEnvironment(), tmpDir);
      const surface = dmSurface(1);
      const prior = await lifecycle.resolveOrStart(surface);
      const projectRoot = makeProjectDir("project");

      await lifecycle.assignProject(surface, projectRoot);

      const reloaded = store.load(prior.id);
      expect(reloaded?.executionEnvironment).toEqual(personalEnvironment());
      expect(bindings.bindings.surfaces[surfaceId(surface)]).not.toBe(prior.id);
    });
  });

  describe("real runtime movement", () => {
    let runtimeHome: string;
    let memoryStore: MemoryStore;

    beforeEach(() => {
      runtimeHome = mkdtempSync(join(tmpdir(), "goblin-lifecycle-runtime-"));
      memoryStore = new MemoryStore(runtimeHome);
    });

    afterEach(() => {
      memoryStore.close();
      rmSync(runtimeHome, { recursive: true, force: true });
    });

    function makeRuntimeFixture(): {
      lifecycle: ConversationLifecycle;
      dispatcher: TurnDispatcher;
    } {
      const cfg = { goblinHome: runtimeHome } as Config;
      const subagentRunner = new SubagentRunner(cfg);
      const surfaceSettings = staticSettings(personalEnvironment());
      const store = new ConversationStore(runtimeHome);
      const bindings = new InMemoryBindingStore();
      let dispatcher: TurnDispatcher | undefined;
      const lifecycle = new ConversationLifecycleManager(
        runtimeHome,
        store,
        bindings,
        surfaceSettings,
        createTurnDispatcherRuntimeHost(() => {
          if (dispatcher === undefined) throw new Error("runtime host used before dispatcher construction");
          return dispatcher;
        }),
      );
      dispatcher = new TurnDispatcher({
        cfg,
        surfaceSettings,
        subagentRunner,
        memoryStore,
        agentRunners: new Map(),
        createMessageBuffer: (): TurnSink => ({
          onTextDelta: () => {},
          onToolStart: () => {},
          onToolEnd: () => {},
          onStatusUpdate: () => {},
          onMessageStart: () => {},
          onMessageEnd: () => {},
          onAgentEnd: () => {},
        }),
        createBetaTools: () => [],
        createAgentRunner: (opts) => new FakeAgentRunner(opts) as unknown as AgentRunner,
        surfaceRuntimeAuthority: lifecycle,
      });
      return { lifecycle, dispatcher };
    }

    it("does not let runtime acquisition reopen old authority after a failed project assignment", async () => {
      const cfg = { goblinHome: runtimeHome } as Config;
      const surface = dmSurface(1);
      const projectRoot = join(runtimeHome, "project");
      mkdirSync(projectRoot, { recursive: true });
      const store = new ConversationStore(runtimeHome);
      const bindings = new InMemoryBindingStore();
      const surfaceSettings = fileBasedSettings(runtimeHome);
      const subagentRunner = new SubagentRunner(cfg);
      let dispatcherRef: TurnDispatcher | null = null;
      const lifecycle = new ConversationLifecycleManager(
        runtimeHome,
        store,
        bindings,
        surfaceSettings,
        createTurnDispatcherRuntimeHost(() => {
          if (dispatcherRef === null) throw new Error("runtime host used before dispatcher construction");
          return dispatcherRef;
        }),
      );
      const dispatcher = new TurnDispatcher({
        cfg,
        surfaceSettings,
        subagentRunner,
        memoryStore,
        agentRunners: new Map(),
        createMessageBuffer: (): TurnSink => ({
          onTextDelta: () => {},
          onToolStart: () => {},
          onToolEnd: () => {},
          onStatusUpdate: () => {},
          onMessageStart: () => {},
          onMessageEnd: () => {},
          onAgentEnd: () => {},
        }),
        createBetaTools: () => [],
        createAgentRunner: (opts) => new FakeAgentRunner(opts) as unknown as AgentRunner,
        surfaceRuntimeAuthority: lifecycle,
      });
      dispatcherRef = dispatcher;

      const personal = await lifecycle.resolveOrStart(surface);
      const personalSession = runtimeSessionWithPreferences(personal, surface, runtimeHome);
      await dispatcher.getOrCreateRunner(personalSession, surface);
      bindings.failNextSave = true;

      await expect(lifecycle.assignProject(surface, projectRoot)).rejects.toThrow(/binding save failed/);
      expect(loadPendingProjectAssignment(runtimeHome)).not.toBeNull();
      expect(dispatcher.getRunner(personal.id)).toBeNull();

      // This is the same dispatcher acquisition used by /queue. It must replay
      // Q before it can register anything, then reject stale P rather than
      // silently reconstructing its personal runtime.
      await expect(dispatcher.getOrCreateRunner(personalSession, surface)).rejects.toThrow(/binding.*no longer current|binding rotated/);
      expect(dispatcher.getRunner(personal.id)).toBeNull();
      expect(loadPendingProjectAssignment(runtimeHome)).toBeNull();

      const current = lifecycle.inspect(surface);
      expect(current).not.toBeNull();
      expect(current?.id).not.toBe(personal.id);
      expect(current?.executionEnvironment).toEqual(projectEnvironment(projectRoot));
    });

    it("disposes both source and destination runtimes during cross-surface resume and recreates with destination authority", async () => {
      const { lifecycle, dispatcher } = makeRuntimeFixture();
      const source = dmSurface(1);
      const destination = dmSurface(2);

      const target = await lifecycle.resolveOrStart(source);
      const displaced = await lifecycle.resolveOrStart(destination);

      const r1 = await dispatcher.getOrCreateRunner(
        runtimeSessionWithPreferences(target, source, runtimeHome),
        source,
      );
      const r2 = await dispatcher.getOrCreateRunner(
        runtimeSessionWithPreferences(displaced, destination, runtimeHome),
        destination,
      );

      expect(dispatcher.getRunner(target.id)).toBe(r1);
      expect(dispatcher.getRunner(displaced.id)).toBe(r2);
      expect((r1 as unknown as FakeAgentRunner).transcriptWriterContext).toEqual({
        kind: "surface",
        sourceSurfaceId: surfaceId(source),
      });
      expect((r2 as unknown as FakeAgentRunner).transcriptWriterContext).toEqual({
        kind: "surface",
        sourceSurfaceId: surfaceId(destination),
      });

      await lifecycle.resume(destination, target.id);

      expect((r1 as unknown as FakeAgentRunner).disposeCalled).toBe(true);
      expect((r2 as unknown as FakeAgentRunner).disposeCalled).toBe(true);
      expect(dispatcher.getRunner(target.id)).toBeNull();
      expect(dispatcher.getRunner(displaced.id)).toBeNull();

      const r3 = await dispatcher.getOrCreateRunner(
        runtimeSessionWithPreferences(target, destination, runtimeHome),
        destination,
      );

      expect(r3).not.toBe(r1);
      expect((r3 as unknown as FakeAgentRunner).transcriptWriterContext).toEqual({
        kind: "surface",
        sourceSurfaceId: surfaceId(destination),
      });
    });
  });
});
