import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SubagentRunner, type SubagentPreparation } from "../mod.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import {
  DelegatedWorkHost,
  asConversationRuntimeId,
  type DelegatedDeliveryState,
  type DelegatedWorkOutcome,
  type DelegatedWorkRecord,
  type DelegatedWorkStatus,
} from "../../delegated-work/mod.ts";
import { topicScopeDir } from "../../memory/paths.ts";
import { workspacePath } from "../../workspace/paths.ts";
import {
  delegatedWorkRecordPath,
  delegatedWorkRunDir,
} from "../../delegated-work/paths.ts";
import {
  namedAgentAgentsMdPath,
  namedAgentDir,
  namedAgentSkillsDir,
} from "../paths.ts";
import {
  completeAndAcknowledge,
  createTestHome,
  DEFAULT_AUTHORITY,
  DEFAULT_PARENT_CAPTURE,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
  readRecord,
  validRecord,
  writeRecordAndSession,
  writeSessionFile,
} from "./support.ts";

class ThrowingCloseInvocationHost extends DelegatedWorkHost {
  closeInvocationCalls = 0;

  closeInvocation(
    _runId: string,
    _index: number,
    _status: Extract<DelegatedWorkStatus, "completed" | "cancelled" | "error" | "interrupted">,
    _outcome: DelegatedWorkOutcome | null,
    _deliveryState: DelegatedDeliveryState,
  ): never {
    this.closeInvocationCalls += 1;
    throw new Error("close invocation failed");
  }
}

class ThrowingLoadRecordHost extends DelegatedWorkHost {
  loadRecordCalls = 0;

  loadRecord(runId: string): DelegatedWorkRecord | null {
    this.loadRecordCalls += 1;
    if (this.loadRecordCalls === 1) return super.loadRecord(runId);
    throw new Error("load record failed");
  }
}

describe("SubagentRunner.revive", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-revive-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function spawnGeneric(): Promise<string> {
    const handle = await runner.spawn({ prompt: "first turn", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    await completeAndAcknowledge(runner, host, handle, "first response");
    writeSessionFile(tmp, handle.id, "2026-01-01T00-00-00_fake-session.jsonl");

    return handle.id;
  }

  it("throws 'Subagent not found' when id does not exist on disk", async () => {
    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, "nonexistent-id", "ping")).rejects.toThrow("Subagent not found");
  });

  it("throws 'Subagent not found' when run exists but has no session file", async () => {
    const id = "abc123-no-session";
    writeRecordAndSession(tmp, id, validRecord(id), undefined);

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

    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "second turn");
    await flush();

    expect(host.preparations.at(-1)?.cwd).toBe(workspacePath(tmp));
    expect(host.latest().invocations[0]?.customTools.map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_write",
    ]);
    expect(host.latest().invocations[0]?.prompt).toBe("second turn");

    host.latest().complete("second response");

    await expect(resultPromise).resolves.toBe("second response");
  });

  it("updates meta.json to status=running on revive, then completed on agent_end", async () => {
    const id = await spawnGeneric();

    let meta = readRecord(tmp, id);
    expect(meta.status).toBe("completed");

    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "follow-up");
    await flush();

    meta = readRecord(tmp, id);
    expect(meta.status).toBe("running");

    host.latest().complete("done");
    await resultPromise;

    meta = readRecord(tmp, id);
    expect(meta.status).toBe("completed");
  });

  it("tracks the revived subagent in list()", async () => {
    const id = await spawnGeneric();

    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "check");
    resultPromise.catch(() => {});
    await flush();

    const entry = runner.list().find((info) => info.id === id);
    expect(entry?.status).toBe("running");

    host.latest().complete("done");
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

    await completeAndAcknowledge(runner, host, handle, "done");

    const instDir = delegatedWorkRunDir(tmp, handle.id);
    if (!existsSync(instDir)) {
      mkdirSync(instDir, { recursive: true });
    }
    writeFileSync(join(instDir, "2026-01-01T00-00-00_fake-session.jsonl"), "");

    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, handle.id, "more research");
    await flush();

    expect(host.preparations.at(-1)?.cwd).toBe(namedAgentDir(tmp, "researcher"));
    expect(host.preparations.at(-1)?.resource).toEqual({ kind: "named", skillsDir: namedAgentSkillsDir(tmp, "researcher") });
    expect(host.latest().invocations[0]?.systemPrompt).toBe(agentsMd);
    expect(host.latest().invocations[0]?.prompt).toBe("more research");

    host.latest().complete("more");
    await resultPromise;
  });

  it("rejects revive result when the revived subagent errors", async () => {
    const id = await spawnGeneric();

    const result = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "bad");
    await flush();
    host.latest().fail(new Error("revive-fail"));

    await expect(result).rejects.toThrow("revive-fail");
  });
});

