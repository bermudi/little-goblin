import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { admitRevival, SubagentReviveRejectedError } from "../revive.ts";
import { SubagentReviveBusyError, SubagentRunner } from "../mod.ts";
import { DelegatedWorkHost } from "../../delegated-work/mod.ts";
import { delegatedWorkRunDir } from "../../delegated-work/paths.ts";
import type { CapturedMemoryContext } from "../../memory/mod.ts";
import { topicScopeDir } from "../../memory/paths.ts";
import { projectEnvironment } from "../../sessions/environment.ts";
import { workspacePath } from "../../workspace/paths.ts";
import { namedAgentAgentsMdPath, namedAgentDir } from "../paths.ts";
import { FakeSubagentHost } from "./fake-host.ts";
import {
  completeAndAcknowledge,
  createTestHome,
  DEFAULT_AUTHORITY,
  DEFAULT_PARENT_CAPTURE,
  EMPTY_GENERIC_SUBAGENT_INHERITANCE,
  flush,
  makeConfig,
  OTHER_AUTHORITY,
  validRecord,
  writeRecordAndSession,
  writeSessionFile,
} from "./support.ts";

type AdmissionOptions = Parameters<typeof admitRevival>[0];

describe("admitRevival", () => {
  let tmp: string;
  let delegatedWorkHost: DelegatedWorkHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-admission-");
    delegatedWorkHost = new DelegatedWorkHost(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function admissionFor(id: string, overrides: Partial<AdmissionOptions> = {}): AdmissionOptions {
    return {
      goblinHome: tmp,
      delegatedWorkHost,
      parentCapture: DEFAULT_PARENT_CAPTURE,
      inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE,
      id,
      ...overrides,
    };
  }

  it("returns a validated plan for a completed generic record", () => {
    const id = "admit-generic";
    const sessionFile = writeRecordAndSession(tmp, id, validRecord(id), "2026-01-01T00-00-00.jsonl");

    const plan = admitRevival(admissionFor(id));

    expect(plan.record.id).toBe(id);
    expect(plan.role).toBe("generic");
    expect(plan.displayName).toBeNull();
    expect(plan.authority).toBe(DEFAULT_AUTHORITY);
    expect(plan.caller).toEqual({ kind: "anonymous-subagent" });
    expect(plan.delegatedOwnership.lifetime).toBe("attached");
    expect(plan.delegatedOwnership.originSurfaceId).toBe(DEFAULT_AUTHORITY.sourceSurfaceId);
    expect(plan.delegatedOwnership.ownerConversationId).toBe(DEFAULT_AUTHORITY.sourceSurfaceId);
    expect(plan.delegatedOwnership.executionEnvironment).toEqual(
      EMPTY_GENERIC_SUBAGENT_INHERITANCE.executionEnvironment,
    );
    expect(plan.runDir).toBe(delegatedWorkRunDir(tmp, id));
    expect(plan.history).toEqual({
      kind: "open",
      sessionDir: delegatedWorkRunDir(tmp, id),
      sessionFile,
    });
    expect(plan.cwd).toBe(workspacePath(tmp));
    expect(plan.definition).toBeNull();
    expect(plan.inheritance).toBe(EMPTY_GENERIC_SUBAGENT_INHERITANCE);
  });

  it("returns a named plan with the loaded definition and no inheritance", () => {
    mkdirSync(namedAgentDir(tmp, "researcher"), { recursive: true });
    writeFileSync(namedAgentAgentsMdPath(tmp, "researcher"), "# Researcher\n");
    const id = "admit-named";
    writeRecordAndSession(
      tmp,
      id,
      validRecord(id, { kind: "named-subagent", name: "researcher" }),
      "2026-01-01T00-00-00.jsonl",
    );

    const plan = admitRevival(admissionFor(id));

    expect(plan.role).toBe("named");
    expect(plan.displayName).toBe("researcher");
    expect(plan.caller).toEqual({ kind: "named-subagent", name: "researcher" });
    expect(plan.cwd).toBe(namedAgentDir(tmp, "researcher"));
    expect(plan.definition).not.toBeNull();
    expect(plan.inheritance).toBeNull();
  });

  it("rejects a non-Surface parent capture with a plain Error", () => {
    const bad = { ...DEFAULT_PARENT_CAPTURE, kind: "internal" } as unknown as CapturedMemoryContext;

    let failure: unknown;
    try {
      admitRevival(admissionFor("any-id", { parentCapture: bad }));
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SubagentReviveRejectedError);
    expect((failure as Error).message).toBe(
      "Revival requires a Surface-backed parent memory context, got internal",
    );
  });

  it("rejects a missing record as 'Subagent not found'", () => {
    let failure: unknown;
    try {
      admitRevival(admissionFor("missing-id"));
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(SubagentReviveRejectedError);
    expect((failure as Error).message).toBe("Subagent not found");
  });

  it("rejects a record without a session file as 'Subagent not found'", () => {
    const id = "admit-no-session";
    writeRecordAndSession(tmp, id, validRecord(id), undefined);

    let failure: unknown;
    try {
      admitRevival(admissionFor(id));
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(SubagentReviveRejectedError);
    expect((failure as Error).message).toBe("Subagent not found");
  });

  it("rejects generic revival without the reviving runtime's inheritance", () => {
    const id = "admit-no-inheritance";
    writeRecordAndSession(tmp, id, validRecord(id), "2026-01-01T00-00-00.jsonl");

    let failure: unknown;
    try {
      admitRevival(admissionFor(id, { inheritance: null }));
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      `Generic subagent '${id}' revival requires the reviving runtime's resolved skill manifest and execution environment`,
    );
  });

  it("rejects a delegated context from a different origin Surface", () => {
    const id = "admit-origin-mismatch";
    writeRecordAndSession(tmp, id, validRecord(id), "2026-01-01T00-00-00.jsonl");

    expect(() => admitRevival(admissionFor(id, {
      delegatedContext: {
        ownerConversationId: "conversation-b",
        runtimeId: DelegatedWorkHost.newRuntimeId(),
        originSurfaceId: OTHER_AUTHORITY.sourceSurfaceId,
        executionEnvironment: EMPTY_GENERIC_SUBAGENT_INHERITANCE.executionEnvironment,
      },
    }))).toThrow("delegated revival Surface does not match captured memory authority");
  });

  it("rejects a delegated environment that differs from inherited authority", () => {
    const id = "admit-env-mismatch";
    writeRecordAndSession(tmp, id, validRecord(id), "2026-01-01T00-00-00.jsonl");

    expect(() => admitRevival(admissionFor(id, {
      delegatedContext: {
        ownerConversationId: "conversation-b",
        runtimeId: DelegatedWorkHost.newRuntimeId(),
        originSurfaceId: DEFAULT_AUTHORITY.sourceSurfaceId,
        executionEnvironment: projectEnvironment("/nonexistent-project-root"),
      },
    }))).toThrow("generic delegated revival environment differs from inherited authority");
  });

  it("rejects a missing topic directory", () => {
    const id = "admit-topic-missing";
    writeRecordAndSession(tmp, id, validRecord(id), "2026-01-01T00-00-00.jsonl");
    const topicCapture: CapturedMemoryContext = {
      ...DEFAULT_PARENT_CAPTURE,
      authority: {
        ...DEFAULT_PARENT_CAPTURE.authority,
        activeScope: { chatId: 777, topicScope: { topicId: 42 } },
      },
    };

    let failure: unknown;
    try {
      admitRevival(admissionFor(id, { parentCapture: topicCapture }));
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(SubagentReviveRejectedError);
    expect((failure as Error).message).toMatch(/topic scope \(777\/42\) no longer exists/);
  });

  it("rejects a named revival whose definition is gone", () => {
    const id = "admit-ghost-named";
    writeRecordAndSession(
      tmp,
      id,
      validRecord(id, { kind: "named-subagent", name: "ghost" }),
      "2026-01-01T00-00-00.jsonl",
    );

    let failure: unknown;
    try {
      admitRevival(admissionFor(id));
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(SubagentReviveRejectedError);
    expect((failure as Error).message).toBe("Named agent 'ghost' definition missing; cannot revive");
  });
});

describe("SubagentRunner — revive latch", () => {
  let tmp: string;
  let runner: SubagentRunner;
  let host: FakeSubagentHost;

  beforeEach(() => {
    tmp = createTestHome("goblin-revive-latch-");
    host = new FakeSubagentHost();
    runner = new SubagentRunner(makeConfig(tmp), undefined, undefined, host);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function spawnAndComplete(): Promise<string> {
    const handle = await runner.spawn({ prompt: "first", authority: DEFAULT_AUTHORITY, inheritance: EMPTY_GENERIC_SUBAGENT_INHERITANCE });
    await flush();
    await completeAndAcknowledge(runner, host, handle, "done");
    writeSessionFile(tmp, handle.id, "2026-01-01T00-00-00_fake.jsonl");
    return handle.id;
  }

  it("releases the latch after an admission rejection so a retry can proceed", async () => {
    const id = await spawnAndComplete();
    const topicCapture: CapturedMemoryContext = {
      ...DEFAULT_PARENT_CAPTURE,
      authority: {
        ...DEFAULT_PARENT_CAPTURE.authority,
        activeScope: { chatId: 777, topicScope: { topicId: 42 } },
      },
    };

    await expect(
      runner.revive(topicCapture, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "topic missing"),
    ).rejects.toBeInstanceOf(SubagentReviveRejectedError);

    mkdirSync(topicScopeDir(tmp, 777, 42), { recursive: true });

    const retry = runner.revive(topicCapture, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "retry");
    await flush();
    host.latest().complete("done");
    await expect(retry).resolves.toBe("done");
  });

  it("rejects a concurrent revive while a cancelled revival is still settling", async () => {
    const id = await spawnAndComplete();
    let releaseAttachment!: () => void;
    const attachmentStarted = new Promise<void>((resolve) => {
      releaseAttachment = resolve;
    });
    let markAttached!: () => void;
    const attached = new Promise<void>((resolve) => {
      markAttached = resolve;
    });

    const revival = runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "will be cancelled", undefined, async () => {
      markAttached();
      await attachmentStarted;
    });
    await attached;
    await runner.cancel(id);

    // The instance is already claimed cancelled, so the already-running check
    // does not fire; the still-held revive latch is what rejects this attempt.
    let failure: unknown;
    try {
      await runner.revive(DEFAULT_PARENT_CAPTURE, EMPTY_GENERIC_SUBAGENT_INHERITANCE, id, "concurrent");
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(SubagentReviveBusyError);
    expect((failure as Error).message).toBe("Subagent revive already in progress");

    releaseAttachment();
    await expect(revival).rejects.toThrow("Subagent was cancelled");
  });
});
