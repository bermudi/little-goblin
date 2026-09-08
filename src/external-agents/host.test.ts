import { describe, it, expect } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  agent as acpAgent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentCapabilities,
  type AgentRequestContext,
  type InitializeRequest,
  type NewSessionRequest,
  type PermissionOption,
  type PromptRequest,
  type PromptResponse,
  type SessionModeState,
  type SessionUpdate,
  type SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { AcpHostError, ExternalAgentHost, claudeBridgeEntryPath } from "./host.ts";
import type { AcpHostEvent, PermissionProfile, ProcessExit, ProcessHandle, ProcessHost, ProcessSpawnArgs } from "./types.ts";

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  loadSession: true,
  sessionCapabilities: { resume: {}, close: {} },
};

const DEVIN_CAPABILITIES: AgentCapabilities = {
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

function allow(optionId: string, kind: "allow_once" | "allow_always") {
  return { optionId, name: optionId, kind } as const;
}

function reject(optionId: string, kind: "reject_once" | "reject_always") {
  return { optionId, name: optionId, kind } as const;
}

type PromptBehavior = (
  ctx: AgentRequestContext<PromptRequest>,
  server: MockAcpServer,
) => Promise<PromptResponse> | PromptResponse;

async function notifySessionUpdate(
  ctx: AgentRequestContext<PromptRequest>,
  sessionId: string,
  update: SessionUpdate,
): Promise<void> {
  await ctx.client.notify(methods.client.session.update, { sessionId, update });
}

async function requestPermission(
  ctx: AgentRequestContext<PromptRequest>,
  sessionId: string,
  server: MockAcpServer,
  options: PermissionOption[],
) {
  const outcome = await ctx.client.request(methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId: "t1", title: "Run command" },
    options,
  });
  server.permissionOutcomes.push(JSON.stringify(outcome.outcome));
  return outcome;
}

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

  // The ACP transport consumes stdout via ndJsonStream; this method exists for
  // interface compatibility only and must not attach a second reader.
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
    // Close the pipes the way a real child death would: EOF on both sides.
    this.stdin.end();
    this.stdout.push(null);
    this.resolveExit({ exitCode: null, signal: "SIGTERM" });
    await this.exitPromise;
  }

  getStderr(): string {
    return "";
  }
}

interface MockServerConfig {
  sessionId: string;
  agentCapabilities: AgentCapabilities;
  modes?: SessionModeState;
  promptBehaviors?: PromptBehavior[];
}

class MockAcpServer {
  readonly handle: FakeAcpHandle;
  readonly initializeRequests: InitializeRequest[] = [];
  readonly newSessionRequests: NewSessionRequest[] = [];
  readonly setModeRequests: SetSessionModeRequest[] = [];
  readonly prompts: string[] = [];
  readonly permissionOutcomes: string[] = [];
  readonly clientMethodErrors: string[] = [];
  cancelNotifications = 0;
  private readonly script: PromptBehavior[];
  private readonly fallback: PromptBehavior = () => ({ stopReason: "end_turn" });

  constructor(config: MockServerConfig) {
    this.script = [...(config.promptBehaviors ?? [])];

    const fromClient = new PassThrough();
    const toClient = new PassThrough();
    this.handle = new FakeAcpHandle(fromClient, toClient);

    const app = acpAgent({ name: "mock-acp-agent" })
      .onRequest(methods.agent.initialize, (c) => {
        this.initializeRequests.push(c.params);
        return {
          protocolVersion: c.params.protocolVersion,
          agentCapabilities: config.agentCapabilities,
          authMethods: [],
        };
      })
      .onRequest(methods.agent.session.new, (c) => {
        this.newSessionRequests.push(c.params);
        return config.modes === undefined
          ? { sessionId: config.sessionId }
          : { sessionId: config.sessionId, modes: config.modes };
      })
      .onRequest(methods.agent.session.setMode, (c) => {
        this.setModeRequests.push(c.params);
        return {};
      })
      .onNotification(methods.agent.session.cancel, () => {
        this.cancelNotifications += 1;
      })
      .onRequest(methods.agent.session.prompt, (c) => this.runPrompt(c));

    const connection = app.connect(ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(fromClient)));
    void connection.closed.catch(() => {});
  }

  private async runPrompt(c: AgentRequestContext<PromptRequest>): Promise<PromptResponse> {
    this.prompts.push(c.params.prompt.map((block) => (block.type === "text" ? block.text : "")).join(""));
    const behavior = this.script.shift() ?? this.fallback;
    return behavior(c, this);
  }
}

