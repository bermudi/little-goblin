import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { PiServices } from "../../pi-host.ts";
import {
  PiSubagentHost,
  SubagentExecutionQuiescenceError,
  SubagentExecutionStoppedError,
  type PiSubagentHostDeps,
  type SubagentInvocation,
  type SubagentPreparation,
} from "../host.ts";
import { namedAgentSkillsDir } from "../paths.ts";
import {
  createTestHome,
  flush,
  getCapturedCreateArgs,
  getSessionHolder,
  makeConfig,
  resetPiMockState,
  sessionHolder,
  setLoadedSkillPathsOverride,
} from "./support.ts";
import { workspacePath } from "../../workspace/paths.ts";

function genericPreparation(home: string, sessionDir = join(home, "instance")): SubagentPreparation {
  return {
    cwd: workspacePath(home),
    history: { kind: "create", sessionDir },
    resource: { kind: "generic", skillPaths: [] },
  };
}

function invocation(overrides: Partial<SubagentInvocation> = {}): SubagentInvocation {
  return {
    prompt: "hello",
    customTools: [],
    ...overrides,
  };
}

describe("PiSubagentHost contract", () => {
  let home: string;

  beforeEach(() => {
    home = createTestHome("goblin-pi-subagent-host-");
    resetPiMockState();
  });

  afterEach(() => {
    setLoadedSkillPathsOverride(null);
    rmSync(home, { recursive: true, force: true });
  });

  it("defers AgentSession activation until run and uses the exact history target", async () => {
    const host = new PiSubagentHost(makeConfig(home));
    const execution = host.prepare(genericPreparation(home));

    expect(getCapturedCreateArgs()).toHaveLength(0);
    const result = execution.run(invocation());
    await flush();

    const options = getCapturedCreateArgs()[0] as Record<string, unknown>;
    expect(options.cwd).toBe(workspacePath(home));
    expect(options.sessionManager).toBeDefined();
    expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith("hello");

    sessionHolder.complete();
    await expect(result).resolves.toBe("");
    expect(sessionHolder.listeners).toHaveLength(0);
    expect(sessionHolder.dispose).toHaveBeenCalledTimes(1);
  });

  it("uses exact SessionManager create/open targets without rediscovery", async () => {
    const calls: Array<{ kind: string; args: string[] }> = [];
    const sessionManager = {
      create: (cwd: string, dir: string) => {
        calls.push({ kind: "create", args: [cwd, dir] });
        return {};
      },
      open: (file: string, dir: string, cwd: string) => {
        calls.push({ kind: "open", args: [file, dir, cwd] });
        return {};
      },
    } as unknown as PiSubagentHostDeps["SessionManager"];
    const host = new PiSubagentHost(makeConfig(home), { deps: { SessionManager: sessionManager } });
    const createDir = join(home, "create");
    const openDir = join(home, "open");
    const openFile = join(openDir, "exact.jsonl");
    const first = host.prepare(genericPreparation(home, createDir));
    const second = host.prepare({
      ...genericPreparation(home, openDir),
      history: { kind: "open", sessionDir: openDir, sessionFile: openFile },
    });
    expect(calls).toEqual([
      { kind: "create", args: [workspacePath(home), createDir] },
      { kind: "open", args: [openFile, openDir, workspacePath(home)] },
    ]);

    const firstRun = first.run(invocation({ prompt: "first" }));
    const secondRun = second.run(invocation({ prompt: "second" }));
    await flush();
    getSessionHolder(0).complete();
    getSessionHolder(1).complete();
    await firstRun;
    await secondRun;
  });

  it("keeps concurrent leases on independent Pi sessions", async () => {
    const host = new PiSubagentHost(makeConfig(home));
    const first = host.prepare(genericPreparation(home, join(home, "first"))).run(invocation({ prompt: "first" }));
    const second = host.prepare(genericPreparation(home, join(home, "second"))).run(invocation({ prompt: "second" }));
    await flush();

    const firstSession = getSessionHolder(0);
    const secondSession = getSessionHolder(1);
    firstSession.complete([{ role: "assistant", stopReason: "stop" }]);
    await expect(first).resolves.toBe("");
    expect(secondSession.listeners).toHaveLength(1);
    expect(secondSession.abort).not.toHaveBeenCalled();
    expect(secondSession.dispose).not.toHaveBeenCalled();

    secondSession.complete([{ role: "assistant", stopReason: "stop" }]);
    await expect(second).resolves.toBe("");
  });

  it("memoizes concurrent first PiServices initialization", async () => {
    let serviceCreates = 0;
    const authCalls: Array<[string, string]> = [];
    const services = {
      modelRuntime: {
        setRuntimeApiKey: async (provider: string, key: string) => {
          authCalls.push([provider, key]);
        },
      },
      settingsManager: {},
    } as unknown as PiServices;
    const host = new PiSubagentHost(makeConfig(home), {
      deps: {
        createPiServices: async () => {
          serviceCreates += 1;
          await Promise.resolve();
          return services;
        },
      },
    });

    const first = host.prepare(genericPreparation(home, join(home, "first"))).run(invocation({ prompt: "one" }));
    const second = host.prepare(genericPreparation(home, join(home, "second"))).run(invocation({ prompt: "two" }));
    await flush();
    expect(serviceCreates).toBe(1);
    expect(authCalls[0]).toEqual(["openai", "test-key"]);
    expect(authCalls).toHaveLength(2);

    getSessionHolder(0).complete();
    getSessionHolder(1).complete();
    await expect(first).resolves.toBe("");
    await expect(second).resolves.toBe("");
  });

  it("retries PiServices initialization after a transient failure", async () => {
    let serviceCreates = 0;
    const services = {
      modelRuntime: {
        setRuntimeApiKey: async (_provider: string, _key: string) => {},
      },
      settingsManager: {},
    } as unknown as PiServices;
    const host = new PiSubagentHost(makeConfig(home), {
      deps: {
        createPiServices: async () => {
          serviceCreates += 1;
          if (serviceCreates === 1) throw new Error("transient services failure");
          return services;
        },
      },
    });

    const first = host.prepare(genericPreparation(home, join(home, "first"))).run(invocation({ prompt: "first" }));
    await expect(first).rejects.toThrow("transient services failure");

    const second = host.prepare(genericPreparation(home, join(home, "second"))).run(invocation({ prompt: "second" }));
    await flush();
    expect(serviceCreates).toBe(2);

    getSessionHolder(0).complete();
    await expect(second).resolves.toBe("");
  });

  it("uses the injected resource-loader constructor", async () => {
    let constructions = 0;
    class SentinelLoader {
      constructor(_options: Record<string, unknown>) {
        constructions += 1;
      }

      async reload(): Promise<void> {}

      getSkills(): { skills: Array<{ filePath: string }> } {
        return { skills: [] };
      }
    }
    const host = new PiSubagentHost(makeConfig(home), {
      deps: {
        DefaultResourceLoader: SentinelLoader as unknown as PiSubagentHostDeps["DefaultResourceLoader"],
      },
    });
    const result = host.prepare(genericPreparation(home)).run(invocation());
    await flush();

    expect(constructions).toBe(1);
    sessionHolder.complete();
    await expect(result).resolves.toBe("");
  });

  it("keeps prelude-before-prompt ordering and accumulates text/status", async () => {
    const order: string[] = [];
    sessionHolder.sendCustomMessage = mock(async () => {
      order.push("prelude");
    });
    sessionHolder.sendUserMessage = mock(async () => {
      order.push("prompt");
    });
    const statuses: string[] = [];
    const result = new PiSubagentHost(makeConfig(home))
      .prepare(genericPreparation(home))
      .run(invocation({
        systemPrompt: "frozen prompt",
        relevantMemoryPrelude: {
          customType: "goblin.memory.relevant",
          content: "## relevant memory\nentry",
          display: false,
        },
        onStatusUpdate: (message) => statuses.push(message),
      }));
    await flush();

    const options = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const loader = options.resourceLoader as { options: Record<string, unknown> };
    expect(loader.options.systemPrompt).toBe("frozen prompt");
    expect(order).toEqual(["prelude", "prompt"]);

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "answer" },
    });
    sessionHolder.emit({ type: "tool_execution_start", toolName: "read", args: {} });
    sessionHolder.emit({ type: "tool_execution_end", toolName: "read", isError: false });
    sessionHolder.complete();

    await expect(result).resolves.toBe("answer");
    expect(statuses).toEqual(["thinking...", "tool: read", "tool ok: read"]);
  });

  it("enforces named Pi isolation without owning named identity", async () => {
    const skillsDir = namedAgentSkillsDir(home, "researcher");
    mkdirSync(skillsDir, { recursive: true });
    const result = new PiSubagentHost(makeConfig(home))
      .prepare({
        cwd: join(home, "workspace", "agents", "researcher"),
        history: { kind: "open", sessionDir: join(home, "instance"), sessionFile: join(home, "instance", "history.jsonl") },
        resource: { kind: "named", skillsDir },
      })
      .run(invocation({ systemPrompt: "# Researcher" }));
    await flush();

    const options = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const loader = options.resourceLoader as { options: Record<string, unknown> };
    expect(loader.options.noContextFiles).toBe(true);
    expect(loader.options.noSkills).toBe(true);
    expect(loader.options.additionalSkillPaths).toEqual([skillsDir]);
    expect(loader.options.systemPrompt).toBe("# Researcher");

    sessionHolder.complete();
    await result;
  });

  it("materializes malformed skill names under an index-only directory", async () => {
    // Snapshot validation crosses async filesystem I/O. The prompt call is the
    // deterministic boundary where create args exist and the session is subscribed.
    let markPromptSent!: () => void;
    const promptSent = new Promise<void>((resolve) => {
      markPromptSent = resolve;
    });
    sessionHolder.sendUserMessage = mock(async () => {
      markPromptSent();
    });

    const result = new PiSubagentHost(makeConfig(home))
      .prepare({
        ...genericPreparation(home),
        resource: {
          kind: "generic",
          skillPaths: [],
          skillSnapshots: [{
            name: "UPPER BAD",
            snapshot: {
              entryPath: "SKILL.md",
              files: [{
                relativePath: "SKILL.md",
                base64: Buffer.from("---\nname: UPPER BAD\n---\nbody\n").toString("base64"),
              }],
            },
          }],
        },
      })
      .run(invocation());
    await Promise.race([
      promptSent,
      result.then(
        () => { throw new Error("subagent execution settled before sending its prompt"); },
        (error: unknown) => { throw error; },
      ),
    ]);

    const options = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const loader = options.resourceLoader as { options: { additionalSkillPaths: string[] } };
    const pathParts = loader.options.additionalSkillPaths[0]!.split(sep);
    expect(pathParts.slice(-2)).toEqual(["0", "SKILL.md"]);
    expect(loader.options.additionalSkillPaths[0]).not.toContain("UPPER BAD");
    expect(readFileSync(loader.options.additionalSkillPaths[0]!, "utf8")).toContain("UPPER BAD");

    sessionHolder.complete();
    await result;
  });

  it("fails visibly when a selected generic skill disappears or is not loaded", async () => {
    const missing = join(home, "missing", "SKILL.md");
    const result = new PiSubagentHost(makeConfig(home))
      .prepare({
        ...genericPreparation(home),
        resource: { kind: "generic", skillPaths: [missing] },
      })
      .run(invocation());
    await expect(result).rejects.toThrow(/inherited skill file\(s\) missing/);

    const skill = join(home, "skill", "SKILL.md");
    mkdirSync(join(home, "skill"), { recursive: true });
    writeFileSync(skill, "---\nname: test\n---\nbody");
    setLoadedSkillPathsOverride([]);
    const omitted = new PiSubagentHost(makeConfig(home))
      .prepare({
        ...genericPreparation(home),
        resource: { kind: "generic", skillPaths: [skill] },
      })
      .run(invocation());
    await expect(omitted).rejects.toThrow(/failed to load/);
  });

  it("does not terminalize a retrying agent_end before agent_settled", async () => {
    const result = new PiSubagentHost(makeConfig(home))
      .prepare(genericPreparation(home))
      .run(invocation());
    await flush();

    sessionHolder.emit({
      type: "agent_end",
      willRetry: true,
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "retrying" }],
    });
    await flush();
    sessionHolder.emit({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "final" } });
    let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);

    sessionHolder.complete([{ role: "assistant", stopReason: "stop" }]);
    await expect(result).resolves.toBe("final");
  });

  it("discards retry-attempt text and error state before a successful settled attempt", async () => {
    const result = new PiSubagentHost(makeConfig(home))
      .prepare(genericPreparation(home))
      .run(invocation());
    await flush();

    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "retry text" },
    });
    sessionHolder.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "retry text" }],
        stopReason: "error",
        errorMessage: "temporary provider failure",
      },
    });
    sessionHolder.complete([
      { role: "assistant", content: [{ type: "text", text: "retry text" }], stopReason: "error", errorMessage: "temporary provider failure" },
    ], true);

    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "success" },
    });
    sessionHolder.complete([
      { role: "assistant", content: [{ type: "text", text: "success" }], stopReason: "stop" },
    ]);

    await expect(result).resolves.toBe("success");
  });

  it("uses full assistant message_end content when deltas are missing", async () => {
    const result = new PiSubagentHost(makeConfig(home))
      .prepare(genericPreparation(home))
      .run(invocation());
    await flush();

    sessionHolder.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "complete without deltas" }],
        stopReason: "stop",
      },
    });
    sessionHolder.complete([
      { role: "assistant", content: [{ type: "text", text: "complete without deltas" }], stopReason: "stop" },
    ]);

    await expect(result).resolves.toBe("complete without deltas");
  });

  it("retains multiple assistant messages across tool turns without duplication", async () => {
    const result = new PiSubagentHost(makeConfig(home))
      .prepare(genericPreparation(home))
      .run(invocation());
    await flush();

    sessionHolder.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "before tool" }],
        stopReason: "toolUse",
      },
    });
    sessionHolder.emit({ type: "tool_execution_start", toolName: "read", args: {} });
    sessionHolder.emit({ type: "tool_execution_end", toolName: "read", isError: false });
    sessionHolder.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "after tool" }],
        stopReason: "stop",
      },
    });
    sessionHolder.complete([
      { role: "assistant", content: [{ type: "text", text: "before tool" }], stopReason: "toolUse" },
      { role: "assistant", content: [{ type: "text", text: "after tool" }], stopReason: "stop" },
    ]);

    await expect(result).resolves.toBe("before toolafter tool");
  });

  it("rejects final assistant errors without including the synthetic notice", async () => {
    const result = new PiSubagentHost(makeConfig(home))
      .prepare(genericPreparation(home))
      .run(invocation());
    await flush();

    sessionHolder.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "final provider failure",
      },
    });
    sessionHolder.complete([
      { role: "assistant", content: [], stopReason: "error", errorMessage: "final provider failure" },
    ]);

    await expect(result).rejects.toThrow("final provider failure");
  });

  it("claims settled success exactly once", async () => {
    let claims = 0;
    const result = new PiSubagentHost(makeConfig(home))
      .prepare(genericPreparation(home))
      .run(invocation({ onCompletionClaimed: () => { claims += 1; } }));
    await flush();

    sessionHolder.complete([{ role: "assistant", stopReason: "stop" }]);
    sessionHolder.emit({ type: "agent_settled" });
    await expect(result).resolves.toBe("");
    expect(claims).toBe(1);
  });

  it("rejects a settled assistant error", async () => {
    const result = new PiSubagentHost(makeConfig(home))
      .prepare(genericPreparation(home))
      .run(invocation());
    await flush();

    sessionHolder.emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
    });
    sessionHolder.complete([{ role: "assistant", stopReason: "error", errorMessage: "provider failed" }]);
    await expect(result).rejects.toThrow("provider failed");
  });

  it("rejects a settled assistant abort", async () => {
    const result = new PiSubagentHost(makeConfig(home))
      .prepare(genericPreparation(home))
      .run(invocation());
    await flush();

    sessionHolder.complete([{ role: "assistant", stopReason: "aborted", errorMessage: "aborted" }]);
    await expect(result).rejects.toThrow("aborted");
  });

  it("does not send the prompt if Pi terminates during the prelude", async () => {
    sessionHolder.sendCustomMessage = mock(async () => {
      sessionHolder.complete();
    });
    const execution = new PiSubagentHost(makeConfig(home)).prepare(genericPreparation(home));
    const result = execution.run(invocation({
      relevantMemoryPrelude: {
        customType: "goblin.memory.relevant",
        content: "prelude",
        display: false,
      },
    }));
    await flush();

    await expect(result).resolves.toBe("");
    expect(sessionHolder.sendUserMessage).not.toHaveBeenCalled();
  });

  it("stops before run without creating a session or sending messages", async () => {
    const host = new PiSubagentHost(makeConfig(home));
    const execution = host.prepare(genericPreparation(home));
    await execution.stop();

    await expect(execution.run(invocation())).rejects.toBeInstanceOf(SubagentExecutionStoppedError);
    expect(getCapturedCreateArgs()).toHaveLength(0);
    expect(sessionHolder.sendCustomMessage).not.toHaveBeenCalled();
    expect(sessionHolder.sendUserMessage).not.toHaveBeenCalled();
  });

  it("bounds a hung session creation and cleans a late session without sending a prompt", async () => {
    let releaseCreate!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const host = new PiSubagentHost(makeConfig(home), {
      quiescenceTimeoutMs: 10,
      abortTimeoutMs: 10,
      deps: {
        createAgentSession: (async () => {
          await blocked;
          return { session: sessionHolder.proxy, extensionsResult: {} };
        }) as unknown as PiSubagentHostDeps["createAgentSession"],
      },
    });
    const execution = host.prepare(genericPreparation(home));
    const run = execution.run(invocation());
    run.catch(() => {});
    await flush();

    await expect(execution.stop()).rejects.toBeInstanceOf(SubagentExecutionQuiescenceError);
    expect(sessionHolder.sendUserMessage).not.toHaveBeenCalled();

    releaseCreate();
    await flush();
    await flush();
    await expect(run).rejects.toBeInstanceOf(SubagentExecutionStoppedError);
    expect(sessionHolder.sendUserMessage).not.toHaveBeenCalled();
    expect(sessionHolder.dispose).toHaveBeenCalledTimes(1);
    expect(sessionHolder.listeners).toHaveLength(0);
  });

  it("bounds a hung prompt, fences late events, and does not double-dispose", async () => {
    let releasePrompt!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    sessionHolder.sendUserMessage = mock(async () => {
      await blocked;
    });
    const statuses: string[] = [];
    const execution = new PiSubagentHost(makeConfig(home), {
      quiescenceTimeoutMs: 10,
      abortTimeoutMs: 10,
    }).prepare(genericPreparation(home));
    const run = execution.run(invocation({ onStatusUpdate: (message) => statuses.push(message) }));
    run.catch(() => {});
    await flush();

    await expect(execution.stop()).rejects.toThrow(/activation quiescence timed out/);
    expect(sessionHolder.abort).toHaveBeenCalledTimes(1);
    expect(sessionHolder.dispose).toHaveBeenCalledTimes(1);

    sessionHolder.emit({ type: "agent_start" });
    expect(statuses).toEqual([]);
    releasePrompt();
    await expect(run).rejects.toBeInstanceOf(SubagentExecutionStoppedError);
    expect(sessionHolder.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sessionHolder.dispose).toHaveBeenCalledTimes(1);
  });

  it("waits for session setup before reporting a quiescent stop", async () => {
    let releaseCreate!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const deps = {
      createAgentSession: (async () => {
        await blocked;
        return { session: sessionHolder.proxy, extensionsResult: {} };
      }) as unknown as PiSubagentHostDeps["createAgentSession"],
    };
    const host = new PiSubagentHost(makeConfig(home), { deps });
    const execution = host.prepare(genericPreparation(home));
    const run = execution.run(invocation());
    run.catch(() => {});
    await flush();

    let stopped = false;
    const stopping = execution.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(sessionHolder.sendUserMessage).not.toHaveBeenCalled();
    releaseCreate();
    await stopping;
    await expect(run).rejects.toBeInstanceOf(SubagentExecutionStoppedError);
  });

  it("waits for a blocked prompt send before reporting stop", async () => {
    let releasePrompt!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    sessionHolder.sendUserMessage = mock(async () => {
      await blocked;
    });
    const execution = new PiSubagentHost(makeConfig(home)).prepare(genericPreparation(home));
    const run = execution.run(invocation());
    run.catch(() => {});
    await flush();

    const stopping = execution.stop();
    await flush();
    expect(sessionHolder.abort).toHaveBeenCalledTimes(1);
    expect(sessionHolder.dispose).toHaveBeenCalledTimes(1);
    releasePrompt();
    await stopping;
    await expect(run).rejects.toBeInstanceOf(SubagentExecutionStoppedError);
    expect(sessionHolder.dispose).toHaveBeenCalledTimes(1);
    expect(sessionHolder.listeners).toHaveLength(0);
  });

  it("stops between prelude and prompt and ignores late events", async () => {
    let releasePrelude!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePrelude = resolve;
    });
    sessionHolder.sendCustomMessage = mock(async () => {
      await blocked;
    });
    const statuses: string[] = [];
    const execution = new PiSubagentHost(makeConfig(home)).prepare(genericPreparation(home));
    const run = execution.run(invocation({
      relevantMemoryPrelude: {
        customType: "goblin.memory.relevant",
        content: "prelude",
        display: false,
      },
      onStatusUpdate: (message) => statuses.push(message),
    }));
    run.catch(() => {});
    await flush();

    const stopping = execution.stop();
    releasePrelude();
    await stopping;
    await execution.stop();
    await expect(run).rejects.toBeInstanceOf(SubagentExecutionStoppedError);
    expect(sessionHolder.sendUserMessage).not.toHaveBeenCalled();

    sessionHolder.emit({ type: "agent_start" });
    expect(statuses).toEqual([]);
    expect(sessionHolder.abort).toHaveBeenCalledTimes(1);
    expect(sessionHolder.dispose).toHaveBeenCalledTimes(1);
  });
});
