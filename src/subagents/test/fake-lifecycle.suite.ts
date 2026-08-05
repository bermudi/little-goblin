import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../../memory/mod.ts";
import { SubagentRunner } from "../mod.ts";
import type { SubagentHost } from "../host.ts";
import { delegatedWorkRunDir } from "../../delegated-work/paths.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import {
  createTestHome,
  DEFAULT_AUTHORITY,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
  readRecord,
  validRecord,
  writeRecordAndSession,
} from "./support.ts";

class CloseFailingMemoryStore extends MemoryStore {
  closeCalls = 0;

  constructor(home: string, private readonly closeError: Error) {
    super(home);
  }

  override close(): void {
    this.closeCalls += 1;
    super.close();
    throw this.closeError;
  }
}

function containsError(error: unknown, target: Error): boolean {
  if (error === target) return true;
  if (error instanceof AggregateError) {
    return error.errors.some((nested) => containsError(nested, target));
  }
  return false;
}

describe("SubagentRunner lifecycle with an opaque fake host", () => {
  let home: string;
  let host: FakeSubagentHost;
  let runner: SubagentRunner;

  beforeEach(() => {
    home = createTestHome("goblin-subagent-fake-lifecycle-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(home), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("does not persist a running record when host preparation fails", async () => {
    const preparationError = new Error("history preparation failed");
    const failingHost: SubagentHost = {
      prepare: () => {
        throw preparationError;
      },
    };
    runner = new SubagentRunner(makeConfig(home), undefined, undefined, failingHost);

    await expect(
      runner.spawn({
        prompt: "work",
        authority: DEFAULT_AUTHORITY,
        inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
      }),
    ).rejects.toBe(preparationError);
    expect(runner.list()).toEqual([]);
  });

  it("keeps Pi resources out of lifecycle state while completing normally", async () => {
    const handle = await runner.spawn({
      prompt: "work",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    expect(host.preparations).toHaveLength(1);
    expect(host.preparations[0]?.history).toEqual({
      kind: "create",
      sessionDir: delegatedWorkRunDir(home, handle.id),
    });
    expect(host.latest().invocations[0]?.prompt).toBe("work");

    host.latest().complete("done");
    await expect(handle.result).resolves.toBe("done");
    expect(runner.list()[0]?.status).toBe("completed");

    const record = readRecord(home, handle.id);
    expect(record.status).toBe("completed");
  });

  it("claims completion before a concurrent cancellation can overwrite it", async () => {
    const handle = await runner.spawn({
      prompt: "work",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    const execution = host.latest();
    execution.complete("done");
    await runner.cancel(handle.id);

    await expect(handle.result).resolves.toBe("done");
    expect(execution.stopCalls).toBe(0);
    expect(runner.list()[0]?.status).toBe("completed");
    const record = readRecord(home, handle.id);
    expect(record.status).toBe("completed");
  });

  it("cancellation claims lifecycle first and stops the lease exactly once", async () => {
    const handle = await runner.spawn({
      prompt: "work",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    const execution = host.latest();
    await runner.cancel(handle.id);
    expect(execution.stopCalls).toBe(1);
    expect(runner.list()[0]?.status).toBe("cancelled");
    await expect(handle.result).rejects.toThrow("cancelled");

    // A late fake completion cannot resurrect the lifecycle record.
    execution.complete("late");
    expect(runner.list()[0]?.status).toBe("cancelled");
    const record = readRecord(home, handle.id);
    expect(record.status).toBe("cancelled");
  });

  it("surfaces startup and stop failures when cancellation races failStartup", async () => {
    let releaseStop!: () => void;
    const stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const startupError = new Error("memory setup failed");
    const stopError = new Error("startup stop failed");
    host.stopBarrier = stopBarrier;
    host.stopFailure = stopError;
    runner = new SubagentRunner(
      makeConfig(home),
      undefined,
      undefined,
      host,
      () => {
        throw startupError;
      },
    );

    const handle = await runner.spawn({
      prompt: "work",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    expect(host.latest().stopCalls).toBe(1);

    const cancellation = runner.cancel(handle.id);
    expect(runner.list()[0]?.status).toBe("cancelled");
    releaseStop();

    let failure: unknown;
    try {
      await cancellation;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(containsError(failure, startupError)).toBe(true);
    expect(containsError(failure, stopError)).toBe(true);
    expect(host.latest().stopCalls).toBe(1);
  });

  it("waits for memory cleanup on cancellation and surfaces close failure once", async () => {
    const closeError = new Error("memory close failed");
    const store = new CloseFailingMemoryStore(home, closeError);
    runner = new SubagentRunner(
      makeConfig(home),
      undefined,
      undefined,
      host,
      () => store,
    );

    const handle = await runner.spawn({
      prompt: "work",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    let failure: unknown;
    try {
      await runner.cancel(handle.id);
    } catch (error) {
      failure = error;
    }
    expect(containsError(failure, closeError)).toBe(true);
    await expect(handle.result).rejects.toThrow("Subagent was cancelled");
    expect(store.closeCalls).toBe(1);
    expect(runner.list()[0]?.status).toBe("cancelled");
  });

  it("revival passes the exact lexically selected history file to the host", async () => {
    const id = "revive-fake";
    const dir = delegatedWorkRunDir(home, id);
    writeRecordAndSession(home, id, validRecord(id), undefined);
    const olderHistory = join(dir, "2026-01-01T00-00-00_old.jsonl");
    const history = join(dir, "2026-01-02T00-00-00_new.jsonl");
    // Subagent revival intentionally keeps its lexical filename policy. The
    // host receives the selected path and does no compatibility discovery.
    writeFileSync(olderHistory, "{\"cwd\":\"/different/cwd\"}\n");
    writeFileSync(history, "{\"cwd\":\"/different/cwd\"}\n");

    const result = runner.revive(
      {
        kind: "surface",
        authority: DEFAULT_AUTHORITY,
        caller: { kind: "main" },
        frozenSummary: null,
        frozenUserBody: "",
        frozenActiveMemoryBody: "",
      },
      EMPTY_GENERIC_SUBAGENT_INHERITANCE,
      id,
      "follow-up",
    );
    await flush();

    expect(host.preparations[0]?.history).toEqual({
      kind: "open",
      sessionDir: dir,
      sessionFile: history,
    });
    host.latest().complete("continued");
    await expect(result).resolves.toBe("continued");
    expect(existsSync(history)).toBe(true);
  });
});
