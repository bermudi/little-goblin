import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Module mock for @mariozechner/pi-coding-agent
//
// `mock.module` is process-global (last writer wins), so this file installs
// a fully-featured mock covering every pi entry point the SubagentRunner
// touches: AuthStorage, ModelRegistry, SettingsManager, SessionManager,
// DefaultResourceLoader, createAgentSession.
//
// Tests drive the fake AgentSession through the `sessionHolder` below so they
// can emit `agent_end` / errors / text deltas at will.
// ---------------------------------------------------------------------------

type Listener = (event: Record<string, unknown>) => void;

const sessionHolder = {
  listeners: [] as Listener[],
  sendUserMessage: mock(async (_text: string) => {}),
  abort: mock(async () => {}),
  dispose: mock(() => {}),

  reset() {
    this.listeners = [];
    this.sendUserMessage = mock(async (_text: string) => {});
    this.abort = mock(async () => {});
    this.dispose = mock(() => {});
  },

  emit(event: Record<string, unknown>) {
    for (const l of this.listeners) l(event);
  },

  get proxy() {
    const holder = this;
    return {
      subscribe(l: Listener) {
        holder.listeners.push(l);
        return () => {
          const idx = holder.listeners.indexOf(l);
          if (idx !== -1) holder.listeners.splice(idx, 1);
        };
      },
      sendUserMessage: (text: string) => holder.sendUserMessage(text),
      abort: () => holder.abort(),
      dispose: () => holder.dispose(),
    };
  },
};

let capturedCreateArgs: unknown[] = [];

mock.module("@mariozechner/pi-coding-agent", () => ({
  AuthStorage: {
    create: (_path: string) => ({
      setRuntimeApiKey: (_provider: string, _key: string) => {},
    }),
  },
  ModelRegistry: {
    create: (_auth: unknown, _path: string) => ({}),
  },
  SettingsManager: {
    inMemory: (_obj: unknown) => ({}),
  },
  SessionManager: {
    create: (_cwd: string, dir: string) => {
      mkdirSync(dir, { recursive: true });
      return { __stub: true } as unknown;
    },
    open: (path: string, _sessionDir?: string, _cwdOverride?: string) => {
      // Return a stub that looks like a SessionManager for revive flows.
      return { __stub: true, __openedFrom: path } as unknown;
    },
  },
  DefaultResourceLoader: class {
    public readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
    async reload() {}
  },
  createAgentSession: async (opts: unknown) => {
    capturedCreateArgs.push(opts);
    return { session: sessionHolder.proxy, extensionsResult: {} };
  },
}));

// ---------------------------------------------------------------------------
// Module under test (imported AFTER mock.module so it sees the mock)
// ---------------------------------------------------------------------------

import type { Config } from "../config.ts";
import { SubagentRunner } from "./mod.ts";
import { MAX_SUBAGENT_DEPTH, type SubagentMeta } from "./types.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  namedAgentAgentsMdPath,
  namedAgentDir,
  namedAgentInstanceDir,
  namedAgentInstanceMetaPath,
  namedAgentSkillsDir,
  subagentsRoot,
} from "./paths.ts";

function makeConfig(home: string): Config {
  return Object.freeze({
    botToken: "test-token",
    allowedTgUserIds: new Set<number>([1]),
    // Pattern-matched by `resolveModel`: poe/* with a poeApiKey is enough.
    modelName: "poe/test-model",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "error",
    toolVisibility: "none",
  }) as Config;
}

