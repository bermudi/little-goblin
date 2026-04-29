import { describe, it, expect, mock } from "bun:test";
import {
  interruptAndCascade,
  type InterruptableRunner,
  type InterruptableSubagentRunner,
} from "./interrupt.ts";

function makeRunner(opts: {
  isStreaming: boolean;
  abort?: () => Promise<void>;
}): InterruptableRunner & { abort: ReturnType<typeof mock> } {
  const abort = mock(opts.abort ?? (async () => {}));
  return {
    get isStreaming() {
      return opts.isStreaming;
    },
    abort,
  };
}

function makeSubagentRunner(
  subs: ReadonlyArray<{ id: string; status: string }>,
  cancelImpl?: (id: string) => Promise<void>,
): InterruptableSubagentRunner & { cancel: ReturnType<typeof mock> } {
  const cancel = mock(cancelImpl ?? (async (_id: string) => {}));
  return {
    list: () => subs,
    cancel,
  };
}

describe("interruptAndCascade", () => {
  it("calls runner.abort when streaming", async () => {
    const runner = makeRunner({ isStreaming: true });
    const sr = makeSubagentRunner([]);
    const res = await interruptAndCascade(runner, sr);
    expect(runner.abort).toHaveBeenCalledTimes(1);
    expect(res.attemptedMain).toBe(true);
    expect(res.timedOutMain).toBe(false);
  });

  it("does not call runner.abort when idle", async () => {
    const runner = makeRunner({ isStreaming: false });
    const sr = makeSubagentRunner([]);
    const res = await interruptAndCascade(runner, sr);
    expect(runner.abort).not.toHaveBeenCalled();
    expect(res.attemptedMain).toBe(false);
  });

  it("works with a null runner (no active session)", async () => {
    const sr = makeSubagentRunner([{ id: "a", status: "running" }]);
    const res = await interruptAndCascade(null, sr);
    expect(sr.cancel).toHaveBeenCalledWith("a");
    expect(res.attemptedMain).toBe(false);
    expect(res.attemptedSubagents).toBe(1);
  });

  it("cancels every running subagent and reports the count", async () => {
    const runner = makeRunner({ isStreaming: false });
    const sr = makeSubagentRunner([
      { id: "a", status: "running" },
      { id: "b", status: "running" },
      { id: "c", status: "completed" },
      { id: "d", status: "cancelled" },
      { id: "e", status: "running" },
    ]);
    const res = await interruptAndCascade(runner, sr);
    expect(sr.cancel).toHaveBeenCalledTimes(3);
    const ids = sr.cancel.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual(["a", "b", "e"]);
    expect(res.attemptedSubagents).toBe(3);
    expect(res.timedOutSubagents).toBe(0);
  });

  it("continues when runner.abort throws", async () => {
    const runner = makeRunner({
      isStreaming: true,
      abort: async () => {
        throw new Error("boom");
      },
    });
    const sr = makeSubagentRunner([{ id: "a", status: "running" }]);
    const res = await interruptAndCascade(runner, sr);
    expect(sr.cancel).toHaveBeenCalledWith("a");
    // A throwing abort still completed (synchronously rejected) — not a timeout.
    expect(res.timedOutMain).toBe(false);
    expect(res.attemptedMain).toBe(true);
  });

  it("continues when individual subagent cancels throw", async () => {
    const runner = makeRunner({ isStreaming: false });
    const sr = makeSubagentRunner(
      [
        { id: "a", status: "running" },
        { id: "b", status: "running" },
      ],
      async (id) => {
        if (id === "a") throw new Error("stuck");
      },
    );
    const res = await interruptAndCascade(runner, sr);
    expect(sr.cancel).toHaveBeenCalledTimes(2);
    expect(res.timedOutSubagents).toBe(0);
  });

  it("aborts the runner before cancelling subagents", async () => {
    const order: string[] = [];
    const runner: InterruptableRunner = {
      get isStreaming() {
        return true;
      },
      abort: async () => {
        order.push("abort");
      },
    };
    const sr: InterruptableSubagentRunner = {
      list: () => [{ id: "a", status: "running" }],
      cancel: async (_id: string) => {
        order.push("cancel");
      },
    };
    await interruptAndCascade(runner, sr);
    expect(order).toEqual(["abort", "cancel"]);
  });

  it("times out a stuck main runner abort without blocking the command", async () => {
    // The whole point of the timeout: a never-resolving abort must not hang
    // the user's command. With timeout=10ms this test should complete fast.
    const runner = makeRunner({
      isStreaming: true,
      abort: () => new Promise<void>(() => {}), // never resolves
    });
    const sr = makeSubagentRunner([{ id: "a", status: "running" }]);
    const start = Date.now();
    const res = await interruptAndCascade(runner, sr, 10);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(res.attemptedMain).toBe(true);
    expect(res.timedOutMain).toBe(true);
    // Subagent cancels still run after the main timeout.
    expect(sr.cancel).toHaveBeenCalledWith("a");
  });

  it("times out stuck subagent cancels and reports the count", async () => {
    const runner = makeRunner({ isStreaming: false });
    const sr = makeSubagentRunner(
      [
        { id: "stuck1", status: "running" },
        { id: "fast", status: "running" },
        { id: "stuck2", status: "running" },
      ],
      async (id) => {
        if (id === "fast") return;
        await new Promise<void>(() => {}); // never resolves
      },
    );
    const start = Date.now();
    const res = await interruptAndCascade(runner, sr, 10);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(res.attemptedSubagents).toBe(3);
    expect(res.timedOutSubagents).toBe(2);
  });
});
