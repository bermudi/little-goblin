import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentRunner } from "./mod.ts";
import { dmSurface } from "../surface.ts";
import { PiAgentBackend } from "./backend.ts";
import { createFauxPiServices } from "../test/faux-pi-services.ts";
import type { TurnCallbacks } from "./mod.ts";
import type { Config } from "../config.ts";
import { soulMdPath, workspacePath } from "../workspace/paths.ts";
import { piAgentDir } from "../pi-host.ts";
import { IncompatiblePiHistoryError, MalformedPiHistoryError } from "../pi-host.ts";
import { personalEnvironment, projectEnvironment } from "../sessions/environment.ts";
import { MemoryStore } from "../memory/store.ts";
import { captureRuntimeMemoryContext } from "../memory/mod.ts";

function makeConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([1]),
    modelName: "faux/faux-1",
    poeApiKey: "test-key",
    openrouterApiKey: "test-key",
    openaiApiKey: "test-key",
    anthropicApiKey: "test-key",
    goblinHome: home,
    logLevel: "error",
    toolVisibility: "standard",
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

/** Build a captured memory context for the contract tests. */
async function makeMemoryContext(home: string, surface = dmSurface(1)) {
  const store = new MemoryStore(home);
  try {
    return await captureRuntimeMemoryContext({
      surface,
      caller: { kind: "main" },
      store,
    });
  } finally {
    store.close();
  }
}