/**
 * Wait for `runAgent`'s async chain to settle so `createAgentSession`
 * (and the subscribe call) have actually run before we emit events.
 *
 * Two microtask flushes is enough today: one for the promise returned by
 * `getSharedServices` setup, one for the awaited `createAgentSession`.
 * Bun's test runner doesn't expose a "next tick" helper, so we approximate
 * with a 0-ms timer + a microtask drain — robust enough for the fake
 * session pipeline.
 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

describe("SubagentRunner — skeleton", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagents-"));
    runner = new SubagentRunner(makeConfig(tmp));
    capturedCreateArgs = [];
    sessionHolder.reset();
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
    await expect(
      runner.revive("missing", "ping"),
    ).rejects.toThrow("Subagent not found");
  });

  it("cancel() throws 'Subagent not found' for unknown id", async () => {
    await expect(runner.cancel("missing")).rejects.toThrow("Subagent not found");
  });
});

describe("SubagentRunner.spawn — generic", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagents-"));
    mkdirSync(join(tmp, "workdir"), { recursive: true });
    mkdirSync(join(tmp, "pi-agent"), { recursive: true });
    runner = new SubagentRunner(makeConfig(tmp));
    capturedCreateArgs = [];
    sessionHolder.reset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the subagent directory and meta.json", async () => {
    const handle = await runner.spawn({ prompt: "Analyze logs" });
    handle.result.catch(() => {}); // tested separately; suppress unhandled

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
      spawnedBy: "goblin-session-42",
    });
    handle.result.catch(() => {});
    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.spawnedBy).toBe("goblin-session-42");
  });

  it("tracks the spawned subagent in list()", async () => {
    const handle = await runner.spawn({ prompt: "ping" });
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
    const handle = await runner.spawn({ prompt: "ping" });
    handle.result.catch(() => {});
    expect(runner.list()[0]?.id).toBe(handle.id);

    // SessionManager.create() creates the dir and prepares the session file
    // path inside it. The file itself isn't flushed until pi sees an
    // assistant turn; the directory must exist.
    expect(existsSync(genericSubagentDir(tmp, handle.id))).toBe(true);
  });

  it("rejects spawning beyond depth 3", async () => {
    // Spawner at depth 3 → child would be at depth 4 → blocked.
    await expect(
      runner.spawn({ prompt: "deep", depth: 3 }),
    ).rejects.toThrow(/Maximum subagent depth reached \(3\)/);
  });

  it("permits spawning at the boundary (depth 2 spawner → depth 3 child)", async () => {
    const handle = await runner.spawn({ prompt: "boundary", depth: 2 });
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
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagents-"));
    mkdirSync(join(tmp, "workdir"), { recursive: true });
    mkdirSync(join(tmp, "pi-agent"), { recursive: true });
    runner = new SubagentRunner(makeConfig(tmp));
    capturedCreateArgs = [];
    sessionHolder.reset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws 'Named agent <name> not found' when AGENTS.md is missing", async () => {
    await expect(
      runner.spawn({ prompt: "hi", name: "nonexistent" }),
    ).rejects.toThrow("Named agent 'nonexistent' not found");
  });

  it("loads AGENTS.md and creates an instance directory + meta.json", async () => {
    const agentDir = namedAgentDir(tmp, "researcher");
    mkdirSync(agentDir, { recursive: true });
    const agentsMd = "# Researcher\n\nYou are a focused research subagent.\n";
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), agentsMd);

    const handle = await runner.spawn({
      prompt: "Investigate the docs",
      name: "researcher",
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
    });
    handle.result.catch(() => {});

    expect(existsSync(genericSubagentDir(tmp, handle.id))).toBe(false);
    expect(
      existsSync(namedAgentInstanceDir(tmp, "researcher", handle.id)),
    ).toBe(true);
  });

  it("records the named agent in list() with its name and role", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# x");

    const handle = await runner.spawn({
      prompt: "ping",
      name: "researcher",
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
    });
    handle.result.catch(() => {});

    const instances = (
      runner as unknown as {
        activeSubagents: Map<string, { definition: { agentsMd: string; skillsDir: string } | null }>;
      }
    ).activeSubagents;
    const inst = instances.get(handle.id);
    expect(inst?.definition).not.toBeNull();
    expect(inst?.definition?.agentsMd).toBe(agentsMd);
    expect(inst?.definition?.skillsDir).toBe(namedAgentSkillsDir(tmp, "researcher"));
    expect(inst?.definition?.skillsDir).not.toContain(`${tmp}/skills`);
  });

  it("rejects named spawn beyond depth 3", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# x");

    await expect(
      runner.spawn({ prompt: "deep", name: "researcher", depth: 3 }),
    ).rejects.toThrow(/Maximum subagent depth reached \(3\)/);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Subagent execution and result return
// ---------------------------------------------------------------------------

describe("SubagentRunner.spawn — execution & result return", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagents-"));
    mkdirSync(join(tmp, "workdir"), { recursive: true });
    mkdirSync(join(tmp, "pi-agent"), { recursive: true });
    runner = new SubagentRunner(makeConfig(tmp));
    capturedCreateArgs = [];
    sessionHolder.reset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates an AgentSession with customTools=[] and the subagent's SessionManager", async () => {
    const handle = await runner.spawn({ prompt: "Analyze logs" });
    handle.result.catch(() => {});
    await flush();

    expect(capturedCreateArgs).toHaveLength(1);
    const opts = capturedCreateArgs[0] as Record<string, unknown>;
    expect(opts.cwd).toBe(join(tmp, "workdir"));
    expect(Array.isArray(opts.customTools)).toBe(true);
    expect((opts.customTools as unknown[]).length).toBe(0);
    expect(opts.sessionManager).toBeDefined();
    // Generic subagents leave resourceLoader unset → pi's default discovery.
    expect(opts.resourceLoader).toBeUndefined();
  });

  it("for named subagents, builds a DefaultResourceLoader pinned to the agent's skills dir", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    const agentsMd = "# Researcher\nYou are a research specialist.\n";
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), agentsMd);

    const handle = await runner.spawn({ prompt: "go", name: "researcher" });
    handle.result.catch(() => {});
    await flush();

    const opts = capturedCreateArgs[0] as Record<string, unknown>;
    expect(opts.cwd).toBe(namedAgentDir(tmp, "researcher"));
    const loader = opts.resourceLoader as { options: Record<string, unknown> };
    expect(loader).toBeDefined();
    expect(loader.options.systemPrompt).toBe(agentsMd);
    expect(loader.options.noContextFiles).toBe(true);
    expect(loader.options.noSkills).toBe(true);
    expect(loader.options.additionalSkillPaths).toEqual([
      namedAgentSkillsDir(tmp, "researcher"),
    ]);
  });

  it("sends the initial prompt as the first user message", async () => {
    const handle = await runner.spawn({ prompt: "Hello there" });
    handle.result.catch(() => {});
    await flush();

    expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith("Hello there");
  });

  it("resolves handle.result with the accumulated assistant text on agent_end", async () => {
    const handle = await runner.spawn({ prompt: "Greet me" });
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

    const text = await handle.result;
    expect(text).toBe("Hello, world!");
  });

  it("propagates status updates via onStatusUpdate (agent_start + tool events)", async () => {
    const events: string[] = [];
    const handle = await runner.spawn({
      prompt: "do work",
      onStatusUpdate: (msg) => events.push(msg),
    });
    handle.result.catch(() => {});
    await flush();

    const prefix = `🧠 ${handle.id.slice(0, 8)} `;

    sessionHolder.emit({ type: "agent_start" });
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
      `${prefix}tool: bash`,
      `${prefix}tool ok: bash`,
    ]);
  });

  it("updates meta.json with status=completed and completedAt on agent_end", async () => {
    const handle = await runner.spawn({ prompt: "ping" });
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

    // In-memory state mirrors the persisted status.
    const list = runner.list();
    expect(list[0]?.status).toBe("completed");
  });

  it("rejects handle.result and writes status=error when sendUserMessage throws", async () => {
    sessionHolder.sendUserMessage = mock(async () => {
      throw new Error("boom");
    });

    const handle = await runner.spawn({ prompt: "trigger" });
    await flush();
    // Drain any extra microtasks the rejected sendUserMessage queued.
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

// ---------------------------------------------------------------------------
// Phase 5: Subagent revival
// ---------------------------------------------------------------------------

describe("SubagentRunner.revive", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagents-revive-"));
    mkdirSync(join(tmp, "workdir"), { recursive: true });
    mkdirSync(join(tmp, "pi-agent"), { recursive: true });
    runner = new SubagentRunner(makeConfig(tmp));
    capturedCreateArgs = [];
    sessionHolder.reset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Helper: simulate a completed generic spawn so there's a persisted
   * session.jsonl + meta.json on disk for revival.
   */
  async function spawnGeneric(): Promise<string> {
    const handle = await runner.spawn({ prompt: "first turn" });
    await flush();

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "first response" },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    // The mock SessionManager.create() doesn't create a .jsonl file.
    // Write a fake one so findSessionFile() can discover it.
    const dir = genericSubagentDir(tmp, handle.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00_fake-session.jsonl"), "");

    return handle.id;
  }

  it("throws 'Subagent not found' when id does not exist on disk", async () => {
    await expect(runner.revive("nonexistent-id", "ping")).rejects.toThrow(
      "Subagent not found",
    );
  });

  it("throws 'Subagent not found' when dir exists but has no session file", async () => {
    // Create a meta.json but no .jsonl — simulates corrupted/incomplete state.
    const id = "abc123-no-session";
    const dir = genericSubagentDir(tmp, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        id,
        role: "generic",
        name: null,
        spawnedBy: null,
        depth: 1,
        createdAt: new Date().toISOString(),
        status: "completed",
      }),
    );
    await expect(runner.revive(id, "ping")).rejects.toThrow("Subagent not found");
  });

  it("revives a generic subagent and sends the new prompt", async () => {
    const id = await spawnGeneric();

    // Reset mock state so we can observe the revive call.
    capturedCreateArgs = [];
    sessionHolder.reset();

    const resultPromise = runner.revive(id, "second turn");
    await flush();

    // createAgentSession was called again.
    expect(capturedCreateArgs).toHaveLength(1);
    const opts = capturedCreateArgs[0] as Record<string, unknown>;
    expect(opts.cwd).toBe(join(tmp, "workdir"));
    expect(opts.customTools).toEqual([]);

    // The new prompt was sent.
    expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith("second turn");

    // Simulate the response.
    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "second response" },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });

    const text = await resultPromise;
    expect(text).toBe("second response");
  });

  it("updates meta.json to status=running on revive, then completed on agent_end", async () => {
    const id = await spawnGeneric();

    // Verify it was completed after the first turn.
    let meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("completed");

    capturedCreateArgs = [];
    sessionHolder.reset();

    const resultPromise = runner.revive(id, "follow-up");
    await flush();

    // After revive(), meta flips back to running.
    meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("running");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await resultPromise;

    // After agent_end, back to completed.
    meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("completed");
  });

  it("tracks the revived subagent in list()", async () => {
    const id = await spawnGeneric();

    capturedCreateArgs = [];
    sessionHolder.reset();

    const resultPromise = runner.revive(id, "check");
    resultPromise.catch(() => {});
    await flush();

    const list = runner.list();
    const entry = list.find((info) => info.id === id);
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("running");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await resultPromise;
  });

  it("revives a named subagent using its AGENTS.md and isolated skills dir", async () => {
    // Set up a named agent.
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    const agentsMd = "# Researcher\nYou do research.\n";
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), agentsMd);

    const handle = await runner.spawn({
      prompt: "initial",
      name: "researcher",
    });
    await flush();

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    // Write a fake session file so findSessionFile() discovers it.
    const instDir = namedAgentInstanceDir(tmp, "researcher", handle.id);
    if (!existsSync(instDir)) mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "2026-01-01T00-00-00_fake-session.jsonl"), "");

    // Now revive.
    capturedCreateArgs = [];
    sessionHolder.reset();

    const resultPromise = runner.revive(handle.id, "more research");
    await flush();

    // Verify the revived session uses the named agent's cwd and resource loader.
    const opts = capturedCreateArgs[0] as Record<string, unknown>;
    expect(opts.cwd).toBe(namedAgentDir(tmp, "researcher"));
    const loader = opts.resourceLoader as { options: Record<string, unknown> };
    expect(loader).toBeDefined();
    expect(loader.options.systemPrompt).toBe(agentsMd);
    expect(loader.options.noContextFiles).toBe(true);
    expect(loader.options.noSkills).toBe(true);
    expect(loader.options.additionalSkillPaths).toEqual([
      namedAgentSkillsDir(tmp, "researcher"),
    ]);

    expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith("more research");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await resultPromise;
  });

  it("rejects revive result when the revived subagent errors", async () => {
    const id = await spawnGeneric();

    capturedCreateArgs = [];
    sessionHolder.reset();
    sessionHolder.sendUserMessage = mock(async () => {
      throw new Error("revive-fail");
    });

    await expect(runner.revive(id, "bad")).rejects.toThrow("revive-fail");
  });
});

