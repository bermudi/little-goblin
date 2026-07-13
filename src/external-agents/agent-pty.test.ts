import { describe, it, expect } from "bun:test";
import { Writable, Readable } from "node:stream";
import type { ExternalAgentEvent, ProcessExit, ProcessHandle, ProcessHost, ProcessSpawnArgs } from "./types.ts";
import { AgentPtyAdapter } from "./agent-pty.ts";

class FakeProcessHandle implements ProcessHandle {
  stdin = new Writable({ write() {} });
  stdout = new Readable({ read() {} });
  private lineIndex = 0;

  constructor(private readonly lines: string[] = []) {}

  async *readLines(): AsyncIterable<string> {
    while (this.lineIndex < this.lines.length) {
      const line = this.lines[this.lineIndex++];
      if (line !== undefined) yield line;
    }
  }

  waitForExit(): Promise<ProcessExit> {
    return new Promise(() => {});
  }

  async kill(): Promise<void> {}

  getStderr(): string {
    return "";
  }
}

class FakeProcessHost implements ProcessHost {
  spawns: { args: ProcessSpawnArgs; handle: FakeProcessHandle }[] = [];

  constructor(private readonly response: string = '{"ok":true,"name":"test"}') {}

  async spawn(args: ProcessSpawnArgs): Promise<ProcessHandle> {
    const handle = new FakeProcessHandle([this.response]);
    this.spawns.push({ args, handle });
    return handle;
  }
}

describe("AgentPtyAdapter", () => {
  it("does not persist the task text in the status event", async () => {
    const processHost = new FakeProcessHost();
    const adapter = new AgentPtyAdapter();
    const events: ExternalAgentEvent[] = [];
    const task = "secret user task";

    const handle = await adapter.start(
      {
        runId: "run-1",
        sessionId: "s1",
        backend: "codex",
        task,
        projectDir: "/tmp/project",
        env: {},
        timeoutMs: 300_000,
        permissionProfile: "read-only",
        processHost,
        signal: new AbortController().signal,
      },
      (event) => events.push(event),
    );

    expect(handle).toBeDefined();
    expect(processHost.spawns.length).toBe(1);
    const status = events.find((e) => e.type === "status");
    expect(status).toBeDefined();
    expect(status!.message).not.toContain(task);
    expect(status!.message).toContain("agent-pty spawn: codex");
  });

  it("passes the task text to the agent-pty daemon in the spawn request", async () => {
    const processHost = new FakeProcessHost();
    const adapter = new AgentPtyAdapter();
    const task = "secret user task";

    await adapter.start(
      {
        runId: "run-1",
        sessionId: "s1",
        backend: "codex",
        task,
        projectDir: "/tmp/project",
        env: {},
        timeoutMs: 300_000,
        permissionProfile: "read-only",
        processHost,
        signal: new AbortController().signal,
      },
      () => {},
    );

    const request = processHost.spawns[0]!.args.stdin;
    expect(request).toContain(task);
  });
});
