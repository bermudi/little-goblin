import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SubagentRunner, type SubagentToolFactory } from "../mod.ts";
import { skillsPath, workdirPath } from "../../workspace/paths.ts";
import {
  MAX_SUBAGENT_DEPTH,
  type SubagentMeta,
} from "../types.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  namedAgentAgentsMdPath,
  namedAgentDir,
  namedAgentInstanceDir,
  namedAgentInstanceMetaPath,
  namedAgentSkillsDir,
  subagentsRoot,
} from "../paths.ts";
import {
  createTestHome,
  DEFAULT_SCOPE,
  flush,
  getCapturedCreateArgs,
  installStandardPiMock,
  makeConfig,
  resetPiMockState,
  sessionHolder,
} from "./support.ts";

// Install mock before any tests run
installStandardPiMock();

describe("SubagentRunner — skeleton", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("instantiates without I/O", () => {
    expect(runner).toBeInstanceOf(SubagentRunner);
    expect(existsSync(subagentsRoot(tmp))).toBe(false);
  });

  it("starts with no active subagents", () => {
    expect(runner.list()).toEqual([]);
  });

  it("exposes a depth cap of 3", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3);
  });

  it("revive() throws 'Subagent not found' for unknown id", async () => {
    await expect(runner.revive("missing", "ping")).rejects.toThrow("Subagent not found");
  });

  it("cancel() throws 'Subagent not found' for unknown id", async () => {
    await expect(runner.cancel("missing")).rejects.toThrow("Subagent not found");
  });
});

describe("SubagentRunner.spawn — generic", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the subagent directory and meta.json", async () => {
    const handle = await runner.spawn({ prompt: "Analyze logs", activeScope: DEFAULT_SCOPE });
    handle.result.catch(() => {});

    expect(handle.status).toBe("running");
    expect(handle.id).toMatch(/^[0-9a-f-]{36}$/);

    const dir = genericSubagentDir(tmp, handle.id);
    expect(existsSync(dir)).toBe(true);

    const metaPath = genericSubagentMetaPath(tmp, handle.id);
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SubagentMeta;
    expect(meta).toMatchObject({
      id: handle.id,
      role: "generic",
      name: null,
      spawnedBy: null,
      depth: 1,
      status: "running",
    });
    expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("records spawnedBy when provided", async () => {
    const handle = await runner.spawn({
      prompt: "hi",
      activeScope: DEFAULT_SCOPE,
      spawnedBy: "goblin-session-42",
    });
    handle.result.catch(() => {});

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.spawnedBy).toBe("goblin-session-42");
  });

  it("tracks the spawned subagent in list()", async () => {
    const handle = await runner.spawn({ prompt: "ping", activeScope: DEFAULT_SCOPE });
    handle.result.catch(() => {});

    const list = runner.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: handle.id,
      role: "generic",
      status: "running",
      name: null,
    });
  });

  it("provisions a persisted SessionManager pointing at the subagent dir", async () => {
    const handle = await runner.spawn({ prompt: "ping", activeScope: DEFAULT_SCOPE });
    handle.result.catch(() => {});

    expect(runner.list()[0]?.id).toBe(handle.id);
    expect(existsSync(genericSubagentDir(tmp, handle.id))).toBe(true);
  });

  it("rejects spawning beyond depth 3", async () => {
    await expect(runner.spawn({ prompt: "deep", depth: 3, activeScope: DEFAULT_SCOPE })).rejects.toThrow(
      /Maximum subagent depth reached \(3\)/,
    );
  });

  it("permits spawning at the boundary (depth 2 spawner → depth 3 child)", async () => {
    const handle = await runner.spawn({ prompt: "boundary", depth: 2, activeScope: DEFAULT_SCOPE });
    handle.result.catch(() => {});

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.depth).toBe(3);
  });
});

