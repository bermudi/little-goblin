import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { log } from "../log.ts";
import type { Config } from "../config.ts";
import type {
  ExternalAgentAdapter,
  ExternalAgentBackend,
  ExternalAgentEvent,
  ExternalAgentRunRecord,
  ExternalAgentRunSummary,
  ExternalAgentStatus,
  ExternalRunDetail,
  InternalRun,
  ProcessHost,
  TerminalStatus,
} from "./types.ts";
import { errorString, isTerminal, nowIso } from "./util.ts";
import { prepareEnv } from "./env.ts";
import { defaultProcessHost } from "./process.ts";
import { ExternalRunStore } from "./store.ts";
import { CodexAdapter } from "./codex.ts";
import { ClaudeAdapter } from "./claude.ts";
import { DevinAdapter } from "./devin.ts";
import { AgentPtyAdapter } from "./agent-pty.ts";

const MAX_RESULT_CHARS = 128_000;
const MAX_OUTPUT_EVENT_CHARS = 32_000;
const MAX_STATUS_CHARS = 16_000;
const MAX_LIST_COUNT = 20;

export interface ExternalAgentRunnerDeps {
  processHost?: ProcessHost;
  store?: ExternalRunStore;
  clock?: () => number;
}

export class ExternalAgentRunner {
  private readonly config;
  private readonly processHost: ProcessHost;
  private readonly store: ExternalRunStore;
  private readonly adapters: Map<ExternalAgentBackend, ExternalAgentAdapter>;
  private readonly fallbackAdapter: AgentPtyAdapter | undefined;
  private readonly concurrencyLimiter: ConcurrencyLimiter;
  private readonly runs = new Map<string, InternalRun>();
  private readonly clock: () => number;
  private disposed = false;

  constructor(cfg: Config, deps: ExternalAgentRunnerDeps = {}) {
    this.config = cfg.externalAgents ?? {
      backends: [],
      permissionProfile: "read-only",
      maxConcurrent: 2,
      timeoutMs: 1_800_000,
      ptyFallback: false,
    };
    this.processHost = deps.processHost ?? defaultProcessHost();
    this.store = deps.store ?? new ExternalRunStore(cfg.goblinHome);
    this.clock = deps.clock ?? Date.now;

    this.adapters = new Map<ExternalAgentBackend, ExternalAgentAdapter>();
    for (const backend of this.config.backends) {
      this.adapters.set(backend, this.createAdapter(backend));
    }

    this.fallbackAdapter = this.config.ptyFallback ? new AgentPtyAdapter() : undefined;
    this.concurrencyLimiter = new ConcurrencyLimiter(this.config.maxConcurrent);
  }

  async start(args: {
    backend: ExternalAgentBackend;
    task: string;
    sessionId: string;
    projectDir?: string;
    signal?: AbortSignal;
  }): Promise<ExternalAgentRunSummary> {
    if (this.disposed) {
      throw new Error("External agent runner is disposed");
    }
    if (!this.config.backends.includes(args.backend)) {
      throw new Error(`Backend ${args.backend} is not enabled`);
    }
    if (!args.task.trim()) {
      throw new Error("Task is required");
    }

    await this.concurrencyLimiter.acquire(args.signal);
    let run: InternalRun;
    try {
      run = this.createRun(args);
      this.store.create(run.meta);
      this.runs.set(run.id, run);
    } catch (err) {
      this.concurrencyLimiter.release();
      throw err;
    }

    run.runPromise = this.runWithConcurrencyLimit(run).catch((err) => {
      log.error("external agent run failed", { runId: run.id, error: errorString(err) });
    });

    return this.summary(run);
  }

  async message(id: string, sessionId: string, text: string): Promise<ExternalAgentRunSummary> {
    const run = this.runs.get(id);
    if (!run || run.sessionId !== sessionId) {
      throw new Error("Run not found");
    }
    if (run.terminal) {
      throw new Error("Run is already terminal");
    }
    if (run.status !== "input_required") {
      throw new Error("Run is not awaiting input");
    }
    if (!run.handle?.send) {
      throw new Error("Adapter does not support messages");
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Message is required");
    }

    run.inputRequired = undefined;
    run.meta.inputRequired = undefined;
    this.transitionStatus(run, "running");
    this.store.save(run.meta);

    await run.handle.send(trimmed);
    return this.summary(run);
  }

  async status(id: string, sessionId?: string): Promise<ExternalRunDetail | null> {
    const run = this.runs.get(id);
    if (!run || (sessionId && run.sessionId !== sessionId)) {
      return null;
    }
    return this.detail(run);
  }

