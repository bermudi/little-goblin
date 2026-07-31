import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SubagentRunner } from "../mod.ts";
import { topicScopeDir } from "../../memory/paths.ts";
import { workspacePath } from "../../workspace/paths.ts";
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
  DEFAULT_AUTHORITY,
  DEFAULT_PARENT_CAPTURE,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
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
    const handle = await runner.spawn({ prompt: "first turn", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
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
    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, "nonexistent-id", "ping")).rejects.toThrow("Subagent not found");
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
        activeScope: DEFAULT_PARENT_CAPTURE.authority.activeScope,
        depth: 1,
        createdAt: new Date().toISOString(),
        status: "completed",
      }),
    );

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "ping")).rejects.toThrow("Subagent not found");
  });

  it("rejects revival when the topic directory is missing", async () => {
    const id = await spawnGeneric();
    const topicCapture = {
      ...DEFAULT_PARENT_CAPTURE,
      authority: {
        ...DEFAULT_PARENT_CAPTURE.authority,
        activeScope: { chatId: 777, topicScope: { topicId: 42 } },
      },
    };

    await expect(
      runner.revive(topicCapture, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "topic missing"),
    ).rejects.toThrow(/topic scope \(777\/42\) no longer exists/);
  });

  it("rejects revival when the topic path is a regular file", async () => {
    const id = await spawnGeneric();
    const topicPath = topicScopeDir(tmp, 777, 42);
    mkdirSync(dirname(topicPath), { recursive: true });
    writeFileSync(topicPath, "not a directory");
    const topicCapture = {
      ...DEFAULT_PARENT_CAPTURE,
      authority: {
        ...DEFAULT_PARENT_CAPTURE.authority,
        activeScope: { chatId: 777, topicScope: { topicId: 42 } },
      },
    };

    await expect(
      runner.revive(topicCapture, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "topic file"),
    ).rejects.toThrow(/topic scope \(777\/42\) is not a directory/);
  });

  it("propagates non-ENOENT topic stat failures", async () => {
    const id = await spawnGeneric();
    const topicPath = topicScopeDir(tmp, 777, 42);
    const chatPath = dirname(topicPath);
    mkdirSync(dirname(chatPath), { recursive: true });
    writeFileSync(chatPath, "not a chat directory");
    const topicCapture = {
      ...DEFAULT_PARENT_CAPTURE,
      authority: {
        ...DEFAULT_PARENT_CAPTURE.authority,
        activeScope: { chatId: 777, topicScope: { topicId: 42 } },
      },
    };

    let failure: unknown;
    try {
      await runner.revive(topicCapture, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "topic stat error");
    } catch (err) {
      failure = err;
    }
    expect((failure as NodeJS.ErrnoException).code).toBe("ENOTDIR");
  });

  it("revives a generic subagent and sends the new prompt", async () => {
    const id = await spawnGeneric();

    resetPiMockState();
    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "second turn");
    await flush();

    const opts = getCapturedCreateArgs()[0] as Record<string, unknown>;
    expect(opts.cwd).toBe(workspacePath(tmp));
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
    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "follow-up");
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
    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "check");
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
      authority: DEFAULT_AUTHORITY,
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
    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, handle.id, "more research");
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

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "bad")).rejects.toThrow("revive-fail");
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
    const handle = await runner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    writeFileSync(join(genericSubagentDir(tmp, handle.id), "2026-01-01T00-00-00_fake.jsonl"), "");

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, handle.id, "second")).rejects.toThrow("Subagent is already running");
  });

  it("clears stale errorMessage and completedAt on revival", async () => {
    sessionHolder.sendUserMessage = mock(async () => {
      throw new Error("first-fail");
    });
    const handle = await runner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    await flush();
    await expect(handle.result).rejects.toThrow("first-fail");

    writeFileSync(join(genericSubagentDir(tmp, handle.id), "2026-01-01T00-00-00_fake.jsonl"), "");

    resetPiMockState();
    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, handle.id, "second");
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

  it("reports malformed meta.json instead of treating it as not found", async () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000000";
    const dir = genericSubagentDir(tmp, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), "NOT VALID JSON{{{");
    writeFileSync(join(dir, "2026-01-01T00-00-00.jsonl"), "");

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "hello")).rejects.toThrow(
      /Invalid subagent metadata .* malformed JSON/,
    );
  });

  it("allows a same-id retry after a corrupted meta.json failure", async () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    const dir = genericSubagentDir(tmp, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), "NOT VALID JSON");

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "first try")).rejects.toThrow(
      /Invalid subagent metadata .* malformed JSON/,
    );

    // Repair the directory with a valid meta and a session file.
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        id,
        role: "generic",
        name: null,
        spawnedBy: null,
        activeScope: DEFAULT_PARENT_CAPTURE.authority.activeScope,
        depth: 1,
        createdAt: new Date().toISOString(),
        status: "completed",
      }),
    );
    writeFileSync(join(dir, "2026-01-01T00-00-00.jsonl"), "");

    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "second try");
    await flush();
    expect(sessionHolder.sendUserMessage).toHaveBeenCalledWith("second try");

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "retry response" },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });

    await expect(resultPromise).resolves.toBe("retry response");
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
    const handle = await runner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
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

    const firstRevive = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "turn 2");
    await flush();

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "turn 2b")).rejects.toThrow("Subagent revive already in progress");

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await firstRevive;
  });

  it("clears revivesInProgress after revive completes", async () => {
    const id = await spawnAndComplete();
    resetPiMockState();

    const firstRevive = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "turn 2");
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await firstRevive;

    resetPiMockState();
    const secondRevive = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "turn 3");
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

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "bad")).rejects.toThrow("revive-err");

    resetPiMockState();
    const secondRevive = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "turn 3");
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await secondRevive;
  });

  it("cleans up an attachment callback failure so the subagent can be revived again", async () => {
    const id = await spawnAndComplete();

    await expect(
      runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "will not start", undefined, async () => {
        throw new Error("attachment failed");
      }),
    ).rejects.toThrow("attachment failed");
    expect(runner.list().find((info) => info.id === id)).toBeUndefined();

    resetPiMockState();
    const retry = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "retry");
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await expect(retry).resolves.toBe("");
  });

  it("does not restart a subagent cancelled during asynchronous attachment", async () => {
    const id = await spawnAndComplete();
    let releaseAttachment!: () => void;
    const attachmentStarted = new Promise<void>((resolve) => {
      releaseAttachment = resolve;
    });
    let markAttached!: () => void;
    const attached = new Promise<void>((resolve) => {
      markAttached = resolve;
    });

    const revival = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "will be cancelled", undefined, async () => {
      markAttached();
      await attachmentStarted;
    });
    await attached;
    await runner.cancel(id);
    releaseAttachment();

    await expect(revival).rejects.toThrow("Subagent was cancelled");
    expect(sessionHolder.sendUserMessage).not.toHaveBeenCalledWith("will be cancelled");
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

    const handle = await runner.spawn({ prompt: "go", name: "researcher", authority: DEFAULT_AUTHORITY });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    const instDir = namedAgentInstanceDir(tmp, "researcher", handle.id);
    writeFileSync(join(instDir, "2026-01-01T00-00-00.jsonl"), "");
    rmSync(namedAgentAgentsMdPath(tmp, "researcher"));

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, handle.id, "more")).rejects.toThrow(/definition missing; cannot revive/);
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
    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, "any-id", "ping")).rejects.toThrow("SubagentRunner is disposed");
  });
});