describe("SubagentRunner.spawn — named", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws 'Named agent <name> not found' when AGENTS.md is missing", async () => {
    await expect(runner.spawn({ prompt: "hi", activeScope: DEFAULT_SCOPE, name: "nonexistent" })).rejects.toThrow(
      "Named agent 'nonexistent' not found",
    );
  });

  it("loads AGENTS.md and creates an instance directory + meta.json", async () => {
    const agentDir = namedAgentDir(tmp, "researcher");
    mkdirSync(agentDir, { recursive: true });
    const agentsMd = "# Researcher\n\nYou are a focused research subagent.\n";
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), agentsMd);

    const handle = await runner.spawn({
      prompt: "Investigate the docs",
      name: "researcher",
      activeScope: DEFAULT_SCOPE,
    });
    handle.result.catch(() => {});

    expect(handle.status).toBe("running");
    expect(handle.id).toMatch(/^[0-9a-f-]{36}$/);

    const instDir = namedAgentInstanceDir(tmp, "researcher", handle.id);
    expect(existsSync(instDir)).toBe(true);

    const metaPath = namedAgentInstanceMetaPath(tmp, "researcher", handle.id);
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as SubagentMeta;
    expect(meta).toMatchObject({
      id: handle.id,
      role: "named",
      name: "researcher",
      depth: 1,
      status: "running",
    });
  });

  it("does not place named-agent instances under the generic subagents dir", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# x");

    const handle = await runner.spawn({
      prompt: "ping",
      name: "researcher",
      activeScope: DEFAULT_SCOPE,
    });
    handle.result.catch(() => {});

    expect(existsSync(genericSubagentDir(tmp, handle.id))).toBe(false);
    expect(existsSync(namedAgentInstanceDir(tmp, "researcher", handle.id))).toBe(true);
  });

  it("records the named agent in list() with its name and role", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# x");

    const handle = await runner.spawn({
      prompt: "ping",
      name: "researcher",
      activeScope: DEFAULT_SCOPE,
    });
    handle.result.catch(() => {});

    const list = runner.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: handle.id,
      name: "researcher",
      role: "named",
      status: "running",
    });
  });

  it("records strict skill isolation on the in-memory instance", async () => {
    const agentsMd = "# Researcher\n";
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), agentsMd);

    const handle = await runner.spawn({
      prompt: "ping",
      name: "researcher",
      activeScope: DEFAULT_SCOPE,
    });
    handle.result.catch(() => {});

    const instances = (
      runner as unknown as {
        activeSubagents: Map<string, { definition: { agentsMd: string; skillsDir: string } | null }>;
      }
    ).activeSubagents;
    const instance = instances.get(handle.id);
    expect(instance?.definition).not.toBeNull();
    expect(instance?.definition?.agentsMd).toBe(agentsMd);
    expect(instance?.definition?.skillsDir).toBe(namedAgentSkillsDir(tmp, "researcher"));
    expect(instance?.definition?.skillsDir).not.toContain(`${tmp}/skills`);
  });

  it("rejects named spawn beyond depth 3", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# x");

    await expect(
      runner.spawn({ prompt: "deep", name: "researcher", depth: 3, activeScope: DEFAULT_SCOPE }),
    ).rejects.toThrow(/Maximum subagent depth reached \(3\)/);
  });
});

