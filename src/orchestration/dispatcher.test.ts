import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnDispatcher } from "./dispatcher.ts";
import type { CurrentBindingGuard } from "./dispatcher.ts";
import type { AgentRunner } from "../agent/mod.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import { MemoryStore } from "../memory/mod.ts";
import type { CapturedMemoryContext, InternalMemoryContext } from "../memory/mod.ts";
import type { SessionState } from "../sessions/mod.ts";
import type { Config } from "../config.ts";
import type { Surface } from "../surface.ts";
import { personalEnvironment, projectEnvironment } from "../sessions/environment.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import type { TurnSink, SurfaceSettings } from "./dispatcher.ts";
import { dmSurface, surfaceId } from "../surface.ts";

class FakeAgentRunner {
  disposeCalled = false;
  disposeDelayMs = 0;
  _isStreaming = false;
  _isPrompting = false;
  _isAbortTimedOut = false;
  _modelName = "";
  memoryContext: CapturedMemoryContext | InternalMemoryContext | undefined = undefined;

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  get isPrompting(): boolean {
    return this._isPrompting;
  }

  get isAbortTimedOut(): boolean {
    return this._isAbortTimedOut;
  }

  get modelName(): string {
    return this._modelName;
  }

  async dispose(): Promise<void> {
    this.disposeCalled = true;
    if (this.disposeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.disposeDelayMs));
    }
  }

  async setModel(_modelName: string): Promise<void> {}
  setThinkingLevel(_level: string | undefined): void {}
  async prompt(_content: unknown, _sink: unknown): Promise<void> {}
  async abort(): Promise<void> {}
  async followUp(_content: unknown): Promise<void> {}
  async compact(_instructions?: string): Promise<unknown> {
    return {};
  }
}

class FakeSubagentRunner {
  cancelled: string[] = [];
  lastReviveArgs: {
    parentCapture: CapturedMemoryContext | InternalMemoryContext;
    id: string;
    prompt: string;
    onStatusUpdate?: (msg: string) => void;
  } | null = null;

  cancelBySession(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  list(): unknown[] {
    return [];
  }

  cancel(_id: string): Promise<void> {
    return Promise.resolve();
  }

  revive(
    parentCapture: CapturedMemoryContext | InternalMemoryContext,
    id: string,
    prompt: string,
    _onStatusUpdate?: (msg: string) => void,
    onAttached?: () => void | Promise<void>,
  ): Promise<string> {
    this.lastReviveArgs = { parentCapture, id, prompt };
    if (onAttached) {
      onAttached();
    }
    return Promise.resolve("revived result");
  }
}

class FakeMemoryStore {
  read(_scope: unknown): { body: string; description: string | null } {
    return { body: "", description: null };
  }

  archiveOrphan(_chatId: number, _topicId?: number): Promise<void> {
    return Promise.resolve();
  }
}

function buildDispatcher(
  opts: {
    runners?: Map<string, AgentRunner>;
    subagentRunner?: SubagentRunner;
    surfaceEnv?: ExecutionEnvironment;
    createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
  } = {},
): {
  dispatcher: TurnDispatcher;
  runners: Map<string, AgentRunner>;
  subagentRunner: FakeSubagentRunner;
  betaSurfaces: Surface[];
  createAgentRunnerCalls: ConstructorParameters<typeof AgentRunner>[0][];
} {
  const runners = opts.runners ?? new Map<string, AgentRunner>();
  const subagentRunner = (opts.subagentRunner ?? new FakeSubagentRunner()) as unknown as SubagentRunner;
  const surfaceEnv = opts.surfaceEnv ?? personalEnvironment();
  const surfaceSettings: SurfaceSettings = {
    effectiveEnvironment: (_surface: Surface): ExecutionEnvironment => surfaceEnv,
  };
  const betaSurfaces: Surface[] = [];
  const createAgentRunnerCalls: ConstructorParameters<typeof AgentRunner>[0][] = [];
  const createAgentRunner = opts.createAgentRunner ?? ((o) => {
    createAgentRunnerCalls.push(o);
    return o as unknown as AgentRunner;
  });

  const dispatcher = new TurnDispatcher({
    cfg: {} as Config,
    surfaceSettings,
    subagentRunner,
    memoryStore: new FakeMemoryStore() as unknown as MemoryStore,
    agentRunners: runners,
    createMessageBuffer: (_surface: Surface, _session?: SessionState): TurnSink => ({
      onTextDelta: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onStatusUpdate: () => {},
      onMessageStart: () => {},
      onMessageEnd: () => {},
      onAgentEnd: () => {},
    }),
    createBetaTools: (surface: Surface) => {
      betaSurfaces.push(surface);
      return [];
    },
    createAgentRunner,
  });

  return { dispatcher, runners, subagentRunner: subagentRunner as unknown as FakeSubagentRunner, betaSurfaces, createAgentRunnerCalls };
}

function makeSession(id: string, env: ExecutionEnvironment = personalEnvironment()): SessionState {
  return { id, createdAt: new Date().toISOString(), chatId: 1, executionEnvironment: env } as SessionState;
}

class FakeBindingGuard implements CurrentBindingGuard {
  private readonly bindings = new Map<string, string>();

