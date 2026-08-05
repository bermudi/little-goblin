import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DelegatedWorkRecordStore } from "../../delegated-work/store.ts";
import {
  delegatedWorkRecordPath,
  delegatedWorkRunDir,
  delegatedWorkRunsRoot,
} from "../../delegated-work/paths.ts";
import { personalEnvironment } from "../../sessions/environment.ts";
import { dmSurface, surfaceId } from "../../surface.ts";
import { SubagentRunner } from "../mod.ts";
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

function validRecord(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: "generic-subagent",
    name: null,
    depth: 1,
    createdAt: new Date().toISOString(),
    invocations: [{
      index: 0,
      ownerConversationId: "conversation-a",
      runtimeId: "runtime-1",
      ownershipEpochId: "epoch-1",
      lifetime: "attached",
      originSurfaceId: surfaceId(dmSurface(1)),
      executionEnvironment: personalEnvironment(),
      status: "running",
      outcome: null,
      deliveryState: "pending",
      startedAt: new Date().toISOString(),
      completedAt: null,
    }],
    ...overrides,
  };
}

function writeRecord(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("Delegated work record store boundary", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;
  let store: DelegatedWorkRecordStore;

  beforeEach(() => {
    tmp = createTestHome("goblin-delegated-record-boundary-");
    store = new DelegatedWorkRecordStore(tmp);
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects malformed run IDs before filesystem lookup", async () => {
    for (const id of ["", "../escape", "nested/id", "..\\escape"]) {
      await expect(
        runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "go"),
      ).rejects.toThrow(/safe path segment/);
    }

    expect(existsSync(delegatedWorkRunsRoot(tmp))).toBe(false);
  });

  it("creates a record with an append-only invocation log on spawn", async () => {
    const handle = await runner.spawn({
      prompt: "Analyze logs",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    handle.result.catch(() => {});

    const runDir = delegatedWorkRunDir(tmp, handle.id);
    expect(existsSync(runDir)).toBe(true);

    const recordPath = delegatedWorkRecordPath(tmp, handle.id);
    expect(existsSync(recordPath)).toBe(true);

    const record = JSON.parse(readFileSync(recordPath, "utf-8"));
    expect(record).toMatchObject({
      id: handle.id,
      kind: "generic-subagent",
      name: null,
      depth: 1,
    });
    expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record.invocations).toHaveLength(1);
    expect(record.invocations[0]).toMatchObject({
      index: 0,
      status: "running",
      deliveryState: "pending",
      outcome: null,
    });
  });

  it("revival appends a new invocation instead of patching the old one", async () => {
    const handle = await runner.spawn({
      prompt: "first turn",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();

    await completeAndAcknowledge(runner, host, handle, "first response");

    writeSessionFile(tmp, handle.id, "2026-01-01T00-00-00.jsonl");

    const recordPath = delegatedWorkRecordPath(tmp, handle.id);
    let record = JSON.parse(readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
    expect(record.invocations).toHaveLength(1);
    expect((record.invocations as Record<string, unknown>[])[0]?.status).toBe("completed");

    const revival = runner.revive(
      DEFAULT_PARENT_CAPTURE,
      EMPTY_GENERIC_SUBAGENT_INHERITANCE,
      handle.id,
      "continue",
    );
    await flush();

    record = JSON.parse(readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
    expect(record.invocations).toHaveLength(2);
    expect((record.invocations as Record<string, unknown>[])[0]?.status).toBe("completed");
    expect((record.invocations as Record<string, unknown>[])[1]?.status).toBe("running");

    host.latest().complete("revived");
    await expect(revival).resolves.toBe("revived");

    record = JSON.parse(readFileSync(recordPath, "utf-8")) as Record<string, unknown>;
    expect((record.invocations as Record<string, unknown>[])[1]?.status).toBe("completed");
  });

  it("rejects a record whose id disagrees with its file path", () => {
    const id = "requested-id";
    const path = delegatedWorkRecordPath(tmp, id);
    writeRecord(path, validRecord("different-id"));

    expect(() => store.load(id)).toThrow(/record id does not match/);
  });

  it("rejects a generic record with a non-null name", () => {
    const id = "generic-with-name";
    const path = delegatedWorkRecordPath(tmp, id);
    writeRecord(path, validRecord(id, { name: "writer" }));

    expect(() => store.load(id)).toThrow(/generic-subagent records must have name = null/);
  });

  it("rejects a named record without a valid name", () => {
    const id = "named-without-name";
    const path = delegatedWorkRecordPath(tmp, id);
    writeRecord(path, validRecord(id, { kind: "named-subagent", name: null }));

    expect(() => store.load(id)).toThrow(/named-subagent records must have a valid agent name/);
  });

  it("rejects non-contiguous invocation indices", () => {
    const id = "bad-indices";
    const path = delegatedWorkRecordPath(tmp, id);
    const baseInvocation = (validRecord(id).invocations as Record<string, unknown>[])[0] as Record<string, unknown>;
    writeRecord(path, validRecord(id, {
      invocations: [
        baseInvocation,
        { ...baseInvocation, index: 2 },
      ],
    }));

    expect(() => store.load(id)).toThrow(/invocation indices must be contiguous/);
  });

  it("does not reconstruct a missing or corrupt record during cancellation", async () => {
    const missing = await runner.spawn({
      prompt: "missing record",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    rmSync(delegatedWorkRecordPath(tmp, missing.id));

    await expect(runner.cancel(missing.id)).rejects.toThrow(/record not found/);
    expect(existsSync(delegatedWorkRecordPath(tmp, missing.id))).toBe(false);

    const corrupt = await runner.spawn({
      prompt: "corrupt record",
      authority: DEFAULT_AUTHORITY,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
    });
    await flush();
    const corruptPath = delegatedWorkRecordPath(tmp, corrupt.id);
    writeFileSync(corruptPath, "not-json");

    await expect(runner.cancel(corrupt.id)).rejects.toThrow(/malformed JSON/);
    expect(readFileSync(corruptPath, "utf-8")).toBe("not-json");
    expect(host.latest().stopCalls).toBe(1);
  });

  it("lists run ids from the host-owned store", () => {
    for (const id of ["run-a", "run-b"]) {
      writeRecord(delegatedWorkRecordPath(tmp, id), validRecord(id));
    }

    expect(store.listIds()).toEqual(["run-a", "run-b"]);
  });

  it("returns null for a missing record", () => {
    expect(store.load("no-such-run")).toBeNull();
  });
});
