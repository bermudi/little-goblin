import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { SubagentRunner } from "../mod.ts";
import { markCompleted } from "../execution.ts";
import type { SubagentInstance, SubagentMeta } from "../types.ts";
import { genericSubagentMetaPath } from "../paths.ts";
import {
  createTestHome,
  DEFAULT_SCOPE,
  flush,
  installStandardPiMock,
  makeConfig,
  resetPiMockState,
  sessionHolder,
} from "./support.ts";

// Install mock before any tests run
installStandardPiMock();

describe("SubagentRunner.cancel", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-cancel-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws 'Subagent not found' for unknown id", async () => {
    await expect(runner.cancel("nonexistent")).rejects.toThrow("Subagent not found");
  });

  it("calls session.abort() and updates status to cancelled", async () => {
    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();

    expect(sessionHolder.abort).not.toHaveBeenCalled();
    await runner.cancel(handle.id);

    expect(sessionHolder.abort).toHaveBeenCalledTimes(1);
    expect(runner.list().find((entry) => entry.id === handle.id)?.status).toBe("cancelled");
  });

  it("persists status=cancelled to meta.json with completedAt", async () => {
    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();

    await runner.cancel(handle.id);

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("cancelled");
    expect(meta.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("cleans up the event subscription on cancel", async () => {
    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();

    const listenerCountBefore = sessionHolder.listeners.length;
    expect(listenerCountBefore).toBeGreaterThanOrEqual(1);

    await runner.cancel(handle.id);

    expect(sessionHolder.listeners.length).toBeLessThan(listenerCountBefore);
  });
});

describe("SubagentRunner.list", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagents-list-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty array when no subagents are active", () => {
    expect(runner.list()).toEqual([]);
  });

  it("returns multiple subagents with correct shape", async () => {
    const first = await runner.spawn({ prompt: "a", activeScope: DEFAULT_SCOPE });
    first.result.catch(() => {});
    const second = await runner.spawn({ prompt: "b", activeScope: DEFAULT_SCOPE });
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
    const handle = await runner.spawn({ prompt: "x", activeScope: DEFAULT_SCOPE });
    await flush();
    await runner.cancel(handle.id);

    expect(runner.list()).toHaveLength(1);
    expect(runner.list()[0]?.status).toBe("cancelled");
  });

  it("reflects completed status after agent_end", async () => {
    const handle = await runner.spawn({ prompt: "x", activeScope: DEFAULT_SCOPE });
    await flush();

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    expect(runner.list()[0]?.status).toBe("completed");
  });
});

describe("SubagentRunner — prune terminal instances", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-prune-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prunes completed subagents on next spawn", async () => {
    const first = await runner.spawn({ prompt: "a", activeScope: DEFAULT_SCOPE });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await first.result;

    expect(runner.list()).toHaveLength(1);

    const second = await runner.spawn({ prompt: "b", activeScope: DEFAULT_SCOPE });
    second.result.catch(() => {});
    await flush();

    const ids = runner.list().map((entry) => entry.id);
    expect(ids).not.toContain(first.id);
    expect(ids).toContain(second.id);

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await second.result;
  });

  it("prunes cancelled subagents on next spawn", async () => {
    const first = await runner.spawn({ prompt: "a", activeScope: DEFAULT_SCOPE });
    await flush();
    await runner.cancel(first.id);

    expect(runner.list()).toHaveLength(1);

    const second = await runner.spawn({ prompt: "b", activeScope: DEFAULT_SCOPE });
    second.result.catch(() => {});
    await flush();

    expect(runner.list().map((entry) => entry.id)).not.toContain(first.id);
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await second.result;
  });
});

describe("SubagentRunner — dispose", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-dispose-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("cancels running subagents and clears the map", async () => {
    const handle = await runner.spawn({ prompt: "a", activeScope: DEFAULT_SCOPE });
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
    const handle = await runner.spawn({ prompt: "a", activeScope: DEFAULT_SCOPE });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    expect(runner.list()).toHaveLength(1);
    await runner.dispose();
    expect(runner.list()).toHaveLength(0);
  });
});

describe("SubagentRunner — cancel with abort() that throws", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-cancel-abort-throws-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("still updates status and cleans up if session.abort() throws", async () => {
    sessionHolder.abort = mock(async () => {
      throw new Error("abort-failed");
    });

    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();
    await runner.cancel(handle.id);

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
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects spawn after dispose", async () => {
    await runner.dispose();
    await expect(runner.spawn({ prompt: "late", activeScope: DEFAULT_SCOPE })).rejects.toThrow("SubagentRunner is disposed");
  });

  it("rejects spawn even if active map was empty at dispose time", async () => {
    expect(runner.list()).toEqual([]);
    await runner.dispose();
    await expect(runner.spawn({ prompt: "x", activeScope: DEFAULT_SCOPE })).rejects.toThrow("SubagentRunner is disposed");
  });
});

