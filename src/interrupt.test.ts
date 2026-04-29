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
    await interruptAndCascade(runner, sr);
    expect(runner.abort).toHaveBeenCalledTimes(1);
  });

  it("does not call runner.abort when idle", async () => {
    const runner = makeRunner({ isStreaming: false });
    const sr = makeSubagentRunner([]);
    await interruptAndCascade(runner, sr);
    expect(runner.abort).not.toHaveBeenCalled();
  });

  it("works with a null runner (no active session)", async () => {
    const sr = makeSubagentRunner([{ id: "a", status: "running" }]);
    await interruptAndCascade(null, sr);
    expect(sr.cancel).toHaveBeenCalledWith("a");
  });

  it("cancels every running subagent", async () => {
    const runner = makeRunner({ isStreaming: false });
    const sr = makeSubagentRunner([
      { id: "a", status: "running" },
      { id: "b", status: "running" },
      { id: "c", status: "completed" },
      { id: "d", status: "cancelled" },
      { id: "e", status: "running" },
    ]);
    await interruptAndCascade(runner, sr);
    expect(sr.cancel).toHaveBeenCalledTimes(3);
    const ids = sr.cancel.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual(["a", "b", "e"]);
  });

  it("continues when runner.abort throws", async () => {
    const runner = makeRunner({
      isStreaming: true,
      abort: async () => {
        throw new Error("boom");
      },
    });
    const sr = makeSubagentRunner([{ id: "a", status: "running" }]);
    await expect(interruptAndCascade(runner, sr)).resolves.toBeUndefined();
    expect(sr.cancel).toHaveBeenCalledWith("a");
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
    await expect(interruptAndCascade(runner, sr)).resolves.toBeUndefined();
    expect(sr.cancel).toHaveBeenCalledTimes(2);
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
});
