import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ExternalAgentRunner } from "./runner.ts";
import type { Config } from "../config.ts";
import type { ProcessExit, ProcessHandle, ProcessHost, ProcessSpawnArgs } from "./types.ts";

const dirs: string[] = [];

function makeConfig(): Config {
  const goblinHome = mkdtempSync(join(tmpdir(), "goblin-external-runner-"));
  dirs.push(goblinHome);
  return {
    botToken: "token",
    allowedTgUserIds: new Set([1]),
    modelName: "poe/GPT-4o",
    goblinHome,
    logLevel: "error",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    voiceName: "en-US-AriaNeural",
    favorites: [],
    externalAgents: {
      backends: ["codex"],
      permissionProfile: "read-only",
      maxConcurrent: 1,
      timeoutMs: 300_000,
      ptyFallback: false,
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeProcessHandle implements ProcessHandle {
  stdin = new Writable({ write() {} });
  stdout = new Readable({ read() {} });
  killed = false;
  private exitResult: ProcessExit = { exitCode: 0, signal: null };
  private exitResolve: ((exit: ProcessExit) => void) | undefined;
  private exitPromise: Promise<ProcessExit> | undefined;
  private resolved = false;
  private lines: string[] = [];
  private lineIndex = 0;

  constructor(lines: string[] = [], private stderr: string = "", exitCode: number = 0) {
    this.lines = lines;
    this.exitResult = { exitCode, signal: null };
  }

  async *readLines(): AsyncIterable<string> {
    while (this.lineIndex < this.lines.length) {
      const line = this.lines[this.lineIndex++];
      if (line !== undefined) {
        yield line;
      }
    }
    if (this.lines.length > 0 && !this.resolved) {
      this.resolved = true;
      this.exitResolve?.(this.exitResult);
    }
  }

  waitForExit(): Promise<ProcessExit> {
    if (this.exitPromise === undefined) {
      if (this.resolved) {
        return Promise.resolve(this.exitResult);
      }
      this.exitPromise = new Promise<ProcessExit>((resolve) => {
        this.exitResolve = resolve;
        if (this.lineIndex >= this.lines.length && this.lines.length > 0 && !this.resolved) {
          this.resolved = true;
          resolve(this.exitResult);
        }
      });
    }
    return this.exitPromise;
  }

  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    if (!this.resolved) {
      this.resolved = true;
      this.exitResult = { exitCode: 1, signal: "SIGTERM" };
      this.exitResolve?.(this.exitResult);
    }
  }

  getStderr(): string {
    return this.stderr;
  }
}

class FakeProcessHost implements ProcessHost {
  spawns: { args: ProcessSpawnArgs; handle: FakeProcessHandle }[] = [];

  constructor(
    private readonly lines: string[] = [],
    private readonly stderr: string = "",
    private readonly exitCode: number = 0,
  ) {}

  async spawn(args: ProcessSpawnArgs): Promise<ProcessHandle> {
    if (args.signal?.aborted) {
      throw new Error("Spawn aborted");
    }
    const handle = new FakeProcessHandle(this.lines, this.stderr, this.exitCode);
    const entry = { args, handle };
    this.spawns.push(entry);

    if (args.signal) {
      args.signal.addEventListener("abort", () => {
        handle.kill().catch(() => {});
      }, { once: true });
    }

    return handle;
  }

  lastHandle(): FakeProcessHandle {
    const entry = this.spawns[this.spawns.length - 1];
    if (entry === undefined) throw new Error("no spawns");
    return entry.handle;
  }
}

class SlowProcessHost implements ProcessHost {
  async spawn(args: ProcessSpawnArgs): Promise<ProcessHandle> {
    if (args.signal?.aborted) {
      throw new Error("Spawn aborted");
    }
    return new Promise((_resolve, reject) => {
      args.signal?.addEventListener("abort", () => {
        reject(new Error("Spawn aborted"));
      }, { once: true });
    });
  }
}

describe("ExternalAgentRunner", () => {
  it("starts a run and reports summary", async () => {
    const cfg = makeConfig();
    const processHost = new FakeProcessHost();
    const runner = new ExternalAgentRunner(cfg, { processHost });

    const summary = await runner.start({
      backend: "codex",
      task: "hello",
      sessionId: "s1",
      projectDir: cfg.goblinHome,
    });

    expect(summary.backend).toBe("codex");
    expect(summary.status).toBe("starting");
    expect(processHost.spawns.length).toBe(1);
  });

  it("cancel waits for the process handle to be killed", async () => {
    const cfg = makeConfig();
    const processHost = new FakeProcessHost();
    const runner = new ExternalAgentRunner(cfg, { processHost });

    const summary = await runner.start({
      backend: "codex",
      task: "hello",
      sessionId: "s1",
      projectDir: cfg.goblinHome,
    });

    // Give the run time to enter the adapter.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cancelPromise = runner.cancel(summary.id);
    expect(processHost.lastHandle().killed).toBe(true);
    await cancelPromise;

    const run = await runner.status(summary.id);
    expect(run?.status).toBe("cancelled");
  });

  it("cancelBySession waits for all live runs to be cancelled", async () => {
    const cfg = makeConfig();
    cfg.externalAgents = { ...cfg.externalAgents!, maxConcurrent: 2 };
    const processHost = new FakeProcessHost();
    const runner = new ExternalAgentRunner(cfg, { processHost });

    const a = await runner.start({ backend: "codex", task: "a", sessionId: "s1", projectDir: cfg.goblinHome });
    const b = await runner.start({ backend: "codex", task: "b", sessionId: "s1", projectDir: cfg.goblinHome });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const count = await runner.cancelBySession("s1");
    expect(count).toBe(2);
    expect(processHost.spawns.length).toBe(2);
    expect(processHost.spawns.every((s) => s.handle.killed)).toBe(true);
    expect((await runner.status(a.id))?.status).toBe("cancelled");
    expect((await runner.status(b.id))?.status).toBe("cancelled");
  });

  it("status returns the run detail", async () => {
    const cfg = makeConfig();
    const processHost = new FakeProcessHost();
    const runner = new ExternalAgentRunner(cfg, { processHost });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    const detail = await runner.status(summary.id);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(summary.id);
  });

  it("forbids starting a disabled backend", async () => {
    const cfg = makeConfig();
    const processHost = new FakeProcessHost();
    const runner = new ExternalAgentRunner(cfg, { processHost });

    await expect(runner.start({ backend: "claude", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome }))
      .rejects.toThrow("Backend claude is not enabled");
  });

  it("queues start when the concurrency limit is reached", async () => {
    const cfg = makeConfig();
    cfg.externalAgents = { ...cfg.externalAgents!, maxConcurrent: 1 };
    const processHost = new FakeProcessHost(['{"type":"turn.completed"}']);
    const runner = new ExternalAgentRunner(cfg, { processHost });

    const a = runner.start({ backend: "codex", task: "first", sessionId: "s1", projectDir: cfg.goblinHome });
    const b = runner.start({ backend: "codex", task: "second", sessionId: "s1", projectDir: cfg.goblinHome });

    const [summaryA, summaryB] = await Promise.all([a, b]);
    expect(summaryA.status).toBe("starting");
    expect(summaryB.status).toBe("starting");
    expect(processHost.spawns.length).toBe(2);

    const finishedA = await runner.status(summaryA.id);
    expect(finishedA?.status).toBe("completed");
  });

  it("times out a run while the adapter is still starting", async () => {
    const cfg = makeConfig();
    cfg.externalAgents = { ...cfg.externalAgents!, timeoutMs: 10 };
    const processHost = new SlowProcessHost();
    const runner = new ExternalAgentRunner(cfg, { processHost });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("timed_out");
  });

  it("requires a project directory", async () => {
    const cfg = makeConfig();
    const processHost = new FakeProcessHost();
    const runner = new ExternalAgentRunner(cfg, { processHost });

    await expect(runner.start({ backend: "codex", task: "hello", sessionId: "s1" }))
      .rejects.toThrow("Project directory is required");
  });

  it("transitions to input_required when interactive mode is required and PTY fallback is disabled", async () => {
    const cfg = makeConfig();
    cfg.externalAgents = { ...cfg.externalAgents!, ptyFallback: false };
    const processHost = new FakeProcessHost(["invalid json"], "interactive mode required", 0);
    const runner = new ExternalAgentRunner(cfg, { processHost });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("input_required");
    expect(detail?.inputRequired).toContain("interactive fallback is unavailable");
  });
});