  list(sessionId?: string): ExternalAgentRunSummary[] {
    const runs = Array.from(this.runs.values())
      .filter((run) => !run.terminal && (!sessionId || run.sessionId === sessionId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_LIST_COUNT)
      .map((run) => this.summary(run));
    return runs;
  }

  async cancel(id: string, sessionId?: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || (sessionId && run.sessionId !== sessionId)) {
      return false;
    }
    if (run.terminal) {
      return false;
    }
    this.emitTerminal(run, "cancelled");
    run.abortController.abort();
    try {
      await run.runPromise;
    } catch {
      // best-effort
    }
    return true;
  }

  async cancelBySession(sessionId?: string): Promise<number> {
    const live = Array.from(this.runs.values()).filter(
      (run) => (!sessionId || run.sessionId === sessionId) && !run.terminal,
    );
    await Promise.all(live.map((run) => this.cancel(run.id)));
    return live.length;
  }

  async init(): Promise<void> {
    const records = this.store.list();
    const ptyOwners = new Set<string>();
    for (const meta of records) {
      if (isTerminal(meta.status as ExternalAgentStatus)) continue;
      if (meta.adapterKind === "pty") {
        ptyOwners.add(meta.ownerSessionId);
      }
    }
    if (ptyOwners.size > 0) {
      const adapter = this.fallbackAdapter ?? new AgentPtyAdapter();
      const env = prepareEnv();
      for (const ownerSessionId of ptyOwners) {
        await adapter.killOwner(this.processHost, process.cwd(), env, ownerSessionId);
      }
    }
    for (const meta of records) {
      if (isTerminal(meta.status as ExternalAgentStatus)) continue;
      const run = this.createRunFromMeta(meta);
      this.runs.set(run.id, run);
      this.emitTerminal(run, "interrupted", "Interrupted during startup");
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const live = Array.from(this.runs.values()).filter((run) => !run.terminal);
    await Promise.all(
      live.map((run) =>
        this.cancel(run.id, run.sessionId).catch((err) => {
          log.error("external agent dispose cancel failed", { runId: run.id, error: errorString(err) });
        })
      ),
    );
  }

  private async runWithConcurrencyLimit(run: InternalRun): Promise<void> {
    try {
      await this.executeRun(run);
    } finally {
      this.concurrencyLimiter.release();
    }
  }

  private async executeRun(run: InternalRun): Promise<void> {
    if (run.terminal) {
      return;
    }
    try {
      const adapter = run.fallback ? this.fallbackAdapter : this.adapters.get(run.backend);
      if (!adapter) {
        throw new Error(`No adapter available for ${run.backend}`);
      }

      // Start the timeout before adapter startup so it covers the whole run
      // and is not reset on PTY fallback (preserves the original deadline).
      this.startTimeout(run);

      const input = this.buildInput(run);
      const handle = await adapter.start(input, (event) => this.handleEvent(run, event));
      run.handle = handle;

      if (run.terminal) {
        return;
      }

      if (run.status === "starting") {
        this.transitionStatus(run, "running");
        this.store.save(run.meta);
      }
      this.startTimeout(run);

      if (handle.waitForExit) {
        const exit = await handle.waitForExit();
        if (run.terminal) {
          return;
        }
        if (exit.exitCode === 0) {
          this.emitTerminal(run, "completed");
        } else {
          this.emitTerminal(run, "failed", `exit code ${exit.exitCode ?? "null"}`);
        }
        return;
      }

      await run.terminalPromise;
    } catch (err) {
      if (run.terminal) {
        return;
      }
      if (err instanceof Error && err.name === "InteractiveRequiredError" && !run.fallback) {
        if (this.fallbackAdapter) {
          this.handleEvent(run, { type: "status", message: "interactive fallback", at: nowIso(this.clock) });
          try {
            await run.handle?.cancel();
          } catch {
            // ignore
          }
          run.handle = undefined;
          run.fallback = true;
          run.adapterKind = "pty";
          run.status = "starting";
          run.meta.status = "starting";
          run.meta.adapterKind = "pty";
          run.meta.updatedAt = nowIso(this.clock);
          run.updatedAt = run.meta.updatedAt;
          this.store.save(run.meta);
          await this.executeRun(run);
          run.handle = undefined;
          return;
        }
        this.handleEvent(run, {
          type: "input_required",
          message: `${errorString(err)} (interactive fallback is unavailable)`,
          at: nowIso(this.clock),
        });
        // Keep the timeout alive and the concurrency slot held until the run is
        // cancelled or times out.
        await run.terminalPromise;
        return;
      }
      this.emitTerminal(run, "failed", errorString(err));
    } finally {
      this.clearTimeout(run);
      try {
        await run.handle?.cancel();
      } catch {
        // ignore
      }
    }
  }

  private buildInput(run: InternalRun): Parameters<ExternalAgentAdapter["start"]>[0] {
    return {
      runId: run.id,
      sessionId: run.sessionId,
      backend: run.backend,
      task: run.task,
      projectDir: run.projectDir,
      env: prepareEnv(),
      timeoutMs: this.config.timeoutMs,
      permissionProfile: this.config.permissionProfile,
      processHost: this.processHost,
      signal: run.abortController.signal,
    };
  }

  private createAdapter(backend: ExternalAgentBackend): ExternalAgentAdapter {
    switch (backend) {
      case "codex":
        return new CodexAdapter();
      case "claude":
        return new ClaudeAdapter();
      case "devin":
        return new DevinAdapter();
      default: {
        const _exhaustive: never = backend;
        void _exhaustive;
        throw new Error(`unknown backend: ${backend}`);
      }
    }
  }

  private createRunFromMeta(meta: ExternalAgentRunRecord): InternalRun {
    const abortController = new AbortController();
    let resolveTerminal: (() => void) | undefined;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const run: InternalRun = {
      ...meta,
      sessionId: meta.ownerSessionId,
      task: "",
      terminal: isTerminal(meta.status as ExternalAgentStatus),
      terminalError: meta.terminalError,
      handle: undefined,
      timeout: undefined,
      abortController,
      terminalPromise,
      resolveTerminal: resolveTerminal!,
      meta,
      eventsBytes: this.store.getEventsBytes(meta.id),
      result: this.store.getResult(meta.id),
      inputRequired: meta.inputRequired,
      fallback: meta.adapterKind === "pty",
      runPromise: undefined,
    };
    return run;
  }

  private createRun(args: { backend: ExternalAgentBackend; task: string; sessionId: string; projectDir?: string }): InternalRun {
    const { backend, task, sessionId } = args;
    let projectDir = args.projectDir;
    if (projectDir === undefined) {
      throw new Error("Project directory is required");
    }
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
      throw new Error(`Project directory does not exist: ${projectDir}`);
    }
    projectDir = realpathSync(projectDir);

    const id = randomUUID();
    const createdAt = nowIso(this.clock);
    const meta: ExternalAgentRunRecord = {
      id,
      ownerSessionId: sessionId,
      backend,
      projectDir,
      status: "starting",
      createdAt,
      updatedAt: createdAt,
      adapterKind: "native",
      eventsTruncated: false,
      resultTruncated: false,
      inputRequired: undefined,
      terminalError: undefined,
    };

    let resolveTerminal: (() => void) | undefined;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const abortController = new AbortController();

    const run: InternalRun = {
      ...meta,
      sessionId,
      task: task.trim(),
      terminal: false,
      terminalError: undefined,
      handle: undefined,
      timeout: undefined,
      abortController,
      terminalPromise,
      resolveTerminal: resolveTerminal!,
      meta,
      eventsBytes: 0,
      result: "",
      inputRequired: undefined,
      fallback: false,
      runPromise: undefined,
    };

    return run;
  }