describe("AgentRunner pi-ai contract", () => {
  let tmpDir: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  let sessionManagerCalls: { method: "open" | "create"; args: unknown[] }[] = [];
  const InstrumentedSessionManager = {
    open(path: string, sessionDir?: string, cwdOverride?: string) {
      sessionManagerCalls.push({ method: "open", args: [path, sessionDir, cwdOverride] });
      return SessionManager.open(path, sessionDir, cwdOverride);
    },
    create(cwd: string, sessionDir?: string) {
      sessionManagerCalls.push({ method: "create", args: [cwd, sessionDir] });
      return SessionManager.create(cwd, sessionDir);
    },
  } as unknown as typeof SessionManager;

  function piSessionDirFor(sessionId: string): string {
    return join(tmpDir, "state", "sessions", sessionId, "pi");
  }

  function callbacks(): TurnCallbacks {
    return {
      onTextDelta: mock(() => {}),
      onToolStart: mock(() => {}),
      onToolEnd: mock(() => {}),
      onStatusUpdate: mock(() => {}),
      onMessageStart: mock(() => {}),
      onMessageEnd: mock(() => {}),
      onAgentEnd: mock(() => {}),
    };
  }

  function realBackend(opts: ConstructorParameters<typeof PiAgentBackend>[0]): PiAgentBackend {
    return new PiAgentBackend({
      ...opts,
      deps: { createPiServices: (home) => createFauxPiServices(home, faux) },
    });
  }

  async function surfaceRunner(isCurrent: () => boolean): Promise<AgentRunner> {
    const model = faux.getModel() as Model<Api>;
    return new AgentRunner({
      cfg: makeConfig(tmpDir),
      sessionId: "abcdef1234",
      surface: dmSurface(1),
      memoryContext: await makeMemoryContext(tmpDir),
      isCurrent,
      customTools: [],
      executionEnvironment: personalEnvironment(),
      resolvedModel: { model, apiKey: "fake-key", thinkingLevel: "medium" },
      backendFactory: (opts) => realBackend(opts),
    });
  }

  function internalRunner(): AgentRunner {
    const model = faux.getModel() as Model<Api>;
    return new AgentRunner({
      cfg: makeConfig(tmpDir),
      sessionId: "__contract_internal__",
      memoryContext: { kind: "internal", caller: { kind: "internal" } },
      customTools: [],
      executionEnvironment: personalEnvironment(),
      resolvedModel: { model, apiKey: "fake-key", thinkingLevel: "medium" },
      backendFactory: (opts) => realBackend(opts),
    });
  }

  beforeEach(() => {
    sessionManagerCalls = [];
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-contract-"));
    mkdirSync(workspacePath(tmpDir), { recursive: true });
    mkdirSync(piAgentDir(tmpDir), { recursive: true });
    mkdirSync(dirname(soulMdPath(tmpDir)), { recursive: true });
    writeFileSync(soulMdPath(tmpDir), "test goblin identity\n", "utf-8");
    faux = registerFauxProvider();
  });

  afterEach(() => {
    faux.unregister();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams a response through the real SDK using the faux provider", async () => {
    const model = faux.getModel() as Model<Api>;
    const memoryContext = await makeMemoryContext(tmpDir);
    const runner = new AgentRunner({
      cfg: makeConfig(tmpDir),
      sessionId: "abcdef1234",
      surface: dmSurface(1),
      memoryContext,
      isCurrent: () => true,
      customTools: [],
      executionEnvironment: personalEnvironment(),
      resolvedModel: { model, apiKey: "fake-key", thinkingLevel: "medium" },
      backendFactory: (opts) =>
        new PiAgentBackend({
          ...opts,
          deps: { createPiServices: (home) => createFauxPiServices(home, faux) },
        }),
    });

    faux.setResponses([fauxAssistantMessage("Hello from faux")]);

    const onTextDelta = mock((_text: string) => {});
    const onAgentEnd = mock(() => {});
    const callbacks: TurnCallbacks = {
      onTextDelta,
      onToolStart: mock(() => {}),
      onToolEnd: mock(() => {}),
      onStatusUpdate: mock(() => {}),
      onMessageStart: mock(() => {}),
      onMessageEnd: mock(() => {}),
      onAgentEnd,
    };

    await runner.prompt("hi", callbacks);

    expect(onTextDelta).toHaveBeenCalled();
    expect(onAgentEnd).toHaveBeenCalled();

    const deltas = onTextDelta.mock.calls.map((call) => call[0]);
    expect(deltas.join("")).toContain("Hello from faux");
  });

  it("fences stale default write and bash tools before they create host effects", async () => {
    const cases = [
      {
        name: "write",
        target: "stale-write.txt",
        toolCall: () => fauxToolCall("write", { path: "stale-write.txt", content: "must not exist" }),
      },
      {
        name: "bash",
        target: "stale-bash.txt",
        toolCall: () => fauxToolCall("bash", { command: "printf blocked > stale-bash.txt" }),
      },
    ];

    for (const testCase of cases) {
      let current = true;
      const runner = await surfaceRunner(() => current);
      faux.setResponses([
        () => {
          // Initialization and prompt dispatch completed while current. The
          // tool call is then delivered after its Surface runtime rotated.
          current = false;
          return fauxAssistantMessage(testCase.toolCall());
        },
        fauxAssistantMessage("unreachable completion"),
      ]);

      await expect(runner.prompt(`run stale ${testCase.name}`, callbacks()))
        .rejects.toThrow(/no longer current/);
      expect(existsSync(join(workspacePath(tmpDir), testCase.target))).toBe(false);
      await runner.dispose();
    }
  });

  it("keeps guarded default write and bash behavior working while current", async () => {
    const writeRunner = await surfaceRunner(() => true);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "current-write.txt", content: "written through pi" })),
      fauxAssistantMessage("write complete"),
    ]);
    await writeRunner.prompt("write a file", callbacks());
    expect(readFileSync(join(workspacePath(tmpDir), "current-write.txt"), "utf-8")).toBe("written through pi");
    await writeRunner.dispose();

    const bashRunner = await surfaceRunner(() => true);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'ran through pi' > current-bash.txt" })),
      fauxAssistantMessage("bash complete"),
    ]);
    await bashRunner.prompt("run a command", callbacks());
    expect(readFileSync(join(workspacePath(tmpDir), "current-bash.txt"), "utf-8")).toBe("ran through pi");
    await bashRunner.dispose();
  });

  it("keeps default tools available to explicit internal runtimes", async () => {
    const runner = internalRunner();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "internal-write.txt", content: "internal work" })),
      fauxAssistantMessage("internal write complete"),
    ]);

    await runner.prompt("write internal file", callbacks());
    expect(readFileSync(join(workspacePath(tmpDir), "internal-write.txt"), "utf-8")).toBe("internal work");
    await runner.dispose();
  });

  it("reopens compatible personal pi history without a cwd override", async () => {
    const model = faux.getModel() as Model<Api>;
    const sessionId = "abcdef1234";
    const piDir = piSessionDirFor(sessionId);
    mkdirSync(piDir, { recursive: true });
    const historyFile = join(piDir, "2026-01-01T00-00-00-000Z_old.jsonl");
    writeFileSync(
      historyFile,
      JSON.stringify({ type: "session", version: 3, id: "old-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: workspacePath(tmpDir) }) + "\n",
      "utf-8",
    );

    const memoryContext = await makeMemoryContext(tmpDir);
    const runner = new AgentRunner({
      cfg: makeConfig(tmpDir),
      sessionId,
      surface: dmSurface(1),
      memoryContext,
      isCurrent: () => true,
      customTools: [],
      executionEnvironment: personalEnvironment(),
      resolvedModel: { model, apiKey: "fake-key", thinkingLevel: "medium" },
      backendFactory: (opts) =>
        new PiAgentBackend({
          ...opts,
          deps: {
            createPiServices: (home) => createFauxPiServices(home, faux),
            SessionManager: InstrumentedSessionManager,
          },
        }),
    });

    faux.setResponses([fauxAssistantMessage("Resumed")]);
    const callbacks: TurnCallbacks = {
      onTextDelta: mock(() => {}),
      onToolStart: mock(() => {}),
      onToolEnd: mock(() => {}),
      onStatusUpdate: mock(() => {}),
      onMessageStart: mock(() => {}),
      onMessageEnd: mock(() => {}),
      onAgentEnd: mock(() => {}),
    };

    await runner.prompt("hi", callbacks);

    const openCalls = sessionManagerCalls.filter((c) => c.method === "open");
    expect(openCalls).toHaveLength(1);
    expect(openCalls[0]?.args[0]).toBe(historyFile);
    expect(openCalls[0]?.args[2]).toBe(workspacePath(tmpDir));
  });

  it("fails loudly when project pi history cwd is incompatible", async () => {
    const model = faux.getModel() as Model<Api>;
    const sessionId = "abcdef1234";
    const projectRoot = join(tmpDir, "project");
    mkdirSync(projectRoot, { recursive: true });
    const piDir = piSessionDirFor(sessionId);
    mkdirSync(piDir, { recursive: true });
    const historyFile = join(piDir, "2026-01-01T00-00-00-000Z_old.jsonl");
    writeFileSync(
      historyFile,
      JSON.stringify({ type: "session", version: 3, id: "old-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/other" }) + "\n",
      "utf-8",
    );

    const memoryContext = await makeMemoryContext(tmpDir);
    const runner = new AgentRunner({
      cfg: makeConfig(tmpDir),
      sessionId,
      surface: dmSurface(1),
      memoryContext,
      isCurrent: () => true,
      customTools: [],
      executionEnvironment: projectEnvironment(projectRoot),
      resolvedModel: { model, apiKey: "fake-key", thinkingLevel: "medium" },
      backendFactory: (opts) =>
        new PiAgentBackend({
          ...opts,
          deps: { createPiServices: (home) => createFauxPiServices(home, faux) },
        }),
    });

    const callbacks: TurnCallbacks = {
      onTextDelta: mock(() => {}),
      onToolStart: mock(() => {}),
      onToolEnd: mock(() => {}),
      onStatusUpdate: mock(() => {}),
      onMessageStart: mock(() => {}),
      onMessageEnd: mock(() => {}),
      onAgentEnd: mock(() => {}),
    };

    await expect(runner.prompt("hi", callbacks)).rejects.toBeInstanceOf(IncompatiblePiHistoryError);
  });

  it("fails loudly when the pi history header is malformed", async () => {
    const model = faux.getModel() as Model<Api>;
    const sessionId = "abcdef1234";
    const piDir = piSessionDirFor(sessionId);
    mkdirSync(piDir, { recursive: true });
    const historyFile = join(piDir, "2026-01-01T00-00-00-000Z_bad.jsonl");
    writeFileSync(historyFile, "not valid json\n", "utf-8");

    const memoryContext = await makeMemoryContext(tmpDir);
    const runner = new AgentRunner({
      cfg: makeConfig(tmpDir),
      sessionId,
      surface: dmSurface(1),
      memoryContext,
      isCurrent: () => true,
      customTools: [],
      executionEnvironment: personalEnvironment(),
      resolvedModel: { model, apiKey: "fake-key", thinkingLevel: "medium" },
      backendFactory: (opts) =>
        new PiAgentBackend({
          ...opts,
          deps: { createPiServices: (home) => createFauxPiServices(home, faux) },
        }),
    });

    const callbacks: TurnCallbacks = {
      onTextDelta: mock(() => {}),
      onToolStart: mock(() => {}),
      onToolEnd: mock(() => {}),
      onStatusUpdate: mock(() => {}),
      onMessageStart: mock(() => {}),
      onMessageEnd: mock(() => {}),
      onAgentEnd: mock(() => {}),
    };

    await expect(runner.prompt("hi", callbacks)).rejects.toBeInstanceOf(MalformedPiHistoryError);
  });
});
