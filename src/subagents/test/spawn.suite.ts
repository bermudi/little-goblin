import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SubagentRunner, type GenericSubagentInheritance, type SubagentToolFactory } from "../mod.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import type { ResolvedSkillSet } from "../../agent/skills/mod.ts";
import { personalEnvironment, projectEnvironment, type ExecutionEnvironment } from "../../sessions/environment.ts";
import { goblinSkillsPath, workspacePath } from "../../workspace/paths.ts";
import { MAX_SUBAGENT_DEPTH } from "../types.ts";
import {
  namedAgentAgentsMdPath,
  namedAgentDir,
  namedAgentSkillsDir,
} from "../paths.ts";
import {
  delegatedWorkRecordPath,
  delegatedWorkRunDir,
  delegatedWorkRunsRoot,
} from "../../delegated-work/paths.ts";
import {
  completeAndAcknowledge,
  createTestHome,
  DEFAULT_AUTHORITY,
  DEFAULT_PARENT_CAPTURE,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
  readRecord,
} from "./support.ts";

describe("SubagentRunner — skeleton", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-");
    runner = new SubagentRunner(makeConfig(tmp));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("instantiates without I/O", () => {
    expect(runner).toBeInstanceOf(SubagentRunner);
    expect(existsSync(delegatedWorkRunsRoot(tmp))).toBe(false);
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
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the subagent directory and meta.json", async () => {
    const handle = await runner.spawn({ prompt: "Analyze logs", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    handle.result.catch(() => {});

    expect(handle.status).toBe("running");
    expect(handle.id).toMatch(/^[0-9a-f-]{36}$/);

    const dir = delegatedWorkRunDir(tmp, handle.id);
    expect(existsSync(dir)).toBe(true);

    const metaPath = delegatedWorkRecordPath(tmp, handle.id);
    expect(existsSync(metaPath)).toBe(true);

    const meta = readRecord(tmp, handle.id);
    expect(meta).toMatchObject({
      id: handle.id,
      role: "generic",
      name: null,
      depth: 1,
      status: "running",
    });
    expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("tracks spawnedBy in the active instance when provided", async () => {
    const handle = await runner.spawn({
      prompt: "hi",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "goblin-session-42",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    handle.result.catch(() => {});

    const list = runner.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.spawnedBy).toBe("goblin-session-42");
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

  it("prepares an exact persisted history target under the subagent dir", async () => {
    const handle = await runner.spawn({ prompt: "ping", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    handle.result.catch(() => {});

    expect(runner.list()[0]?.id).toBe(handle.id);
    expect(existsSync(delegatedWorkRunDir(tmp, handle.id))).toBe(true);
  });

  it("does not persist a record when pre-registration validation fails", async () => {
    await expect(
      runner.spawn({
        prompt: "cannot prepare",
        authority: DEFAULT_AUTHORITY,
        depth: -1,
        inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
      }),
    ).rejects.toThrow(/Invalid depth/);

    expect(runner.list()).toEqual([]);
    expect(existsSync(delegatedWorkRunsRoot(tmp))).toBe(false);
  });

  it("rejects spawning beyond depth 3", async () => {
    await expect(runner.spawn({ prompt: "deep", depth: 3, authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE })).rejects.toThrow(
      /Maximum subagent depth reached \(3\)/,
    );
  });

  it("permits spawning at the boundary (depth 2 spawner → depth 3 child)", async () => {
    const handle = await runner.spawn({ prompt: "boundary", depth: 2, authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    handle.result.catch(() => {});

    const meta = readRecord(tmp, handle.id);
    expect(meta.depth).toBe(3);
  });
});

describe("SubagentRunner.spawn — named", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws 'Named agent <name> not found' when AGENTS.md is missing", async () => {
    await expect(runner.spawn({ prompt: "hi", authority: DEFAULT_AUTHORITY, name: "nonexistent" })).rejects.toThrow(
      "Named agent 'nonexistent' not found",
    );
  });

  it("loads AGENTS.md and creates a host-owned run directory + record.json", async () => {
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

    const instDir = delegatedWorkRunDir(tmp, handle.id);
    expect(existsSync(instDir)).toBe(true);

    const metaPath = delegatedWorkRecordPath(tmp, handle.id);
    expect(existsSync(metaPath)).toBe(true);

    const meta = readRecord(tmp, handle.id);
    expect(meta).toMatchObject({
      id: handle.id,
      role: "named",
      name: "researcher",
      depth: 1,
      status: "running",
    });
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
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes the subagent-only tools and prepared plan through the opaque host", async () => {
    const handle = await runner.spawn({ prompt: "Analyze logs", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    expect(host.preparations[0]?.cwd).toBe(workspacePath(tmp));
    const invocation = host.latest().invocations[0];
    expect(invocation?.prompt).toBe("Analyze logs");
    const names = invocation?.customTools.map((tool) => tool.name);
    expect(names).not.toContain("schedule_turn");
    expect(names).toEqual(["memory_search", "memory_write"]);

    host.latest().complete("done");
    await expect(handle.result).resolves.toBe("done");
  });

  it("passes the initial prompt to the opaque execution", async () => {
    const handle = await runner.spawn({ prompt: "Hello there", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    handle.result.catch(() => {});
    await flush();

    expect(host.latest().invocations[0]?.prompt).toBe("Hello there");
    host.latest().complete("done");
    await handle.result;
  });

  it("resolves handle.result with the execution result", async () => {
    const handle = await runner.spawn({ prompt: "Greet me", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    host.latest().complete("Hello, world!");

    await expect(handle.result).resolves.toBe("Hello, world!");
  });

  it("passes status updates through the coordinator-owned prefix", async () => {
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

    host.latest().emitStatus("thinking...");
    host.latest().emitStatus("tool: bash");
    host.latest().emitStatus("tool ok: bash");

    expect(events).toEqual([
      `${prefix}thinking...`,
      `${prefix}tool: bash`,
      `${prefix}tool ok: bash`,
    ]);
  });

  it("updates meta.json with status=completed and completedAt on execution completion", async () => {
    const handle = await runner.spawn({ prompt: "ping", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    host.latest().complete("pong");

    await handle.result;

    const meta = readRecord(tmp, handle.id);
    expect(meta.status).toBe("completed");
    expect(meta.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(runner.list()[0]?.status).toBe("completed");
  });

  it("rejects handle.result and writes status=error when execution fails", async () => {
    const handle = await runner.spawn({ prompt: "trigger", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    host.latest().fail(new Error("boom"));

    await expect(handle.result).rejects.toThrow("boom");

    const meta = readRecord(tmp, handle.id);
    expect(meta.status).toBe("error");
    expect(meta.errorMessage).toBe("boom");
    expect(meta.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("SubagentRunner — status prefix propagation", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-status-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
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

    host.latest().emitStatus("thinking...");

    expect(events).toEqual([
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

    host.latest().emitStatus("thinking...");
    host.latest().emitStatus("tool: read");

    expect(events).toEqual([
      "🧠 researcher thinking...",
      "🧠 researcher tool: read",
    ]);
  });

  it("does not call back when onStatusUpdate is not provided", async () => {
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    expect(() => host.latest().emitStatus("tool: bash")).not.toThrow();

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

    host.latest().emitStatus("tool error: bash");

    expect(events).toEqual([`🧠 ${handle.id.slice(0, 8)} tool error: bash`]);
  });
});

describe("SubagentRunner — name validation", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-name-validation-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
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
    host.latest().complete("done");
    await handle.result;
  });
});

describe("SubagentRunner — negative depth rejection", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-depth-neg-");
    runner = new SubagentRunner(makeConfig(tmp));
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
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-recursion-");
    host = new FakeSubagentHost();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes subagent tools to spawned subagents via toolFactory", async () => {
    const { createSpawnSubagentTool } = await import("../tool.ts");
    runner = new SubagentRunner(makeConfig(tmp), (subagentRunner, depth, sessionId, parentCapture, inheritedSkills, onStatusUpdate) => [
      createSpawnSubagentTool(subagentRunner, depth, sessionId, parentCapture, inheritedSkills, onStatusUpdate, undefined),
    ], undefined, host);

    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    const tools = host.latest().invocations[0]?.customTools ?? [];
    expect(tools.map((tool) => tool.name)).toContain("spawn_subagent");
    expect(tools.map((tool) => tool.name)).toContain("memory_write");

    host.latest().complete("done");
    await handle.result;
  });

  it("always registers scoped memory tools even when no toolFactory is provided", async () => {
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);

    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    expect(host.latest().invocations[0]?.customTools.map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_write",
    ]);

    host.latest().complete("done");
    await handle.result;
  });
});

describe("SubagentRunner — nested prefix prevention", () => {
  let tmp: string;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-nested-prefix-");
    host = new FakeSubagentHost();
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

    const parentRunner = new SubagentRunner(makeConfig(tmp), toolFactory, undefined, host);
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

    host.latest().complete("done");
    await handle.result;
  });
});

describe("SubagentRunner — skill inheritance", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-skills-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
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

  it("passes the frozen manifest and execution CWD to the host", async () => {
    const alpha = writeSkill(goblinSkillsPath(tmp), "alpha");
    const beta = writeSkill(join(tmp, "project", ".agents", "skills"), "beta");
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
    await flush();

    const preparation = host.preparations[0];
    expect(preparation?.cwd).toBe(join(tmp, "project"));
    expect(preparation?.resource).toEqual({ kind: "generic", skillPaths: [alpha, beta] });

    host.latest().complete("done");
    await handle.result;
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
    runner = new SubagentRunner(makeConfig(tmp), toolFactory, undefined, host);

    const handle = await runner.spawn({
      prompt: "parent",
      authority: DEFAULT_AUTHORITY,
      inheritance,
    });
    await flush();
    expect(factorySaw).toBe(inheritance);

    host.latest().complete("parent");
    await handle.result;

    // Drive a nested generic spawn through a tool built with the manifest the
    // parent's toolFactory received: the child must get the same frozen
    // manifest, not a re-resolved catalog.
    const spawnTool = createSpawnSubagentTool(runner, 1, "parent-session", DEFAULT_PARENT_CAPTURE, factorySaw ?? null, undefined);
    const childExec = spawnTool.execute("tc-child", { prompt: "child" }, undefined, undefined, {} as never);
    childExec.catch(() => {});
    await flush();

    expect(host.latest().invocations[0]?.prompt).toBe("child");
    expect(host.preparations.at(-1)?.resource).toEqual({ kind: "generic", skillPaths: [alpha] });

    host.latest().complete("child");
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
    await completeAndAcknowledge(runner, host, handle, "first");
    writeFileSync(join(delegatedWorkRunDir(tmp, handle.id), "2026-01-01T00-00-00_fake.jsonl"), "");

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

    expect(host.preparations.at(-1)?.cwd).toBe(projectRoot);
    expect(host.preparations.at(-1)?.resource).toEqual({ kind: "generic", skillPaths: [beta] });

    host.latest().complete("second");
    await revivePromise;
  });

  it("rejects a generic revival without a manifest", async () => {
    const handle = await runner.spawn({
      prompt: "first",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    await completeAndAcknowledge(runner, host, handle, "first");

    await expect(
      runner.revive(DEFAULT_PARENT_CAPTURE, null, handle.id, "second"),
    ).rejects.toThrow(/requires the reviving runtime's resolved skill manifest/);
  });
});
