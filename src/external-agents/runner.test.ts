import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ExternalAgentRunner } from "./runner.ts";
import { ExternalRunStore } from "./store.ts";
import { externalAgentMetaPath } from "./paths.ts";
import type { Config } from "../config.ts";
import type { AdapterStartInput, ExternalAgentAdapter, ExternalAgentEvent, ExternalAgentHandle, ExternalAgentRunRecord, InternalRun, ProcessExit, ProcessHandle, ProcessHost, ProcessSpawnArgs } from "./types.ts";

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

class RecordingStore extends ExternalRunStore {
  calls: { method: string; runId: string; text?: string; status?: string }[] = [];

  override writeResult(runId: string, text: string): void {
    super.writeResult(runId, text);
    this.calls.push({ method: "writeResult", runId, text });
  }

  override save(record: ExternalAgentRunRecord): void {
    super.save(record);
    this.calls.push({ method: "save", runId: record.id, status: record.status });
  }
}

class ThrowingStore extends ExternalRunStore {
  override writeResult(): void {
    throw new Error("writeResult failed");
  }
}

class FlakyStore extends ExternalRunStore {
  private saveAttempts = 0;

  override save(record: ExternalAgentRunRecord): void {
    if (record.status === "completed" && this.saveAttempts === 0) {
      this.saveAttempts++;
      throw new Error("save failed once");
    }
    super.save(record);
  }
}

class ThrowingAppendStore extends ExternalRunStore {
  override appendEvent(run: InternalRun, event: ExternalAgentEvent): void {
    if (event.type === "completed") {
      throw new Error("appendEvent failed");
    }
    super.appendEvent(run, event);
  }
}

class FakeNoWaitAdapter implements ExternalAgentAdapter {
  readonly backend = "codex";

  async start(_input: AdapterStartInput, emit: (event: ExternalAgentEvent) => void): Promise<ExternalAgentHandle> {
    setTimeout(() => {
      emit({ type: "output", at: "2024-01-01T00:00:00.000Z", output: "hello output" });
      emit({ type: "completed", at: "2024-01-01T00:00:00.000Z" });
    }, 0);
    return { cancel: async () => {} };
  }
}

class FakeFailedEventAdapter implements ExternalAgentAdapter {
  readonly backend = "codex";

  async start(_input: AdapterStartInput, emit: (event: ExternalAgentEvent) => void): Promise<ExternalAgentHandle> {
    setTimeout(() => {
      emit({ type: "output", at: "2024-01-01T00:00:00.000Z", output: "hello output" });
      emit({ type: "failed", at: "2024-01-01T00:00:00.000Z", error: "original adapter failure" });
    }, 0);
    return { cancel: async () => {} };
  }
}

class FakeWaitExitAdapter implements ExternalAgentAdapter {
  readonly backend = "codex";

