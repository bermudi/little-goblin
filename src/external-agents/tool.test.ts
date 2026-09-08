import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { createDelegatedExternalAgentTool } from "./tool.ts";
import type { ProcessHandle, ProcessHost, ProcessSpawnArgs, ProcessExit } from "./types.ts";
import { ExternalAgentHost } from "./host.ts";
import { DelegatedWorkHost } from "../delegated-work/host.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import { asConversationRuntimeId } from "../delegated-work/types.ts";

// ---------------------------------------------------------------------------
// Delegated-run tool surface (issue #58 launch-input unit).
// ---------------------------------------------------------------------------

const TOOL_CLAUDE_MODES: SessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Manual" },
    { id: "acceptEdits", name: "Accept Edits" },
    { id: "bypassPermissions", name: "Bypass Permissions" },
  ],
};

const TOOL_CLAUDE_CAPS: AgentCapabilities = {
  loadSession: true,
  sessionCapabilities: { resume: {}, close: {} },
};

type ToolPromptBehavior = (ctx: AgentRequestContext<PromptRequest>) => Promise<PromptResponse> | PromptResponse;

class ToolFakeHandle implements ProcessHandle {
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

class ToolMockServer {
  readonly handle: ToolFakeHandle;
  readonly setModes: Array<{ sessionId: string; modeId: string }> = [];
  private readonly behaviors: ToolPromptBehavior[];
  constructor(sessionId: string, caps: AgentCapabilities, modes: SessionModeState | undefined, behaviors: ToolPromptBehavior[]) {
    this.behaviors = [...behaviors];
    const fromClient = new PassThrough();
    const toClient = new PassThrough();
    this.handle = new ToolFakeHandle(fromClient, toClient);
    const app = acpAgent({ name: "mock-tool-agent" })
      .onRequest(methods.agent.initialize, (c) => ({
        protocolVersion: c.params.protocolVersion,
        agentCapabilities: caps,
        authMethods: [],
      }))
      .onRequest(methods.agent.session.new, () => (
        modes === undefined ? { sessionId } : { sessionId, modes }
      ))
      .onRequest(methods.agent.session.setMode, (c) => {
        this.setModes.push({ sessionId: c.params.sessionId, modeId: c.params.modeId });
        return {};
      })
      .onRequest(methods.agent.session.prompt, (c) => {
        const next = this.behaviors.shift();
        if (next !== undefined) return next(c);
        return { stopReason: "end_turn" };
      });
    const connection = app.connect(ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(fromClient)));
    void connection.closed.catch(() => {});
  }
}

class ToolMockProcessHost implements ProcessHost {
  readonly spawns: Array<{ args: ProcessSpawnArgs; server: ToolMockServer }> = [];
  constructor(private readonly factory: (args: ProcessSpawnArgs) => ToolMockServer) {}
  async spawn(args: ProcessSpawnArgs): Promise<ProcessHandle> {
    const server = this.factory(args);
    this.spawns.push({ args, server });
    return server.handle;
  }
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first !== undefined && first.type === "text" && typeof first.text === "string") return first.text;
  return "";
}

function delegatedOwnership() {
  return {
    lifetime: "durable" as const,
    ownerConversationId: "conversation-tool",
    runtimeId: asConversationRuntimeId("runtime-tool"),
    originSurfaceId: surfaceId(dmSurface(901)),
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: "epoch-tool",
  };
}

