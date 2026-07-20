import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SubagentRunner } from "../mod.ts";
import { workdirPath } from "../../workspace/paths.ts";
import type { SubagentMeta } from "../types.ts";
import {
  genericSubagentDir,
  genericSubagentMetaPath,
  namedAgentAgentsMdPath,
  namedAgentDir,
  namedAgentInstanceDir,
  namedAgentSkillsDir,
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

describe("SubagentRunner.revive", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-revive-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function spawnGeneric(): Promise<string> {
    const handle = await runner.spawn({ prompt: "first turn", activeScope: DEFAULT_SCOPE });
    await flush();

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "first response" },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    const dir = genericSubagentDir(tmp, handle.id);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(dir, "2026-01-01T00-00-00_fake-session.jsonl"), "");

    return handle.id;
  }

  it("throws 'Subagent not found' when id does not exist on disk", async () => {
    await expect(runner.revive("nonexistent-id", "ping")).rejects.toThrow("Subagent not found");
  });

  it("throws 'Subagent not found' when dir exists but has no session file", async () => {
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

    resetPiMockState();
    const resultPromise = runner.revive(id, "second turn");
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    expect(opts.cwd).toBe(workdirPath(tmp));
    expect((opts.customTools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_write",
    ]);
    expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith("second turn");

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "second response" },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });

    await expect(resultPromise).resolves.toBe("second response");
  });

  it("updates meta.json to status=running on revive, then completed on agent_end", async () => {
    const id = await spawnGeneric();

    let meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("completed");

    resetPiMockState();
    const resultPromise = runner.revive(id, "follow-up");
    await flush();

    meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("running");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await resultPromise;

    meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("completed");
  });

  it("tracks the revived subagent in list()", async () => {
    const id = await spawnGeneric();

    resetPiMockState();
    const resultPromise = runner.revive(id, "check");
    resultPromise.catch(() => {});
    await flush();

    const entry = runner.list().find((info) => info.id === id);
    expect(entry?.status).toBe("running");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await resultPromise;
  });

  it("revives a named subagent using its AGENTS.md and isolated skills dir", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    const agentsMd = "# Researcher\nYou do research.\n";
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), agentsMd);

    const handle = await runner.spawn({
      prompt: "initial",
      name: "researcher",
      activeScope: DEFAULT_SCOPE,
    });
    await flush();

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    const instDir = namedAgentInstanceDir(tmp, "researcher", handle.id);
    if (!existsSync(instDir)) {
      mkdirSync(instDir, { recursive: true });
    }
    writeFileSync(join(instDir, "2026-01-01T00-00-00_fake-session.jsonl"), "");

    resetPiMockState();
    const resultPromise = runner.revive(handle.id, "more research");
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    expect(opts.cwd).toBe(namedAgentDir(tmp, "researcher"));
    const loader = opts.resourceLoader as { options: Record<string, unknown> };
    expect(loader.options.systemPrompt).toBe(agentsMd);
    expect(loader.options.noContextFiles).toBe(true);
    expect(loader.options.noSkills).toBe(true);
    expect(loader.options.additionalSkillPaths).toEqual([namedAgentSkillsDir(tmp, "researcher")]);
    expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith("more research");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await resultPromise;
  });

  it("rejects revive result when the revived subagent errors", async () => {
    const id = await spawnGeneric();

    resetPiMockState();
    sessionHolder.sendUserMessage = mock(async () => {
      throw new Error("revive-fail");
    });

    await expect(runner.revive(id, "bad")).rejects.toThrow("revive-fail");
  });
});

describe("SubagentRunner — revive guards", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-revive-guards-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws when reviving a subagent that is already running", async () => {
    const handle = await runner.spawn({ prompt: "first", activeScope: DEFAULT_SCOPE });
    await flush();

    writeFileSync(join(genericSubagentDir(tmp, handle.id), "2026-01-01T00-00-00_fake.jsonl"), "");

    await expect(runner.revive(handle.id, "second")).rejects.toThrow("Subagent is already running");
  });

  it("clears stale errorMessage and completedAt on revival", async () => {
    sessionHolder.sendUserMessage = mock(async () => {
      throw new Error("first-fail");
    });
    const handle = await runner.spawn({ prompt: "first", activeScope: DEFAULT_SCOPE });
    await flush();
    await flush();
    await expect(handle.result).rejects.toThrow("first-fail");

    writeFileSync(join(genericSubagentDir(tmp, handle.id), "2026-01-01T00-00-00_fake.jsonl"), "");

    resetPiMockState();
    const resultPromise = runner.revive(handle.id, "second");
    await flush();

    let meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("running");
    expect(meta.errorMessage).toBeUndefined();

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await resultPromise;

    meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("completed");
    expect(meta.errorMessage).toBeUndefined();
  });
});

describe("SubagentRunner — corrupted meta.json", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-corrupted-meta-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws 'Subagent not found' for corrupted meta.json (not raw SyntaxError)", async () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000000";
    const dir = genericSubagentDir(tmp, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), "NOT VALID JSON{{{");
    writeFileSync(join(dir, "2026-01-01T00-00-00.jsonl"), "");

    await expect(runner.revive(id, "hello")).rejects.toThrow("Subagent not found");
  });
});

describe("SubagentRunner — double-revive race guard", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-race-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function spawnAndComplete(): Promise<string> {
    const handle = await runner.spawn({ prompt: "first", activeScope: DEFAULT_SCOPE });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
    const dir = genericSubagentDir(tmp, handle.id);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(dir, "2026-01-01T00-00-00_fake.jsonl"), "");
    return handle.id;
  }

  it("throws 'Subagent revive already in progress' on concurrent revive of same ID", async () => {
    const id = await spawnAndComplete();
    resetPiMockState();

    const firstRevive = runner.revive(id, "turn 2");
    await flush();

    await expect(runner.revive(id, "turn 2b")).rejects.toThrow("Subagent revive already in progress");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await firstRevive;
  });

  it("clears revivesInProgress after revive completes", async () => {
    const id = await spawnAndComplete();
    resetPiMockState();

    const firstRevive = runner.revive(id, "turn 2");
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await firstRevive;

    resetPiMockState();
    const secondRevive = runner.revive(id, "turn 3");
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await secondRevive;
  });

  it("clears revivesInProgress after revive errors", async () => {
    const id = await spawnAndComplete();
    resetPiMockState();
    sessionHolder.sendUserMessage = mock(async () => {
      throw new Error("revive-err");
    });

    await expect(runner.revive(id, "bad")).rejects.toThrow("revive-err");

    resetPiMockState();
    const secondRevive = runner.revive(id, "turn 3");
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await secondRevive;
  });
});

describe("SubagentRunner — revive with deleted AGENTS.md", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-deleted-agents-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws clear error when named agent's AGENTS.md was deleted after original spawn", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# R");

    const handle = await runner.spawn({ prompt: "go", name: "researcher", activeScope: DEFAULT_SCOPE });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    const instDir = namedAgentInstanceDir(tmp, "researcher", handle.id);
    writeFileSync(join(instDir, "2026-01-01T00-00-00.jsonl"), "");
    rmSync(namedAgentAgentsMdPath(tmp, "researcher"));

    await expect(runner.revive(handle.id, "more")).rejects.toThrow(/definition missing; cannot revive/);
  });
});

describe("SubagentRunner — revive rejects after dispose", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-disposed-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws after dispose", async () => {
    await runner.dispose();
    await expect(runner.revive("any-id", "ping")).rejects.toThrow("SubagentRunner is disposed");
  });
});
