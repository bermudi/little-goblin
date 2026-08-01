import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { SubagentRunner } from "../mod.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import { markCompleted, SubagentTerminalError } from "../execution.ts";
import type { SubagentInstance, SubagentMeta } from "../types.ts";
import { genericSubagentMetaPath } from "../paths.ts";
import {
  createTestHome,
  DEFAULT_AUTHORITY,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
} from "./support.ts";

describe("SubagentRunner.cancel", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-cancel-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws 'Subagent not found' for unknown id", async () => {
    await expect(runner.cancel("nonexistent")).rejects.toThrow("Subagent not found");
  });

  it("calls session.abort() and updates status to cancelled", async () => {
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    expect(host.latest().stopCalls).toBe(0);
    await runner.cancel(handle.id);

    expect(host.latest().stopCalls).toBe(1);
    expect(runner.list().find((entry) => entry.id === handle.id)?.status).toBe("cancelled");
  });

  it("persists status=cancelled to meta.json with completedAt", async () => {
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    await runner.cancel(handle.id);

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("cancelled");
    expect(meta.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stops the prepared execution on cancel", async () => {
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    await runner.cancel(handle.id);

    expect(host.latest().stopCalls).toBe(1);
  });
});

describe("SubagentRunner.list", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-list-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array when no subagents are active", () => {
    expect(runner.list()).toEqual([]);
  });

  it("returns multiple subagents with correct shape", async () => {
    const first = await runner.spawn({ prompt: "a", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    first.result.catch(() => {});
    const second = await runner.spawn({ prompt: "b", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    second.result.catch(() => {});
    await flush();

    const list = runner.list();
    expect(list).toHaveLength(2);
    expect(list.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());

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
    const handle = await runner.spawn({ prompt: "x", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    await runner.cancel(handle.id);

    expect(runner.list()).toHaveLength(1);
    expect(runner.list()[0]?.status).toBe("cancelled");
  });

  it("reflects completed status after agent_end", async () => {
    const handle = await runner.spawn({ prompt: "x", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    host.latest().complete("done");
    await handle.result;

    expect(runner.list()[0]?.status).toBe("completed");
  });
});

describe("SubagentRunner — prune terminal instances", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-prune-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prunes completed subagents on next spawn", async () => {
    const first = await runner.spawn({ prompt: "a", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    host.latest().complete("done");
    await first.result;

    expect(runner.list()).toHaveLength(1);

    const second = await runner.spawn({ prompt: "b", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    second.result.catch(() => {});
    await flush();

    const ids = runner.list().map((entry) => entry.id);
    expect(ids).not.toContain(first.id);
    expect(ids).toContain(second.id);

    host.latest().complete("second");
    await second.result;
  });

  it("prunes cancelled subagents on next spawn", async () => {
    const first = await runner.spawn({ prompt: "a", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    await runner.cancel(first.id);

    expect(runner.list()).toHaveLength(1);

    const second = await runner.spawn({ prompt: "b", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    second.result.catch(() => {});
    await flush();

    expect(runner.list().map((entry) => entry.id)).not.toContain(first.id);
    host.latest().complete("second");
    await second.result;
  });

  it("does not prune a terminal parent while it has running descendants", async () => {
    const a = await runner.spawn({
      prompt: "a",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    const b = await runner.spawn({
      prompt: "b",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: a.id,
      depth: 1,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    // Complete the parent while the child is still running.
    const aInst = (runner as unknown as { activeSubagents: Map<string, SubagentInstance> }).activeSubagents.get(a.id);
    expect(aInst).toBeDefined();
    markCompleted(aInst!);

    // Spawning a third subagent triggers pruneTerminal(). The completed
    // parent must be retained because child b is still running and needs
    // the ancestry chain for cascade cancel.
    const c = await runner.spawn({ prompt: "c", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    c.result.catch(() => {});
    await flush();

    const ids = runner.list().map((entry) => entry.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);

    // Now complete the child. pruneTerminal is leaf-first: the next spawn
    // prunes b (the leaf), and the spawn after that prunes a (now that no
    // one references it as a parent).
    const bInst = (runner as unknown as { activeSubagents: Map<string, SubagentInstance> }).activeSubagents.get(b.id);
    expect(bInst).toBeDefined();
    markCompleted(bInst!);

    const d = await runner.spawn({ prompt: "d", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    d.result.catch(() => {});
    await flush();

    const idsAfterFirst = runner.list().map((entry) => entry.id);
    expect(idsAfterFirst).not.toContain(b.id);
    expect(idsAfterFirst).toContain(a.id); // a still retained (was parent of b)
    expect(idsAfterFirst).toContain(d.id);

    const e = await runner.spawn({ prompt: "e", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    e.result.catch(() => {});
    await flush();

    const idsAfterSecond = runner.list().map((entry) => entry.id);
    expect(idsAfterSecond).not.toContain(a.id);
    expect(idsAfterSecond).not.toContain(b.id);
    expect(idsAfterSecond).toContain(e.id);

    host.latest().complete("end");
    await e.result;
  });
});

describe("SubagentRunner — dispose", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-dispose-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("cancels running subagents and clears the map", async () => {
    const handle = await runner.spawn({ prompt: "a", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    handle.result.catch(() => {});
    await flush();

    expect(runner.list()).toHaveLength(1);
    await runner.dispose();

    expect(runner.list()).toHaveLength(0);
    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("cancelled");
  });

  it("disposes subagents that already completed", async () => {
    const handle = await runner.spawn({ prompt: "a", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    host.latest().complete("done");
    await handle.result;

    expect(runner.list()).toHaveLength(1);
    await runner.dispose();
    expect(runner.list()).toHaveLength(0);
  });
});

describe("SubagentRunner — cancel with stop() that throws", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-cancel-abort-throws-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("updates status but surfaces a stop() failure", async () => {
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    host.latest().stopFailure = new Error("stop-failed");
    await expect(runner.cancel(handle.id)).rejects.toThrow("stop-failed");

    expect(runner.list()[0]?.status).toBe("cancelled");

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("cancelled");
  });
});

describe("SubagentRunner — disposed flag", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-disposed-flag-");
    runner = new SubagentRunner(makeConfig(tmp));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects spawn after dispose", async () => {
    await runner.dispose();
    await expect(runner.spawn({ prompt: "late", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE })).rejects.toThrow("SubagentRunner is disposed");
  });

  it("rejects spawn even if active map was empty at dispose time", async () => {
    expect(runner.list()).toEqual([]);
    await runner.dispose();
    await expect(runner.spawn({ prompt: "x", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE })).rejects.toThrow("SubagentRunner is disposed");
  });
});

describe("SubagentRunner — dispose does not overwrite completed", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-dispose-no-overwrite-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("preserves completed meta.json status on dispose", async () => {
    const handle = await runner.spawn({ prompt: "a", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    host.latest().complete("done");
    await handle.result;

    let meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("completed");

    await runner.dispose();

    meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("completed");
  });

  it("preserves errored meta.json status on dispose", async () => {
    const handle = await runner.spawn({ prompt: "a", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    host.latest().fail(new Error("boom"));
    await expect(handle.result).rejects.toThrow("boom");

    let meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("error");

    await runner.dispose();

    meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("error");
  });
});

describe("SubagentRunner — persistMeta failure resilience", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-persist-resilience-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects with both execution and metadata persistence failures", async () => {
    const executionError = new Error("first-fail");

    const handle = await runner.spawn({ prompt: "trigger", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    const metaPath = genericSubagentMetaPath(tmp, handle.id);
    const dir = dirname(metaPath);

    rmSync(metaPath);
    chmodSync(dir, 0o444);

    await flush();
    host.latest().fail(executionError);

    let failure: unknown;
    try {
      await handle.result;
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(SubagentTerminalError);
    const combined = failure as SubagentTerminalError;
    expect(combined.executionError).toBe(executionError);
    expect(combined.cause).toBe(executionError);
    expect(combined.persistenceError).toBeInstanceOf(Error);
    expect(combined.message).toContain("first-fail");
    expect(combined.message).toContain("metadata persistence failed");
    expect(runner.list().find((entry) => entry.id === handle.id)?.status).toBe("error");

    chmodSync(dir, 0o755);
  });

  it("markCompleted rejects the result when persistMeta fails", async () => {
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    const metaPath = genericSubagentMetaPath(tmp, handle.id);
    const dir = dirname(metaPath);
    rmSync(metaPath);
    chmodSync(dir, 0o444);

    host.latest().complete("important result");

    await expect(handle.result).rejects.toThrow(/EACCES|metadata file is missing/);
    expect(runner.list().find((entry) => entry.id === handle.id)?.status).toBe("completed");

    chmodSync(dir, 0o755);
  });
});

describe("SubagentRunner.cancelBySession", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-cancel-by-session-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function getInstance(id: string): SubagentInstance | undefined {
    return (runner as unknown as { activeSubagents: Map<string, SubagentInstance> }).activeSubagents.get(id);
  }

  it("cancels direct children of the session", async () => {
    const a = await runner.spawn({
      prompt: "a",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    const b = await runner.spawn({
      prompt: "b",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    await runner.cancelBySession("session-abc");

    expect(host.executions.reduce((count, execution) => count + execution.stopCalls, 0)).toBe(2);
    expect(runner.list().find((entry) => entry.id === a.id)?.status).toBe("cancelled");
    expect(runner.list().find((entry) => entry.id === b.id)?.status).toBe("cancelled");

    const aMeta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, a.id), "utf-8")) as SubagentMeta;
    const bMeta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, b.id), "utf-8")) as SubagentMeta;
    expect(aMeta.status).toBe("cancelled");
    expect(bMeta.status).toBe("cancelled");
    expect(aMeta.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(bMeta.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("recursively cancels grandchildren", async () => {
    const a = await runner.spawn({
      prompt: "a",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    const b = await runner.spawn({
      prompt: "b",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: a.id,
      depth: 1,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    await runner.cancelBySession("session-abc");

    expect(runner.list().find((entry) => entry.id === a.id)?.status).toBe("cancelled");
    expect(runner.list().find((entry) => entry.id === b.id)?.status).toBe("cancelled");
    expect(host.executions.reduce((count, execution) => count + execution.stopCalls, 0)).toBe(2);
  });

  it("cancels a running child even when its parent is already terminal", async () => {
    const a = await runner.spawn({
      prompt: "a",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    const b = await runner.spawn({
      prompt: "b",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: a.id,
      depth: 1,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    const aInst = getInstance(a.id);
    expect(aInst).toBeDefined();
    markCompleted(aInst!);

    await runner.cancelBySession("session-abc");

    expect(aInst?.status).toBe("completed");
    expect(runner.list().find((entry) => entry.id === b.id)?.status).toBe("cancelled");
    expect(host.executions.reduce((count, execution) => count + execution.stopCalls, 0)).toBe(1);
  });

  it("skips terminal instances", async () => {
    const a = await runner.spawn({
      prompt: "a",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    const aInst = getInstance(a.id);
    expect(aInst).toBeDefined();
    markCompleted(aInst!);

    await runner.cancelBySession("session-abc");

    expect(aInst?.status).toBe("completed");
    const meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, a.id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("completed");
    expect(host.executions[0]?.stopCalls).toBe(0);
  });

  it("does not match null spawnedBy", async () => {
    await runner.spawn({ prompt: "a", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    await runner.cancelBySession("session-abc");

    expect(runner.list()[0]?.status).toBe("running");
    expect(host.executions.every((execution) => execution.stopCalls === 0)).toBe(true);
  });

  it("is a no-op when no subagents match the session", async () => {
    await runner.cancelBySession("session-xyz");

    expect(host.executions).toHaveLength(0);
    expect(runner.list()).toHaveLength(0);
  });

  it("does not cancel subagents of other sessions", async () => {
    const a = await runner.spawn({
      prompt: "a",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    const c = await runner.spawn({
      prompt: "c",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-def",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    await runner.cancelBySession("session-abc");

    expect(runner.list().find((entry) => entry.id === a.id)?.status).toBe("cancelled");
    expect(runner.list().find((entry) => entry.id === c.id)?.status).toBe("running");
    expect(host.executions.reduce((count, execution) => count + execution.stopCalls, 0)).toBe(1);
  });

  it("does not double-cancel when called concurrently with cancel", async () => {
    const a = await runner.spawn({
      prompt: "a",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    await Promise.all([runner.cancelBySession("session-abc"), runner.cancel(a.id)]);

    expect(host.executions[0]?.stopCalls).toBe(1);
    expect(runner.list().find((entry) => entry.id === a.id)?.status).toBe("cancelled");
  });
});