  private handleEvent(run: InternalRun, event: ExternalAgentEvent): void {
    if (run.terminal) {
      return;
    }
    const capped = this.capEvent(event);
    this.applyEvent(run, capped);
    this.store.appendEvent(run, capped);
    this.store.save(run.meta);
  }

  private capEvent(event: ExternalAgentEvent): ExternalAgentEvent {
    const cap = (text: string | undefined): string | undefined => {
      if (text && text.length > MAX_OUTPUT_EVENT_CHARS) {
        return text.slice(0, MAX_OUTPUT_EVENT_CHARS);
      }
      return text;
    };
    return {
      ...event,
      message: cap(event.message),
      output: cap(event.output),
      error: cap(event.error),
    };
  }

  private applyEvent(run: InternalRun, event: ExternalAgentEvent): void {
    switch (event.type) {
      case "status": {
        // Status events are persisted by handleEvent; no Telegram-side action.
        break;
      }
      case "output": {
        if (event.output) {
          this.setResult(run, event.output);
        }
        break;
      }
      case "completed": {
        this.transitionTerminal(run, "completed");
        break;
      }
      case "failed": {
        this.transitionTerminal(run, "failed", event.error);
        break;
      }
      case "cancelled": {
        this.transitionTerminal(run, "cancelled");
        break;
      }
      case "timed_out": {
        this.transitionTerminal(run, "timed_out");
        break;
      }
      case "interrupted": {
        this.transitionTerminal(run, "interrupted", event.error);
        break;
      }
      case "input_required": {
        if (this.transitionStatus(run, "input_required")) {
          run.inputRequired = event.message ?? "send a message";
          run.meta.inputRequired = run.inputRequired;
        }
        break;
      }
      case "truncation": {
        // Truncation is a meta event; it is persisted and may be shown to the
        // user, but it does not change run state.
        break;
      }
      default: {
        const _exhaustive: never = event.type;
        void _exhaustive;
        throw new Error(`unknown event type: ${(event as { type: string }).type}`);
      }
    }
  }

