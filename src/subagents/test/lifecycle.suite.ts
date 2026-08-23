import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, rmSync } from "node:fs";
import { SubagentCancellationRejectedError, SubagentRunner } from "../mod.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import { markCompleted, SubagentTerminalError } from "../execution.ts";
import type { SubagentInstance } from "../types.ts";
import {
  delegatedWorkRecordPath,
  delegatedWorkRunDir,
} from "../../delegated-work/paths.ts";
import {
  completeAndAcknowledge,
  createTestHome,
  DEFAULT_AUTHORITY,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
  readRecord,
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

  it("rejects an unknown cancellation synchronously before delegated handoff", () => {
    expect(() => runner.beginCancel("nonexistent"))
      .toThrow(SubagentCancellationRejectedError);
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

    const meta = readRecord(tmp, handle.id);
    expect(meta.status).toBe("cancelled");
    expect(meta.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stops the prepared execution on cancel", async () => {
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    await runner.cancel(handle.id);

    expect(host.latest().stopCalls).toBe(1);
  });

  it("shares pending cancellation cleanup and its failure with a concurrent caller", async () => {
    const cleanupFailure = new Error("stop cleanup failed");
    host.stopFailure = cleanupFailure;
    let releaseStop!: () => void;
    host.stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    let firstSettled = false;
    let secondSettled = false;
    const first = runner.cancel(handle.id).finally(() => {
      firstSettled = true;
    });
    const second = runner.cancel(handle.id).finally(() => {
      secondSettled = true;
    });
    await flush();

    expect(host.latest().stopCalls).toBe(1);
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    releaseStop();
    const outcomes = await Promise.allSettled([first, second]);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
    expect(outcomes).toEqual([
      { status: "rejected", reason: cleanupFailure },
      { status: "rejected", reason: cleanupFailure },
    ]);
  });

  it("retains host registration when cancellation persistence fails, allowing a later invalidation retry", async () => {
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    const instance = (runner as unknown as { activeSubagents: Map<string, SubagentInstance> }).activeSubagents.get(handle.id);
    expect(instance).toBeDefined();
    const runtimeId = instance!.delegatedOwnership!.runtimeId;
    expect(runner.delegatedWorkHost.registeredForRuntime(runtimeId)).toBe(1);

    const delegatedHost = runner.delegatedWorkHost;
    const originalCancelInvocation = delegatedHost.cancelInvocation.bind(delegatedHost);
    let closeCalls = 0;
    delegatedHost.cancelInvocation = (id, index) => {
      closeCalls += 1;
      if (closeCalls === 1) throw new Error("disk full");
      return originalCancelInvocation(id, index);
    };

    await expect(runner.cancel(handle.id)).rejects.toThrow("disk full");

    expect(runner.list()[0]?.status).toBe("cancelled");
    expect(runner.delegatedWorkHost.registeredForRuntime(runtimeId)).toBe(1);
    let diskRecord = readRecord(tmp, handle.id);
    expect(diskRecord.status).toBe("running");

    // Restore the host boundary and retry via runtime invalidation.
    delegatedHost.cancelInvocation = originalCancelInvocation;
    await runner.delegatedWorkHost.invalidateRuntime(runtimeId);

    expect(runner.delegatedWorkHost.registeredForRuntime(runtimeId)).toBe(0);
    diskRecord = readRecord(tmp, handle.id);
    expect(diskRecord.status).toBe("cancelled");
    expect(diskRecord.deliveryState).toBe("suppressed");
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
    await completeAndAcknowledge(runner, host, first);

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
    markCompleted(aInst!, runner.delegatedWorkHost);
    runner.acknowledgeDelivery(a.id);

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
    markCompleted(bInst!, runner.delegatedWorkHost);
    runner.acknowledgeDelivery(b.id);

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
    const meta = readRecord(tmp, handle.id);
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

    const meta = readRecord(tmp, handle.id);
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

    let meta = readRecord(tmp, handle.id);
    expect(meta.status).toBe("completed");

    await runner.dispose();

    meta = readRecord(tmp, handle.id);
    expect(meta.status).toBe("completed");
  });

  it("preserves errored meta.json status on dispose", async () => {
    const handle = await runner.spawn({ prompt: "a", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    host.latest().fail(new Error("boom"));
    await expect(handle.result).rejects.toThrow("boom");

    let meta = readRecord(tmp, handle.id);
    expect(meta.status).toBe("error");

    await runner.dispose();

    meta = readRecord(tmp, handle.id);
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
    const metaPath = delegatedWorkRecordPath(tmp, handle.id);
    const dir = delegatedWorkRunDir(tmp, handle.id);

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

    const metaPath = delegatedWorkRecordPath(tmp, handle.id);
    const dir = delegatedWorkRunDir(tmp, handle.id);
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

    const aMeta = readRecord(tmp, a.id);
    const bMeta = readRecord(tmp, b.id);
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
    markCompleted(aInst!, runner.delegatedWorkHost);

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
    markCompleted(aInst!, runner.delegatedWorkHost);

    await runner.cancelBySession("session-abc");

    expect(aInst?.status).toBe("completed");
    const meta = readRecord(tmp, a.id);
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

  it("sets deliveryState to suppressed and releases the delegated registration", async () => {
    const a = await runner.spawn({
      prompt: "a",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    a.result.catch(() => {});
    await flush();

    const aInst = getInstance(a.id);
    expect(aInst).toBeDefined();
    const runtimeId = aInst!.delegatedOwnership!.runtimeId;
    expect(runner.delegatedWorkHost.registeredForRuntime(runtimeId)).toBe(1);

    await runner.cancelBySession("session-abc");

    const cancelledRecord = readRecord(tmp, a.id);
    expect(cancelledRecord.status).toBe("cancelled");
    expect(cancelledRecord.deliveryState).toBe("suppressed");
    expect(runner.list().find((entry) => entry.id === a.id)?.deliveryState).toBe("suppressed");
    expect(runner.delegatedWorkHost.registeredForRuntime(runtimeId)).toBe(0);

    // The next spawn triggers pruneTerminal, which can now remove the terminal
    // instance because its deliveryState is no longer pending and its
    // delegated registration has been released.
    const b = await runner.spawn({
      prompt: "b",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    b.result.catch(() => {});
    await flush();

    expect(getInstance(a.id)).toBeUndefined();
    expect(runner.list().some((entry) => entry.id === a.id)).toBe(false);
  });

  it("suppresses pending delivery for a completion-claimed instance", async () => {
    const a = await runner.spawn({
      prompt: "a",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    a.result.catch(() => {});
    await flush();

    const aInst = getInstance(a.id);
    expect(aInst).toBeDefined();
    const runtimeId = aInst!.delegatedOwnership!.runtimeId;
    expect(runner.delegatedWorkHost.registeredForRuntime(runtimeId)).toBe(1);

    // Claim completion without awaiting the result, so the coordinator sees a
    // running instance whose completion has been claimed and whose delivery is
    // still pending when cancellation begins.
    host.latest().complete("done");
    await runner.cancelBySession("session-abc");

    const record = readRecord(tmp, a.id);
    expect(record.status).toBe("completed");
    expect(record.deliveryState).toBe("suppressed");
    expect(runner.list().find((entry) => entry.id === a.id)?.deliveryState).toBe("suppressed");
    expect(runner.delegatedWorkHost.registeredForRuntime(runtimeId)).toBe(0);
  });
});
