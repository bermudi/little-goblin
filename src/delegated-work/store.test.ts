import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DelegatedWorkRecordStore,
  assertSafeRunId,
  parseDelegatedWorkRecord,
  type DelegatedWorkStatus,
} from "./store.ts";
import { delegatedWorkRecordPath, delegatedWorkRunsRoot } from "./paths.ts";
import { log } from "../log.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import type { ConversationRuntimeId } from "./types.ts";
import { DelegatedWorkHost } from "./host.ts";

const baseTimestamp = "2024-01-01T00:00:00.000Z";

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

function makeInvocation(
  index: number,
  status: DelegatedWorkStatus,
  completedAt: string | null = null,
): Record<string, unknown> {
  const outcome =
    status === "completed"
      ? { kind: "success", text: "done" }
      : status === "error"
        ? { kind: "error", errorMessage: "failed" }
        : null;
  return {
    index,
    ownerConversationId: "conversation-a",
    runtimeId: "runtime-1",
    ownershipEpochId: "epoch-1",
    lifetime: "attached",
    originSurfaceId: surfaceId(dmSurface(1)),
    executionEnvironment: personalEnvironment(),
    status,
    outcome,
    deliveryState: status === "running" ? "pending" : status === "completed" ? "delivered" : "suppressed",
    startedAt: baseTimestamp,
    completedAt,
  };
}