// ---------------------------------------------------------------------------
// Phase 6: List and cancel operations
// ---------------------------------------------------------------------------

describe("SubagentRunner.cancel", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagents-cancel-"));
    mkdirSync(join(tmp, "workdir"), { recursive: true });
    mkdirSync(join(tmp, "pi-agent"), { recursive: true });
    runner = new SubagentRunner(makeConfig(tmp));
    capturedCreateArgs = [];
    sessionHolder.reset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws 'Subagent not found' for unknown id", async () => {
    await expect(runner.cancel("nonexistent")).rejects.toThrow("Subagent not found");
  });

  it("calls session.abort() and updates status to cancelled", async () => {
    const handle = await runner.spawn({ prompt: "work" });
    await flush();

    expect(sessionHolder.abort).not.toHaveBeenCalled();
    await runner.cancel(handle.id);

    expect(sessionHolder.abort).toHaveBeenCalledTimes(1);
    const list = runner.list();
    const entry = list.find((i) => i.id === handle.id);
    expect(entry?.status).toBe("cancelled");
  });

  it("persists status=cancelled to meta.json with completedAt", async () => {
    const handle = await runner.spawn({ prompt: "work" });
    await flush();

    await runner.cancel(handle.id);

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("cancelled");
    expect(meta.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("cleans up the event subscription on cancel", async () => {
    const handle = await runner.spawn({ prompt: "work" });
    await flush();

    // There should be one listener from subscribe().
    expect(sessionHolder.listeners.length).toBeGreaterThanOrEqual(1);
    const listenerCountBefore = sessionHolder.listeners.length;

    await runner.cancel(handle.id);

    // After cancel, unsubscribe should have removed the listener.
    expect(sessionHolder.listeners.length).toBeLessThan(listenerCountBefore);
  });
});

describe("SubagentRunner.list", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagents-list-"));
    mkdirSync(join(tmp, "workdir"), { recursive: true });
    mkdirSync(join(tmp, "pi-agent"), { recursive: true });
    runner = new SubagentRunner(makeConfig(tmp));
    capturedCreateArgs = [];
    sessionHolder.reset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array when no subagents are active", () => {
    expect(runner.list()).toEqual([]);
  });

  it("returns multiple subagents with correct shape", async () => {
    const h1 = await runner.spawn({ prompt: "a" });
    h1.result.catch(() => {});
    const h2 = await runner.spawn({ prompt: "b" });
    h2.result.catch(() => {});
    await flush();

    const list = runner.list();
    expect(list).toHaveLength(2);

    const ids = list.map((i) => i.id).sort();
    expect(ids).toEqual([h1.id, h2.id].sort());

    for (const entry of list) {
      expect(entry).toMatchObject({
        role: "generic",
        status: "running",
      });
      expect(entry.spawnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.name).toBeNull();
    }
  });

  it("reflects cancelled status after cancel()", async () => {
    const handle = await runner.spawn({ prompt: "x" });
    await flush();
    await runner.cancel(handle.id);

    const list = runner.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("cancelled");
  });

  it("reflects completed status after agent_end", async () => {
    const handle = await runner.spawn({ prompt: "x" });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    const list = runner.list();
    expect(list[0]?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Phase 7: Status callback propagation
// ---------------------------------------------------------------------------

describe("SubagentRunner — status prefix propagation", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagents-status-"));
    mkdirSync(join(tmp, "workdir"), { recursive: true });
    mkdirSync(join(tmp, "pi-agent"), { recursive: true });
    runner = new SubagentRunner(makeConfig(tmp));
    capturedCreateArgs = [];
    sessionHolder.reset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prefixes generic subagent status with 🧠 and truncated id", async () => {
    const events: string[] = [];
    const handle = await runner.spawn({
      prompt: "work",
      onStatusUpdate: (msg) => events.push(msg),
    });
    handle.result.catch(() => {});
    await flush();

    sessionHolder.emit({ type: "agent_start" });

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(`🧠 ${handle.id.slice(0, 8)} thinking...`);
  });

  it("prefixes named subagent status with 🧠 and agent name", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# R");

    const events: string[] = [];
    const handle = await runner.spawn({
      prompt: "work",
      name: "researcher",
      onStatusUpdate: (msg) => events.push(msg),
    });
    handle.result.catch(() => {});
    await flush();

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: {},
    });

    expect(events).toEqual([
      "🧠 researcher thinking...",
      "🧠 researcher tool: read",
    ]);
  });

  it("does not call back when onStatusUpdate is not provided", async () => {
    // No callback — should not throw or explode.
    const handle = await runner.spawn({ prompt: "work" });
    await flush();

    // Emitting events without a callback is a no-op.
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
      onStatusUpdate: (msg) => events.push(msg),
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

    const prefix = `🧠 ${handle.id.slice(0, 8)} `;
    expect(events).toEqual([`${prefix}tool error: bash`]);
  });
});