  bind(surface: Surface, conversationId: string): void {
    this.bindings.set(surfaceId(surface), conversationId);
  }

  async withCurrentBinding<T>(
    surface: Surface,
    conversationId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const bound = this.bindings.get(surfaceId(surface));
    if (bound !== conversationId) {
      throw new Error(
        `binding rotated: ${bound ?? "unbound"} !== ${conversationId}`,
      );
    }
    return fn();
  }
}

/** A minimal fake CapturedMemoryContext for tests that exercise dispatcher logic. */
function fakeCapturedContext(): CapturedMemoryContext {
  return {
    kind: "surface",
    authority: {
      kind: "surface",
      sourceSurfaceId: surfaceId(dmSurface(1)),
      activeScope: { chatId: 1, topicScope: "general" },
    },
    caller: { kind: "main" },
    frozenSummary: null,
    frozenUserBody: "",
    frozenActiveMemoryBody: "",
  };
}


describe("TurnDispatcher runtime host support", () => {
  it("removes runner and queue map entries synchronously before awaiting dispose", async () => {
    const { dispatcher, runners } = buildDispatcher();
    const session = makeSession("abc123def0");
    const runner = new FakeAgentRunner();
    runner.disposeDelayMs = 50;
    runners.set(session.id, runner as unknown as AgentRunner);

    expect(dispatcher.hasRunner(session.id)).toBe(true);
    const disposePromise = dispatcher.disposeRunner(session.id);
    expect(dispatcher.hasRunner(session.id)).toBe(false);
    expect(dispatcher.isPromptPending(session.id)).toBe(false);
    expect(dispatcher.isCommandPending(session.id)).toBe(false);
    await disposePromise;
    expect(runner.disposeCalled).toBe(true);
  });

  it("cancels subagents by session id during dispose", async () => {
    const { dispatcher, runners, subagentRunner } = buildDispatcher();
    const session = makeSession("abc123def0");
    const runner = new FakeAgentRunner();
    runners.set(session.id, runner as unknown as AgentRunner);

    await dispatcher.disposeRunner(session.id);
    expect(subagentRunner.cancelled).toContain(session.id);
    expect(dispatcher.hasRunner(session.id)).toBe(false);
  });

  it("does not recreate a disposed runner while dispose is in flight", async () => {
    const { dispatcher, runners } = buildDispatcher();
    const session = makeSession("abc123def0");
    const runner = new FakeAgentRunner();
    runner.disposeDelayMs = 50;
    runners.set(session.id, runner as unknown as AgentRunner);

    const disposePromise = dispatcher.disposeRunner(session.id);
    // Synchronous: the runner is gone before dispose resolves.
    expect(dispatcher.getRunner(session.id)).toBeNull();
    await disposePromise;
  });

  it("rejects an environment mismatch before creating the runner or beta tools", () => {
    const projectRoot = "/srv/project-a";
    const { dispatcher, betaSurfaces, createAgentRunnerCalls } = buildDispatcher({
      surfaceEnv: projectEnvironment(projectRoot),
    });
    const session = makeSession("abc123def0", personalEnvironment());

    expect(() => dispatcher.createRunner(session, dmSurface(1), fakeCapturedContext())).toThrow(/environment mismatch/);
    expect(betaSurfaces).toHaveLength(0);
    expect(createAgentRunnerCalls).toHaveLength(0);
  });

  it("creates an internal runner without Surface comparison", () => {
    const projectRoot = "/srv/project-a";
    const { dispatcher, betaSurfaces, createAgentRunnerCalls } = buildDispatcher({
      surfaceEnv: projectEnvironment(projectRoot),
    });
    const session = makeSession("abc123def0", personalEnvironment());
    session.chatId = 0;

    // Internal runners are constructed via enqueueInternalTurn, which builds
    // AgentRunnerOptions directly with an InternalMemoryContext and no Surface.
    // createRunner is Surface-backed only; the internal path bypasses the
    // environment mismatch check because there is no Surface to compare.
    dispatcher.enqueueInternalTurn(
      session,
      "test prompt",
      () => {},
      () => {},
    );

    expect(betaSurfaces).toHaveLength(0);
    expect(createAgentRunnerCalls).toHaveLength(1);
    expect(createAgentRunnerCalls[0]?.executionEnvironment).toEqual(personalEnvironment());
  });
});

describe("TurnDispatcher async runner creation", () => {
  let tmpDir: string;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-dispatch-async-"));
    memoryStore = new MemoryStore(tmpDir);
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildAsyncDispatcher(
    opts: {
      createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
      bindingInspector?: (surface: Surface) => string | undefined;
    } = {},
  ): {
    dispatcher: TurnDispatcher;
    runners: Map<string, AgentRunner>;
    subagentRunner: FakeSubagentRunner;
    createAgentRunnerCalls: ConstructorParameters<typeof AgentRunner>[0][];
  } {
    const runners = new Map<string, AgentRunner>();
    const subagentRunner = new FakeSubagentRunner();
    const surfaceSettings: SurfaceSettings = {
      effectiveEnvironment: (_surface: Surface): ExecutionEnvironment => personalEnvironment(),
    };
    const createAgentRunnerCalls: ConstructorParameters<typeof AgentRunner>[0][] = [];
    const createAgentRunner = opts.createAgentRunner ?? ((o) => {
      createAgentRunnerCalls.push(o);
      const runner = new FakeAgentRunner();
      runner.disposeCalled = false;
      runner.memoryContext = o.memoryContext;
      return runner as unknown as AgentRunner;
    });

    const dispatcher = new TurnDispatcher({
      cfg: {} as Config,
      surfaceSettings,
      subagentRunner: subagentRunner as unknown as SubagentRunner,
      memoryStore,
      agentRunners: runners,
      createMessageBuffer: (_surface: Surface, _session?: SessionState): TurnSink => ({
        onTextDelta: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onStatusUpdate: () => {},
        onMessageStart: () => {},
        onMessageEnd: () => {},
        onAgentEnd: () => {},
      }),
      createBetaTools: (_surface: Surface) => [],
      createAgentRunner,
      bindingInspector: opts.bindingInspector,
    });

    return { dispatcher, runners, subagentRunner, createAgentRunnerCalls };
  }

  it("getOrCreateRunner is async and returns a runner with a captured memory context", async () => {
    await memoryStore.add("general", "test fact");
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    const runner = await dispatcher.getOrCreateRunner(session, dmSurface(1));
    expect(runner).toBeDefined();
    expect(createAgentRunnerCalls).toHaveLength(1);
    const opts = createAgentRunnerCalls[0]!;
    expect(opts.memoryContext).toBeDefined();
    expect(opts.memoryContext.kind).toBe("surface");
    if (opts.memoryContext.kind === "surface") {
      expect(opts.memoryContext.frozenSummary).toContain("test fact");
    }
  });

  it("deduplicates concurrent creation — two callers share one runner", async () => {
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    // Two concurrent calls — both should share the same in-flight promise.
    const [r1, r2] = await Promise.all([
      dispatcher.getOrCreateRunner(session, dmSurface(1)),
      dispatcher.getOrCreateRunner(session, dmSurface(1)),
    ]);
    expect(r1).toBe(r2);
    expect(createAgentRunnerCalls).toHaveLength(1);
  });

  it("reuses an existing runner for the same surface without recreating", async () => {
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    const r1 = await dispatcher.getOrCreateRunner(session, dmSurface(1));
    const r2 = await dispatcher.getOrCreateRunner(session, dmSurface(1));
    expect(r1).toBe(r2);
    expect(createAgentRunnerCalls).toHaveLength(1);
  });

  it("disposes and recreates when the surface changes", async () => {
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    const r1 = await dispatcher.getOrCreateRunner(session, dmSurface(1));
    const r2 = await dispatcher.getOrCreateRunner(session, dmSurface(2));
    expect(r1).not.toBe(r2);
    expect(createAgentRunnerCalls).toHaveLength(2);
  });

  it("stale-guard: a capture disposed during capture is discarded", async () => {
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    // Start creation but don't await it — the in-flight promise is registered.
    const creationPromise = dispatcher.getOrCreateRunner(session, dmSurface(1));
    // Dispose before the creation completes. This clears the in-flight entry.
    await dispatcher.disposeRunner(session.id);
    // The creation promise should reject with a stale-runtime error.
    await expect(creationPromise).rejects.toThrow(/stale runtime creation/);
    expect(createAgentRunnerCalls).toHaveLength(0);
  });

  it("concurrent X/Y creation: a different-surface request does not share X's promise", async () => {
    // X captures for dmSurface(1); Y concurrently requests dmSurface(2) for
    // the same session. Y must NOT receive X's promise (which would give it
    // X's memory authority). Y overwrites the in-flight entry, causing X's
    // post-capture recheck to fail. Y's creation succeeds.
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    const xPromise = dispatcher.getOrCreateRunner(session, dmSurface(1));
    const yPromise = dispatcher.getOrCreateRunner(session, dmSurface(2));

    // X is discarded because Y overwrote the in-flight entry during X's capture.
    await expect(xPromise).rejects.toThrow(/stale runtime creation/);
    const yRunner = await yPromise;
    expect(yRunner).toBeDefined();
    // Only Y's runner was created and registered.
    expect(createAgentRunnerCalls).toHaveLength(1);
    const yOpts = createAgentRunnerCalls[0]!;
    expect(yOpts.memoryContext.kind).toBe("surface");
    if (yOpts.memoryContext.kind === "surface") {
      expect(yOpts.memoryContext.authority.sourceSurfaceId).toBe(surfaceId(dmSurface(2)));
    }
  });

  it("binding authority recheck: a stale caller whose binding rotated is discarded", async () => {
    // Simulate: intake resolves X → session A, then /new rotates X to B and
    // disposes A, then the stale intake starts A's creation. The binding
    // inspector returns B's id (not A), so the creation is discarded.
    const bindingMap = new Map<string, string>();
    bindingMap.set(surfaceId(dmSurface(1)), "abc123def0");
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher({
      bindingInspector: (surface) => bindingMap.get(surfaceId(surface)),
    });
    const session = makeSession("abc123def0");

    // Rotate the binding to a different session before the creation completes.
    // We do this by starting the creation (which registers the in-flight
    // promise), then mutating the binding map before awaiting.
    const creationPromise = dispatcher.getOrCreateRunner(session, dmSurface(1));
    bindingMap.set(surfaceId(dmSurface(1)), "bbbbbbbbbb");

    await expect(creationPromise).rejects.toThrow(/stale runtime creation.*binding/);
    expect(createAgentRunnerCalls).toHaveLength(0);
  });

  it("capture failure: a rejected capture leaves no half-created runtime", async () => {
    // Close the memory store so captureRuntimeMemoryContext rejects when it
    // tries to read. This proves a failed capture leaves no half-created
    // runtime and the in-flight entry is cleared for subsequent creation.
    const { dispatcher, createAgentRunnerCalls, runners } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    // Close the store so the capture's store.read throws.
    memoryStore.close();

    await expect(dispatcher.getOrCreateRunner(session, dmSurface(1))).rejects.toThrow();
    expect(createAgentRunnerCalls).toHaveLength(0);
    expect(runners.has(session.id)).toBe(false);

    // Reopen the store and verify a subsequent creation can proceed — the
    // in-flight entry was cleared by the failed creation's finally block.
    memoryStore = new MemoryStore(tmpDir);
    // Rebuild the dispatcher with the reopened store (the dispatcher captured
    // the old store reference at construction).
    const { dispatcher: dispatcher2, createAgentRunnerCalls: calls2 } = buildAsyncDispatcher();
    const runner = await dispatcher2.getOrCreateRunner(session, dmSurface(1));
    expect(runner).toBeDefined();
    expect(calls2).toHaveLength(1);
  });

  it("replacement quiescence: old runner's dispose completes before new runner is created", async () => {
    // The replacement path must await disposeRunner (which awaits
    // runner.dispose) before creating the replacement. We verify by tracking
    // dispose ordering: the old runner's dispose must resolve before the new
    // runner's constructor runs.
    const disposeTimeline: string[] = [];
    let createCount = 0;
    const createAgentRunner = (o: ConstructorParameters<typeof AgentRunner>[0]): AgentRunner => {
      createCount++;
      disposeTimeline.push(`create:${o.sessionId}:${createCount}`);
      const runner = new FakeAgentRunner();
      runner.disposeCalled = false;
      const origDispose = runner.dispose.bind(runner);
      runner.dispose = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        disposeTimeline.push(`disposed:${o.sessionId}:${createCount}`);
        await origDispose();
      };
      return runner as unknown as AgentRunner;
    };
    const { dispatcher } = buildAsyncDispatcher({ createAgentRunner });
    const session = makeSession("abc123def0");

    // Create the first runner.
    const r1 = await dispatcher.getOrCreateRunner(session, dmSurface(1));
    expect(createCount).toBe(1);

    // Replace with a different surface. The old runner's dispose must complete
    // before the new runner is constructed.
    const r2 = await dispatcher.getOrCreateRunner(session, dmSurface(2));
    expect(r1).not.toBe(r2);
    expect(createCount).toBe(2);
    // The old runner's dispose must have been awaited before the new runner
    // was created. The timeline must show disposed:abc123def0:1 before
    // create:abc123def0:2.
    const firstDisposeIdx = disposeTimeline.indexOf("disposed:abc123def0:1");
    const secondCreateIdx = disposeTimeline.indexOf("create:abc123def0:2");
    expect(firstDisposeIdx).toBeGreaterThanOrEqual(0);
    expect(secondCreateIdx).toBeGreaterThan(firstDisposeIdx);
  });

  it("reviveSubagent delegates to subagentRunner.revive with the runner's captured Surface authority", async () => {
    await memoryStore.add("general", "test fact");
    const { dispatcher, subagentRunner } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);

    const guard = new FakeBindingGuard();
    guard.bind(surface, session.id);
    dispatcher.setCurrentBindingGuard(guard);

    await dispatcher.getOrCreateRunner(session, surface);
    const result = await dispatcher.reviveSubagent(surface, session, "sub-1", "follow-up");

    expect(result).toBe("revived result");
    expect(subagentRunner.lastReviveArgs).not.toBeNull();
    expect(subagentRunner.lastReviveArgs!.id).toBe("sub-1");
    expect(subagentRunner.lastReviveArgs!.prompt).toBe("follow-up");
    expect(subagentRunner.lastReviveArgs!.parentCapture.kind).toBe("surface");
    if (subagentRunner.lastReviveArgs!.parentCapture.kind === "surface") {
      expect(subagentRunner.lastReviveArgs!.parentCapture.authority.sourceSurfaceId).toBe(surfaceId(surface));
    }
  });