class MockProcessHost implements ProcessHost {
  readonly spawns: { args: ProcessSpawnArgs; server: MockAcpServer; handle: ProcessHandle }[] = [];

  constructor(private readonly factory: (args: ProcessSpawnArgs) => MockAcpServer) {}

  async spawn(args: ProcessSpawnArgs): Promise<ProcessHandle> {
    if (args.signal?.aborted) {
      throw new Error("Spawn aborted");
    }
    const server = this.factory(args);
    this.spawns.push({ args, server, handle: server.handle });
    if (args.signal) {
      args.signal.addEventListener("abort", () => {
        void server.handle.kill().catch(() => {});
      }, { once: true });
    }
    return server.handle;
  }
}

const ENV = { PATH: "/usr/bin", HOME: "/home/operator" };
const CWD = "/tmp/acp-host-test";

function claudeServerConfig(overrides: Partial<MockServerConfig> = {}): MockServerConfig {
  return {
    sessionId: "sess-claude-1",
    agentCapabilities: CLAUDE_CAPABILITIES,
    modes: CLAUDE_MODES,
    ...overrides,
  };
}

function hostServing(
  serverFactory: (args: ProcessSpawnArgs) => MockAcpServer,
  hostOptions: { cancelGraceMs?: number } = {},
): { host: ExternalAgentHost; processHost: MockProcessHost } {
  const processHost = new MockProcessHost(serverFactory);
  return { host: new ExternalAgentHost({ processHost, ...hostOptions }), processHost };
}

function claudeHost(
  serverOverrides: Partial<MockServerConfig> = {},
  hostOptions: { cancelGraceMs?: number } = {},
): { host: ExternalAgentHost; processHost: MockProcessHost } {
  return hostServing(() => new MockAcpServer(claudeServerConfig(serverOverrides)), hostOptions);
}

function devinHost(
  serverOverrides: Partial<MockServerConfig> = {},
  hostOptions: { cancelGraceMs?: number } = {},
): { host: ExternalAgentHost; processHost: MockProcessHost } {
  return hostServing(() => new MockAcpServer(devinServerConfig(serverOverrides)), hostOptions);
}

function devinServerConfig(overrides: Partial<MockServerConfig> = {}): MockServerConfig {
  return {
    sessionId: "sess-devin-1",
    agentCapabilities: DEVIN_CAPABILITIES,
    ...overrides,
  };
}

async function connectClaude(
  host: ExternalAgentHost,
  permissionProfile: PermissionProfile = "default",
  overrides: { promptTimeoutMs?: number; signal?: AbortSignal } = {},
) {
  return host.connect({
    backend: "claude",
    workingDirectory: CWD,
    permissionProfile,
    env: ENV,
    ...overrides,
  });
}