// ---------------------------------------------------------------------------
// Phase 8: spawn_subagent tool
// ---------------------------------------------------------------------------

describe("spawn_subagent tool", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagent-tool-"));
    mkdirSync(join(tmp, "workdir"), { recursive: true });
    mkdirSync(join(tmp, "pi-agent"), { recursive: true });
    runner = new SubagentRunner(makeConfig(tmp));
    capturedCreateArgs = [];
    sessionHolder.reset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("has the correct name and description", async () => {
    const { createSpawnSubagentTool } = await import("./tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1");
    expect(tool.name).toBe("spawn_subagent");
    expect(tool.label).toBe("Spawn Subagent");
    expect(tool.description).toBeTruthy();
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it("execute returns the subagent response text", async () => {
    const { createSpawnSubagentTool } = await import("./tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1");

    // Start the tool execute — it calls spawn() under the hood.
    const execPromise = tool.execute(
      "tc-1",
      { prompt: "Analyze the logs" },
      undefined, // signal
      undefined, // onUpdate
    );
    await flush();

    // Simulate the subagent completing.
    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "Analysis complete." },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });

    const result = await execPromise;
    expect(result.content).toEqual([
      { type: "text", text: "Analysis complete." },
    ]);
    expect((result.details as { subagentId: string }).subagentId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("passes name parameter through to spawn", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# R");

    const { createSpawnSubagentTool } = await import("./tool.ts");
    const tool = createSpawnSubagentTool(runner, 0, "sess-1");

    const execPromise = tool.execute(
      "tc-1",
      { prompt: "go", name: "researcher" },
      undefined,
      undefined,
    );
    await flush();

    // Verify the subagent was created as named.
    const list = runner.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("researcher");
    expect(list[0]?.role).toBe("named");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await execPromise;
  });

  it("propagates spawn errors as tool errors", async () => {
    // Spawning at depth 3 should fail.
    const { createSpawnSubagentTool } = await import("./tool.ts");
    const tool = createSpawnSubagentTool(runner, 3, "sess-1");

    await expect(
      tool.execute("tc-1", { prompt: "deep" }, undefined, undefined),
    ).rejects.toThrow(/Maximum subagent depth reached/);
  });
});

