import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  agent as acpAgent,
  methods,
  ndJsonStream,
  type AgentCapabilities,
  type AgentRequestContext,
  type PromptRequest,
  type PromptResponse,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import { AcpHostError, ExternalAgentHost } from "./host.ts";
import { continueExternalRun, ContinuationRefusedError } from "./continuation.ts";
import { DelegatedWorkHost } from "../delegated-work/host.ts";
import {
  asConversationRuntimeId,
  type DurableDelegatedWorkOwnership,
} from "../delegated-work/types.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import type { ProcessExit, ProcessHandle, ProcessHost, ProcessSpawnArgs } from "./types.ts";

const CLAUDE_CAPS: AgentCapabilities = {
  loadSession: true,
  sessionCapabilities: { resume: {}, close: {} },
};

const DEVIN_CAPS: AgentCapabilities = {
  loadSession: true,
  sessionCapabilities: { delete: {} },
};

const CLAUDE_MODES: SessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Manual" },
    { id: "acceptEdits", name: "Accept Edits" },
    { id: "bypassPermissions", name: "Bypass Permissions" },
  ],
};

const ENV = { PATH: "/usr/bin", HOME: "/home/operator" };
const OWNER = "conversation-continuation";

type PromptBehavior = (
  ctx: AgentRequestContext<PromptRequest>,
) => Promise<PromptResponse> | PromptResponse;

class FakeAcpHandle implements ProcessHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  killed = false;
  private readonly exitPromise: Promise<ProcessExit>;
  private resolveExit!: (exit: ProcessExit) => void;

  constructor(fromClient: PassThrough, toClient: PassThrough) {
    this.stdin = fromClient;
    this.stdout = toClient;
    this.exitPromise = new Promise<ProcessExit>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  async *readLines(): AsyncIterable<string> {}

  waitForExit(): Promise<ProcessExit> {
    return this.exitPromise;
  }

  async kill(): Promise<void> {
    if (this.killed) {
      await this.exitPromise;
      return;
    }
    this.killed = true;
    this.stdin.end();
    this.stdout.push(null);
    this.resolveExit({ exitCode: null, signal: "SIGTERM" });
    await this.exitPromise;
  }

  getStderr(): string {
    return "";
  }
}

interface MockContinuationConfig {
  agentCapabilities: AgentCapabilities;
  modes?: SessionModeState;
  promptBehaviors?: PromptBehavior[];
}

class MockContinuationServer {
  readonly handle: FakeAcpHandle;
  readonly resumeRequests: Array<{ sessionId: string }> = [];
  readonly loadRequests: Array<{ sessionId: string }> = [];
  readonly setModeRequests: Array<{ sessionId: string; modeId: string }> = [];
  readonly prompts: string[] = [];
  private readonly script: PromptBehavior[];
  private readonly fallback: PromptBehavior = () => ({ stopReason: "end_turn" });

  constructor(config: MockContinuationConfig) {
    this.script = [...(config.promptBehaviors ?? [])];
    const fromClient = new PassThrough();
    const toClient = new PassThrough();
    this.handle = new FakeAcpHandle(fromClient, toClient);

    const app = acpAgent({ name: "mock-continuation-agent" })
      .onRequest(methods.agent.initialize, (c) => ({
        protocolVersion: c.params.protocolVersion,
        agentCapabilities: config.agentCapabilities,
        authMethods: [],
      }))
      .onRequest(methods.agent.session.resume, (c) => {
        this.resumeRequests.push({ sessionId: c.params.sessionId });
        return config.modes === undefined ? {} : { modes: config.modes };
      })
      .onRequest(methods.agent.session.load, (c) => {
        this.loadRequests.push({ sessionId: c.params.sessionId });
        return config.modes === undefined ? {} : { modes: config.modes };
      })
      .onRequest(methods.agent.session.setMode, (c) => {
        this.setModeRequests.push({ sessionId: c.params.sessionId, modeId: c.params.modeId });
        return {};
      })
      .onRequest(methods.agent.session.prompt, (c) => {
        this.prompts.push(
          c.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join(""),
        );
        const behavior = this.script.shift() ?? this.fallback;
        return behavior(c);
      });

    const connection = app.connect(ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(fromClient)));
    void connection.closed.catch(() => {});
  }
}

class MockContinuationProcessHost implements ProcessHost {
  readonly spawns: { args: ProcessSpawnArgs; server: MockContinuationServer; handle: FakeAcpHandle }[] = [];

  constructor(private readonly factory: (args: ProcessSpawnArgs) => MockContinuationServer) {}

  async spawn(args: ProcessSpawnArgs): Promise<ProcessHandle> {
    const server = this.factory(args);
    this.spawns.push({ args, server, handle: server.handle });
    return server.handle;
  }
}

