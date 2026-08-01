import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { genericSubagentMetaPath } from "../paths.ts";
import { SubagentRunner } from "../mod.ts";
import type { SubagentHost } from "../host.ts";
import { markCompleted } from "../execution.ts";
import type { SubagentInstance, SubagentMeta } from "../types.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import {
  createTestHome,
  DEFAULT_AUTHORITY,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
} from "./support.ts";

describe("SubagentRunner — cancel guards", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-cancel-guards-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("cancel on completed subagent is a no-op (doesn't overwrite status)", async () => {
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    host.latest().complete("done");
    await handle.result;
    expect(runner.list()[0]?.status).toBe("completed");

    await runner.cancel(handle.id);
    expect(runner.list()[0]?.status).toBe("completed");
    expect(host.latest().stopCalls).toBe(0);
  });

  it("cancel on errored subagent is a no-op", async () => {
    const handle = await runner.spawn({ prompt: "trigger", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    host.latest().fail(new Error("boom"));
    await expect(handle.result).rejects.toThrow("boom");

    expect(runner.list()[0]?.status).toBe("error");
    await runner.cancel(handle.id);
    expect(runner.list()[0]?.status).toBe("error");
  });

  it("cancel during coordinator setup phase prevents execution.run()", async () => {
    // Block execution.run() before it records the invocation. After flush(),
    // the coordinator has completed its async memory/tool setup and is stuck
    // at the runBarrier inside FakeSubagentExecution.run() — the invocation
    // has NOT been accepted yet. Cancelling here exercises the pre-run()
    // isCancelled() window in runInvocation: cancel claims "cancelled"
    // synchronously, stop() sets `stopped`, and when the barrier releases,
    // run() sees `stopped` and rejects without ever recording the invocation.
    let releaseRun!: () => void;
    host.runBarrier = new Promise<void>((resolve) => { releaseRun = resolve; });

    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    // The coordinator has reached execution.run() but it is blocked on the
    // barrier — no invocation has been recorded.
    expect(host.latest().invocations.length).toBe(0);

    const cancelPromise = runner.cancel(handle.id);
    // cancel() synchronously claims "cancelled" before awaiting stop.
    expect(runner.list()[0]?.status).toBe("cancelled");

    // Release the run barrier so execution.run() can proceed; it will see
    // `stopped` and reject, unblocking the coordinator settlement that
    // cancel() is waiting on via collectSettlement.
    releaseRun();
    await cancelPromise;

    expect(runner.list()[0]?.status).toBe("cancelled");
    expect(host.latest().invocations.length).toBe(0);
    expect(host.latest().stopCalls).toBe(1);
    await handle.result.catch(() => {});
  });
});

describe("SubagentRunner — startup error handling", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-startup-err-");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("marks meta as error when execution startup throws", async () => {
    const startupError = new Error("session-creation-failed");
    const failingHost: SubagentHost = {
      prepare: () => ({
        run: async () => {
          throw startupError;
        },
        stop: async () => {},
      }),
    };
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, failingHost);

    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await expect(handle.result).rejects.toBe(startupError);

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("error");
    expect(meta.errorMessage).toBe("session-creation-failed");
  });
});

describe("SubagentRunner — double-cancel race guard", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-cancel-race-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("second cancel is a no-op when first cancels synchronously", async () => {
    const handle = await runner.spawn({ prompt: "work", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    await Promise.all([runner.cancel(handle.id), runner.cancel(handle.id)]);

    expect(host.latest().stopCalls).toBe(1);
    expect(runner.list()[0]?.status).toBe("cancelled");
  });
});

describe("SubagentRunner — cancel vs completion race", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-cancel-race-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("completion arriving during cancel() does not overwrite cancelled status", async () => {
    const handle = await runner.spawn({ prompt: "test", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    // Hold stop() in-flight so complete() can race with it. The barrier must
    // be set on the execution directly — the host copies it during prepare(),
    // which already ran inside spawn(). With the deferred settled check,
    // complete() genuinely resolves the completion promise while stop() is
    // still pending — the coordinator receives "late" but markCompleted is
    // skipped because instance.status is already "cancelled".
    let resolveStop!: () => void;
    host.latest().stopBarrier = new Promise<void>((resolve) => { resolveStop = resolve; });
    const cancelPromise = runner.cancel(handle.id);
    host.latest().complete("late");
    resolveStop();
    await cancelPromise;

    expect(runner.list().find((entry) => entry.id === handle.id)?.status).toBe("cancelled");
    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("cancelled");
  });

  it("failure arriving during cancel() does not overwrite cancelled status", async () => {
    const handle = await runner.spawn({ prompt: "test", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();

    // Same stopBarrier interleaving as the completion race. The barrier is set
    // on the execution directly (the host copies it during prepare(), which
    // already ran). fail() genuinely rejects the completion promise while
    // stop() is still pending. The coordinator receives the error but
    // markErrored is skipped because instance.status is already "cancelled".
    // The late failure propagates through collectSettlement and is surfaced
    // by cancel() — but the lifecycle status remains "cancelled" regardless.
    let resolveStop!: () => void;
    host.latest().stopBarrier = new Promise<void>((resolve) => { resolveStop = resolve; });
    const cancelPromise = runner.cancel(handle.id);
    host.latest().fail(new Error("late failure"));
    resolveStop();

    // cancel() surfaces the late failure (it is not a StoppedError, so
    // collectSettlement does not filter it), but the lifecycle guard
    // prevents markErrored from overwriting the "cancelled" status.
    await expect(cancelPromise).rejects.toThrow("late failure");
    expect(runner.list().find((entry) => entry.id === handle.id)?.status).toBe("cancelled");
    await handle.result.catch(() => {});
  });
});

describe("SubagentRunner — parent status guard", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-parent-guard-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("allows child spawn when parent is running", async () => {
    const parent = await runner.spawn({
      prompt: "parent",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    const child = await runner.spawn({
      prompt: "child",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: parent.id,
      depth: 1,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    expect(child.status).toBe("running");
  });

  it("rejects child spawn when parent is completed", async () => {
    const parent = await runner.spawn({
      prompt: "parent",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    const parentInst = (runner as unknown as { activeSubagents: Map<string, SubagentInstance> }).activeSubagents.get(
      parent.id,
    );
    expect(parentInst).toBeDefined();
    markCompleted(parentInst!);

    await expect(
      runner.spawn({
        prompt: "child",
        authority: DEFAULT_AUTHORITY,
        spawnedBy: parent.id,
        depth: 1,
        inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
      }),
    ).rejects.toThrow("Cannot spawn subagent from a non-running parent");
  });

  it("rejects child spawn when parent is cancelled", async () => {
    const parent = await runner.spawn({
      prompt: "parent",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-abc",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    await runner.cancel(parent.id);

    await expect(
      runner.spawn({
        prompt: "child",
        authority: DEFAULT_AUTHORITY,
        spawnedBy: parent.id,
        depth: 1,
        inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
      }),
    ).rejects.toThrow("Cannot spawn subagent from a non-running parent");
  });

  it("allows top-level spawn with a session id that is not an active subagent", async () => {
    const handle = await runner.spawn({
      prompt: "top",
      authority: DEFAULT_AUTHORITY,
      spawnedBy: "session-xyz",
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    expect(handle.status).toBe("running");
    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.spawnedBy).toBe("session-xyz");
  });
});