describe("SubagentRunner — revive guards", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-revive-guards-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws when reviving a subagent that is already running", async () => {
    const handle = await runner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    writeFileSync(join(delegatedWorkRunDir(tmp, handle.id), "2026-01-01T00-00-00_fake.jsonl"), "");

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, handle.id, "second")).rejects.toThrow("Subagent is already running");
  });

  it("clears stale errorMessage and completedAt on revival", async () => {
    const handle = await runner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    host.latest().fail(new Error("first-fail"));
    await expect(handle.result).rejects.toThrow("first-fail");

    writeFileSync(join(delegatedWorkRunDir(tmp, handle.id), "2026-01-01T00-00-00_fake.jsonl"), "");

    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, handle.id, "second");
    await flush();

    let meta = readRecord(tmp, handle.id);
    expect(meta.status).toBe("running");
    expect(meta.errorMessage).toBeUndefined();

    host.latest().complete("done");
    await resultPromise;

    meta = readRecord(tmp, handle.id);
    expect(meta.status).toBe("completed");
    expect(meta.errorMessage).toBeUndefined();
  });
});

describe("SubagentRunner — corrupted meta.json", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-corrupted-meta-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports malformed record.json instead of treating it as not found", async () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000000";
    const dir = delegatedWorkRunDir(tmp, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(delegatedWorkRecordPath(tmp, id), "NOT VALID JSON{{{");
    writeFileSync(join(dir, "2026-01-01T00-00-00.jsonl"), "");

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "hello")).rejects.toThrow(
      /Invalid delegated work record .* malformed JSON/,
    );
  });

  it("allows a same-id retry after a corrupted record.json failure", async () => {
    const id = "aaaaaaaa-0000-0000-0000-000000000001";
    const dir = delegatedWorkRunDir(tmp, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(delegatedWorkRecordPath(tmp, id), "NOT VALID JSON");

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "first try")).rejects.toThrow(
      /Invalid delegated work record .* malformed JSON/,
    );

    // Repair the directory with a valid record and a session file.
    writeRecordAndSession(tmp, id, validRecord(id), "2026-01-01T00-00-00.jsonl");

    const resultPromise = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "second try");
    await flush();
    expect(host.latest().invocations[0]?.prompt).toBe("second try");

    host.latest().complete("retry response");

    await expect(resultPromise).resolves.toBe("retry response");
  });
});