function followupText(ctx: AgentRequestContext<PromptRequest>, text: string): Promise<PromptResponse> {
  return ctx.client
    .notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    })
    .then(() => ({ stopReason: "end_turn" }));
}

function setupOwnership(): DurableDelegatedWorkOwnership {
  return {
    lifetime: "durable",
    ownerConversationId: OWNER,
    runtimeId: asConversationRuntimeId("runtime-setup"),
    originSurfaceId: surfaceId(dmSurface(911)),
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: "epoch-setup",
  };
}

function followupOwnership(): DurableDelegatedWorkOwnership {
  return {
    lifetime: "durable",
    ownerConversationId: OWNER,
    runtimeId: asConversationRuntimeId("runtime-followup"),
    originSurfaceId: surfaceId(dmSurface(911)),
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: "epoch-followup",
  };
}

function completedRecord(
  workHost: DelegatedWorkHost,
  runId: string,
  backend: "claude" | "devin",
  providerSessionId: string,
  cwd: string,
): void {
  workHost.createExternalRecord(runId, backend, setupOwnership(), {
    workingDirectory: cwd,
    permissionProfile: "dangerous",
    ...(backend === "devin" ? { devinModel: "glm-5.2" } : { devinModel: null }),
    task: "original task",
  });
  workHost.captureExternalSession(runId, providerSessionId);
  workHost.completeInvocation(runId, 0, "first answer");
}