describe("SubagentRunner — dispose does not overwrite completed", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-dispose-no-overwrite-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("preserves completed meta.json status on dispose", async () => {
    const handle = await runner.spawn({ prompt: "a", activeScope: DEFAULT_SCOPE });
    await flush();
    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;

    let meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("completed");

    await runner.dispose();

    meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("completed");
  });

  it("preserves errored meta.json status on dispose", async () => {
    sessionHolder.sendUserMessage = mock(async () => {
      throw new Error("boom");
    });

    const handle = await runner.spawn({ prompt: "a", activeScope: DEFAULT_SCOPE });
    await flush();
    await flush();
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

  beforeEach(() => {
    tmp = createTestHome("goblin-persist-resilience-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("markErrored still updates in-memory status when persistMeta fails", async () => {
    sessionHolder.sendUserMessage = mock(async () => {
      throw new Error("first-fail");
    });

    const handle = await runner.spawn({ prompt: "trigger", activeScope: DEFAULT_SCOPE });
    const metaPath = genericSubagentMetaPath(tmp, handle.id);
    const dir = dirname(metaPath);

    rmSync(metaPath);
    chmodSync(dir, 0o444);

    await flush();
    await flush();

    await expect(handle.result).rejects.toThrow("first-fail");
    expect(runner.list().find((entry) => entry.id === handle.id)?.status).toBe("error");

    chmodSync(dir, 0o755);
  });

  it("markCompleted still resolves with text when persistMeta fails", async () => {
    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();

    const metaPath = genericSubagentMetaPath(tmp, handle.id);
    const dir = dirname(metaPath);
    rmSync(metaPath);
    chmodSync(dir, 0o444);

    sessionHolder.emit({ type: "agent_start" });
    sessionHolder.emit({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "important result" },
    });
    sessionHolder.emit({ type: "agent_end", messages: [] });

    await expect(handle.result).resolves.toBe("important result");
    expect(runner.list().find((entry) => entry.id === handle.id)?.status).toBe("completed");

    chmodSync(dir, 0o755);
  });
});

describe("SubagentRunner.cancelBySession", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-cancel-by-session-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
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
      activeScope: DEFAULT_SCOPE,
      spawnedBy: "session-abc",
    });
    const b = await runner.spawn({
      prompt: "b",
      activeScope: DEFAULT_SCOPE,
      spawnedBy: "session-abc",
    });
    await flush();

    await runner.cancelBySession("session-abc");

    expect(sessionHolder.abort).toHaveBeenCalledTimes(2);
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
      activeScope: DEFAULT_SCOPE,
      spawnedBy: "session-abc",
    });
    const b = await runner.spawn({
      prompt: "b",
      activeScope: DEFAULT_SCOPE,
      spawnedBy: a.id,
      depth: 1,
    });
    await flush();

    await runner.cancelBySession("session-abc");

    expect(runner.list().find((entry) => entry.id === a.id)?.status).toBe("cancelled");
    expect(runner.list().find((entry) => entry.id === b.id)?.status).toBe("cancelled");
    expect(sessionHolder.abort).toHaveBeenCalledTimes(2);
  });

  it("cancels a running child even when its parent is already terminal", async () => {
    const a = await runner.spawn({
      prompt: "a",
      activeScope: DEFAULT_SCOPE,
      spawnedBy: "session-abc",
    });
    await flush();

    const b = await runner.spawn({
      prompt: "b",
      activeScope: DEFAULT_SCOPE,
      spawnedBy: a.id,
      depth: 1,
    });
    await flush();

    const aInst = getInstance(a.id);
    expect(aInst).toBeDefined();
    markCompleted(aInst!);

    await runner.cancelBySession("session-abc");

    expect(aInst?.status).toBe("completed");
    expect(runner.list().find((entry) => entry.id === b.id)?.status).toBe("cancelled");
    expect(sessionHolder.abort).toHaveBeenCalledTimes(1);
  });

  it("skips terminal instances", async () => {
    const a = await runner.spawn({
      prompt: "a",
      activeScope: DEFAULT_SCOPE,
      spawnedBy: "session-abc",
    });
    await flush();

    const aInst = getInstance(a.id);
    expect(aInst).toBeDefined();
    markCompleted(aInst!);

    await runner.cancelBySession("session-abc");

    expect(aInst?.status).toBe("completed");
    const meta = JSON.parse(readFileSync(genericSubagentMetaPath(tmp, a.id), "utf-8")) as SubagentMeta;
    expect(meta.status).toBe("completed");
    expect(sessionHolder.abort).not.toHaveBeenCalled();
  });

  it("does not match null spawnedBy", async () => {
    await runner.spawn({ prompt: "a", activeScope: DEFAULT_SCOPE });
    await flush();

    await runner.cancelBySession("session-abc");

    expect(runner.list()[0]?.status).toBe("running");
    expect(sessionHolder.abort).not.toHaveBeenCalled();
  });

  it("is a no-op when no subagents match the session", async () => {
    await runner.cancelBySession("session-xyz");

    expect(sessionHolder.abort).not.toHaveBeenCalled();
    expect(runner.list()).toHaveLength(0);
  });

  it("does not cancel subagents of other sessions", async () => {
    const a = await runner.spawn({
      prompt: "a",
      activeScope: DEFAULT_SCOPE,
      spawnedBy: "session-abc",
    });
    const c = await runner.spawn({
      prompt: "c",
      activeScope: DEFAULT_SCOPE,
      spawnedBy: "session-def",
    });
    await flush();

    await runner.cancelBySession("session-abc");

    expect(runner.list().find((entry) => entry.id === a.id)?.status).toBe("cancelled");
    expect(runner.list().find((entry) => entry.id === c.id)?.status).toBe("running");
    expect(sessionHolder.abort).toHaveBeenCalledTimes(1);
  });

  it("does not double-cancel when called concurrently with cancel", async () => {
    const a = await runner.spawn({
      prompt: "a",
      activeScope: DEFAULT_SCOPE,
      spawnedBy: "session-abc",
    });
    await flush();

    await Promise.all([runner.cancelBySession("session-abc"), runner.cancel(a.id)]);

    expect(sessionHolder.abort).toHaveBeenCalledTimes(1);
    expect(runner.list().find((entry) => entry.id === a.id)?.status).toBe("cancelled");
  });
});
