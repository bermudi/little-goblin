import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnDispatcher } from "./dispatcher.ts";
import { ConversationRuntimeHost } from "./conversation-runtime-host.ts";
import type { AttachmentSignal, AttachedWork, SurfaceRuntimeAuthority } from "./dispatcher.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRunner } from "../agent/mod.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import { MemoryStore } from "../memory/mod.ts";
import type { CapturedMemoryContext, InternalMemoryContext } from "../memory/mod.ts";
import type { ConversationState } from "../sessions/mod.ts";
import type { InternalSessionState } from "../sessions/internal-session.ts";
import type { Config } from "../config.ts";
import type { Surface } from "../surface.ts";
import { personalEnvironment, projectEnvironment } from "../sessions/environment.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import type { TurnSink, SurfaceSettings } from "./dispatcher.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import type { TranscriptWriterContext } from "../sessions/transcript.ts";
import { DEFAULT_SKILL_POLICY, type SkillPolicy } from "../agent/skills/mod.ts";
import type { GenericSubagentInheritance } from "../subagents/mod.ts";
import { DelegatedWorkHost, type ConversationRuntimeId } from "../delegated-work/mod.ts";

class FakeAgentRunner {
  disposeCalled = false;
  disposeDelayMs = 0;
  disposeRejectsWith: Error | undefined;
  _isStreaming = false;
  _isPrompting = false;
  _isAbortTimedOut = false;
  _modelName = "";
  memoryContext: CapturedMemoryContext | InternalMemoryContext | undefined = undefined;
  transcriptWriterContext: TranscriptWriterContext | undefined = undefined;
  genericSubagentInheritance: GenericSubagentInheritance | null = null;

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
    if (this.disposeRejectsWith) {
      throw this.disposeRejectsWith;
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
  acknowledged: string[] = [];
  lastReviveArgs: {
    parentCapture: CapturedMemoryContext | InternalMemoryContext;
    inheritance: GenericSubagentInheritance | null;
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
    inheritance: GenericSubagentInheritance | null,
    id: string,
    prompt: string,
    _onStatusUpdate?: (msg: string) => void,
    onAttached?: () => void | Promise<void>,
  ): Promise<string> {
    this.lastReviveArgs = { parentCapture, inheritance, id, prompt };
    if (onAttached) {
      onAttached();
    }
    return Promise.resolve("revived result");
  }

  acknowledgeDelivery(id: string): void {
    this.acknowledged.push(id);
  }
}

class FakeDelegatedWorkHost {
  invalidateRuntimeCalls: ConversationRuntimeId[] = [];
  invalidateRuntimeRejectWith: Error | undefined;
  invalidateRuntimeDelayMs = 0;

  async invalidateRuntime(runtimeId: ConversationRuntimeId): Promise<void> {
    this.invalidateRuntimeCalls.push(runtimeId);
    if (this.invalidateRuntimeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.invalidateRuntimeDelayMs));
    }
    if (this.invalidateRuntimeRejectWith) {
      throw this.invalidateRuntimeRejectWith;
    }
  }
}

function permissiveRuntimeAuthority(): SurfaceRuntimeAuthority {
  return {
    assertCurrentBinding: async () => {},
    isCurrentBinding: () => true,
    withCurrentBinding: async <T>(
      _surface: Surface,
      _conversationId: string,
      fn: (signal: AttachmentSignal) => Promise<AttachedWork<T>>,
    ) => {
      let settled = false;
      const signal: AttachmentSignal = {
        get settled() { return settled; },
        attached: () => { settled = true; },
        failed: () => { settled = true; },
      };
      return await fn(signal);
    },
  };
}

