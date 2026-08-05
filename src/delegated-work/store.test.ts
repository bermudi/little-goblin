import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegatedWorkRecordStore } from "./store.ts";
import { delegatedWorkRecordPath } from "./paths.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import type { ConversationRuntimeId } from "./types.ts";

function ownership(runtimeId: string) {
  return {
    lifetime: "attached" as const,
    ownerConversationId: "conversation-a",
    runtimeId: runtimeId as ConversationRuntimeId,
    originSurfaceId: surfaceId(dmSurface(1)),
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: `epoch-${runtimeId}`,
  };
}

describe("DelegatedWorkRecordStore", () => {
  let home: string;
  let store: DelegatedWorkRecordStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-delegated-store-"));
    store = new DelegatedWorkRecordStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates a record with one running invocation", () => {
    const { record, runDir } = store.createRecord(
      "run-1",
      "generic-subagent",
      null,
      1,
      ownership("runtime-1"),
    );

    expect(record.id).toBe("run-1");
    expect(record.kind).toBe("generic-subagent");
    expect(record.name).toBeNull();
    expect(record.depth).toBe(1);
    expect(record.invocations).toHaveLength(1);
    expect(record.invocations[0]?.status).toBe("running");

    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(delegatedWorkRecordPath(home, "run-1"))).toBe(true);
  });

  it("rejects a generic record with a name", () => {
    expect(() =>
      store.createRecord("run-2", "generic-subagent", "bad-name", 1, ownership("runtime-1"))
    ).toThrow(/generic-subagent records must have name = null/);
  });

  it("creates a named record with a valid name", () => {
    const { record } = store.createRecord(
      "run-3",
      "named-subagent",
      "researcher",
      1,
      ownership("runtime-1"),
    );

    expect(record.kind).toBe("named-subagent");
    expect(record.name).toBe("researcher");
  });

  it("appends a revival invocation and keeps the old one terminal", () => {
    store.createRecord("run-4", "generic-subagent", null, 1, ownership("runtime-1"));
    store.closeInvocation("run-4", 0, "completed", { kind: "success", text: "done" }, "pending");

    const { record } = store.appendInvocation("run-4", ownership("runtime-2"));

    expect(record.invocations).toHaveLength(2);
    expect(record.invocations[0]?.status).toBe("completed");
    expect(record.invocations[1]?.status).toBe("running");
    expect(record.invocations[1]?.index).toBe(1);
  });

  it("refuses to append when the latest invocation is still running", () => {
    store.createRecord("run-5", "generic-subagent", null, 1, ownership("runtime-1"));
    expect(() => store.appendInvocation("run-5", ownership("runtime-2"))).toThrow(
      /Cannot append invocation/,
    );
  });

  it("closes the current invocation with outcome and delivery state", () => {
    store.createRecord("run-6", "generic-subagent", null, 1, ownership("runtime-1"));
    const record = store.closeInvocation(
      "run-6",
      0,
      "completed",
      { kind: "success", text: "result" },
      "pending",
    );

    expect(record.invocations[0]?.status).toBe("completed");
    expect(record.invocations[0]?.outcome).toEqual({ kind: "success", text: "result" });
    expect(record.invocations[0]?.deliveryState).toBe("pending");
    expect(record.invocations[0]?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("updates delivery state without touching terminal outcome", () => {
    store.createRecord("run-7", "generic-subagent", null, 1, ownership("runtime-1"));
    store.closeInvocation("run-7", 0, "completed", { kind: "success", text: "x" }, "pending");

    const record = store.setDeliveryState("run-7", 0, "delivered");
    expect(record.invocations[0]?.deliveryState).toBe("delivered");
    expect(record.invocations[0]?.outcome).toEqual({ kind: "success", text: "x" });
  });

  it("lists run ids and returns null for missing records", () => {
    store.createRecord("alpha", "generic-subagent", null, 1, ownership("runtime-1"));
    store.createRecord("beta", "generic-subagent", null, 1, ownership("runtime-1"));

    expect(store.listIds()).toEqual(["alpha", "beta"]);
    expect(store.load("missing")).toBeNull();
  });

  it("fails loudly on malformed JSON", () => {
    const path = delegatedWorkRecordPath(home, "bad-json");
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "not-json");
    expect(() => store.load("bad-json")).toThrow(/malformed JSON/);
    expect(existsSync(dir)).toBe(true);
  });

  it("fails loudly on a record whose id mismatches its path", () => {
    const path = delegatedWorkRecordPath(home, "id-mismatch");
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        id: "different-id",
        kind: "generic-subagent",
        name: null,
        depth: 1,
        createdAt: new Date().toISOString(),
        invocations: [],
      }),
    );
    expect(() => store.load("id-mismatch")).toThrow(/record id does not match/);
    expect(existsSync(dir)).toBe(true);
  });
});
