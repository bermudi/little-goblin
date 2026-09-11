import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleDelegatedStart,
  handleDelegatedMessage,
  type DelegatedExternalAgentToolOptions,
  type LiveDelegatedRun,
} from "./tool-actions.ts";
import { ExternalAgentHost, type AcpAgentConnection, type AcpHostEvent, type AcpPromptOutcome } from "./host.ts";
import type { ProcessHost } from "./types.ts";
import { DelegatedWorkHost } from "../delegated-work/host.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import { asConversationRuntimeId } from "../delegated-work/types.ts";

// ---------------------------------------------------------------------------
// Per-action delegated-tool handlers (issue #61): failure paths exercised
// directly against the extracted handlers, without the ACP mock-server stack.
// ---------------------------------------------------------------------------

class StubPromptConnection {
  readonly sessionId = "sess-stub";
  readonly promptTexts: string[] = [];
  disposed = false;
  constructor(private readonly respond: (text: string) => Promise<AcpPromptOutcome>) {}
  async prompt(text: string, _emit: (event: AcpHostEvent) => void): Promise<AcpPromptOutcome> {
    this.promptTexts.push(text);
    return this.respond(text);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function asAcpConnection(stub: StubPromptConnection): AcpAgentConnection {
  return stub as unknown as AcpAgentConnection;
}

const unreachableProcessHost: ProcessHost = {
  spawn: async () => {
    throw new Error("unexpected spawn in handler test");
  },
};

function delegatedOwnership() {
  return {
    lifetime: "durable" as const,
    ownerConversationId: "conversation-tool-actions",
    runtimeId: asConversationRuntimeId("runtime-tool-actions"),
    originSurfaceId: surfaceId(dmSurface(902)),
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: "epoch-tool-actions",
  };
}

function toolOptions(workHost: DelegatedWorkHost, agentHost: ExternalAgentHost): DelegatedExternalAgentToolOptions {
  return {
    workHost,
    agentHost,
    enabledBackends: ["claude"],
    buildOwnership: delegatedOwnership,
    resolveDevinModel: () => undefined,
  };
}

describe("delegated external-agent action handlers", () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-tool-actions-"));
    cwd = mkdtempSync(join(tmpdir(), "goblin-tool-actions-cwd-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("start connect failure marks the invocation error, suppresses delivery, and leaves no live entry", async () => {
    const workHost = new DelegatedWorkHost(home);
    const agentHost = new ExternalAgentHost({
      processHost: {
        spawn: async () => {
          throw new Error("spawn ENOENT");
        },
      },
    });
    const live = new Map<string, LiveDelegatedRun>();
    const result = await handleDelegatedStart(toolOptions(workHost, agentHost), live, {
      action: "start",
      agent: "claude",
      task: "will not launch",
      workingDirectory: cwd,
      permissionProfile: "dangerous",
    });
    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("spawn ENOENT");
    const runId = workHost.listRecordIds()[0] ?? "";
    const record = workHost.loadRecord(runId);
    expect(record?.invocations[0]?.status).toBe("error");
    expect(record?.invocations[0]?.deliveryState).toBe("suppressed");
    expect(live.size).toBe(0);
  });

  it("message prompt failure marks the invocation error, suppresses delivery, disposes, and drops the live entry", async () => {
    const workHost = new DelegatedWorkHost(home);
    const runId = workHost.createExternalRecord(randomUUID(), "claude", delegatedOwnership(), {
      workingDirectory: cwd,
      permissionProfile: "dangerous",
      task: "needs input",
    }).record.id;
    const conn = new StubPromptConnection(() => Promise.reject(new Error("transport lost mid-message")));
    const live = new Map<string, LiveDelegatedRun>([
      [runId, { connection: asAcpConnection(conn), lastStopReason: "input_required", lastAgentText: "" }],
    ]);
    const agentHost = new ExternalAgentHost({ processHost: unreachableProcessHost });
    const result = await handleDelegatedMessage(toolOptions(workHost, agentHost), live, {
      action: "message",
      id: runId,
      message: "go on",
    });
    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("transport lost mid-message");
    const record = workHost.loadRecord(runId);
    expect(record?.invocations[0]?.status).toBe("error");
    expect(record?.invocations[0]?.deliveryState).toBe("suppressed");
    expect(conn.disposed).toBe(true);
    expect(live.has(runId)).toBe(false);
  });

  it("start completion-persistence failure marks the invocation error, suppresses delivery, disposes, and drops the live entry", async () => {
    const workHost = new DelegatedWorkHost(home);
    const agentHost = new ExternalAgentHost({ processHost: unreachableProcessHost });
    const conn = new StubPromptConnection(async () => ({ stopReason: "end_turn", agentText: "done" }));
    agentHost.connect = async () => asAcpConnection(conn);
    const live = new Map<string, LiveDelegatedRun>();
    const originalComplete = workHost.completeInvocation.bind(workHost);
    workHost.completeInvocation = () => {
      throw new Error("completion write failed");
    };
    let result: string;
    try {
      result = await handleDelegatedStart(toolOptions(workHost, agentHost), live, {
        action: "start",
        agent: "claude",
        task: "complete will fail",
        workingDirectory: cwd,
        permissionProfile: "dangerous",
      });
    } finally {
      workHost.completeInvocation = originalComplete;
    }
    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("completion write failed");
    const runId = workHost.listRecordIds()[0] ?? "";
    const record = workHost.loadRecord(runId);
    expect(record?.invocations[0]?.status).toBe("error");
    expect(record?.invocations[0]?.deliveryState).toBe("suppressed");
    expect(conn.disposed).toBe(true);
    expect(live.has(runId)).toBe(false);
  });

  it("message completion-persistence failure marks the invocation error, suppresses delivery, disposes, and drops the live entry", async () => {
    const workHost = new DelegatedWorkHost(home);
    const runId = workHost.createExternalRecord(randomUUID(), "claude", delegatedOwnership(), {
      workingDirectory: cwd,
      permissionProfile: "dangerous",
      task: "needs input",
    }).record.id;
    const conn = new StubPromptConnection(async () => ({ stopReason: "end_turn", agentText: "done" }));
    const live = new Map<string, LiveDelegatedRun>([
      [runId, { connection: asAcpConnection(conn), lastStopReason: "input_required", lastAgentText: "" }],
    ]);
    const agentHost = new ExternalAgentHost({ processHost: unreachableProcessHost });
    const originalComplete = workHost.completeInvocation.bind(workHost);
    workHost.completeInvocation = () => {
      throw new Error("completion write failed");
    };
    let result: string;
    try {
      result = await handleDelegatedMessage(toolOptions(workHost, agentHost), live, {
        action: "message",
        id: runId,
        message: "go on",
      });
    } finally {
      workHost.completeInvocation = originalComplete;
    }
    expect(result.startsWith("Error:")).toBe(true);
    expect(result).toContain("completion write failed");
    const record = workHost.loadRecord(runId);
    expect(record?.invocations[0]?.status).toBe("error");
    expect(record?.invocations[0]?.deliveryState).toBe("suppressed");
    expect(conn.disposed).toBe(true);
    expect(live.has(runId)).toBe(false);
  });
});