  private setResult(run: InternalRun, text: string): void {
    if (run.meta.resultTruncated) {
      return;
    }
    const remaining = MAX_RESULT_CHARS - run.result.length;
    if (remaining <= 0) {
      run.meta.resultTruncated = true;
      return;
    }
    const toWrite = text.length > remaining ? text.slice(0, remaining) : text;
    run.result += toWrite;
    this.store.appendResult(run.id, toWrite);
    if (text.length > remaining) {
      run.meta.resultTruncated = true;
    }
  }

  private transitionStatus(run: InternalRun, status: ExternalAgentStatus): boolean {
    if (run.terminal || run.status === status) {
      return false;
    }
    run.status = status;
    run.meta.status = status;
    run.meta.updatedAt = nowIso(this.clock);
    run.updatedAt = run.meta.updatedAt;
    return true;
  }

  private transitionTerminal(run: InternalRun, terminal: ExternalAgentStatus, error?: string): boolean {
    if (run.terminal) {
      return false;
    }
    if (
      terminal !== "failed" &&
      terminal !== "cancelled" &&
      terminal !== "timed_out" &&
      terminal !== "completed" &&
      terminal !== "interrupted"
    ) {
      throw new Error(`invalid terminal status: ${terminal}`);
    }
    run.terminal = true;
    run.status = terminal;
    run.meta.status = terminal;
    run.terminalError = error;
    run.meta.terminalError = error;
    run.inputRequired = undefined;
    run.meta.inputRequired = undefined;
    run.meta.updatedAt = nowIso(this.clock);
    run.updatedAt = run.meta.updatedAt;
    this.clearTimeout(run);
    run.resolveTerminal();
    return true;
  }

  private emitTerminal(run: InternalRun, terminal: TerminalStatus, error?: string): void {
    if (run.terminal) {
      return;
    }
    this.handleEvent(run, { type: terminal, error, at: nowIso(this.clock) });
  }

  private startTimeout(run: InternalRun): void {
    if (this.config.timeoutMs <= 0) {
      return;
    }
    // Preserve the existing deadline across retries (e.g. PTY fallback).
    if (run.timeout) {
      return;
    }
    run.timeout = setTimeout(() => {
      this.timeoutRun(run.id);
    }, this.config.timeoutMs);
  }

  private timeoutRun(id: string): void {
    const run = this.runs.get(id);
    if (!run || run.terminal) {
      return;
    }
    this.emitTerminal(run, "timed_out");
    run.abortController.abort();
  }

  private clearTimeout(run: InternalRun): void {
    if (run.timeout) {
      clearTimeout(run.timeout);
      run.timeout = undefined;
    }
  }

  private summary(run: InternalRun): ExternalAgentRunSummary {
    return {
      id: run.id,
      backend: run.backend,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      projectDir: run.projectDir,
      eventsTruncated: run.meta.eventsTruncated,
      resultTruncated: run.meta.resultTruncated,
    };
  }

  private detail(run: InternalRun): ExternalRunDetail {
    const result = this.store.getResult(run.id);
    return {
      ...this.summary(run),
      recentEvents: this.store.getEvents(run.id),
      recentOutput: result.slice(-MAX_STATUS_CHARS),
      result,
      inputRequired: run.inputRequired,
      error: run.terminalError,
    };
  }
}

class ConcurrencyLimiter {
  private available: number;
  private waiters: Array<{
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    abortHandler: () => void;
  }> = [];

  constructor(max: number) {
    this.available = max;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Aborted"));
    }
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, abortHandler: () => {} };
      waiter.abortHandler = () => {
        this.removeWaiter(waiter);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      if (signal) {
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  release(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      if (waiter.signal?.aborted) continue;
      waiter.signal?.removeEventListener("abort", waiter.abortHandler);
      waiter.resolve();
      return;
    }
    this.available++;
  }

  private removeWaiter(waiter: typeof this.waiters[0]): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx >= 0) this.waiters.splice(idx, 1);
  }
}