describe("SubagentRunner.spawn — execution & result return", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates an AgentSession with the subagent-only tool list and the subagent's SessionManager", async () => {
    const handle = await runner.spawn({ prompt: "Analyze logs", activeScope: DEFAULT_SCOPE });
    handle.result.catch(() => {});
    await flush();

    const captured = getCapturedCreateArgs();
    expect(captured).toHaveLength(1);
    const opts = captured[0] as Record<string, unknown>;
    expect(opts.cwd).toBe(workdirPath(tmp));
    expect(Array.isArray(opts.customTools)).toBe(true);
    const names = (opts.customTools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).not.toContain("schedule_turn");
    expect(names).toEqual([
      "memory_read",
      "memory_read_index",
      "memory_search",
      "memory_write",
    ]);
    expect(opts.sessionManager).toBeDefined();

    const loader = opts.resourceLoader as { options: Record<string, unknown> } | undefined;
    expect(loader).toBeDefined();
    expect((loader!.options.additionalSkillPaths as string[])[0]).toBe(skillsPath(tmp));
  });

  it("for named subagents, builds a DefaultResourceLoader pinned to the agent's skills dir", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    const agentsMd = "# Researcher\nYou are a research specialist.\n";
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), agentsMd);

    const handle = await runner.spawn({ prompt: "go", name: "researcher", activeScope: DEFAULT_SCOPE });
    handle.result.catch(() => {});
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    expect(opts.cwd).toBe(namedAgentDir(tmp, "researcher"));
    const loader = opts.resourceLoader as { options: Record<string, unknown> };
    expect(loader).toBeDefined();
    expect(loader.options.systemPrompt).toBe(agentsMd);
    expect(loader.options.noContextFiles).toBe(true);
    expect(loader.options.noSkills).toBe(true);
    expect(loader.options.additionalSkillPaths).toEqual([namedAgentSkillsDir(tmp, "researcher")]);
  });

  it("sends the initial prompt as the first user message", async () => {
    const handle = await runner.spawn({ prompt: "Hello there", activeScope: DEFAULT_SCOPE });
    handle.result.catch(() => {});
    await flush();

    expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith("Hello there");
  });

  it("resolves handle.result with the accumulated assistant text on agent_end", async () => {
    const handle = await runner.spawn({ prompt: "Greet me", activeScope: DEFAULT_SCOPE });
    await flush();

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Hello, " },
    });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "world!" },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });

    await expect(handle.result).resolves.toBe("Hello, world!");
  });

  it("propagates status updates via onStatusUpdate (agent_start + tool events)", async () => {
    const events: string[] = [];
    const handle = await runner.spawn({
      prompt: "do work",
      activeScope: DEFAULT_SCOPE,
      onStatusUpdate: (message) => events.push(message),
    });
    handle.result.catch(() => {});
    await flush();

    const prefix = `🧠 ${handle.id.slice(0, 8)} `;

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_start" },
    });
    sessionHolder.emit({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    });
    sessionHolder.emit({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: {},
      isError: false,
    });

    expect(events).toEqual([
      `${prefix}thinking...`,
      `${prefix}thinking...`,
      `${prefix}tool: bash`,
      `${prefix}tool ok: bash`,
    ]);
  });

  it("updates meta.json with status=completed and completedAt on agent_end", async () => {
    const handle = await runner.spawn({ prompt: "ping", activeScope: DEFAULT_SCOPE });
    await flush();

    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "pong" },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });

    await handle.result;

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("completed");
    expect(meta.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(runner.list()[0]?.status).toBe("completed");
  });

  it("rejects handle.result and writes status=error when sendUserMessage throws", async () => {
    sessionHolder.sendUserMessage = mock(async () => {
      throw new Error("boom");
    });

    const handle = await runner.spawn({ prompt: "trigger", activeScope: DEFAULT_SCOPE });
    await flush();
    await flush();

    await expect(handle.result).rejects.toThrow("boom");

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("error");
    expect(meta.errorMessage).toBe("boom");
    expect(meta.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("SubagentRunner — status prefix propagation", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-status-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prefixes generic subagent status with 🧠 and truncated id", async () => {
    const events: string[] = [];
    const handle = await runner.spawn({
      prompt: "work",
      activeScope: DEFAULT_SCOPE,
      onStatusUpdate: (message) => events.push(message),
    });
    handle.result.catch(() => {});
    await flush();

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    });

    expect(events).toEqual([
      `🧠 ${handle.id.slice(0, 8)} thinking...`,
      `🧠 ${handle.id.slice(0, 8)} thinking...`,
    ]);
  });

  it("prefixes named subagent status with 🧠 and agent name", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# R");

    const events: string[] = [];
    const handle = await runner.spawn({
      prompt: "work",
      name: "researcher",
      activeScope: DEFAULT_SCOPE,
      onStatusUpdate: (message) => events.push(message),
    });
    handle.result.catch(() => {});
    await flush();

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_start" },
    });
    sessionHolder.emit({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: {},
    });

    expect(events).toEqual([
      "🧠 researcher thinking...",
      "🧠 researcher thinking...",
      "🧠 researcher tool: read",
    ]);
  });

  it("does not call back when onStatusUpdate is not provided", async () => {
    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();

    expect(() => {
      sessionHolder.emit({ type: "agent_start" });
      sessionHolder.emit({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: {},
      });
    }).not.toThrow();

    handle.result.catch(() => {});
  });

  it("propagates tool error status with prefix", async () => {
    const events: string[] = [];
    const handle = await runner.spawn({
      prompt: "work",
      activeScope: DEFAULT_SCOPE,
      onStatusUpdate: (message) => events.push(message),
    });
    handle.result.catch(() => {});
    await flush();

    sessionHolder.emit({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: {},
      isError: true,
    });

    expect(events).toEqual([`🧠 ${handle.id.slice(0, 8)} tool error: bash`]);
  });
});

