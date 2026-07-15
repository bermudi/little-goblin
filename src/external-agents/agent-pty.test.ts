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

/**
 * Process host that returns a caller-supplied response per spawn, in order.
 * Used to drive the spawn RPC to success and the type RPC to failure.
 */
class SequencedProcessHost implements ProcessHost {
  spawns: { args: ProcessSpawnArgs; handle: FakeProcessHandle }[] = [];
  private next = 0;

  constructor(private readonly responses: string[]) {}

  async spawn(args: ProcessSpawnArgs): Promise<ProcessHandle> {
    const response = this.responses[this.next++] ?? '{"ok":true}';
    const handle = new FakeProcessHandle([response]);
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
    // Two spawns: the `spawn` RPC and the `type` RPC that delivers the task.
    expect(processHost.spawns.length).toBe(2);
    const status = events.find((e) => e.type === "status");
    expect(status).toBeDefined();
    expect(status!.message).not.toContain(task);
    expect(status!.message).toContain("agent-pty spawn: codex");
  });

  it("does not include the task text in the spawn command argv", async () => {
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

    // The first spawn is the `spawn` RPC; its request must not include the
    // task in the command args (visible via `ps`).
    const spawnRequest = JSON.parse(processHost.spawns[0]!.args.stdin! as string) as { command?: string; args?: string[] };
    expect(spawnRequest.args).not.toContain(task);
    expect(spawnRequest.args).not.toContain("--");
  });

  it("sends the task text via the type RPC after startup", async () => {
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

    // The second spawn is the `type` RPC that delivers the task.
    expect(processHost.spawns.length).toBeGreaterThanOrEqual(2);
    const typeRequest = JSON.parse(processHost.spawns[1]!.args.stdin! as string) as { cmd?: string; text?: string };
    expect(typeRequest.cmd).toBe("type");
    expect(typeRequest.text).toContain(task);
  });

  it("cancels the spawned session when task delivery fails", async () => {
    // spawn RPC succeeds, type RPC fails (non-ok response).
    const processHost = new SequencedProcessHost([
      '{"ok":true,"name":"test"}',
      '{"ok":false,"error":"type failed"}',
    ]);
    const adapter = new AgentPtyAdapter();
    const task = "secret user task";

    await expect(
      adapter.start(
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
      ),
    ).rejects.toThrow("type failed");

    // Three spawns: spawn RPC, type RPC (fails), then kill + remove cleanup.
    expect(processHost.spawns.length).toBeGreaterThanOrEqual(3);
    const cmds = processHost.spawns.slice(2).map((s) => {
      const req = JSON.parse(s.args.stdin! as string) as { cmd?: string };
      return req.cmd;
    });
    expect(cmds).toContain("kill");
    expect(cmds).toContain("remove");
  });
});