  it("reviveSubagent rejects when no runner exists for the session", async () => {
    const { dispatcher } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);

    const guard = new FakeBindingGuard();
    guard.bind(surface, session.id);
    dispatcher.setCurrentBindingGuard(guard);

    await expect(dispatcher.reviveSubagent(surface, session, "sub-1", "go")).rejects.toThrow(
      /no current runner/,
    );
  });

  it("reviveSubagent rejects when the binding has rotated", async () => {
    await memoryStore.add("general", "test fact");
    const { dispatcher } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);

    const guard = new FakeBindingGuard();
    guard.bind(surface, "other-session-id");
    dispatcher.setCurrentBindingGuard(guard);

    await dispatcher.getOrCreateRunner(session, surface);
    await expect(dispatcher.reviveSubagent(surface, session, "sub-1", "go")).rejects.toThrow(
      /binding rotated/,
    );
  });

  it("reviveSubagent rejects when the runner's captured Surface does not match the requested surface", async () => {
    await memoryStore.add("general", "test fact");
    const { dispatcher } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    const guard = new FakeBindingGuard();
    guard.bind(dmSurface(1), session.id);
    dispatcher.setCurrentBindingGuard(guard);

    await dispatcher.getOrCreateRunner(session, dmSurface(1));

    // The conversation binding rotates to Surface 2, but the in-memory runner
    // still carries a Surface 1 capture. The guard passes the new Surface, and
    // the runner-capture mismatch is detected inside.
    guard.bind(dmSurface(2), session.id);
    await expect(dispatcher.reviveSubagent(dmSurface(2), session, "sub-1", "go")).rejects.toThrow(
      /sourceSurfaceId mismatch/,
    );
  });
});