function makeRecord(id: string, invocations: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id,
    kind: "generic-subagent",
    name: null,
    depth: 1,
    createdAt: baseTimestamp,
    invocations,
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

  it("external-agent record validates with backend identity and durable capture set", () => {
    const host = new DelegatedWorkHost(home);
    for (const backend of ["claude", "devin"] as const) {
      const capture = { ...ownership(`runtime-${backend}`), lifetime: "durable" as const };
      const id = `external-${backend}`;
      const { record, runDir } = host.createExternalRecord(id, backend, capture);
      expect(runDir).toBe(join(home, "state", "delegated-work", "runs", id));
      expect(record.kind).toBe("external-agent");
      expect(record).toMatchObject({ external: { backend, providerSessionId: null } });
      expect(record.invocations).toEqual([{
        ...capture,
        index: 0,
        status: "running",
        outcome: null,
        deliveryState: "pending",
        startedAt: record.createdAt,
        completedAt: null,
      }]);

      const path = delegatedWorkRecordPath(home, id);
      chmodSync(path, 0o600);
      host.captureExternalSession(id, `provider-${backend}`);
      const disk: unknown = JSON.parse(readFileSync(path, "utf-8"));
      expect(parseDelegatedWorkRecord(disk, path, id)).toMatchObject({
        external: { backend, providerSessionId: `provider-${backend}` },
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(new DelegatedWorkRecordStore(home).load(id)).toEqual(host.loadRecord(id));
      expect(() => host.createExternalRecord(id, backend, capture)).toThrow(/already exists/);
    }
  });

  it("rejects malformed external identity and attached external invocations before writing", () => {
    const raw = {
      ...makeRecord("external-invalid", [{ ...makeInvocation(0, "running"), lifetime: "durable" }]),
      kind: "external-agent",
      external: { backend: "claude", providerSessionId: null },
    };
    expect(parseDelegatedWorkRecord(raw, "external-test")).toBeDefined();
    for (const external of [
      undefined,
      { backend: "codex", providerSessionId: null },
      { backend: "devin", providerSessionId: "" },
      { backend: "devin", providerSessionId: 42 },
      { backend: "claude", providerSessionId: null, surprise: true },
    ]) {
      expect(() => parseDelegatedWorkRecord({ ...raw, external }, "external-test")).toThrow();
    }
    expect(() => parseDelegatedWorkRecord({
      ...raw, invocations: [makeInvocation(0, "running")],
    }, "external-test")).toThrow(/durable/);
    expect(() => parseDelegatedWorkRecord({ ...raw, name: "researcher" }, "external-test"))
      .toThrow(/name/);
    expect(() => parseDelegatedWorkRecord({
      ...raw, kind: "generic-subagent",
    }, "external-test")).toThrow();
    // The ordinary creation entry cannot manufacture a backend-less external record.
    expect(() => store.createRecord(
      "external-invalid", "external-agent", null, 1,
      { ...ownership("runtime-external"), lifetime: "durable" },
    )).toThrow();
    expect(existsSync(store.runDir("external-invalid"))).toBe(false);
  });

  it("external session capture is write-once, fails loudly, and cannot mutate terminal context", () => {
    const host = new DelegatedWorkHost(home);
    host.createExternalRecord("external-capture", "claude", {
      ...ownership("runtime-external"), lifetime: "durable",
    });
    expect(() => host.captureExternalSession("missing-external", "provider")).toThrow(/not found/);
    expect(() => host.captureExternalSession("external-capture", "")).toThrow();
    host.captureExternalSession("external-capture", "provider-first");
    host.captureExternalSession("external-capture", "provider-first");
    expect(() => host.captureExternalSession("external-capture", "provider-other")).toThrow(/already/);
    host.completeInvocation("external-capture", 0, "done");
    expect(() => host.captureExternalSession("external-capture", "provider-other")).toThrow();
    expect(new DelegatedWorkHost(home).loadRecord("external-capture")).toMatchObject({
      external: { backend: "claude", providerSessionId: "provider-first" },
      invocations: [{ status: "completed", deliveryState: "pending" }],
    });
    host.createRecord("pi-capture", "generic-subagent", null, 1, ownership("runtime-pi"));
    expect(() => host.captureExternalSession("pi-capture", "provider")).toThrow(/external/);

    host.createExternalRecord("external-io", "devin", {
      ...ownership("runtime-io"), lifetime: "durable",
    });
    const path = delegatedWorkRecordPath(home, "external-io");
    rmSync(path);
    mkdirSync(path);
    expect(() => host.captureExternalSession("external-io", "provider")).toThrow();
    expect(() => host.loadRecord("external-io")).toThrow();
  });

  it("external invocation killed by process death shows interrupted after restart", () => {
    // The child persists non-terminal invocations and then dies without any teardown.
    // No provider CLI, credentials, or live ACP connection is needed for this storage boundary.
    const hostModule = new URL("./host.ts", import.meta.url).href;
    const script = `
      import { DelegatedWorkHost } from ${JSON.stringify(hostModule)};
      const host = new DelegatedWorkHost(${JSON.stringify(home)});
      for (const backend of ["claude", "devin"]) {
        host.createExternalRecord("killed-" + backend, backend, ${JSON.stringify({
          ...ownership("runtime-killed"), lifetime: "durable",
        })});
        host.captureExternalSession("killed-" + backend, "provider-" + backend);
      }
      process.kill(process.pid, "SIGKILL");
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], { env: {} });
    expect(child.signalCode).toBe("SIGKILL");
    for (const backend of ["claude", "devin"]) {
      expect(store.load(`killed-${backend}`)?.invocations[0]?.status).toBe("running");
    }
    // Legacy data is neither inspected nor migrated, even when malformed.
    const legacy = join(home, "scratch", "external-agents", "abandoned.json");
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(legacy, "not-json");
    const restarted = new DelegatedWorkHost(home);
    for (const backend of ["claude", "devin"]) {
      const record = restarted.loadRecord(`killed-${backend}`);
      expect(record).toMatchObject({
        external: { backend, providerSessionId: `provider-${backend}` },
        invocations: [{
          status: "interrupted", deliveryState: "suppressed", outcome: null,
        }],
      });
      expect(record?.invocations).toHaveLength(1);
      expect(record?.invocations[0]?.completedAt).not.toBeNull();
      expect(new DelegatedWorkHost(home).loadRecord(`killed-${backend}`)).toEqual(record);
    }
    expect(restarted.listRecordIds()).toEqual(["killed-claude", "killed-devin"]);
    expect(readFileSync(legacy, "utf-8")).toBe("not-json");
  });

  it("rejects creating a record that already exists and preserves the original", () => {
    store.createRecord("run-1", "generic-subagent", null, 1, ownership("runtime-1"));
    expect(() =>
      store.createRecord("run-1", "named-subagent", "researcher", 2, ownership("runtime-2"))
    ).toThrow(/Cannot create delegated work record run-1: already exists/);

    const record = store.load("run-1");
    expect(record).not.toBeNull();
    expect(record?.kind).toBe("generic-subagent");
    expect(record?.name).toBeNull();
    expect(record?.depth).toBe(1);
    expect(record?.invocations).toHaveLength(1);
    expect(record?.invocations[0]?.runtimeId).toBe("runtime-1");
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

  it("rejects delivery changes that contradict a terminal status", () => {
    const suppressedStatuses = ["cancelled", "error", "interrupted"] as const;
    for (const status of suppressedStatuses) {
      const runId = `run-terminal-${status}`;
      store.createRecord(runId, "generic-subagent", null, 1, ownership("runtime-1"));
      store.closeInvocation(
        runId,
        0,
        status,
        status === "error" ? { kind: "error", errorMessage: "failed" } : null,
        "suppressed",
      );

      expect(() => store.setDeliveryState(runId, 0, "delivered")).toThrow(
        `${status} invocation delivery must remain suppressed`,
      );
      expect(store.load(runId)?.invocations[0]?.deliveryState).toBe("suppressed");
    }
  });

  it("rejects setDeliveryState on a running invocation", () => {
    store.createRecord("run-8", "generic-subagent", null, 1, ownership("runtime-1"));
    expect(() => store.setDeliveryState("run-8", 0, "delivered")).toThrow(
      /Cannot set delivery state on invocation 0 of run-8: still running/,
    );
  });

  it("lists run ids and returns null for missing records", () => {
    store.createRecord("alpha", "generic-subagent", null, 1, ownership("runtime-1"));
    store.createRecord("beta", "generic-subagent", null, 1, ownership("runtime-1"));

    expect(store.listIds()).toEqual(["alpha", "beta"]);
    expect(store.load("missing")).toBeNull();
  });

  it("lists only canonical run directories that contain a record file", () => {
    const runsRoot = delegatedWorkRunsRoot(home);

    // Valid run directory with a record.json file.
    store.createRecord("valid-run", "generic-subagent", null, 1, ownership("runtime-1"));

    // Unsafe directory name (would fail assertSafeRunId if passed to load).
    mkdirSync(join(runsRoot, "..evil"), { recursive: true });
    writeFileSync(join(runsRoot, "..evil", "record.json"), "{}");

    // Safe directory name but no record.json file.
    mkdirSync(join(runsRoot, "empty-dir"), { recursive: true });

    // Safe name, but the entry is a regular file, not a directory.
    writeFileSync(join(runsRoot, "not-a-dir"), "I am not a run");

    // Unsafe name and a regular file.
    writeFileSync(join(runsRoot, "..evil-file"), "I am not a run");

    const calls: { msg: string; extra: unknown }[] = [];
    const originalWarn = log.warn;
    log.warn = (msg: string, extra?: unknown) => {
      calls.push({ msg, extra });
    };

    try {
      expect(store.listIds()).toEqual(["valid-run"]);

      const skippedPaths = calls
        .map((call) => (call.extra as { path: string }).path)
        .sort();
      expect(skippedPaths).toEqual([join(runsRoot, "..evil"), join(runsRoot, "..evil-file")]);
      for (const call of calls) {
        expect(call.msg).toBe("delegated work run directory skipped: not a canonical run id");
      }
    } finally {
      log.warn = originalWarn;
    }

    expect(store.load("empty-dir")).toBeNull();
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
      JSON.stringify(makeRecord("different-id", [makeInvocation(0, "running")])),
    );
    expect(() => store.load("id-mismatch")).toThrow(/record id does not match/);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("assertSafeRunId and zod schema", () => {
  it("rejects a run id with a trailing line terminator", () => {
    expect(() => assertSafeRunId("run-1\n")).toThrow(
      /run ID must be a non-empty single safe path segment/,
    );
  });

  it("rejects a record whose id contains a line terminator", () => {
    expect(() =>
      parseDelegatedWorkRecord(
        makeRecord("run-1\n", [makeInvocation(0, "running")]),
        "test-path",
      ),
    ).toThrow(/must be a safe run ID/);
  });
});

describe("parseDelegatedWorkRecord", () => {
  it("rejects an empty invocation log", () => {
    expect(() =>
      parseDelegatedWorkRecord(makeRecord("run-empty", []), "test-path"),
    ).toThrow();
  });

  it("rejects two running invocations", () => {
    expect(() =>
      parseDelegatedWorkRecord(
        makeRecord("run-two-running", [makeInvocation(0, "running"), makeInvocation(1, "running")]),
        "test-path",
      ),
    ).toThrow(/only the last invocation may be running/);
  });

  it("rejects a running invocation before a terminal one", () => {
    expect(() =>
      parseDelegatedWorkRecord(
        makeRecord("run-running-first", [
          makeInvocation(0, "running"),
          makeInvocation(1, "completed", baseTimestamp),
        ]),
        "test-path",
      ),
    ).toThrow(/only the last invocation may be running/);
  });

  it("rejects contradictory lifecycle fields", () => {
    const cases: Array<{
      id: string;
      invocation: Record<string, unknown>;
      message: string;
    }> = [
      {
        id: "run-running-outcome",
        invocation: {
          ...makeInvocation(0, "running"),
          outcome: { kind: "success", text: "impossible" },
        },
        message: "running invocations must not have an outcome",
      },
      {
        id: "run-completed-error",
        invocation: {
          ...makeInvocation(0, "completed", baseTimestamp),
          outcome: { kind: "error", errorMessage: "wrong outcome" },
        },
        message: "completed invocations require a success outcome",
      },
      {
        id: "run-error-delivered",
        invocation: {
          ...makeInvocation(0, "error", baseTimestamp),
          deliveryState: "delivered",
        },
        message: "error invocation delivery must remain suppressed",
      },
      {
        id: "run-cancelled-outcome",
        invocation: {
          ...makeInvocation(0, "cancelled", baseTimestamp),
          outcome: { kind: "success", text: "impossible" },
        },
        message: "cancelled invocations must not have an outcome",
      },
      {
        id: "run-terminal-without-time",
        invocation: makeInvocation(0, "interrupted"),
        message: "terminal invocations require a completion timestamp",
      },
    ];

    for (const testCase of cases) {
      expect(() =>
        parseDelegatedWorkRecord(
          makeRecord(testCase.id, [testCase.invocation]),
          "test-path",
        )
      ).toThrow(testCase.message);
    }
  });

  it("accepts a record with a single running invocation", () => {
    expect(parseDelegatedWorkRecord(makeRecord("run-ok", [makeInvocation(0, "running")]), "test-path")).toBeDefined();
  });

  it("accepts a record with all terminal invocations", () => {
    expect(
      parseDelegatedWorkRecord(
        makeRecord("run-all-terminal", [
          makeInvocation(0, "completed", baseTimestamp),
          makeInvocation(1, "completed", baseTimestamp),
        ]),
        "test-path",
      ),
    ).toBeDefined();
  });

  it("accepts a record with a running invocation only at the tail", () => {
    expect(
      parseDelegatedWorkRecord(
        makeRecord("run-tail-running", [
          makeInvocation(0, "completed", baseTimestamp),
          makeInvocation(1, "running"),
        ]),
        "test-path",
      ),
    ).toBeDefined();
  });
});
