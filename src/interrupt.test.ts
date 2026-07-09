import { describe, it, expect, mock } from "bun:test";
import {
  interruptAndCascade,
  type InterruptableRunner,
  type InterruptableSubagentRunner,
} from "./interrupt.ts";

function makeRunner(opts: {
  isStreaming: boolean;
  isAbortTimedOut?: boolean;
  abort?: () => Promise<void>;
}): InterruptableRunner & { abort: ReturnType<typeof mock>; markAbortTimedOut: ReturnType<typeof mock> } {
  const abort = mock(opts.abort ?? (async () => {}));
  const markAbortTimedOut = mock(() => {});
  return {
    get isStreaming() {
      return opts.isStreaming;
    },
    get isAbortTimedOut() {
      return opts.isAbortTimedOut ?? false;
    },
    abort,
    markAbortTimedOut,
  };
}

function makeSubagentRunner(
  subs: ReadonlyArray<{ id: string; status: string; spawnedBy?: string | null }>,
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
      get isAbortTimedOut() {
        return false;
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

  it("waits for isStreaming to settle false after abort resolves", async () => {
    // Simulates pi's behaviour where session.abort() resolves before
    // isStreaming flips — the cascade should not return until the
    // runner is actually idle so /new /archive don't race event
    // flushes. We flip streaming → false 30ms after abort resolves.
    let streaming = true;
    setTimeout(() => {
      streaming = false;
    }, 30);
    const runner: InterruptableRunner = {
      get isStreaming() {
        return streaming;
      },
      get isAbortTimedOut() {
        return false;
      },
      abort: async () => {
        // abort resolves immediately; isStreaming is still true
      },
    };
    const sr = makeSubagentRunner([]);
    const start = Date.now();
    await interruptAndCascade(runner, sr);
    const elapsed = Date.now() - start;
    expect(streaming).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(600);
  });

  it("gives up waiting for idle after the bounded max (500ms)", async () => {
    // Never flips streaming → false. The cascade should not hang;
    // it should log and proceed after the internal max-wait.
    const runner: InterruptableRunner = {
      get isStreaming() {
        return true;
      },
      get isAbortTimedOut() {
        return false;
      },
      abort: async () => {},
    };
    const sr = makeSubagentRunner([]);
    const start = Date.now();
    await interruptAndCascade(runner, sr);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  it("calls markAbortTimedOut on the runner when main abort times out", async () => {
    const runner = makeRunner({
      isStreaming: true,
      abort: () => new Promise<void>(() => {}),
    });
    const sr = makeSubagentRunner([]);
    const res = await interruptAndCascade(runner, sr, 10);
    expect(res.timedOutMain).toBe(true);
    expect(runner.markAbortTimedOut).toHaveBeenCalledTimes(1);
  });

  it("does not call markAbortTimedOut when abort resolves in time", async () => {
    const runner = makeRunner({ isStreaming: true });
    const sr = makeSubagentRunner([]);
    await interruptAndCascade(runner, sr);
    expect(runner.markAbortTimedOut).not.toHaveBeenCalled();
  });

  it("reports wedgedMain and does not re-abort when runner is already wedged", async () => {
    const runner = makeRunner({ isStreaming: false, isAbortTimedOut: true });
    const sr = makeSubagentRunner([]);
    const res = await interruptAndCascade(runner, sr);
    expect(res.attemptedMain).toBe(true);
    expect(res.wedgedMain).toBe(true);
    expect(res.timedOutMain).toBe(false);
    expect(runner.abort).not.toHaveBeenCalled();
  });

  it("tolerates a runner without markAbortTimedOut (optional hook)", async () => {
    // The interface marks markAbortTimedOut as optional; a legacy runner
    // without it shouldn't crash the cascade when abort times out.
    const abort = mock(() => new Promise<void>(() => {}));
    const runner: InterruptableRunner = {
      get isStreaming() {
        return true;
      },
      get isAbortTimedOut() {
        return false;
      },
      abort,
    };
    const sr = makeSubagentRunner([]);
    const res = await interruptAndCascade(runner, sr, 10);
    expect(res.timedOutMain).toBe(true);
  });

  describe("session scoping", () => {
    it("when sessionId given, only cancels subagents in the session tree", async () => {
      const sr = makeSubagentRunner([
        { id: "a", status: "running", spawnedBy: "sess-A" },
        { id: "b", status: "running", spawnedBy: "sess-B" },
        { id: "c", status: "running", spawnedBy: "a" }, // nested under a
        { id: "d", status: "running", spawnedBy: "b" }, // nested under b
      ]);
      const res = await interruptAndCascade(null, sr, 5000, "sess-A");
      const ids = sr.cancel.mock.calls.map((c) => c[0]).sort();
      expect(ids).toEqual(["a", "c"]);
      expect(res.attemptedSubagents).toBe(2);
    });

    it("walks the spawnedBy chain transitively (depth > 2)", async () => {
      const sr = makeSubagentRunner([
        { id: "a", status: "running", spawnedBy: "sess-A" },
        { id: "b", status: "running", spawnedBy: "a" },
        { id: "c", status: "running", spawnedBy: "b" },
      ]);
      await interruptAndCascade(null, sr, 5000, "sess-A");
      expect(sr.cancel).toHaveBeenCalledTimes(3);
    });

    it("skips subagents with null spawnedBy when sessionId is set", async () => {
      const sr = makeSubagentRunner([
        { id: "a", status: "running", spawnedBy: null },
        { id: "b", status: "running", spawnedBy: "sess-A" },
      ]);
      await interruptAndCascade(null, sr, 5000, "sess-A");
      const ids = sr.cancel.mock.calls.map((c) => c[0]);
      expect(ids).toEqual(["b"]);
    });

    it("without sessionId, cancels every running subagent (legacy behaviour)", async () => {
      const sr = makeSubagentRunner([
        { id: "a", status: "running", spawnedBy: "sess-A" },
        { id: "b", status: "running", spawnedBy: "sess-B" },
      ]);
      await interruptAndCascade(null, sr);
      expect(sr.cancel).toHaveBeenCalledTimes(2);
    });
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