describe("SubagentRunner — name validation", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-name-validation-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects path traversal in name", async () => {
    await expect(runner.spawn({ prompt: "x", activeScope: DEFAULT_SCOPE, name: "../etc" })).rejects.toThrow(/Invalid agent name/);
  });

  it("rejects empty string name", async () => {
    await expect(runner.spawn({ prompt: "x", activeScope: DEFAULT_SCOPE, name: "" })).rejects.toThrow(/Invalid agent name/);
  });

  it("rejects names with slashes", async () => {
    await expect(runner.spawn({ prompt: "x", activeScope: DEFAULT_SCOPE, name: "foo/bar" })).rejects.toThrow(/Invalid agent name/);
  });

  it("rejects names with dots", async () => {
    await expect(runner.spawn({ prompt: "x", activeScope: DEFAULT_SCOPE, name: "foo.bar" })).rejects.toThrow(/Invalid agent name/);
  });

  it("accepts valid names: alphanumeric, hyphens, underscores", async () => {
    mkdirSync(namedAgentDir(tmp, "my-agent_v2"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "my-agent_v2"), "# Agent");

    const handle = await runner.spawn({ prompt: "go", name: "my-agent_v2", activeScope: DEFAULT_SCOPE });
    expect(handle.status).toBe("running");
    handle.result.catch(() => {});

    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });
});

describe("SubagentRunner — negative depth rejection", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-depth-neg-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects negative depth", async () => {
    await expect(runner.spawn({ prompt: "x", activeScope: DEFAULT_SCOPE, depth: -1 })).rejects.toThrow(/Invalid depth/);
  });
});

describe("SubagentRunner — recursive tool injection", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-recursion-");
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes subagent tools to spawned subagents via toolFactory", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    runner = new SubagentRunner(makeConfig(tmp), (subagentRunner, depth, sessionId, activeScope, onStatusUpdate) => [
      createSpawnSubagentTool(subagentRunner, depth, sessionId, activeScope, onStatusUpdate, undefined),
    ]);

    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const tools = opts.customTools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toContain("spawn_subagent");
    expect(tools.map((tool) => tool.name)).toContain("memory_write");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("always registers scoped memory tools even when no toolFactory is provided", async () => {
    runner = new SubagentRunner(makeConfig(tmp));

    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    expect((opts.customTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      "memory_read",
      "memory_read_index",
      "memory_search",
      "memory_write",
    ]);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });
});

describe("SubagentRunner — nested prefix prevention", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTestHome("goblin-nested-prefix-");
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("nested subagent receives rawStatusCallback without double-prefixing", async () => {
    const receivedCallbacks: string[] = [];

    const toolFactory: SubagentToolFactory = (
      _runner,
      _depth,
      _sessionId,
      _activeScope,
      onStatusUpdate,
    ) => {
      if (onStatusUpdate) {
        onStatusUpdate("test-message");
        receivedCallbacks.push("captured");
      }
      return [];
    };

    const parentRunner = new SubagentRunner(makeConfig(tmp), toolFactory);
    const handle = await parentRunner.spawn({
      prompt: "parent",
      activeScope: DEFAULT_SCOPE,
      onStatusUpdate: (message) => {
        receivedCallbacks.push(`parent-saw: ${message}`);
      },
    });
    await flush();

    expect(receivedCallbacks).toContain("captured");
    expect(receivedCallbacks).toContain("parent-saw: test-message");
    expect(receivedCallbacks).toHaveLength(2);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });
});
