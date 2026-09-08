import { describe, it, expect } from "bun:test";
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
import { ExternalAgentHost } from "./host.ts";
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
const CWD = "/tmp/acp-shutdown-test";

class FakeShutdownHandle implements ProcessHandle {
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

interface MockShutdownConfig {
  sessionId: string;
  agentCapabilities: AgentCapabilities;
  modes?: SessionModeState;
}

class MockShutdownServer {
  readonly handle: FakeShutdownHandle;
  readonly closeRequests: Array<{ sessionId: string }> = [];
  readonly deleteRequests: Array<{ sessionId: string }> = [];
  readonly resumeRequests: Array<{ sessionId: string }> = [];
  readonly loadRequests: Array<{ sessionId: string }> = [];

  constructor(config: MockShutdownConfig) {
    const fromClient = new PassThrough();
    const toClient = new PassThrough();
    this.handle = new FakeShutdownHandle(fromClient, toClient);

    const app = acpAgent({ name: "mock-shutdown-agent" })
      .onRequest(methods.agent.initialize, (c) => ({
        protocolVersion: c.params.protocolVersion,
        agentCapabilities: config.agentCapabilities,
        authMethods: [],
      }))
      .onRequest(methods.agent.session.new, () =>
        config.modes === undefined ? { sessionId: config.sessionId } : { sessionId: config.sessionId, modes: config.modes },
      )
      .onRequest(methods.agent.session.resume, (c) => {
        this.resumeRequests.push({ sessionId: c.params.sessionId });
        return config.modes === undefined ? {} : { modes: config.modes };
      })
      .onRequest(methods.agent.session.load, (c) => {
        this.loadRequests.push({ sessionId: c.params.sessionId });
        return config.modes === undefined ? {} : { modes: config.modes };
      })
      .onRequest(methods.agent.session.close, (c) => {
        this.closeRequests.push({ sessionId: c.params.sessionId });
        return {};
      })
      .onRequest(methods.agent.session.delete, (c) => {
        this.deleteRequests.push({ sessionId: c.params.sessionId });
        return {};
      })
      .onRequest(methods.agent.session.setMode, () => ({}))
      .onRequest(methods.agent.session.prompt, (c: AgentRequestContext<PromptRequest>): PromptResponse => {
        void c;
        return { stopReason: "end_turn" };
      });

    const connection = app.connect(ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(fromClient)));
    void connection.closed.catch(() => {});
  }
}

class MockShutdownProcessHost implements ProcessHost {
  readonly servers: MockShutdownServer[] = [];
  readonly handles: FakeShutdownHandle[] = [];

  constructor(private readonly factory: () => MockShutdownServer) {}

  async spawn(_args: ProcessSpawnArgs): Promise<ProcessHandle> {
    const server = this.factory();
    this.servers.push(server);
    this.handles.push(server.handle);
    return server.handle;
  }
}

describe("session retirement and bounded process shutdown", () => {
  it("retirement invokes session/close for claude and session/delete for devin", async () => {
    const processHost = new MockShutdownProcessHost(
      () => new MockShutdownServer({ sessionId: "sess-claude-1", agentCapabilities: CLAUDE_CAPS, modes: CLAUDE_MODES }),
    );
    const host = new ExternalAgentHost({ processHost, shutdownGraceMs: 20 });
    const claude = await host.connect({
      backend: "claude",
      workingDirectory: CWD,
      permissionProfile: "dangerous",
      env: ENV,
    });
    try {
      await claude.retire();
      expect(claude.retired).toBe(true);
      expect(processHost.servers[0]?.closeRequests).toEqual([{ sessionId: "sess-claude-1" }]);
      expect(processHost.servers[0]?.deleteRequests).toEqual([]);
      // Retirement is recorded distinctly from process exit: the server
      // process is still alive until bounded local cleanup runs.
      expect(processHost.servers[0]?.handle.killed).toBe(false);
    } finally {
      await claude.dispose();
    }
    expect(processHost.servers[0]?.handle.killed).toBe(true);

    const devinHost = new MockShutdownProcessHost(
      () => new MockShutdownServer({ sessionId: "sess-devin-1", agentCapabilities: DEVIN_CAPS }),
    );
    const devinAgent = new ExternalAgentHost({ processHost: devinHost, shutdownGraceMs: 20 });
    const devin = await devinAgent.connect({
      backend: "devin",
      workingDirectory: CWD,
      permissionProfile: "dangerous",
      env: ENV,
      devinModel: "glm-5.2",
    });
    try {
      await devin.retire();
      expect(devin.retired).toBe(true);
      expect(devinHost.servers[0]?.deleteRequests).toEqual([{ sessionId: "sess-devin-1" }]);
      expect(devinHost.servers[0]?.closeRequests).toEqual([]);
      expect(devinHost.servers[0]?.handle.killed).toBe(false);
    } finally {
      await devin.dispose();
    }
    expect(devinHost.servers[0]?.handle.killed).toBe(true);
  });

  it("shutdown escalates to process termination when transport closure is ignored", async () => {
    const processHost = new MockShutdownProcessHost(
      () => new MockShutdownServer({ sessionId: "sess-claude-1", agentCapabilities: CLAUDE_CAPS, modes: CLAUDE_MODES }),
    );
    // The mock server ignores transport closure the way Devin required
    // bounded termination: nothing exits until the process is killed.
    const host = new ExternalAgentHost({ processHost, shutdownGraceMs: 50 });
    const connection = await host.connect({
      backend: "claude",
      workingDirectory: CWD,
      permissionProfile: "default",
      env: ENV,
    });
    const handle = processHost.handles[0];
    if (handle === undefined) {
      throw new Error("no process handle recorded");
    }
    const started = Date.now();
    await connection.dispose();
    const elapsed = Date.now() - started;
    // Graceful transport closure was awaited first (not an instant kill),
    // then escalation terminated the server that ignored the closure.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
    expect(handle.killed).toBe(true);
  });

  it("process exit alone leaves provider context loadable for follow-up", async () => {
    const processHost = new MockShutdownProcessHost(
      () => new MockShutdownServer({ sessionId: "sess-claude-1", agentCapabilities: CLAUDE_CAPS, modes: CLAUDE_MODES }),
    );
    const host = new ExternalAgentHost({ processHost, shutdownGraceMs: 20 });
    const first = await host.connect({
      backend: "claude",
      workingDirectory: CWD,
      permissionProfile: "dangerous",
      env: ENV,
    });
    const sessionId = first.sessionId;
    // The server process dies without any retirement RPC.
    await processHost.handles[0]?.kill();
    await first.dispose();
    expect(processHost.servers[0]?.closeRequests).toEqual([]);
    expect(processHost.servers[0]?.deleteRequests).toEqual([]);

    const second = await host.continueSession({
      backend: "claude",
      workingDirectory: CWD,
      permissionProfile: "dangerous",
      env: ENV,
      providerSessionId: sessionId,
    });
    try {
      const outcome = await second.prompt("follow up after process death", () => {});
      expect(outcome.stopReason).toBe("end_turn");
      expect(processHost.servers[1]?.resumeRequests).toEqual([{ sessionId }]);
      expect(processHost.servers[1]?.closeRequests).toEqual([]);
    } finally {
      await second.dispose();
    }
  });
});