  async start(_input: AdapterStartInput, _emit: (event: ExternalAgentEvent) => void): Promise<ExternalAgentHandle> {
    return {
      cancel: async () => {},
      waitForExit: async () => ({ exitCode: 1, signal: null }),
    };
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

  it("writes result.txt before saving terminal metadata", async () => {
    const cfg = makeConfig();
    const processHost = new FakeProcessHost([
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello output" } }),
      JSON.stringify({ type: "turn.completed" }),
    ]);
    const store = new RecordingStore(cfg.goblinHome);
    const runner = new ExternalAgentRunner(cfg, { processHost, store });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("completed");
    expect(detail?.result).toBe("hello output");
    expect(store.getResult(summary.id)).toBe("hello output");

    const writeResultIndex = store.calls.findIndex((c) => c.method === "writeResult" && c.runId === summary.id && c.text === "hello output");
    const saveIndex = store.calls.findIndex((c) => c.method === "save" && c.runId === summary.id && c.status === "completed");
    expect(writeResultIndex).toBeGreaterThanOrEqual(0);
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(writeResultIndex).toBeLessThan(saveIndex);
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

  it("does not crash when writeResult fails during timeout", async () => {
    const cfg = makeConfig();
    cfg.externalAgents = { ...cfg.externalAgents!, timeoutMs: 10 };
    const processHost = new SlowProcessHost();
    const store = new ThrowingStore(cfg.goblinHome);
    const runner = new ExternalAgentRunner(cfg, { processHost, store });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("timed_out");
    expect(detail?.error).toContain("writeResult failed");

    const record = store.load(summary.id);
    expect(record?.status).toBe("timed_out");
    expect(record?.terminalError).toContain("writeResult failed");
  });

  it("does not crash when writeResult fails during cancel", async () => {
    const cfg = makeConfig();
    const processHost = new FakeProcessHost();
    const store = new ThrowingStore(cfg.goblinHome);
    const runner = new ExternalAgentRunner(cfg, { processHost, store });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cancelled = await runner.cancel(summary.id);
    expect(cancelled).toBe(true);

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("cancelled");
    expect(detail?.error).toContain("writeResult failed");

    const record = store.load(summary.id);
    expect(record?.status).toBe("cancelled");
    expect(record?.terminalError).toContain("writeResult failed");
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

  it("marks failed when writeResult fails during normal completion", async () => {
    const cfg = makeConfig();
    const processHost = new FakeProcessHost([
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello output" } }),
      JSON.stringify({ type: "turn.completed" }),
    ]);
    const store = new ThrowingStore(cfg.goblinHome);
    const runner = new ExternalAgentRunner(cfg, { processHost, store });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("failed");
    expect(detail?.error).toContain("writeResult failed");

    const record = store.load(summary.id);
    expect(record?.status).toBe("failed");
    expect(record?.terminalError).toContain("writeResult failed");
  });

  it("does not hang when writeResult fails for an adapter without waitForExit", async () => {
    const cfg = makeConfig();
    cfg.externalAgents = { ...cfg.externalAgents!, timeoutMs: 100 };
    const adapter = new FakeNoWaitAdapter();
    const store = new ThrowingStore(cfg.goblinHome);
    const runner = new ExternalAgentRunner(cfg, { store, adapters: new Map([["codex", adapter]]) });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("failed");
    expect(detail?.error).toContain("writeResult failed");

    const record = store.load(summary.id);
    expect(record?.status).toBe("failed");
    expect(record?.terminalError).toContain("writeResult failed");
  });

  it("init does not throw when writeResult fails for a non-terminal run", async () => {
    const cfg = makeConfig();
    const runDir = join(cfg.goblinHome, "scratch", "external-agents", "r-1");
    mkdirSync(runDir, { recursive: true });
    const meta = {
      id: "r-1",
      ownerSessionId: "s1",
      backend: "codex",
      projectDir: cfg.goblinHome,
      status: "running",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      adapterKind: "native",
      eventsTruncated: false,
      resultTruncated: false,
      inputRequired: undefined,
      terminalError: undefined,
    };
    writeFileSync(externalAgentMetaPath(cfg.goblinHome, "r-1"), JSON.stringify(meta, null, 2));
    const store = new ThrowingStore(cfg.goblinHome);
    const runner = new ExternalAgentRunner(cfg, { store });

    await runner.init();
    const detail = await runner.status("r-1");
    expect(detail?.status).toBe("interrupted");
    expect(detail?.error).toContain("writeResult failed");

    const record = store.load("r-1");
    expect(record?.status).toBe("interrupted");
    expect(record?.terminalError).toContain("writeResult failed");
  });

  it("preserves the original error when writeResult fails during a failed event", async () => {
    const cfg = makeConfig();
    const adapter = new FakeFailedEventAdapter();
    const store = new ThrowingStore(cfg.goblinHome);
    const runner = new ExternalAgentRunner(cfg, { store, adapters: new Map([["codex", adapter]]) });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("failed");
    expect(detail?.error).toContain("original adapter failure");
    expect(detail?.error).toContain("writeResult failed");

    const record = store.load(summary.id);
    expect(record?.status).toBe("failed");
    expect(record?.terminalError).toContain("original adapter failure");
  });

  it("preserves the original error when writeResult fails after waitForExit reports failure", async () => {
    const cfg = makeConfig();
    const adapter = new FakeWaitExitAdapter();
    const store = new ThrowingStore(cfg.goblinHome);
    const runner = new ExternalAgentRunner(cfg, { store, adapters: new Map([["codex", adapter]]) });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("failed");
    expect(detail?.error).toContain("exit code 1");
    expect(detail?.error).toContain("writeResult failed");

    const record = store.load(summary.id);
    expect(record?.status).toBe("failed");
    expect(record?.terminalError).toContain("exit code 1");
  });

  it("retries store.save when it fails after the run is already terminal", async () => {
    const cfg = makeConfig();
    const adapter = new FakeNoWaitAdapter();
    const store = new FlakyStore(cfg.goblinHome);
    const runner = new ExternalAgentRunner(cfg, { store, adapters: new Map([["codex", adapter]]) });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("completed");
    expect(detail?.result).toBe("hello output");

    const record = store.load(summary.id);
    expect(record?.status).toBe("completed");
    expect(store.getResult(summary.id)).toBe("hello output");
  });

  it("retries store.save when appendEvent fails after the run is already terminal", async () => {
    const cfg = makeConfig();
    const adapter = new FakeNoWaitAdapter();
    const store = new ThrowingAppendStore(cfg.goblinHome);
    const runner = new ExternalAgentRunner(cfg, { store, adapters: new Map([["codex", adapter]]) });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("completed");
    expect(detail?.result).toBe("hello output");

    const record = store.load(summary.id);
    expect(record?.status).toBe("completed");
    expect(store.getResult(summary.id)).toBe("hello output");
  });

  it("message() does not clobber terminal state when send fails after a concurrent timeout", async () => {
    // Adapter that enters input_required, then on send() blocks until the
    // run becomes terminal (via a short timeout) and throws — exercising the
    // guard that prevents recovery from overwriting a terminal transition.
    const cfg = makeConfig();
    cfg.externalAgents = { ...cfg.externalAgents!, timeoutMs: 30 };
    const adapter = new (class implements ExternalAgentAdapter {
      readonly backend = "codex" as const;
      async start(_input: AdapterStartInput, emit: (event: ExternalAgentEvent) => void): Promise<ExternalAgentHandle> {
        setTimeout(() => {
          emit({ type: "input_required", at: "2024-01-01T00:00:00.000Z", message: "send a message" });
        }, 0);
        return {
          cancel: async () => {},
          send: async (_text: string) => {
            // Block until the run is terminal, then throw.
            await new Promise((resolve) => setTimeout(resolve, 60));
            throw new Error("send failed after timeout");
          },
        };
      }
    })();
    const runner = new ExternalAgentRunner(cfg, { adapters: new Map([["codex", adapter]]) });

    const summary = await runner.start({ backend: "codex", task: "hello", sessionId: "s1", projectDir: cfg.goblinHome });
    // Wait for input_required.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await runner.status(summary.id))?.status).toBe("input_required");

    // Send a message; the send blocks past the 30ms timeout, so the run
    // becomes timed_out while send is in flight.
    await expect(runner.message(summary.id, "s1", "follow up")).rejects.toThrow("send failed after timeout");

    const detail = await runner.status(summary.id);
    expect(detail?.status).toBe("timed_out");
    // The terminal guard must not have restored inputRequired.
    expect(detail?.inputRequired).toBeUndefined();
    const record = runner["store"].load(summary.id);
    expect(record?.status).toBe("timed_out");
    expect(record?.inputRequired).toBeUndefined();
  });
});