function mappedRuntimeAuthority(bindings: Map<string, string>): SurfaceRuntimeAuthority {
  const permissive = permissiveRuntimeAuthority();
  return {
    ...permissive,
    assertCurrentBinding: async (surface, conversationId) => {
      const bound = bindings.get(surfaceId(surface));
      if (bound !== conversationId) {
        throw new Error(`binding rotated: ${bound ?? "unbound"} !== ${conversationId}`);
      }
    },
    isCurrentBinding: (surface, conversationId) => bindings.get(surfaceId(surface)) === conversationId,
  };
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
    subagentRunner?: SubagentRunner;
    surfaceEnv?: ExecutionEnvironment;
    surfaceModelName?: string;
    surfaceThinkingLevel?: ThinkingLevel;
    createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
    surfaceRuntimeAuthority?: SurfaceRuntimeAuthority;
  } = {},
): {
  dispatcher: TurnDispatcher;
  runtimeHost: ConversationRuntimeHost;
  subagentRunner: FakeSubagentRunner;
  betaSurfaces: Surface[];
  createAgentRunnerCalls: ConstructorParameters<typeof AgentRunner>[0][];
} {
  const subagentRunner = (opts.subagentRunner ?? new FakeSubagentRunner()) as unknown as SubagentRunner;
  const surfaceEnv = opts.surfaceEnv ?? personalEnvironment();
  const surfaceModelName = opts.surfaceModelName;
  const surfaceThinkingLevel = opts.surfaceThinkingLevel;
  const surfaceSettings: SurfaceSettings = {
    effectiveEnvironment: (_surface: Surface): ExecutionEnvironment => surfaceEnv,
    getRuntimeSettings: () => ({
      executionEnvironment: surfaceEnv,
      modelName: surfaceModelName,
      thinkingLevel: surfaceThinkingLevel,
      skillPolicy: DEFAULT_SKILL_POLICY,
      fingerprint: JSON.stringify({ surfaceEnv, surfaceModelName, surfaceThinkingLevel, skillPolicy: DEFAULT_SKILL_POLICY }),
    }),
    getModelName: () => surfaceModelName,
    setModelName: () => {},
    getThinkingLevel: () => surfaceThinkingLevel,
    setThinkingLevel: () => {},
    setPreferences: () => {},
    getSkillPolicy: () => DEFAULT_SKILL_POLICY,
  };
  const betaSurfaces: Surface[] = [];
  const createAgentRunnerCalls: ConstructorParameters<typeof AgentRunner>[0][] = [];
  const createAgentRunner = opts.createAgentRunner ?? ((o) => {
    createAgentRunnerCalls.push(o);
    return o as unknown as AgentRunner;
  });

  const delegatedWorkHost = new FakeDelegatedWorkHost() as unknown as DelegatedWorkHost;
  const runtimeHost = new ConversationRuntimeHost({ delegatedWorkHost });
  const dispatcher = new TurnDispatcher({
    cfg: {} as Config,
    surfaceSettings,
    subagentRunner,
    memoryStore: new FakeMemoryStore() as unknown as MemoryStore,
    runtimeHost,
    createMessageBuffer: (_surface: Surface, _session?: ConversationState): TurnSink => ({
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
    surfaceRuntimeAuthority: opts.surfaceRuntimeAuthority ?? permissiveRuntimeAuthority(),
  });

  return { dispatcher, runtimeHost, subagentRunner: subagentRunner as unknown as FakeSubagentRunner, betaSurfaces, createAgentRunnerCalls };
}

function registerTestSurfaceRunner(
  runtimeHost: ConversationRuntimeHost,
  conversationId: string,
  runner: AgentRunner,
): void {
  // Match the real usage pattern: reserve a creation, then register.
  const creation = runtimeHost.reserveCreation(conversationId, surfaceId(dmSurface(1)), "test-settings");
  try {
    runtimeHost.registerSurfaceRuntime(conversationId, runner, {
      surfaceId: surfaceId(dmSurface(1)),
      runtimeId: DelegatedWorkHost.newRuntimeId(),
      skillContext: { settingsFingerprint: "test-settings", policyFingerprint: "test", manifestFingerprint: null },
    });
  } finally {
    creation.complete();
  }
}

function makeSession(id: string, env: ExecutionEnvironment = personalEnvironment()): ConversationState {
  return { id, createdAt: new Date().toISOString(), executionEnvironment: env };
}

it("reports a wedged scheduled runner as an error instead of silently dropping it", async () => {
  const { dispatcher, runtimeHost } = buildDispatcher();
  const conversation = makeSession("scheduled-wedged");
  const runner = new FakeAgentRunner();
  runner._isAbortTimedOut = true;
  registerTestSurfaceRunner(runtimeHost, conversation.id, runner as unknown as AgentRunner);
  const errors: unknown[] = [];

  const admission = dispatcher.enqueueScheduledTurn(
    conversation,
    dmSurface(1),
    "scheduled work",
    (error) => { errors.push(error); },
  );

  if (typeof admission === "boolean") throw new Error("expected scheduled turn admission handle");
  expect(await admission.started).toBe(true);
  await runtimeHost.disposeAll();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(Error);
  expect((errors[0] as Error).message).toContain("runner is wedged");
});

class FakeBindingGuard implements SurfaceRuntimeAuthority {
  private readonly bindings = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  lockReleases = 0;

  bind(surface: Surface, conversationId: string): void {
    this.bindings.set(surfaceId(surface), conversationId);
  }

  async assertCurrentBinding(surface: Surface, conversationId: string): Promise<void> {
    const bound = this.bindings.get(surfaceId(surface));
    if (bound !== conversationId) {
      throw new Error(`binding rotated: ${bound ?? "unbound"} !== ${conversationId}`);
    }
  }

  isCurrentBinding(surface: Surface, conversationId: string): boolean {
    return this.bindings.get(surfaceId(surface)) === conversationId;
  }

  withCurrentBinding<T>(
    surface: Surface,
    conversationId: string,
    fn: (signal: AttachmentSignal) => Promise<AttachedWork<T>>,
  ): Promise<AttachedWork<T>> {
    const bound = this.bindings.get(surfaceId(surface));
    if (bound !== conversationId) {
      throw new Error(
        `binding rotated: ${bound ?? "unbound"} !== ${conversationId}`,
      );
    }

    const prev = this.tail;
    let resolveLock!: () => void;
    let rejectLock!: (err: unknown) => void;
    const released = new Promise<void>((resolve, reject) => {
      resolveLock = resolve;
      rejectLock = reject;
    });

    type MutableSignal = AttachmentSignal & { failed(err: unknown): void; settled: boolean };
    const signal: MutableSignal = {
      attached: () => {
        if (!signal.settled) {
          this.lockReleases++;
          signal.settled = true;
          resolveLock();
        }
      },
      failed: (err) => {
        if (!signal.settled) {
          signal.settled = true;
          rejectLock(err);
        }
      },
      settled: false,
    };

    const resultPromise = (async () => {
      await prev;
      const work = fn(signal);
      work.catch((err) => {
        if (!signal.settled) signal.failed(err);
      });
      await released;
      return work;
    })();

    // The next lifecycle transition waits for the lock (attachment or failure),
    // not for the terminal result.
    this.tail = released.catch(() => {});

    return resultPromise as Promise<AttachedWork<T>>;
  }
}

describe("TurnDispatcher runtime host support", () => {
  it("removes runner and queue map entries synchronously before awaiting dispose", async () => {
    const { dispatcher, runtimeHost } = buildDispatcher();
    const session = makeSession("abc123def0");
    const runner = new FakeAgentRunner();
    runner.disposeDelayMs = 50;
    registerTestSurfaceRunner(runtimeHost, session.id, runner as unknown as AgentRunner);

    expect(dispatcher.hasRunner(session.id)).toBe(true);
    const disposePromise = dispatcher.disposeRunner(session.id);
    expect(dispatcher.hasRunner(session.id)).toBe(false);
    expect(dispatcher.isPromptPending(session.id)).toBe(false);
    expect(dispatcher.isCommandPending(session.id)).toBe(false);
    await disposePromise;
    expect(runner.disposeCalled).toBe(true);
  });

  it("does not enumerate subagents during runtime disposal", async () => {
    const { dispatcher, runtimeHost, subagentRunner } = buildDispatcher();
    const session = makeSession("abc123def0");
    const runner = new FakeAgentRunner();
    registerTestSurfaceRunner(runtimeHost, session.id, runner as unknown as AgentRunner);

    await dispatcher.disposeRunner(session.id);
    expect(subagentRunner.cancelled).toEqual([]);
    expect(dispatcher.hasRunner(session.id)).toBe(false);
  });

  it("does not recreate a disposed runner while dispose is in flight", async () => {
    const { dispatcher, runtimeHost } = buildDispatcher();
    const session = makeSession("abc123def0");
    const runner = new FakeAgentRunner();
    runner.disposeDelayMs = 50;
    registerTestSurfaceRunner(runtimeHost, session.id, runner as unknown as AgentRunner);

    const disposePromise = dispatcher.disposeRunner(session.id);
    // Synchronous: the runner is gone before dispose resolves.
    expect(dispatcher.getRunner(session.id)).toBeNull();
    await disposePromise;
  });





  it("creates an internal runner without Surface comparison", () => {
    const projectRoot = "/srv/project-a";
    const { dispatcher, betaSurfaces, createAgentRunnerCalls } = buildDispatcher({
      surfaceEnv: projectEnvironment(projectRoot),
    });
    const session: InternalSessionState = {
      id: "__internal_test__",
      createdAt: new Date().toISOString(),
      chatId: 0,
      executionEnvironment: personalEnvironment(),
    };

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
    const options = createAgentRunnerCalls[0];
    if (options === undefined || options.plan !== undefined) throw new Error("expected an internal runtime");
    expect(options.executionEnvironment).toEqual(personalEnvironment());
  });

  it("rejects a Surface-backed session at the internal dispatch boundary", () => {
    const { dispatcher } = buildDispatcher();
    const surfaceSession = makeSession("abc123def0", personalEnvironment());

    expect(() => dispatcher.enqueueInternalTurn(
      surfaceSession as unknown as InternalSessionState,
      "test prompt",
      () => {},
      () => {},
    )).toThrow(/reserved __…__ identity/);
  });

  it("rejects reuse of a Surface-backed runner for an internal identity collision", () => {
    const { dispatcher, runtimeHost } = buildDispatcher();
    const internal: InternalSessionState = {
      id: "__internal_test__",
      createdAt: new Date().toISOString(),
      chatId: 0,
      executionEnvironment: personalEnvironment(),
    };
    registerTestSurfaceRunner(runtimeHost, internal.id, new FakeAgentRunner() as unknown as AgentRunner);

    expect(() => dispatcher.enqueueInternalTurn(internal, "test prompt", () => {}, () => {}))
      .toThrow(/Surface-backed runtime/);
  });




});

describe("TurnDispatcher async runner creation", () => {
  let tmpDir: string;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-dispatch-async-"));
    mkdirSync(join(tmpDir, "workspace"), { recursive: true });
    writeFileSync(join(tmpDir, "workspace", "SOUL.md"), "prepared runtime test identity\n", "utf-8");
    memoryStore = new MemoryStore(tmpDir);
  });

  afterEach(() => {
    memoryStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildAsyncDispatcher(
    opts: {
      createAgentRunner?: (opts: ConstructorParameters<typeof AgentRunner>[0]) => AgentRunner;
      surfaceRuntimeAuthority?: SurfaceRuntimeAuthority;
      surfacePolicy?: SkillPolicy;
      cfg?: Config;
      delegatedWorkHost?: DelegatedWorkHost;
      createSurfaceTools?: (surface: Surface) => ToolDefinition[];
    } = {},
  ): {
    dispatcher: TurnDispatcher;
    runtimeHost: ConversationRuntimeHost;
    subagentRunner: FakeSubagentRunner;
    createAgentRunnerCalls: ConstructorParameters<typeof AgentRunner>[0][];
  } {
    const subagentRunner = new FakeSubagentRunner();
    const surfaceSettings: SurfaceSettings = {
      effectiveEnvironment: (_surface: Surface): ExecutionEnvironment => personalEnvironment(),
      getRuntimeSettings: () => ({
        executionEnvironment: personalEnvironment(),
        modelName: undefined,
        thinkingLevel: undefined,
        skillPolicy: opts.surfacePolicy ?? DEFAULT_SKILL_POLICY,
        fingerprint: JSON.stringify({ environment: personalEnvironment(), policy: opts.surfacePolicy ?? DEFAULT_SKILL_POLICY }),
      }),
      getModelName: () => undefined,
      setModelName: () => {},
      getThinkingLevel: () => undefined,
      setThinkingLevel: () => {},
      setPreferences: () => {},
      getSkillPolicy: () => opts.surfacePolicy ?? DEFAULT_SKILL_POLICY,
    };
    const createAgentRunnerCalls: ConstructorParameters<typeof AgentRunner>[0][] = [];
    const createAgentRunner = opts.createAgentRunner ?? ((o) => {
      createAgentRunnerCalls.push(o);
      const plan = o.plan;
      if (plan === undefined) throw new Error("expected a prepared Surface runtime plan");
      const runner = new FakeAgentRunner();
      runner.disposeCalled = false;
      runner.memoryContext = plan.memoryContext;
      runner.genericSubagentInheritance = {
        executionEnvironment: plan.executionEnvironment,
        resolvedSkills: plan.resolvedSkills,
      };
      runner.transcriptWriterContext = {
        kind: "surface",
        sourceSurfaceId: plan.memoryContext.authority.sourceSurfaceId,
      };
      return runner as unknown as AgentRunner;
    });
    const delegatedWorkHost = opts.delegatedWorkHost ?? new FakeDelegatedWorkHost() as unknown as DelegatedWorkHost;
    const runtimeHost = new ConversationRuntimeHost({ delegatedWorkHost });

    const dispatcher = new TurnDispatcher({
      cfg: {
        botToken: "test-token",
        allowedTgUserIds: new Set([1]),
        modelName: "poe/TestModel",
        poeApiKey: "test-key",
        openrouterApiKey: "test-key",
        openaiApiKey: "test-key",
        anthropicApiKey: "test-key",
        goblinHome: tmpDir,
        logLevel: "error",
        toolVisibility: "standard",
        voiceName: "en-US-AriaNeural",
        favorites: [],
        ...opts.cfg,
      },
      surfaceSettings,
      subagentRunner: subagentRunner as unknown as SubagentRunner,
      memoryStore,
      runtimeHost,
      createMessageBuffer: (_surface: Surface, _session?: ConversationState): TurnSink => ({
        onTextDelta: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onStatusUpdate: () => {},
        onMessageStart: () => {},
        onMessageEnd: () => {},
        onAgentEnd: () => {},
      }),
      createBetaTools: opts.createSurfaceTools ?? ((_surface: Surface) => []),
      createAgentRunner,
      surfaceRuntimeAuthority: opts.surfaceRuntimeAuthority ?? permissiveRuntimeAuthority(),
    });

    return { dispatcher, runtimeHost, subagentRunner, createAgentRunnerCalls };
  }

  it("eagerly freezes the Surface policy and resolved manifest at runtime creation", async () => {
    const skillPath = join(tmpDir, ".agents", "skills", "alpha", "SKILL.md");
    mkdirSync(join(tmpDir, ".agents", "skills", "alpha"), { recursive: true });
    writeFileSync(skillPath, "---\nname: alpha\ndescription: alpha\n---\nbody\n", "utf-8");
    const policy: SkillPolicy = {
      goblin: { mode: "selected", names: ["alpha"] },
      environment: { mode: "none" },
      host: { mode: "none" },
    };
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher({
      cfg: { goblinHome: tmpDir } as Config,
      surfacePolicy: policy,
    });

    await dispatcher.getOrCreateRunner(makeSession("abc123def0"), dmSurface(1));
    const opts = createAgentRunnerCalls[0]!;
    const plan = opts.plan;
    if (plan === undefined) throw new Error("expected a prepared Surface runtime plan");
    expect(plan.skillPolicy).toEqual(policy);
    expect(plan.resolvedSkills.skills.map((skill) => skill.name)).toEqual(["alpha"]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.resolvedSkills)).toBe(true);
  });

  it("commits one complete ephemeral plan before Surface runner construction", async () => {
    await memoryStore.add("general", "plan memory fact");
    const { dispatcher, createAgentRunnerCalls, runtimeHost } = buildAsyncDispatcher();
    const conversation = makeSession("abc123def0");
    const surface = dmSurface(1);

    await dispatcher.getOrCreateRunner(conversation, surface);

    const options = createAgentRunnerCalls[0];
    const plan = options?.plan;
    if (plan === undefined) throw new Error("expected a prepared Surface runtime plan");
    expect(plan.conversationId).toBe(conversation.id);
    expect(plan.surfaceId).toBe(surfaceId(surface));
    expect(plan.executionEnvironment).toEqual(personalEnvironment());
    expect(plan.cwd).toBe(join(tmpDir, "workspace"));
    expect(plan.modelName).toBe("poe/TestModel");
    expect(plan.thinkingLevel).toBe(plan.resolvedModel.thinkingLevel);
    expect(plan.systemPrompt.sources).toEqual([join(tmpDir, "workspace", "SOUL.md")]);
    expect(plan.prompt).toContain("prepared runtime test identity");
    expect(plan.prompt).toContain("plan memory fact");
    expect(plan.resolvedSkills.skills).toEqual([]);
    expect(plan.capabilityManifest.capabilities).toEqual([
      "pi-file-tools",
      "memory",
      "subagents",
      "prompt-file-notices",
    ]);
    expect(plan.capabilityManifest.surfaceTools).toEqual([]);
    expect(runtimeHost.runtimeIdFor(conversation.id)).toBe(plan.runtimeId);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.capabilityManifest)).toBe(true);
    expect(Object.isFrozen(plan.memoryContext)).toBe(true);
  });

  it("advertises surface tools only when concrete tools were captured", async () => {
    const tool = { name: "text_to_speech" } as ToolDefinition;
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher({
      createSurfaceTools: () => [tool],
    });

    await dispatcher.getOrCreateRunner(makeSession("abc123def0"), dmSurface(1));
    const plan = createAgentRunnerCalls[0]?.plan;
    if (plan === undefined) throw new Error("expected a prepared Surface runtime plan");
    expect(plan.capabilityManifest.capabilities).toContain("surface-tools");
    expect(plan.capabilityManifest.surfaceTools).toEqual([tool]);
  });

  it("getOrCreateRunner is async and returns a runner with a captured memory context", async () => {
    await memoryStore.add("general", "test fact");
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    const runner = await dispatcher.getOrCreateRunner(session, dmSurface(1));
    expect(runner).toBeDefined();
    expect(createAgentRunnerCalls).toHaveLength(1);
    const opts = createAgentRunnerCalls[0]!;
    const plan = opts.plan;
    if (plan === undefined) throw new Error("expected a prepared Surface runtime plan");
    expect(plan.memoryContext.kind).toBe("surface");
    expect(plan.memoryContext.frozenSummary).toContain("test fact");
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

  it("replacement derives the transcript writer context from the destination Surface capture", async () => {
    const { dispatcher } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    const r1 = await dispatcher.getOrCreateRunner(session, dmSurface(1));
    const r2 = await dispatcher.getOrCreateRunner(session, dmSurface(2));

    expect((r1 as unknown as FakeAgentRunner).transcriptWriterContext).toEqual({
      kind: "surface",
      sourceSurfaceId: surfaceId(dmSurface(1)),
    });
    expect((r2 as unknown as FakeAgentRunner).transcriptWriterContext).toEqual({
      kind: "surface",
      sourceSurfaceId: surfaceId(dmSurface(2)),
    });
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
    const yPlan = yOpts.plan;
    if (yPlan === undefined) throw new Error("expected a prepared Surface runtime plan");
    expect(yPlan.memoryContext.authority.sourceSurfaceId).toBe(surfaceId(dmSurface(2)));
  });

  it("settings invalidation discards a candidate changed during an async authority checkpoint", async () => {
    // Every settings-mutation path bumps the runtime epoch through lifecycle
    // invalidation (invalidateSurfaceRuntime → disposeRuntime →
    // invalidate("settings-change")). This test simulates that path: during
    // the second binding checkpoint, a settings-change invalidation disposes
    // the in-flight creation. The epoch ticket captured at preparation start
    // becomes stale, and the next checkpoint fences the candidate.
    let assertionCount = 0;
    const policy = DEFAULT_SKILL_POLICY;
    const surfaceSettings: SurfaceSettings = {
      effectiveEnvironment: () => personalEnvironment(),
      getRuntimeSettings: () => ({
        executionEnvironment: personalEnvironment(),
        modelName: undefined,
        thinkingLevel: undefined,
        skillPolicy: policy,
        fingerprint: "settings:a",
      }),
      getModelName: () => undefined,
      setModelName: () => {},
      getThinkingLevel: () => undefined,
      setThinkingLevel: () => {},
      setPreferences: () => {},
      getSkillPolicy: () => policy,
    };
    const runtimeHost = new ConversationRuntimeHost({
      delegatedWorkHost: new FakeDelegatedWorkHost() as unknown as DelegatedWorkHost,
    });
    const createAgentRunnerCalls: ConstructorParameters<typeof AgentRunner>[0][] = [];
    const dispatcher = new TurnDispatcher({
      cfg: {
        goblinHome: tmpDir,
        modelName: "poe/TestModel",
        poeApiKey: "test-key",
      } as Config,
      surfaceSettings,
      subagentRunner: new FakeSubagentRunner() as unknown as SubagentRunner,
      memoryStore,
      runtimeHost,
      createMessageBuffer: () => ({
        onTextDelta: () => {}, onToolStart: () => {}, onToolEnd: () => {},
        onStatusUpdate: () => {}, onMessageStart: () => {}, onMessageEnd: () => {}, onAgentEnd: () => {},
      }),
      createBetaTools: () => [],
      createAgentRunner: (options) => {
        createAgentRunnerCalls.push(options);
        return new FakeAgentRunner() as unknown as AgentRunner;
      },
      surfaceRuntimeAuthority: {
        ...permissiveRuntimeAuthority(),
        assertCurrentBinding: async () => {
          assertionCount++;
          if (assertionCount === 2) {
            // Simulate a settings-change invalidation: lifecycle bumps the
            // epoch and drops the in-flight creation.
            await runtimeHost.disposeRuntime("abc123def0", { preserveCommandQueue: true });
          }
        },
      },
    });

    await expect(dispatcher.getOrCreateRunner(makeSession("abc123def0"), dmSurface(1)))
      .rejects.toThrow(/stale runtime creation/);
    expect(createAgentRunnerCalls).toHaveLength(0);
    expect(runtimeHost.hasRuntime("abc123def0")).toBe(false);
  });

  it("creation commit performs no Surface-settings re-read", async () => {
    // The creation commit path (doCreateAndRegisterRunner) must not re-read
    // Surface settings. Every settings-mutation path bumps the runtime epoch
    // through lifecycle invalidation, so isCurrentCreation is sufficient.
    // This test tracks settings reads and verifies the count does not increase
    // during the commit phase (after prepare returns, before registration).
    const policy = DEFAULT_SKILL_POLICY;
    let settingsReadCount = 0;
    const surfaceSettings: SurfaceSettings = {
      effectiveEnvironment: () => personalEnvironment(),
      getRuntimeSettings: () => {
        settingsReadCount++;
        return {
          executionEnvironment: personalEnvironment(),
          modelName: undefined,
          thinkingLevel: undefined,
          skillPolicy: policy,
          fingerprint: "settings:a",
        };
      },
      getModelName: () => undefined,
      setModelName: () => {},
      getThinkingLevel: () => undefined,
      setThinkingLevel: () => {},
      setPreferences: () => {},
      getSkillPolicy: () => policy,
    };
    const runtimeHost = new ConversationRuntimeHost({
      delegatedWorkHost: new FakeDelegatedWorkHost() as unknown as DelegatedWorkHost,
    });
    const createAgentRunnerCalls: ConstructorParameters<typeof AgentRunner>[0][] = [];
    const dispatcher = new TurnDispatcher({
      cfg: {
        goblinHome: tmpDir,
        modelName: "poe/TestModel",
        poeApiKey: "test-key",
      } as Config,
      surfaceSettings,
      subagentRunner: new FakeSubagentRunner() as unknown as SubagentRunner,
      memoryStore,
      runtimeHost,
      createMessageBuffer: () => ({
        onTextDelta: () => {}, onToolStart: () => {}, onToolEnd: () => {},
        onStatusUpdate: () => {}, onMessageStart: () => {}, onMessageEnd: () => {}, onAgentEnd: () => {},
      }),
      createBetaTools: () => [],
      createAgentRunner: (options) => {
        createAgentRunnerCalls.push(options);
        return new FakeAgentRunner() as unknown as AgentRunner;
      },
      surfaceRuntimeAuthority: permissiveRuntimeAuthority(),
    });

    // Record the read count after getOrCreateRunner's initial snapshot but
    // before the commit. The initial snapshot reads once; prepare does not
    // read settings. The commit (doCreateAndRegisterRunner after prepare)
    // must not read settings either.
    const runner = await dispatcher.getOrCreateRunner(makeSession("abc123def0"), dmSurface(1));
    expect(runner).toBeDefined();
    expect(createAgentRunnerCalls).toHaveLength(1);
    // The snapshot at getOrCreateRunner entry reads once. The prepared
    // runtime no longer reads settings at checkpoints or the final check.
    // The commit path (doCreateAndRegisterRunner) no longer re-reads
    // settings. So the total read count should be 1 (the initial snapshot).
    expect(settingsReadCount).toBe(1);
  });

  it("same-binding invalidation preserves queued commands while fencing model work", async () => {
    // A settings-change invalidation (e.g. /model) bumps the runtime epoch
    // but preserves the binding epoch. Queued lifecycle commands (captured
    // under the binding epoch) remain current and execute after the turn;
    // stale model work (captured under the runtime epoch) is fenced.
    const { dispatcher, runtimeHost } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);

    const runner = await dispatcher.getOrCreateRunner(session, surface);
    const fakeRunner = runner as unknown as FakeAgentRunner;
    fakeRunner.disposeDelayMs = 0;

    // Capture epochs at enqueue time.
    const runtimeEpoch = runtimeHost.captureEpoch(session.id, "runtime");
    const bindingEpoch = runtimeHost.captureEpoch(session.id, "binding");

    let commandExecuted = false;
    let promptExecuted = false;

    // Queue a lifecycle command (binding epoch).
    dispatcher.scheduleCommand(
      session,
      surface,
      async (isCurrent) => {
        if (!isCurrent()) return;
        commandExecuted = true;
      },
      () => {},
    );

    // Queue a prompt (runtime epoch) — this represents stale model work.
    dispatcher.schedulePrompt(
      session,
      runner,
      async (isCurrent) => {
        if (!isCurrent()) return;
        promptExecuted = true;
      },
      () => {},
    );

    // Settings-change invalidation: bumps runtime epoch, preserves binding
    // epoch, preserves the command queue.
    await runtimeHost.disposeRuntime(session.id, { preserveCommandQueue: true });

    // The runtime epoch bumped; the binding epoch did not.
    expect(runtimeHost.isEpochCurrent(session.id, "runtime", runtimeEpoch)).toBe(false);
    expect(runtimeHost.isEpochCurrent(session.id, "binding", bindingEpoch)).toBe(true);

    // Allow the queue to drain. The command (binding epoch) executes; the
    // prompt (runtime epoch) is fenced.
    await runtimeHost.awaitSettled(session.id);

    expect(commandExecuted).toBe(true);
    expect(promptExecuted).toBe(false);
  });

  it("binding authority recheck: a stale caller whose binding rotated is discarded", async () => {
    // Simulate: intake resolves X → session A, then /new rotates X to B and
    // disposes A, then the stale intake starts A's creation. The binding
    // lifecycle authority returns B's id (not A), so the creation is discarded.
    const bindingMap = new Map<string, string>();
    bindingMap.set(surfaceId(dmSurface(1)), "abc123def0");
    const { dispatcher, createAgentRunnerCalls } = buildAsyncDispatcher({
      surfaceRuntimeAuthority: mappedRuntimeAuthority(bindingMap),
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

  it("does not resurrect a runtime invalidated during the final authority check", async () => {
    let dispatcher!: TurnDispatcher;
    let assertCount = 0;
    const authority: SurfaceRuntimeAuthority = {
      ...permissiveRuntimeAuthority(),
      assertCurrentBinding: async () => {
        assertCount++;
        if (assertCount === 5) {
          await dispatcher.disposeRunner("abc123def0");
        }
      },
    };
    const built = buildAsyncDispatcher({ surfaceRuntimeAuthority: authority });
    dispatcher = built.dispatcher;
    const session = makeSession("abc123def0");

    await expect(dispatcher.getOrCreateRunner(session, dmSurface(1))).rejects.toThrow(/after prompt capture/);
    expect(built.createAgentRunnerCalls).toHaveLength(0);
    expect(dispatcher.hasRuntime(session.id)).toBe(false);
  });

  it("capture failure: a rejected capture leaves no half-created runtime", async () => {
    // Close the memory store so captureRuntimeMemoryContext rejects when it
    // tries to read. This proves a failed capture leaves no half-created
    // runtime and the in-flight entry is cleared for subsequent creation.
    const { dispatcher, createAgentRunnerCalls, runtimeHost } = buildAsyncDispatcher();
    const session = makeSession("abc123def0");

    // Close the store so the capture's store.read throws.
    memoryStore.close();

    await expect(dispatcher.getOrCreateRunner(session, dmSurface(1))).rejects.toThrow();
    expect(createAgentRunnerCalls).toHaveLength(0);
    expect(runtimeHost.hasRunner(session.id)).toBe(false);

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
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);
    const guard = new FakeBindingGuard();
    guard.bind(surface, session.id);
    const { dispatcher, subagentRunner } = buildAsyncDispatcher({
      surfaceRuntimeAuthority: guard,
      cfg: { goblinHome: tmpDir } as Config,
    });

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
    expect(subagentRunner.lastReviveArgs!.inheritance).toEqual({
      executionEnvironment: personalEnvironment(),
      resolvedSkills: expect.objectContaining({ skills: [] }),
    });
  });

  it("reviveSubagent rejects when no runner exists for the session", async () => {
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);
    const guard = new FakeBindingGuard();
    guard.bind(surface, session.id);
    const { dispatcher } = buildAsyncDispatcher({ surfaceRuntimeAuthority: guard });

    await expect(dispatcher.reviveSubagent(surface, session, "sub-1", "go")).rejects.toThrow(
      /no current runner/,
    );
  });

  it("reviveSubagent rejects when the binding has rotated", async () => {
    await memoryStore.add("general", "test fact");
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);
    const guard = new FakeBindingGuard();
    guard.bind(surface, session.id);
    const { dispatcher } = buildAsyncDispatcher({ surfaceRuntimeAuthority: guard });

    await dispatcher.getOrCreateRunner(session, surface);
    guard.bind(surface, "other-session-id");
    await expect(dispatcher.reviveSubagent(surface, session, "sub-1", "go")).rejects.toThrow(
      /binding rotated/,
    );
  });

  it("reviveSubagent rejects when the runner's captured Surface does not match the requested surface", async () => {
    await memoryStore.add("general", "test fact");
    const session = makeSession("abc123def0");
    const guard = new FakeBindingGuard();
    guard.bind(dmSurface(1), session.id);
    const { dispatcher } = buildAsyncDispatcher({ surfaceRuntimeAuthority: guard });

    await dispatcher.getOrCreateRunner(session, dmSurface(1));

    // The conversation binding rotates to Surface 2, but the in-memory runner
    // still carries a Surface 1 capture. The guard passes the new Surface, and
    // the runner-capture mismatch is detected inside.
    guard.bind(dmSurface(2), session.id);
    await expect(dispatcher.reviveSubagent(dmSurface(2), session, "sub-1", "go")).rejects.toThrow(
      /sourceSurfaceId mismatch/,
    );
  });

  it("reviveSubagent releases the binding guard at attachment, not at terminal result", async () => {
    await memoryStore.add("general", "test fact");
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);
    const guard = new FakeBindingGuard();
    guard.bind(surface, session.id);
    const { dispatcher, subagentRunner } = buildAsyncDispatcher({ surfaceRuntimeAuthority: guard });
    await dispatcher.getOrCreateRunner(session, surface);

    let finishRevive!: () => void;
    subagentRunner.revive = async (
      parentCapture,
      inheritance,
      id,
      prompt,
      _onStatusUpdate,
      onAttached,
    ) => {
      subagentRunner.lastReviveArgs = { parentCapture, inheritance, id, prompt };
      onAttached?.();
      return new Promise((resolve) => {
        finishRevive = () => resolve("revived result");
      });
    };

    const revivePromise = dispatcher.reviveSubagent(surface, session, "sub-1", "follow-up");

    // Wait for microtask queue so the attachment signal fires.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(guard.lockReleases).toBe(1);

    // A concurrent lifecycle transition can proceed while the revived work is
    // still pending.
    let secondEntered = false;
    const secondPromise = guard.withCurrentBinding<string>(surface, session.id, async (signal) => {
      secondEntered = true;
      signal.attached();
      return { result: Promise.resolve("second") };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondEntered).toBe(true);

    finishRevive();
    await expect(revivePromise).resolves.toBe("revived result");
    await secondPromise;
  });

  it("reviveSubagent releases the binding guard when subagentRunner.revive fails before attachment", async () => {
    await memoryStore.add("general", "test fact");
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);
    const guard = new FakeBindingGuard();
    guard.bind(surface, session.id);
    const { dispatcher, subagentRunner } = buildAsyncDispatcher({ surfaceRuntimeAuthority: guard });
    await dispatcher.getOrCreateRunner(session, surface);

    subagentRunner.revive = async () => {
      throw new Error("Subagent not found");
    };

    await expect(dispatcher.reviveSubagent(surface, session, "missing", "go")).rejects.toThrow(
      /Subagent not found/,
    );
    expect(guard.lockReleases).toBe(0);

    // The guard must be fully released despite no attachment signal.
    let released = false;
    await guard.withCurrentBinding<string>(surface, session.id, async (signal) => {
      released = true;
      signal.attached();
      return { result: Promise.resolve("ok") };
    });
    expect(released).toBe(true);
  });

  it("reviveSubagent suppresses stale result and acknowledgement when the runner is invalidated after attachment", async () => {
    await memoryStore.add("general", "test fact");
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);
    const guard = new FakeBindingGuard();
    guard.bind(surface, session.id);
    const { dispatcher, subagentRunner } = buildAsyncDispatcher({
      surfaceRuntimeAuthority: guard,
      delegatedWorkHost: new FakeDelegatedWorkHost() as unknown as DelegatedWorkHost,
    });
    await dispatcher.getOrCreateRunner(session, surface);

    let finishRevive!: () => void;
    subagentRunner.revive = async (
      parentCapture,
      inheritance,
      id,
      prompt,
      _onStatusUpdate,
      onAttached,
    ) => {
      subagentRunner.lastReviveArgs = { parentCapture, inheritance, id, prompt };
      onAttached?.();
      return new Promise((resolve) => {
        finishRevive = () => resolve("stale result");
      });
    };

    const revivePromise = dispatcher.reviveSubagent(surface, session, "sub-1", "follow-up");

    // Wait for microtask queue so the attachment signal fires.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(guard.lockReleases).toBe(1);

    // Simulate a lifecycle replacement that disposes the runner while the
    // revived subagent is still running.
    await dispatcher.disposeRunner(session.id);

    finishRevive();
    await expect(revivePromise).rejects.toThrow(/completed after its runtime was invalidated/);
    expect(subagentRunner.acknowledged).toHaveLength(0);
  });

  it("captures an early delegated invalidation rejection while runner dispose is pending and rethrows it", async () => {
    const delegatedWorkHost = new FakeDelegatedWorkHost();
    delegatedWorkHost.invalidateRuntimeRejectWith = new Error("invalidation failed");

    const { dispatcher } = buildAsyncDispatcher({
      delegatedWorkHost: delegatedWorkHost as unknown as DelegatedWorkHost,
    });
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);

    const runner = await dispatcher.getOrCreateRunner(session, surface);
    const fakeRunner = runner as unknown as FakeAgentRunner;
    fakeRunner.disposeDelayMs = 50;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const disposePromise = dispatcher.disposeRunner(session.id);
      await expect(disposePromise).rejects.toThrow("invalidation failed");
      // Allow any unhandled rejection event that escaped the eager handler to fire.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(fakeRunner.disposeCalled).toBe(true);
    expect(delegatedWorkHost.invalidateRuntimeCalls).toHaveLength(1);
  });

  it("combines runner dispose and delegated invalidation failures instead of dropping the invalidation error", async () => {
    const delegatedWorkHost = new FakeDelegatedWorkHost();
    delegatedWorkHost.invalidateRuntimeRejectWith = new Error("invalidation failed");

    const { dispatcher } = buildAsyncDispatcher({
      delegatedWorkHost: delegatedWorkHost as unknown as DelegatedWorkHost,
    });
    const session = makeSession("abc123def0");
    const surface = dmSurface(1);

    const runner = await dispatcher.getOrCreateRunner(session, surface);
    const fakeRunner = runner as unknown as FakeAgentRunner;
    fakeRunner.disposeRejectsWith = new Error("dispose failed");

    await expect(dispatcher.disposeRunner(session.id)).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "dispose failed" }),
        expect.objectContaining({ message: "invalidation failed" }),
      ],
    });

    expect(fakeRunner.disposeCalled).toBe(true);
    expect(delegatedWorkHost.invalidateRuntimeCalls).toHaveLength(1);
  });
});
