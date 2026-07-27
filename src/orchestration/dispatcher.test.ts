import { describe, it, expect } from "bun:test";
import { TurnDispatcher } from "./dispatcher.ts";
import type { AgentRunner } from "../agent/mod.ts";
import type { SubagentRunner } from "../subagents/mod.ts";
import type { MemoryStore } from "../memory/mod.ts";
import type { SessionState } from "../sessions/mod.ts";
import type { Config } from "../config.ts";
import type { Surface } from "../surface.ts";
import { personalEnvironment, projectEnvironment } from "../sessions/environment.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import type { TurnSink, SurfaceSettings } from "./dispatcher.ts";
import { dmSurface } from "../surface.ts";

class FakeAgentRunner {
  disposeCalled = false;
  disposeDelayMs = 0;
  _isStreaming = false;
  _isPrompting = false;
  _isAbortTimedOut = false;
  _modelName = "";

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

  revive(_id: string, _prompt: string): Promise<string> {
    return Promise.resolve("");
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

    expect(() => dispatcher.createRunner(session, dmSurface(1))).toThrow(/environment mismatch/);
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

    dispatcher.createRunner(session, dmSurface(1));

    expect(betaSurfaces).toHaveLength(0);
    expect(createAgentRunnerCalls).toHaveLength(1);
    expect(createAgentRunnerCalls[0]?.executionEnvironment).toEqual(personalEnvironment());
  });
});
