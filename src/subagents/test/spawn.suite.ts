import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SubagentRunner, type GenericSubagentInheritance, type SubagentToolFactory } from "../mod.ts";
import type { ResolvedSkillSet } from "../../agent/skills/mod.ts";
import { personalEnvironment, projectEnvironment, type ExecutionEnvironment } from "../../sessions/environment.ts";
import { agentsMdPath, goblinSkillsPath, heartbeatMdPath, soulMdPath, workspacePath } from "../../workspace/paths.ts";
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
  DEFAULT_AUTHORITY,
  DEFAULT_PARENT_CAPTURE,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  getCapturedCreateArgs,
  installStandardPiMock,
  makeConfig,
  resetPiMockState,
  sessionHolder,
  setLoadedSkillPathsOverride,
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
    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, "missing", "ping")).rejects.toThrow("Subagent not found");
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
    const handle = await runner.spawn({ prompt: "Analyze logs", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
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
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "goblin-session-42",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    handle.result.catch(() => {});

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.spawnedBy).toBe("goblin-session-42");
  });

  it("tracks the spawned subagent in list()", async () => {
    const handle = await runner.spawn({ prompt: "ping", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
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
    const handle = await runner.spawn({ prompt: "ping", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    handle.result.catch(() => {});

    expect(runner.list()[0]?.id).toBe(handle.id);
    expect(existsSync(genericSubagentDir(tmp, handle.id))).toBe(true);
  });

  it("rejects spawning beyond depth 3", async () => {
    await expect(runner.spawn({ prompt: "deep", depth: 3, authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE })).rejects.toThrow(
      /Maximum subagent depth reached \(3\)/,
    );
  });

  it("permits spawning at the boundary (depth 2 spawner → depth 3 child)", async () => {
    const handle = await runner.spawn({ prompt: "boundary", depth: 2, authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
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
    await expect(runner.spawn({ prompt: "hi", authority: DEFAULT_AUTHORITY, name: "nonexistent" })).rejects.toThrow(
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
      authority: DEFAULT_AUTHORITY,
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
      authority: DEFAULT_AUTHORITY,
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
      authority: DEFAULT_AUTHORITY,
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
      authority: DEFAULT_AUTHORITY,
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
      runner.spawn({ prompt: "deep", name: "researcher", depth: 3, authority: DEFAULT_AUTHORITY }),
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
    const handle = await runner.spawn({ prompt: "Analyze logs", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    handle.result.catch(() => {});
    await flush();

    const captured = getCapturedCreateArgs();
    expect(captured).toHaveLength(1);
    const opts = captured[0] as Record<string, unknown>;
    expect(opts.cwd).toBe(workspacePath(tmp));
    expect(Array.isArray(opts.customTools)).toBe(true);
    const names = (opts.customTools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).not.toContain("schedule_turn");
    expect(names).toEqual([
      "memory_search",
      "memory_write",
    ]);
    expect(opts.sessionManager).toBeDefined();

    const loader = opts.resourceLoader as { options: Record<string, unknown> } | undefined;
    expect(loader).toBeDefined();
    expect(loader!.options.noSkills).toBe(true);
    expect(loader!.options.additionalSkillPaths).toEqual([]);
  });

  it("filters deployment prompt files out of generic subagent context discovery", async () => {
    const handle = await runner.spawn({ prompt: "go", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    handle.result.catch(() => {});
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const loader = opts.resourceLoader as {
      options: {
        agentsFilesOverride?: (base: { agentsFiles: { path: string; content: string }[] }) => { agentsFiles: { path: string; content: string }[] };
      };
    };
    expect(loader).toBeDefined();
    const override = loader.options.agentsFilesOverride;
    expect(override).toBeDefined();

    const input = [
      { path: soulMdPath(tmp), content: "soul" },
      { path: agentsMdPath(tmp), content: "agents" },
      { path: heartbeatMdPath(tmp), content: "heartbeat" },
      { path: join(tmp, "project", "AGENTS.md"), content: "project" },
    ];
    const result = override!({ agentsFiles: input });
    expect(result.agentsFiles.map((f) => f.path)).toEqual([join(tmp, "project", "AGENTS.md")]);
  });

  it("for named subagents, builds a DefaultResourceLoader pinned to the agent's skills dir", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    const agentsMd = "# Researcher\nYou are a research specialist.\n";
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), agentsMd);

    const handle = await runner.spawn({ prompt: "go", name: "researcher", authority: DEFAULT_AUTHORITY });
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
    const handle = await runner.spawn({ prompt: "Hello there", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    handle.result.catch(() => {});
    await flush();

    expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith("Hello there");
  });

  it("resolves handle.result with the accumulated assistant text on agent_end", async () => {
    const handle = await runner.spawn({ prompt: "Greet me", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
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
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
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
    const handle = await runner.spawn({ prompt: "ping", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
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

    const handle = await runner.spawn({ prompt: "trigger", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
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
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
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
      authority: DEFAULT_AUTHORITY,
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
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
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
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
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
    await expect(runner.spawn({ prompt: "x", authority: DEFAULT_AUTHORITY, name: "../etc" })).rejects.toThrow(/Invalid agent name/);
  });

  it("rejects empty string name", async () => {
    await expect(runner.spawn({ prompt: "x", authority: DEFAULT_AUTHORITY, name: "" })).rejects.toThrow(/Invalid agent name/);
  });

  it("rejects names with slashes", async () => {
    await expect(runner.spawn({ prompt: "x", authority: DEFAULT_AUTHORITY, name: "foo/bar" })).rejects.toThrow(/Invalid agent name/);
  });

  it("rejects names with dots", async () => {
    await expect(runner.spawn({ prompt: "x", authority: DEFAULT_AUTHORITY, name: "foo.bar" })).rejects.toThrow(/Invalid agent name/);
  });

  it("accepts valid names: alphanumeric, hyphens, underscores", async () => {
    mkdirSync(namedAgentDir(tmp, "my-agent_v2"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "my-agent_v2"), "# Agent");

    const handle = await runner.spawn({ prompt: "go", name: "my-agent_v2", authority: DEFAULT_AUTHORITY });
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
    await expect(runner.spawn({ prompt: "x", authority: DEFAULT_AUTHORITY, depth: -1, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE })).rejects.toThrow(/Invalid depth/);
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
    runner = new SubagentRunner(makeConfig(tmp), (subagentRunner, depth, sessionId, parentCapture, inheritedSkills, onStatusUpdate) => [
      createSpawnSubagentTool(subagentRunner, depth, sessionId, parentCapture, inheritedSkills, onStatusUpdate, undefined),
    ]);

    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
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

    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    expect((opts.customTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
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
      _parentCapture,
      _inheritedSkills,
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
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
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

describe("SubagentRunner — skill inheritance", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-skills-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    setLoadedSkillPathsOverride(null);
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSkill(catalogRoot: string, name: string): string {
    const dir = join(catalogRoot, name);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "SKILL.md");
    writeFileSync(filePath, `---\nname: ${name}\n---\n`);
    return filePath;
  }

  function manifestOf(...skills: ResolvedSkillSet["skills"]): ResolvedSkillSet {
    return { skills, diagnostics: [], fingerprint: "test" };
  }

  function inheritanceOf(
    resolvedSkills: ResolvedSkillSet,
    executionEnvironment: ExecutionEnvironment = personalEnvironment(),
  ): GenericSubagentInheritance {
    return { executionEnvironment, resolvedSkills };
  }

  it("pins exactly the inherited manifest files with ambient discovery disabled", async () => {
    const alpha = writeSkill(goblinSkillsPath(tmp), "alpha");
    const beta = writeSkill(join(tmp, "project", ".agents", "skills"), "beta");
    // An unselected skill in the same catalog must not leak in.
    writeSkill(goblinSkillsPath(tmp), "unselected");

    const handle = await runner.spawn({
      prompt: "work",
      authority: DEFAULT_AUTHORITY,
      inheritance: inheritanceOf(
        manifestOf(
          { source: "goblin", name: "alpha", filePath: alpha },
          { source: "environment", name: "beta", filePath: beta },
        ),
        projectEnvironment(join(tmp, "project")),
      ),
    });
    handle.result.catch(() => {});
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const loader = opts.resourceLoader as { options: Record<string, unknown> };
    expect(loader.options.noSkills).toBe(true);
    expect(loader.options.additionalSkillPaths).toEqual([alpha, beta]);
    expect(opts.cwd).toBe(join(tmp, "project"));

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("fails visibly when an inherited skill file is missing", async () => {
    const missing = join(goblinSkillsPath(tmp), "ghost", "SKILL.md");
    const handle = await runner.spawn({
      prompt: "work",
      authority: DEFAULT_AUTHORITY,
      inheritance: inheritanceOf(
        manifestOf({ source: "goblin", name: "ghost", filePath: missing }),
      ),
    });

    await expect(handle.result).rejects.toThrow(`inherited skill file(s) missing: ${missing}`);

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("error");
  });

  it("rejects an inherited path that is no longer a regular file", async () => {
    const alpha = writeSkill(goblinSkillsPath(tmp), "alpha");
    rmSync(alpha);
    mkdirSync(alpha);

    const handle = await runner.spawn({
      prompt: "work",
      authority: DEFAULT_AUTHORITY,
      inheritance: inheritanceOf(
        manifestOf({ source: "goblin", name: "alpha", filePath: alpha }),
      ),
    });

    await expect(handle.result).rejects.toThrow(
      `inherited skill path is not a file: ${alpha}`,
    );
  });

  it("fails visibly when pi omits an inherited skill during reload", async () => {
    const alpha = writeSkill(goblinSkillsPath(tmp), "alpha");
    setLoadedSkillPathsOverride([]);

    const handle = await runner.spawn({
      prompt: "work",
      authority: DEFAULT_AUTHORITY,
      inheritance: inheritanceOf(
        manifestOf({ source: "goblin", name: "alpha", filePath: alpha }),
      ),
    });

    await expect(handle.result).rejects.toThrow(
      `inherited skill file(s) failed to load: ${alpha}`,
    );
  });

  it("recursive generic spawns inherit the same frozen manifest", async () => {
    const alpha = writeSkill(goblinSkillsPath(tmp), "alpha");
    const inheritance = inheritanceOf(
      manifestOf({ source: "goblin", name: "alpha", filePath: alpha }),
    );

    const { createSpawnSubagentTool } = await import("../tool.ts");
    let factorySaw: GenericSubagentInheritance | null | undefined;
    const toolFactory: SubagentToolFactory = (subRunner, depth, sessionId, parentCapture, childInheritance, onStatusUpdate) => {
      factorySaw = childInheritance;
      return [createSpawnSubagentTool(subRunner, depth, sessionId, parentCapture, childInheritance, onStatusUpdate, undefined)];
    };
    runner = new SubagentRunner(makeConfig(tmp), toolFactory);

    const handle = await runner.spawn({
      prompt: "parent",
      authority: DEFAULT_AUTHORITY,
      inheritance,
    });
    await flush();
    expect(factorySaw).toBe(inheritance);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
    resetPiMockState();

    // Drive a nested generic spawn through a tool built with the manifest the
    // parent's toolFactory received: the child must get the same frozen
    // manifest, not a re-resolved catalog.
    const spawnTool = createSpawnSubagentTool(runner, 1, "parent-session", DEFAULT_PARENT_CAPTURE, factorySaw ?? null, undefined);
    const childExec = spawnTool.execute("tc-child", { prompt: "child" }, undefined, undefined, {} as never);
    childExec.catch(() => {});
    await flush();

    const childCreate = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const childLoader = childCreate.resourceLoader as { options: Record<string, unknown> };
    expect(childLoader.options.noSkills).toBe(true);
    expect(childLoader.options.additionalSkillPaths).toEqual([alpha]);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await childExec;
  });

  it("revive inherits the reviving runtime's manifest, not the original one", async () => {
    const alpha = writeSkill(goblinSkillsPath(tmp), "alpha");
    const beta = writeSkill(goblinSkillsPath(tmp), "beta");

    const handle = await runner.spawn({
      prompt: "first",
      authority: DEFAULT_AUTHORITY,
      inheritance: inheritanceOf(
        manifestOf({ source: "goblin", name: "alpha", filePath: alpha }),
      ),
    });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
    writeFileSync(join(genericSubagentDir(tmp, handle.id), "2026-01-01T00-00-00_fake.jsonl"), "");

    resetPiMockState();
    const projectRoot = join(tmp, "revive-project");
    mkdirSync(projectRoot, { recursive: true });
    const revivePromise = runner.revive(
      DEFAULT_PARENT_CAPTURE,
      inheritanceOf(
        manifestOf({ source: "goblin", name: "beta", filePath: beta }),
        projectEnvironment(projectRoot),
      ),
      handle.id,
      "second",
    );
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    const loader = opts.resourceLoader as { options: Record<string, unknown> };
    expect(loader.options.noSkills).toBe(true);
    expect(loader.options.additionalSkillPaths).toEqual([beta]);
    expect(opts.cwd).toBe(projectRoot);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await revivePromise;
  });

  it("rejects a generic revival without a manifest", async () => {
    const handle = await runner.spawn({
      prompt: "first",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    await expect(
      runner.revive(DEFAULT_PARENT_CAPTURE, null, handle.id, "second"),
    ).rejects.toThrow(/requires the reviving runtime's resolved skill manifest/);
  });
});
