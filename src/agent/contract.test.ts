import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
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
    skillSources: "goblin-only",
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
