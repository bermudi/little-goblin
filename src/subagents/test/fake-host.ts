import {
  SubagentExecutionStoppedError,
  type SubagentExecution,
  type SubagentHost,
  type SubagentInvocation,
  type SubagentPreparation,
} from "../host.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Deterministic per-invocation lease used by coordinator/lifecycle tests. */
export class FakeSubagentExecution implements SubagentExecution {
  readonly invocations: SubagentInvocation[] = [];
  stopCalls = 0;
  stopFailure: unknown = undefined;
  stopBarrier: Promise<void> | null = null;
  /**
   * When set, `run()` awaits this promise before recording the invocation.
   * This lets tests deterministically cancel during the coordinator setup
   * phase — after the `isCancelled` checks in `runInvocation` but before
   * `run()` has accepted the invocation — exercising the pre-`run()` cancel
   * window without timers.
   */
  runBarrier: Promise<void> | null = null;
  private readonly completion = deferred<string>();
  private stopped = false;
  private settled = false;
  private runStarted = false;

  run(invocation: SubagentInvocation): Promise<string> {
    if (this.stopped) return Promise.reject(new SubagentExecutionStoppedError());
    if (this.invocations.length > 0) {
      return Promise.reject(new Error("fake subagent execution can only run once"));
    }
    const barrier = this.runBarrier;
    if (barrier === null) {
      this.invocations.push(invocation);
      this.runStarted = true;
      return this.completion.promise;
    }
    // Await the barrier before recording the invocation so a concurrent
    // stop() can observe `stopped` and reject without ever accepting the run.
    return (async () => {
      await barrier;
      if (this.stopped) return Promise.reject(new SubagentExecutionStoppedError());
      this.invocations.push(invocation);
      this.runStarted = true;
      return this.completion.promise;
    })();
  }

  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    this.stopCalls += 1;
    const barrier = this.stopBarrier;
    return (async () => {
      if (barrier !== null) await barrier;
      // Claim the terminal only after the barrier resolves. While the barrier
      // is pending, `complete()`/`fail()` can genuinely race with `stop()`,
      // simulating a late Pi event arriving concurrently with cancellation.
      // Without this deferral, `settled` would be set synchronously and the
      // late event would silently no-op, masking the race entirely.
      if (this.runStarted && !this.settled) {
        this.settled = true;
        this.completion.reject(new SubagentExecutionStoppedError());
      }
      if (this.stopFailure !== undefined) throw this.stopFailure;
    })();
  }

  complete(text: string): void {
    if (this.settled) return;
    this.settled = true;
    try {
      this.invocations.at(-1)?.onCompletionClaimed?.();
    } catch (error) {
      this.completion.reject(error);
      return;
    }
    this.completion.resolve(text);
  }

  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.completion.reject(error);
  }

  emitStatus(message: string): void {
    this.invocations.at(-1)?.onStatusUpdate?.(message);
  }
}

/**
 * One fake lease per `prepare()` call. Tests can inspect exact plans without
 * reaching into SubagentRunner's private active map.
 */
export class FakeSubagentHost implements SubagentHost {
  readonly preparations: SubagentPreparation[] = [];
  readonly executions: FakeSubagentExecution[] = [];
  stopFailure: unknown = undefined;
  stopBarrier: Promise<void> | null = null;
  /** Propagated to each execution's `runBarrier`; see {@link FakeSubagentExecution.runBarrier}. */
  runBarrier: Promise<void> | null = null;

  prepare(plan: SubagentPreparation): SubagentExecution {
    this.preparations.push(plan);
    const execution = new FakeSubagentExecution();
    execution.stopFailure = this.stopFailure;
    execution.stopBarrier = this.stopBarrier;
    execution.runBarrier = this.runBarrier;
    this.executions.push(execution);
    return execution;
  }

  latest(): FakeSubagentExecution {
    const execution = this.executions.at(-1);
    if (execution === undefined) throw new Error("No fake subagent execution exists");
    return execution;
  }
}