describe("SubagentRunner — recursive tool injection", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "goblin-subagent-recursion-"));
    mkdirSync(join(tmp, "workdir"), { recursive: true });
    mkdirSync(join(tmp, "pi-agent"), { recursive: true });
    capturedCreateArgs = [];
    sessionHolder.reset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes subagent tools to spawned subagents via toolFactory", async () => {
    // Create a runner with a tool factory that injects spawn_subagent.
    const { createSpawnSubagentTool } = await import("./tool.ts");
    const config = makeConfig(tmp);
    runner = new SubagentRunner(config, (r, depth, sessionId, onStatus) => [
      createSpawnSubagentTool(r, depth, sessionId, onStatus),
    ]);

    const handle = await runner.spawn({ prompt: "work" });
    await flush();

    // The createAgentSession call for the subagent should have spawn_subagent
    // in its customTools.
    expect(capturedCreateArgs).toHaveLength(1);
    const opts = capturedCreateArgs[0] as Record<string, unknown>;
    const tools = opts.customTools as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain("spawn_subagent");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });

  it("uses empty customTools when no toolFactory is provided", async () => {
    runner = new SubagentRunner(makeConfig(tmp));

    const handle = await runner.spawn({ prompt: "work" });
    await flush();

    expect(capturedCreateArgs).toHaveLength(1);
    const opts = capturedCreateArgs[0] as Record<string, unknown>;
    expect((opts.customTools as unknown[]).length).toBe(0);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
  });
});