describe("ExternalAgentHost", () => {
  it("drives a prompt round trip and maps session updates and stop reasons to run events", async () => {
    const { host, processHost } = claudeHost({
      promptBehaviors: [
        async (ctx, server) => {
          await notifySessionUpdate(ctx, "sess-claude-1", {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello " },
          });
          await notifySessionUpdate(ctx, "sess-claude-1", {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "world" },
          });
          await notifySessionUpdate(ctx, "sess-claude-1", {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "Read file",
          });
          await notifySessionUpdate(ctx, "sess-claude-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            title: "Read file",
            status: "completed",
          });
          return { stopReason: "end_turn" };
        },
      ],
    });

    const events: AcpHostEvent[] = [];
    const connection = await connectClaude(host);
    try {
      const outcome = await connection.prompt("do a thing", (event) => events.push(event));

      expect(outcome.stopReason).toBe("end_turn");
      expect(outcome.agentText).toBe("Hello world");
      expect(events).toContainEqual({ type: "agent_message", text: "Hello " });
      expect(events).toContainEqual({ type: "agent_message", text: "world" });
      expect(events).toContainEqual({ type: "tool_status", toolCallId: "t1", title: "Read file" });
      expect(events).toContainEqual({ type: "tool_status", toolCallId: "t1", title: "Read file", status: "completed" });

      const spawn = processHost.spawns[0];
      expect(spawn).toBeDefined();
      expect(spawn.args.command[0]).toBe(process.execPath);
      expect(spawn.args.command[1]).toBe(claudeBridgeEntryPath());
      expect(spawn.args.cwd).toBe(CWD);
      expect(spawn.args.env).toEqual(ENV);

      const server = spawn.server;
      expect(server.initializeRequests.length).toBe(1);
      const init = server.initializeRequests[0];
      expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(init.clientInfo?.name).toBe("goblin");
      expect(server.newSessionRequests[0]?.cwd).toBe(CWD);

      expect(connection.sessionId).toBe("sess-claude-1");
      expect(connection.agentCapabilities).toEqual(CLAUDE_CAPABILITIES);
    } finally {
      await connection.dispose();
    }
    expect(processHost.spawns[0]?.handle.killed).toBe(true);
  });

  it("runs claude through the pinned bridge entrypoint and devin through the native server with the configured model", async () => {
    const { host, processHost } = hostServing((args) =>
      new MockAcpServer(args.command[0] === "devin" ? devinServerConfig() : claudeServerConfig()));

    const claude = await host.connect({
      backend: "claude",
      workingDirectory: CWD,
      permissionProfile: "default",
      env: ENV,
    });
    expect(processHost.spawns[0]?.args.command).toEqual([process.execPath, claudeBridgeEntryPath()]);
    await claude.dispose();

    const devinDefault = await host.connect({
      backend: "devin",
      workingDirectory: CWD,
      permissionProfile: "default",
      env: ENV,
    });
    expect(processHost.spawns[1]?.args.command).toEqual(["devin", "--sandbox", "acp", "--model", "glm-5.2"]);
    await devinDefault.dispose();

    const devinDangerous = await host.connect({
      backend: "devin",
      workingDirectory: CWD,
      permissionProfile: "dangerous",
      env: ENV,
      model: "glm-4.7",
    });
    expect(processHost.spawns[2]?.args.command).toEqual([
      "devin",
      "--permission-mode",
      "auto",
      "--sandbox",
      "acp",
      "--model",
      "glm-4.7",
    ]);
    await devinDangerous.prompt("one prompt", () => {});
    expect(processHost.spawns[2]?.server.prompts).toEqual(["one prompt"]);
    await devinDangerous.dispose();
  });

  it("advertises no filesystem or terminal capability and fs/terminal requests fail closed", async () => {
    const { host, processHost } = claudeHost({
      promptBehaviors: [
        async (ctx, server) => {
          const attempts: [string, Promise<unknown>][] = [
            ["fs/read_text_file", ctx.client.request(methods.client.fs.readTextFile, {
              sessionId: "sess-claude-1",
              path: "/etc/passwd",
            })],
            ["fs/write_text_file", ctx.client.request(methods.client.fs.writeTextFile, {
              sessionId: "sess-claude-1",
              path: "/etc/passwd",
              content: "nope",
            })],
            ["terminal/create", ctx.client.request(methods.client.terminal.create, {
              sessionId: "sess-claude-1",
              command: "rm -rf /",
            })],
          ];
          for (const [method, attempt] of attempts) {
            try {
              await attempt;
              server.clientMethodErrors.push(`${method}:ok`);
            } catch (err) {
              server.clientMethodErrors.push(`${method}:${err instanceof RequestError ? err.code : "other"}`);
            }
          }
          return { stopReason: "end_turn" };
        },
      ],
    });

    const connection = await connectClaude(host);
    try {
      await connection.prompt("probe client capabilities", () => {});
    } finally {
      await connection.dispose();
    }

    const server = processHost.spawns[0]?.server;
    expect(server).toBeDefined();
    // The SDK normalizes omitted capability keys into explicit negatives on
    // the wire; assert the semantics — nothing fs/terminal is advertised.
    const capabilities = server.initializeRequests[0]?.clientCapabilities;
    expect(capabilities?.fs?.readTextFile ?? false).toBe(false);
    expect(capabilities?.fs?.writeTextFile ?? false).toBe(false);
    expect(capabilities?.terminal ?? false).toBe(false);
    expect(server.clientMethodErrors).toEqual([
      "fs/read_text_file:-32601",
      "fs/write_text_file:-32601",
      "terminal/create:-32601",
    ]);
  });

  it("applies the selected permission profile on connection including unattended dangerous approval behavior", async () => {
    const { host, processHost } = claudeHost({
      promptBehaviors: [
        async (ctx, server) => {
          await requestPermission(ctx, "sess-claude-1", server, [
            allow("allow-always", "allow_always"),
            allow("allow-once", "allow_once"),
            reject("reject-once", "reject_once"),
          ]);
          return { stopReason: "end_turn" };
        },
      ],
    });

    const dangerous = await connectClaude(host, "dangerous");
    try {
      await dangerous.prompt("go", () => {});
    } finally {
      await dangerous.dispose();
    }

    const dangerousServer = processHost.spawns[0]?.server;
    expect(dangerousServer.setModeRequests).toEqual([
      { sessionId: "sess-claude-1", modeId: "bypassPermissions" },
    ]);
    expect(dangerousServer.permissionOutcomes).toEqual([
      JSON.stringify({ outcome: "selected", optionId: "allow-always" }),
    ]);

    const acceptEdits = await connectClaude(host, "accept-edits");
    try {
      await acceptEdits.prompt("go", () => {});
    } finally {
      await acceptEdits.dispose();
    }

    const acceptEditsServer = processHost.spawns[1]?.server;
    expect(acceptEditsServer.setModeRequests).toEqual([
      { sessionId: "sess-claude-1", modeId: "acceptEdits" },
    ]);
    expect(acceptEditsServer.permissionOutcomes).toEqual([
      JSON.stringify({ outcome: "selected", optionId: "reject-once" }),
    ]);
  });

  it("does not infer the profile from a prior connection, including concurrent connections", async () => {
    const { host, processHost } = claudeHost({
      promptBehaviors: [
        async (ctx, server) => {
          await requestPermission(ctx, "sess-claude-1", server, [
            allow("allow-once", "allow_once"),
            reject("reject-once", "reject_once"),
          ]);
          return { stopReason: "end_turn" };
        },
      ],
    });

    const dangerous = await connectClaude(host, "dangerous");
    const fallback = await connectClaude(host, "default");
    try {
      const [dangerousOutcome, fallbackOutcome] = await Promise.all([
        dangerous.prompt("dangerous turn", () => {}),
        fallback.prompt("default turn", () => {}),
      ]);
      expect(dangerousOutcome.stopReason).toBe("end_turn");
      expect(fallbackOutcome.stopReason).toBe("end_turn");
    } finally {
      await dangerous.dispose();
      await fallback.dispose();
    }

    expect(processHost.spawns.length).toBe(2);
    expect(processHost.spawns[0]?.server.setModeRequests).toEqual([
      { sessionId: "sess-claude-1", modeId: "bypassPermissions" },
    ]);
    expect(processHost.spawns[0]?.server.permissionOutcomes).toEqual([
      JSON.stringify({ outcome: "selected", optionId: "allow-once" }),
    ]);
    expect(processHost.spawns[1]?.server.setModeRequests).toEqual([
      { sessionId: "sess-claude-1", modeId: "default" },
    ]);
    expect(processHost.spawns[1]?.server.permissionOutcomes).toEqual([
      JSON.stringify({ outcome: "selected", optionId: "reject-once" }),
    ]);
  });

  it("fails honestly when the claude mode for the selected profile is not offered", async () => {
    const { host, processHost } = claudeHost({
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Manual" },
          { id: "acceptEdits", name: "Accept Edits" },
        ],
      },
    });

    let error: unknown;
    try {
      await connectClaude(host, "dangerous");
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(AcpHostError);
    expect((error as AcpHostError).reason).toBe("protocol");
    expect(processHost.spawns[0]?.handle.killed).toBe(true);
  });

  it("applies devin profiles via launch flags and pins the mode only when the server advertises it", async () => {
    const { host, processHost } = devinHost();

    const devin = await host.connect({
      backend: "devin",
      workingDirectory: CWD,
      permissionProfile: "dangerous",
      env: ENV,
    });
    try {
      expect(processHost.spawns[0]?.args.command).toEqual([
        "devin",
        "--permission-mode",
        "auto",
        "--sandbox",
        "acp",
        "--model",
        "glm-5.2",
      ]);
      // Devin's advertised mode vocabulary is not part of the qualified
      // contract; no mode id is inferred or sent for it.
      expect(processHost.spawns[0]?.server.setModeRequests).toEqual([]);
      await devin.prompt("devin turn", () => {});
    } finally {
      await devin.dispose();
    }
  });

  it("surfaces an input_required stop and continues on the same connection", async () => {
    const { host } = claudeHost({
      promptBehaviors: [
        () => ({ stopReason: "input_required" }),
        async (ctx, server) => {
          await notifySessionUpdate(ctx, "sess-claude-1", {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "continued" },
          });
          return { stopReason: "end_turn" };
        },
      ],
    });

    const events: AcpHostEvent[] = [];
    const connection = await connectClaude(host);
    try {
      const first = await connection.prompt("stop and ask", (event) => events.push(event));
      expect(first.stopReason).toBe("input_required");

      const second = await connection.prompt("continue", (event) => events.push(event));
      expect(second.stopReason).toBe("end_turn");
      expect(second.agentText).toBe("continued");
    } finally {
      await connection.dispose();
    }
  });

  it("times out a stuck prompt: cancels, escalates to termination, and throws", async () => {
    const { host, processHost } = claudeHost(
      {
        promptBehaviors: [
          () => new Promise<PromptResponse>(() => {}),
        ],
      },
      { cancelGraceMs: 25 },
    );

    const connection = await connectClaude(host, "default", { promptTimeoutMs: 60 });
    let error: unknown;
    try {
      await connection.prompt("hang forever", () => {});
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(AcpHostError);
    expect((error as AcpHostError).reason).toBe("timeout");
    expect(processHost.spawns[0]?.server.cancelNotifications).toBeGreaterThanOrEqual(1);
    expect(processHost.spawns[0]?.handle.killed).toBe(true);
  });

  it("propagates process death during a prompt instead of hanging", async () => {
    const { host, processHost } = claudeHost({
      promptBehaviors: [
        () => new Promise<PromptResponse>(() => {}),
      ],
    });

    const connection = await connectClaude(host);
    const promptPromise = connection.prompt("dies mid-turn", () => {});
    const handle = processHost.spawns[0]?.handle;
    expect(handle).toBeDefined();
    await handle.kill();

    let error: unknown;
    try {
      await promptPromise;
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AcpHostError);
    expect((error as AcpHostError).reason).toBe("process-exit");
  });

  it("propagates spawn failures instead of swallowing them", async () => {
    const failing: ProcessHost = {
      async spawn(): Promise<ProcessHandle> {
        throw new Error("EACCES: spawn denied");
      },
    };
    const host = new ExternalAgentHost({ processHost: failing });

    let error: unknown;
    try {
      await connectClaude(host);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("EACCES");
  });

  it("honors an abort signal by tearing the connection down", async () => {
    const { host, processHost } = claudeHost({
      promptBehaviors: [
        () => new Promise<PromptResponse>(() => {}),
      ],
    });

    const controller = new AbortController();
    const connection = await connectClaude(host, "default", { signal: controller.signal });
    const promptPromise = connection.prompt("will be aborted", () => {});
    controller.abort();

    let error: unknown;
    try {
      await promptPromise;
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AcpHostError);
    expect((error as AcpHostError).reason).toBe("aborted");
    expect(processHost.spawns[0]?.handle.killed).toBe(true);
  });
});
