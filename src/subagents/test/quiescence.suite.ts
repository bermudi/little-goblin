import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { SubagentRunner } from "../mod.ts";
import type { SubagentInstance } from "../types.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import {
  completeAndAcknowledge,
  createTestHome,
  DEFAULT_AUTHORITY,
  DEFAULT_PARENT_CAPTURE,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
  writeSessionFile,
} from "./support.ts";

function getInstance(runner: SubagentRunner, id: string): SubagentInstance | undefined {
  return (runner as unknown as { activeSubagents: Map<string, SubagentInstance> }).activeSubagents.get(id);
}

function quiesceEpoch(runner: SubagentRunner, epochId: string): Promise<void> {
  return (runner as unknown as { quiesceAttachedOwnership: (epochId: string) => Promise<void> })
    .quiesceAttachedOwnership(epochId);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

describe("SubagentRunner — attached quiescence", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-quiescence-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves an attached but unstarted instance during quiescence", async () => {
    // Create and complete a generic subagent so a session file exists for
    // revival.
    const handle = await runner.spawn({
      prompt: "first",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    await completeAndAcknowledge(runner, host, handle, "done");
    writeSessionFile(tmp, handle.id, "2026-01-01T00-00-00.jsonl");

    // Start a revive but keep the attachment callback pending. This leaves the
    // instance registered with the delegated-work host before `startInstance`
    // has run, which is the exact window that can hang quiescence.
    let releaseAttached!: () => void;
    const attached = new Promise<void>((resolve) => {
      releaseAttached = resolve;
    });
    const revivalPromise = runner.revive(
      DEFAULT_PARENT_CAPTURE,
      EMPTY_GENERIC_SUBAGENT_INHERITANCE,
      handle.id,
      "second turn",
      undefined,
      () => attached,
    ).catch(() => {});

    await flush();

    const instance = getInstance(runner, handle.id);
    expect(instance).toBeDefined();
    expect(instance!.settlementStarted).toBe(false);
    expect(instance!.delegatedOwnership).not.toBeNull();

    const epochId = instance!.delegatedOwnership!.ownershipEpochId;

    // Without the settlementStarted guard, quiescence would await the
    // unstarted instance's settlement forever.
    const quiescePromise = quiesceEpoch(runner, epochId);
    await expect(withTimeout(quiescePromise, 1000)).resolves.toBeUndefined();

    // The unstarted instance's own settlement should now be resolved.
    await expect(withTimeout(instance!.settlement, 1000)).resolves.toBeUndefined();

    // Clean up: cancel the instance and release the attachment so the revive
    // promise can settle.
    await runner.cancel(handle.id);
    releaseAttached();
    await revivalPromise;
  });
});