describe("completed-context follow-up via resume or load", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-continuation-"));
    cwd = mkdtempSync(join(tmpdir(), "goblin-continuation-cwd-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("claude resume continues completed context as a new invocation", async () => {
    const workHost = new DelegatedWorkHost(home);
    const processHost = new MockContinuationProcessHost(
      () =>
        new MockContinuationServer({
          agentCapabilities: CLAUDE_CAPS,
          modes: CLAUDE_MODES,
          promptBehaviors: [(ctx) => followupText(ctx, "follow-up done")],
        }),
    );
    const agentHost = new ExternalAgentHost({ processHost });
    completedRecord(workHost, "followup-claude", "claude", "sess-claude-1", cwd);

    const result = await continueExternalRun({
      workHost,
      agentHost,
      runId: "followup-claude",
      prompt: "do more",
      ownership: followupOwnership(),
      env: ENV,
    });

    expect(result.outcome.stopReason).toBe("end_turn");
    expect(result.outcome.agentText).toBe("follow-up done");
    expect(result.live).toBeNull();
    const server = processHost.spawns[0]?.server;
    expect(server?.resumeRequests).toEqual([{ sessionId: "sess-claude-1" }]);
    expect(server?.loadRequests).toEqual([]);
    expect(server?.prompts).toEqual(["do more"]);
    expect(processHost.spawns[0]?.args.cwd).toBe(cwd);
    expect(processHost.spawns[0]?.handle.killed).toBe(true);

    const record = workHost.loadRecord("followup-claude");
    expect(record?.kind).toBe("external-agent");
    expect(record?.invocations).toHaveLength(2);
    expect(record?.invocations[0]?.status).toBe("completed");
    expect(record?.invocations[0]?.outcome).toEqual({ kind: "success", text: "first answer" });
    expect(record?.invocations[1]?.status).toBe("completed");
    expect(record?.invocations[1]?.outcome).toEqual({ kind: "success", text: "follow-up done" });
    if (record?.kind === "external-agent") {
      expect(record.external.providerSessionId).toBe("sess-claude-1");
      expect(record.external.backend).toBe("claude");
    }
  });

  it("devin load continues completed context as a new invocation", async () => {
    const workHost = new DelegatedWorkHost(home);
    const processHost = new MockContinuationProcessHost(
      () =>
        new MockContinuationServer({
          agentCapabilities: DEVIN_CAPS,
          promptBehaviors: [(ctx) => followupText(ctx, "devin follow-up")],
        }),
    );
    const agentHost = new ExternalAgentHost({ processHost });
    completedRecord(workHost, "followup-devin", "devin", "sess-devin-1", cwd);

    const result = await continueExternalRun({
      workHost,
      agentHost,
      runId: "followup-devin",
      prompt: "do more on devin",
      ownership: followupOwnership(),
      env: ENV,
    });

    expect(result.outcome.stopReason).toBe("end_turn");
    expect(result.outcome.agentText).toBe("devin follow-up");
    expect(result.live).toBeNull();
    const server = processHost.spawns[0]?.server;
    expect(server?.loadRequests).toEqual([{ sessionId: "sess-devin-1" }]);
    expect(server?.resumeRequests).toEqual([]);
    expect(processHost.spawns[0]?.args.command).toEqual([
      "devin",
      "--permission-mode",
      "auto",
      "--sandbox",
      "acp",
      "--model",
      "glm-5.2",
    ]);

    const record = workHost.loadRecord("followup-devin");
    expect(record?.invocations).toHaveLength(2);
    expect(record?.invocations[0]?.status).toBe("completed");
    expect(record?.invocations[1]?.status).toBe("completed");
    expect(record?.invocations[1]?.outcome).toEqual({ kind: "success", text: "devin follow-up" });
  });

  it("permission profile re-applied on continuation connection", async () => {
    const workHost = new DelegatedWorkHost(home);
    const processHost = new MockContinuationProcessHost(
      () =>
        new MockContinuationServer({
          agentCapabilities: CLAUDE_CAPS,
          modes: CLAUDE_MODES,
          promptBehaviors: [
            async (ctx) => {
              const outcome = await ctx.client.request(methods.client.session.requestPermission, {
                sessionId: "sess-claude-1",
                toolCall: { toolCallId: "t1", title: "Run command" },
                options: [
                  { optionId: "allow-always", name: "allow", kind: "allow_always" },
                  { optionId: "reject-once", name: "reject", kind: "reject_once" },
                ],
              });
              const decision = outcome.outcome;
              if (decision.outcome !== "selected" || decision.optionId !== "allow-always") {
                throw new Error("dangerous profile did not allow the permission request");
              }
              return { stopReason: "end_turn" };
            },
          ],
        }),
    );
    const agentHost = new ExternalAgentHost({ processHost });
    completedRecord(workHost, "followup-profile", "claude", "sess-claude-1", cwd);

    await continueExternalRun({
      workHost,
      agentHost,
      runId: "followup-profile",
      prompt: "go",
      ownership: followupOwnership(),
      env: ENV,
    });

    expect(processHost.spawns[0]?.server.setModeRequests).toEqual([
      { sessionId: "sess-claude-1", modeId: "bypassPermissions" },
    ]);
  });

  it("follow-up on an interrupted run refused without a new invocation", async () => {
    for (const [name, close] of [
      ["interrupted", (h: DelegatedWorkHost, id: string) => h.interruptInvocation(id, 0)],
      ["cancelled", (h: DelegatedWorkHost, id: string) => h.cancelInvocation(id, 0)],
      ["errored", (h: DelegatedWorkHost, id: string) => h.failInvocation(id, 0, "boom")],
    ] as const) {
      const runHome = mkdtempSync(join(tmpdir(), "goblin-continuation-refuse-"));
      try {
        const workHost = new DelegatedWorkHost(runHome);
        const processHost = new MockContinuationProcessHost(
          () => new MockContinuationServer({ agentCapabilities: CLAUDE_CAPS, modes: CLAUDE_MODES }),
        );
        const agentHost = new ExternalAgentHost({ processHost });
        const runId = `refused-${name}`;
        workHost.createExternalRecord(runId, "claude", setupOwnership(), {
          workingDirectory: cwd,
          permissionProfile: "dangerous",
          devinModel: null,
          task: "original task",
        });
        workHost.captureExternalSession(runId, "sess-interrupted");
        close(workHost, runId);

        let error: unknown;
        try {
          await continueExternalRun({
            workHost,
            agentHost,
            runId,
            prompt: "try to continue",
            ownership: followupOwnership(),
            env: ENV,
          });
        } catch (err) {
          error = err;
        }
        expect(error).toBeInstanceOf(ContinuationRefusedError);
        expect(workHost.loadRecord(runId)?.invocations).toHaveLength(1);
        expect(processHost.spawns).toHaveLength(0);
      } finally {
        rmSync(runHome, { recursive: true, force: true });
      }
    }
  });

  it("continuation refused when the backend lacks the capability", async () => {
    for (const [backend, caps] of [
      ["claude", { loadSession: true, sessionCapabilities: { close: {} } }],
      ["devin", { loadSession: false, sessionCapabilities: { delete: {} } }],
    ] as const) {
      const runHome = mkdtempSync(join(tmpdir(), "goblin-continuation-cap-"));
      try {
        const workHost = new DelegatedWorkHost(runHome);
        const processHost = new MockContinuationProcessHost(
          () => new MockContinuationServer({ agentCapabilities: caps }),
        );
        const agentHost = new ExternalAgentHost({ processHost });
        const runId = `nocap-${backend}`;
        completedRecord(workHost, runId, backend, `sess-${backend}-1`, cwd);

        let error: unknown;
        try {
          await continueExternalRun({
            workHost,
            agentHost,
            runId,
            prompt: "try to continue",
            ownership: followupOwnership(),
            env: ENV,
          });
        } catch (err) {
          error = err;
        }
        expect(error).toBeInstanceOf(AcpHostError);
        expect((error as AcpHostError).reason).toBe("protocol");
        expect(workHost.loadRecord(runId)?.invocations).toHaveLength(1);
        expect(workHost.loadRecord(runId)?.invocations[0]?.status).toBe("completed");
        expect(processHost.spawns[0]?.handle.killed).toBe(true);
      } finally {
        rmSync(runHome, { recursive: true, force: true });
      }
    }
  });

  it("follow-up from another Conversation is refused without a new invocation", async () => {
    const workHost = new DelegatedWorkHost(home);
    const processHost = new MockContinuationProcessHost(
      () => new MockContinuationServer({ agentCapabilities: CLAUDE_CAPS, modes: CLAUDE_MODES }),
    );
    const agentHost = new ExternalAgentHost({ processHost });
    completedRecord(workHost, "followup-owner", "claude", "sess-claude-1", cwd);

    let error: unknown;
    try {
      await continueExternalRun({
        workHost,
        agentHost,
        runId: "followup-owner",
        prompt: "hijack",
        ownership: { ...followupOwnership(), ownerConversationId: "conversation-other" },
        env: ENV,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ContinuationRefusedError);
    expect(workHost.loadRecord("followup-owner")?.invocations).toHaveLength(1);
    expect(processHost.spawns).toHaveLength(0);
  });

  it("concurrent follow-ups serialize: only one appends a new invocation", async () => {
    const workHost = new DelegatedWorkHost(home);
    const processHost = new MockContinuationProcessHost(
      () =>
        new MockContinuationServer({
          agentCapabilities: CLAUDE_CAPS,
          modes: CLAUDE_MODES,
          promptBehaviors: [(ctx) => followupText(ctx, "winner")],
        }),
    );
    const agentHost = new ExternalAgentHost({ processHost });
    completedRecord(workHost, "followup-race", "claude", "sess-claude-1", cwd);

    const settled = await Promise.allSettled([
      continueExternalRun({
        workHost,
        agentHost,
        runId: "followup-race",
        prompt: "first",
        ownership: followupOwnership(),
        env: ENV,
      }),
      continueExternalRun({
        workHost,
        agentHost,
        runId: "followup-race",
        prompt: "second",
        ownership: { ...followupOwnership(), ownershipEpochId: "epoch-followup-2" },
        env: ENV,
      }),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const record = workHost.loadRecord("followup-race");
    expect(record?.invocations).toHaveLength(2);
    expect(record?.invocations[1]?.status).toBe("completed");
  });

  it("a failed follow-up prompt marks the new invocation errored", async () => {
    const workHost = new DelegatedWorkHost(home);
    const processHost = new MockContinuationProcessHost(
      () =>
        new MockContinuationServer({
          agentCapabilities: CLAUDE_CAPS,
          modes: CLAUDE_MODES,
          promptBehaviors: [
            () => {
              throw new Error("provider boom");
            },
          ],
        }),
    );
    const agentHost = new ExternalAgentHost({ processHost });
    completedRecord(workHost, "followup-error", "claude", "sess-claude-1", cwd);

    let error: unknown;
    try {
      await continueExternalRun({
        workHost,
        agentHost,
        runId: "followup-error",
        prompt: "will fail",
        ownership: followupOwnership(),
        env: ENV,
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    const record = workHost.loadRecord("followup-error");
    expect(record?.invocations).toHaveLength(2);
    expect(record?.invocations[0]?.status).toBe("completed");
    expect(record?.invocations[1]?.status).toBe("error");
    expect(record?.invocations[1]?.deliveryState).toBe("suppressed");
  });

  it("an input_required follow-up stays running on its live connection", async () => {
    const workHost = new DelegatedWorkHost(home);
    const processHost = new MockContinuationProcessHost(
      () =>
        new MockContinuationServer({
          agentCapabilities: CLAUDE_CAPS,
          modes: CLAUDE_MODES,
          promptBehaviors: [
            () => ({ stopReason: "input_required" }) as unknown as PromptResponse,
            (ctx) => followupText(ctx, "continued after input"),
          ],
        }),
    );
    const agentHost = new ExternalAgentHost({ processHost });
    completedRecord(workHost, "followup-input", "claude", "sess-claude-1", cwd);

    const result = await continueExternalRun({
      workHost,
      agentHost,
      runId: "followup-input",
      prompt: "needs input",
      ownership: followupOwnership(),
      env: ENV,
    });

    expect(result.outcome.stopReason).toBe("input_required");
    expect(result.live).not.toBeNull();
    expect(workHost.loadRecord("followup-input")?.invocations).toHaveLength(2);
    expect(workHost.loadRecord("followup-input")?.invocations[1]?.status).toBe("running");
    await result.live?.dispose();
  });
});