describe("delegated external-agent launch input", () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-tool-launch-"));
    cwd = mkdtempSync(join(tmpdir(), "goblin-tool-cwd-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("tool start with explicit working directory, permission profile, and invocation selections outside any project environment succeeds and captures them", async () => {
    const workHost = new DelegatedWorkHost(home);
    const processHost = new ToolMockProcessHost(() => new ToolMockServer("sess-tool-1", TOOL_CLAUDE_CAPS, TOOL_CLAUDE_MODES, [
      async (ctx) => {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: "sess-tool-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
        });
        return { stopReason: "end_turn" };
      },
    ]));
    const agentHost = new ExternalAgentHost({ processHost });
    const tool = createDelegatedExternalAgentTool({
      workHost,
      agentHost,
      enabledBackends: ["claude", "devin"],
      buildOwnership: delegatedOwnership,
      resolveDevinModel: () => "glm-5.2",
    });
    const result = await tool.execute("call-1", {
      action: "start",
      agent: "claude",
      task: "do delegated work",
      workingDirectory: cwd,
      permissionProfile: "dangerous",
    }, undefined, undefined, undefined as unknown as ExtensionContext);
    const text = toolText(result);
    expect(text).toContain("Started external claude run");
    expect(text).toContain(cwd);
    const ids = workHost.listRecordIds();
    expect(ids).toHaveLength(1);
    const record = workHost.loadRecord(ids[0] ?? "");
    expect(record?.kind).toBe("external-agent");
    if (record?.kind === "external-agent") {
      expect(record.external.backend).toBe("claude");
      expect(record.external.workingDirectory).toBe(cwd);
      expect(record.external.permissionProfile).toBe("dangerous");
      expect(record.external.task).toBe("do delegated work");
      expect(record.external.providerSessionId).toBe("sess-tool-1");
    }
    expect(processHost.spawns).toHaveLength(1);
    expect(processHost.spawns[0]?.args.cwd).toBe(cwd);
    const status = await tool.execute("call-2", { action: "status", id: ids[0] }, undefined, undefined, undefined as unknown as ExtensionContext);
    expect(toolText(status)).toContain(cwd);
    const list = await tool.execute("call-3", { action: "list" }, undefined, undefined, undefined as unknown as ExtensionContext);
    expect(toolText(list)).toContain(ids[0] ?? "");
  });

  it("structurally invalid launch selections are rejected without a record or process", async () => {
    const workHost = new DelegatedWorkHost(home);
    const processHost = new ToolMockProcessHost(() => new ToolMockServer("sess-invalid", TOOL_CLAUDE_CAPS, TOOL_CLAUDE_MODES, []));
    const agentHost = new ExternalAgentHost({ processHost });
    const tool = createDelegatedExternalAgentTool({
      workHost,
      agentHost,
      enabledBackends: ["claude"],
      buildOwnership: delegatedOwnership,
      resolveDevinModel: () => undefined,
    });
    const cases: Array<Record<string, string>> = [
      { action: "start", agent: "claude", task: "hi", workingDirectory: "relative/path", permissionProfile: "dangerous" },
      { action: "start", agent: "claude", task: "hi", workingDirectory: cwd, permissionProfile: "nope" },
      { action: "start", agent: "claude", task: "   ", workingDirectory: cwd, permissionProfile: "dangerous" },
      { action: "start", agent: "devin", task: "hi", workingDirectory: cwd, permissionProfile: "dangerous" },
      { action: "start", agent: "codex", task: "hi", workingDirectory: cwd, permissionProfile: "dangerous" },
    ];
    for (const params of cases) {
      const result = await tool.execute("call-x", params, undefined, undefined, undefined as unknown as ExtensionContext);
      expect(toolText(result).startsWith("Error:")).toBe(true);
    }
    expect(workHost.listRecordIds()).toHaveLength(0);
    expect(processHost.spawns).toHaveLength(0);
  });

  it("child environment contains only allowlist keys", async () => {
    process.env.GOBLIN_TEST_API_KEY = "must-not-leak";
    process.env.BOT_TOKEN = "tg-secret";
    try {
      const workHost = new DelegatedWorkHost(home);
      const processHost = new ToolMockProcessHost(() => new ToolMockServer("sess-env", TOOL_CLAUDE_CAPS, TOOL_CLAUDE_MODES, []));
      const agentHost = new ExternalAgentHost({ processHost });
      const tool = createDelegatedExternalAgentTool({
        workHost,
        agentHost,
        enabledBackends: ["claude"],
        buildOwnership: delegatedOwnership,
        resolveDevinModel: () => "glm-5.2",
      });
      const result = await tool.execute("call-1", {
        action: "start",
        agent: "claude",
        task: "env check",
        workingDirectory: cwd,
      }, undefined, undefined, undefined as unknown as ExtensionContext);
      expect(toolText(result)).toContain("Started external claude run");
      const env = processHost.spawns[0]?.args.env ?? {};
      for (const key of Object.keys(env)) {
        expect(key.endsWith("_API_KEY")).toBe(false);
      }
      expect(env["GOBLIN_TEST_API_KEY"]).toBeUndefined();
      expect(env["BOT_TOKEN"]).toBeUndefined();
      expect(env["GOBLIN_HOME"]).toBeUndefined();
    } finally {
      delete process.env.GOBLIN_TEST_API_KEY;
      delete process.env.BOT_TOKEN;
    }
  });

  it("input_required run continues via a tool message", async () => {
    const workHost = new DelegatedWorkHost(home);
    const processHost = new ToolMockProcessHost(() => new ToolMockServer("sess-need-input", TOOL_CLAUDE_CAPS, TOOL_CLAUDE_MODES, [
      () => ({ stopReason: "input_required" }) as unknown as PromptResponse,
      async (ctx) => {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: "sess-need-input",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued" } },
        });
        return { stopReason: "end_turn" };
      },
    ]));
    const agentHost = new ExternalAgentHost({ processHost });
    const tool = createDelegatedExternalAgentTool({
      workHost,
      agentHost,
      enabledBackends: ["claude"],
      buildOwnership: delegatedOwnership,
      resolveDevinModel: () => "glm-5.2",
    });
    const started = await tool.execute("call-1", {
      action: "start",
      agent: "claude",
      task: "needs input",
      workingDirectory: cwd,
      permissionProfile: "dangerous",
    }, undefined, undefined, undefined as unknown as ExtensionContext);
    expect(toolText(started)).toContain("input_required");
    const ids = workHost.listRecordIds();
    expect(ids).toHaveLength(1);
    const runId = ids[0] ?? "";
    const status = await tool.execute("call-2", { action: "status", id: runId }, undefined, undefined, undefined as unknown as ExtensionContext);
    expect(toolText(status)).toContain("input_required");
    const continued = await tool.execute("call-3", { action: "message", id: runId, message: "go on" }, undefined, undefined, undefined as unknown as ExtensionContext);
    expect(toolText(continued)).toContain("completed");
    expect(workHost.loadRecord(runId)?.invocations[0]?.status).toBe("completed");
  });
});