describe("SubagentRunner — double-revive race guard", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-race-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function spawnAndComplete(): Promise<string> {
    const handle = await runner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    await completeAndAcknowledge(runner, host, handle, "done");
    writeSessionFile(tmp, handle.id, "2026-01-01T00-00-00_fake.jsonl");
    return handle.id;
  }

  it("throws 'Subagent revive already in progress' on concurrent revive of same ID", async () => {
    const id = await spawnAndComplete();

    const firstRevive = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "turn 2");
    await flush();

    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "turn 2b")).rejects.toThrow("Subagent revive already in progress");

    host.latest().complete("done");
    await firstRevive;
  });

  it("clears revivesInProgress after revive completes", async () => {
    const id = await spawnAndComplete();

    const firstRevive = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "turn 2");
    await flush();
    host.latest().complete("done");
    await firstRevive;
    // A revival is an invocation like any other: its host registration is held
    // until the blocking caller accepts the result.
    runner.acknowledgeDelivery(id);

    const secondRevive = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "turn 3");
    await flush();
    host.latest().complete("done");
    await secondRevive;
  });

  it("clears revivesInProgress after revive errors", async () => {
    const id = await spawnAndComplete();
    const failedRevive = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "bad");
    await flush();
    host.latest().fail(new Error("revive-err"));

    await expect(failedRevive).rejects.toThrow("revive-err");

    const secondRevive = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "turn 3");
    await flush();
    host.latest().complete("done");
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

    const retry = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "retry");
    await flush();
    host.latest().complete("done");
    await expect(retry).resolves.toBe("done");
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
    expect(host.executions).toHaveLength(2);
    expect(host.latest().invocations).toHaveLength(0);
  });
});

describe("SubagentRunner — revive with deleted AGENTS.md", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-deleted-agents-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws clear error when named agent's AGENTS.md was deleted after original spawn", async () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# R");

    const handle = await runner.spawn({ prompt: "go", name: "researcher", authority: DEFAULT_AUTHORITY });
    await flush();
    await completeAndAcknowledge(runner, host, handle, "done");

    writeSessionFile(tmp, handle.id, "2026-01-01T00-00-00.jsonl");
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
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws after dispose", async () => {
    await runner.dispose();
    await expect(runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, "any-id", "ping")).rejects.toThrow("SubagentRunner is disposed");
  });
});

describe("SubagentRunner — abandonInvocation cleanup containment", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;
  let delegatedHost: ThrowingCloseInvocationHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-abandon-cleanup-");
    host = new FakeSubagentHost();
    delegatedHost = new ThrowingCloseInvocationHost(tmp);
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host, undefined, delegatedHost);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("does not let a throwing closeInvocation mask the original prepare error", async () => {
    const handle = await runner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    await completeAndAcknowledge(runner, host, handle, "done");
    writeSessionFile(tmp, handle.id, "2026-01-01T00-00-00.jsonl");

    // Force prepare to fail so the revive enters the abandonInvocation cleanup path.
    host.prepare = (_plan: SubagentPreparation) => { throw new Error("prepare failed"); };

    await expect(
      runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, handle.id, "retry"),
    ).rejects.toThrow("prepare failed");

    const record = readRecord(tmp, handle.id);
    expect(record.status).toBe("running");
    expect(record.runtimeId).toBeDefined();
    expect(runner.delegatedWorkHost.registeredForRuntime(asConversationRuntimeId(record.runtimeId as string))).toBe(0);
    expect(delegatedHost.closeInvocationCalls).toBe(1);
  });

  it("does not let a throwing loadRecord mask the original prepare error", async () => {
    const delegatedHost = new ThrowingLoadRecordHost(tmp);
    const testRunner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host, undefined, delegatedHost);

    const handle = await testRunner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    await completeAndAcknowledge(testRunner, host, handle, "done");
    writeSessionFile(tmp, handle.id, "2026-01-01T00-00-00.jsonl");

    // Force prepare to fail so the revive enters the abandonInvocation cleanup path.
    host.prepare = (_plan: SubagentPreparation) => { throw new Error("prepare failed"); };

    await expect(
      testRunner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, handle.id, "retry"),
    ).rejects.toThrow("prepare failed");

    const record = readRecord(tmp, handle.id);
    expect(record.status).toBe("running");
    expect(record.runtimeId).toBeDefined();
    expect(testRunner.delegatedWorkHost.registeredForRuntime(asConversationRuntimeId(record.runtimeId as string))).toBe(0);
    expect(delegatedHost.loadRecordCalls).toBe(2);
  });
});
