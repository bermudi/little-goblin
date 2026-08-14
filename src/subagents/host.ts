/**
 * Pi-only execution host for one subagent invocation.
 *
 * The host owns Pi resources and Pi protocol mechanics. It deliberately does
 * not know about SubagentRunner lifecycle, metadata, memory authority,
 * recursion, Telegram, or delegated-work ownership.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";
import { dispatchAgentEvent, extractAssistantText, type TurnCallbacks } from "../agent/events.ts";
import { resolveModel } from "../agent/models.ts";
import {
  materializeSkillSnapshot,
  SkillResolutionError,
  type ResolvedSkillSnapshot,
} from "../agent/skills/mod.ts";
import { boundedError, log } from "../log.ts";
import { createPiServices, piAgentDir, type PiServices } from "../pi-host.ts";
import type { SubagentHistoryTarget } from "./types.ts";
import { agentsMdPath, heartbeatMdPath, soulMdPath } from "../workspace/paths.ts";

/** Exact persisted history selected by the coordinator. */
export type SubagentHistory = SubagentHistoryTarget;

export interface GenericSubagentSkillSnapshot {
  readonly name: string;
  readonly snapshot: ResolvedSkillSnapshot;
}

export type SubagentResourcePreparation =
  | {
      readonly kind: "generic";
      /** Legacy/direct path form used when no captured snapshot is available. */
      readonly skillPaths: readonly string[];
      /** Captured skill bytes; takes precedence over skillPaths when present. */
      readonly skillSnapshots?: readonly GenericSubagentSkillSnapshot[];
    }
  | {
      readonly kind: "named";
      /** The canonical named-agent `.agents/skills/` directory. */
      readonly skillsDir: string;
    };

/**
 * All Pi construction inputs selected outside the host.
 *
 * The coordinator owns identity, environment, history lookup, and authority.
 * The host receives only an exact target and a pre-authorized resource plan.
 */
export interface SubagentPreparation {
  readonly cwd: string;
  readonly history: SubagentHistory;
  readonly resource: SubagentResourcePreparation;
}

/**
 * Invocation material assembled by the coordinator before activation.
 * `customTools` are already-authorized; the host only passes them to Pi.
 */
export interface SubagentCustomMessage {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details?: unknown;
}

export interface SubagentInvocation {
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly relevantMemoryPrelude?: SubagentCustomMessage;
  readonly customTools: readonly ToolDefinition[];
  /** Unprefixed status sink. Presentation prefixing remains coordinator-side. */
  readonly onStatusUpdate?: (message: string) => void;
  /**
   * Synchronous Pi completion observation, before lease cleanup. The host does
   * not assign domain status; the coordinator uses this to claim completion
   * before a concurrent cancellation can overwrite the lifecycle record.
   */
  readonly onCompletionClaimed?: () => void;
}

export interface SubagentHost {
  prepare(plan: SubagentPreparation): SubagentExecution;
}

export interface SubagentExecution {
  /** Runs exactly once; bounded stop may reject while a fenced vendor await drains in the background. */
  run(invocation: SubagentInvocation): Promise<string>;
  /** Idempotent Pi stop primitive; never chooses lifecycle policy. */
  stop(): Promise<void>;
}

export class SubagentExecutionStoppedError extends Error {
  constructor() {
    super("Subagent execution stopped");
    this.name = "SubagentExecutionStoppedError";
  }
}

export interface PiSubagentHostDeps {
  createPiServices: (home: string) => Promise<PiServices>;
  createAgentSession: typeof createAgentSession;
  DefaultResourceLoader: typeof DefaultResourceLoader;
  SessionManager: typeof SessionManager;
}

export interface PiSubagentHostOptions {
  deps?: Partial<PiSubagentHostDeps>;
  /** Bounds a broken provider abort so runner cancellation cannot hang. */
  abortTimeoutMs?: number;
  /** Bounds activation/prelude/prompt quiescence during stop(). */
  quiescenceTimeoutMs?: number;
}

interface PiHostRuntime {
  readonly cfg: Config;
  readonly deps: PiSubagentHostDeps;
  readonly abortTimeoutMs: number;
  readonly quiescenceTimeoutMs: number;
  readonly getServices: () => Promise<PiServices>;
}

const DEFAULT_ABORT_TIMEOUT_MS = 10_000;

export class SubagentExecutionQuiescenceError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Pi subagent activation quiescence timed out after ${timeoutMs}ms`);
    this.name = "SubagentExecutionQuiescenceError";
    this.timeoutMs = timeoutMs;
  }
}

/** Deployment-lifetime Pi infrastructure and per-invocation lease factory. */
export class PiSubagentHost implements SubagentHost {
  private readonly runtime: PiHostRuntime;

  constructor(cfg: Config, options: PiSubagentHostOptions = {}) {
    const deps: PiSubagentHostDeps = {
      createPiServices,
      createAgentSession,
      DefaultResourceLoader,
      SessionManager,
      ...options.deps,
    };
    let servicesPromise: Promise<PiServices> | null = null;
    this.runtime = {
      cfg,
      deps,
      abortTimeoutMs: options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
      quiescenceTimeoutMs: options.quiescenceTimeoutMs ?? options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
      getServices: () => {
        // Memoize the promise, not merely its eventual value. This prevents
        // concurrent first invocations from constructing PiServices twice.
        // A failed initialization must not become deployment-lifetime poison:
        // clear the rejected attempt so a later invocation can retry.
        if (servicesPromise === null) {
          servicesPromise = deps.createPiServices(cfg.goblinHome).catch((error: unknown) => {
            servicesPromise = null;
            throw error;
          });
        }
        return servicesPromise;
      },
    };
  }

  prepare(plan: SubagentPreparation): SubagentExecution {
    const prepared = clonePreparation(plan);
    const sessionManager = prepared.history.kind === "create"
      ? this.runtime.deps.SessionManager.create(prepared.cwd, prepared.history.sessionDir)
      : this.runtime.deps.SessionManager.open(
          prepared.history.sessionFile,
          prepared.history.sessionDir,
          prepared.cwd,
        );
    return new PiSubagentExecution(this.runtime, prepared, sessionManager);
  }
}

function clonePreparation(plan: SubagentPreparation): SubagentPreparation {
  return {
    cwd: plan.cwd,
    history: { ...plan.history },
    resource:
      plan.resource.kind === "generic"
        ? {
            kind: "generic",
            skillPaths: [...plan.resource.skillPaths],
            ...(plan.resource.skillSnapshots === undefined
              ? {}
              : {
                  skillSnapshots: plan.resource.skillSnapshots.map((skill) => ({
                    name: skill.name,
                    snapshot: {
                      entryPath: skill.snapshot.entryPath,
                      files: skill.snapshot.files.map((file) => ({ ...file })),
                    },
                  })),
                }),
          }
        : { kind: "named", skillsDir: plan.resource.skillsDir },
  };
}

function isStoppedError(error: unknown): error is SubagentExecutionStoppedError {
  return error instanceof SubagentExecutionStoppedError;
}

function cleanupError(errors: readonly unknown[]): Error | null {
  if (errors.length === 0) return null;
  return new AggregateError(errors, "Pi subagent cleanup failed");
}

function combineExecutionAndCleanupError(executionError: unknown, cleanup: unknown): Error {
  return new AggregateError(
    [executionError, cleanup],
    `Pi subagent execution failed and cleanup failed: ${boundedError(executionError).error}; ${boundedError(cleanup).error}`,
  );
}

// combineCleanupFailures intentionally differs from cleanupError above: it
// returns the raw Error for a single failure rather than wrapping it in an
// AggregateError. stopInner collects failures from independent cleanup passes
// and activation waits; when only one fails, surfacing that error directly
// preserves its original shape for callers/tests. cleanupError is used by the
// cleanup() body itself, which always wraps (even a single abort/dispose
// failure) so the "Pi subagent cleanup failed" context is never lost. The two
// helpers are kept separate rather than unified because unifying would change
// the error shape at one of the call sites.
function combineCleanupFailures(failures: readonly unknown[]): Error | null {
  if (failures.length === 0) return null;
  if (failures.length === 1) {
    const failure = failures[0];
    return failure instanceof Error ? failure : new Error(String(failure));
  }
  return new AggregateError(failures, "Pi subagent cleanup failed");
}

async function collectFailure(promise: Promise<unknown>, failures: unknown[]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    failures.push(error);
  }
}

export async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface AssistantTerminalInfo {
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

/** One invocation-lifetime Pi resource lease. */
class PiSubagentExecution implements SubagentExecution {
  private runPromise: Promise<string> | null = null;
  private stopPromise: Promise<void> | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private readonly stopSignal: Promise<never>;
  private rejectStopSignal!: (reason?: unknown) => void;
  private activationPromise: Promise<void> | null = null;
  private resolveActivation: (() => void) | null = null;
  private activationSettled = false;
  private terminalPromise: Promise<string> | null = null;
  private terminalResolve: ((text: string) => void) | null = null;
  private terminalReject: ((error: unknown) => void) | null = null;
  private terminalClaim: "completed" | "failed" | "stopped" | null = null;
  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private observer: ((message: string) => void) | null = null;
  private completionObserver: (() => void) | null = null;
  private skillSnapshotDir: string | null = null;
  private latestAssistant: AssistantTerminalInfo | null = null;
  private readonly attemptTexts: string[] = [];
  private currentMessageDelta = "";
  private currentMessageOpen = false;

  constructor(
    private readonly runtime: PiHostRuntime,
    private readonly plan: SubagentPreparation,
    private readonly sessionManager: SessionManager,
  ) {
    this.stopSignal = new Promise<never>((_, reject) => {
      this.rejectStopSignal = reject;
    });
    this.stopSignal.catch(() => {});
  }

  run(invocation: SubagentInvocation): Promise<string> {
    if (this.runPromise !== null) {
      return Promise.reject(new Error("Subagent execution can only run once"));
    }

    this.activationSettled = false;
    this.activationPromise = new Promise<void>((resolve) => {
      this.resolveActivation = resolve;
    });
    this.terminalPromise = new Promise<string>((resolve, reject) => {
      this.terminalResolve = resolve;
      this.terminalReject = reject;
    });
    // The stop race can reject this deferred before activation reaches its
    // terminal wait. Keep that internal rejection observed; callers still
    // receive the run promise below.
    this.terminalPromise.catch(() => {});

    if (this.terminalClaim === "stopped") {
      const stoppedError = new SubagentExecutionStoppedError();
      this.terminalReject?.(stoppedError);
      this.resolveActivationBarrier();
      const stopped = Promise.reject(stoppedError);
      this.runPromise = stopped;
      return stopped;
    }

    this.observer = invocation.onStatusUpdate ?? null;
    this.completionObserver = invocation.onCompletionClaimed ?? null;
    this.runPromise = this.runInner(invocation);
    return this.runPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;

    if (this.terminalClaim === null) {
      this.terminalClaim = "stopped";
      const stoppedError = new SubagentExecutionStoppedError();
      this.terminalReject?.(stoppedError);
      this.rejectStopSignal(stoppedError);
    }

    this.stopPromise = this.stopInner();
    return this.stopPromise;
  }

  private async stopInner(): Promise<void> {
    const failures: unknown[] = [];
    const activation = this.activationPromise;
    const initialCleanup = this.cleanup(true);

    // Start cleanup/abort before waiting on setup or sends. In particular,
    // AgentSession.abort() is what normally releases an in-flight Pi send.
    // The activation barrier is bounded separately: a broken loader, session
    // factory, prelude, or prompt must not make cancellation wait forever.
    const boundedActivation = activation === null
      ? null
      : waitWithTimeout(
          activation,
          this.runtime.quiescenceTimeoutMs,
          () => new SubagentExecutionQuiescenceError(this.runtime.quiescenceTimeoutMs),
        );
    await Promise.all([
      collectFailure(initialCleanup, failures),
      ...(boundedActivation === null ? [] : [collectFailure(boundedActivation, failures)]),
    ]);

    // If setup completed after the first cleanup observed no session, this
    // second pass captures and disposes the late session. Guard against the
    // case where the first pass already cached a (possibly rejected)
    // cleanupPromise — calling cleanup(true) again would return the same
    // promise and double-collect any failure into `failures`.
    if (this.cleanupPromise === null) {
      await collectFailure(this.cleanup(true), failures);
    }

    const failure = combineCleanupFailures(failures);
    if (failure !== null) throw failure;
  }

  private async runInner(invocation: SubagentInvocation): Promise<string> {
    try {
      // A stop may have to return a bounded quiescence error while a vendor
      // operation remains hung in the background. Race activation against the
      // stop fence so the public run/settlement also becomes quiescent; the
      // activation continuation remains fenced by terminalClaim and cleans a
      // session if it appears later.
      const activation = this.activateAndSend(invocation).catch(async (error: unknown) => {
        // If stop won while activation was still in a vendor await, this
        // continuation is the late-session cleanup hook. It runs after the
        // operation finally returns, when cleanup can see any session it
        // created after the timed quiescence fence.
        if (this.terminalClaim === "stopped") await this.cleanup(true);
        throw error;
      });
      await Promise.race([activation, this.stopSignal]);
      return await this.waitForTerminal();
    } catch (error) {
      if (this.terminalClaim === "stopped" || isStoppedError(error)) {
        await this.cleanup(true);
        throw new SubagentExecutionStoppedError();
      }

      if (this.terminalClaim === null) {
        this.terminalClaim = "failed";
        const cleanupFailure = await this.cleanup(true).then(
          () => null,
          (cleanupErrorValue: unknown) => cleanupErrorValue,
        );
        if (cleanupFailure !== null) {
          const combined = combineExecutionAndCleanupError(error, cleanupFailure);
          this.terminalReject?.(combined);
          throw combined;
        }
        this.terminalReject?.(error);
      }
      throw error;
    }
  }

  private async activateAndSend(invocation: SubagentInvocation): Promise<AgentSession> {
    try {
      this.throwIfStopped();

      const services = await this.runtime.getServices();
      this.throwIfStopped();

      const resolved = resolveModel(this.runtime.cfg);
      await services.modelRuntime.setRuntimeApiKey(resolved.model.provider, resolved.apiKey);
      this.throwIfStopped();

      const resource = await buildResourceLoader(
        this.runtime.cfg.goblinHome,
        this.plan,
        invocation.systemPrompt,
        services.settingsManager,
        this.runtime.deps.DefaultResourceLoader,
      );
      this.skillSnapshotDir = resource.skillSnapshotDir;
      this.throwIfStopped();

      const { session } = await this.runtime.deps.createAgentSession({
        cwd: this.plan.cwd,
        agentDir: piAgentDir(this.runtime.cfg.goblinHome),
        modelRuntime: services.modelRuntime,
        settingsManager: services.settingsManager,
        sessionManager: this.sessionManager,
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel,
        customTools: [...invocation.customTools],
        ...(resource.loader ? { resourceLoader: resource.loader } : {}),
      });
      this.session = session;
      this.throwIfStopped();

      const unsubscribe = session.subscribe((event) => {
        this.handleEvent(event);
      });
      if (this.terminalClaim === null) {
        this.unsubscribe = unsubscribe;
      } else {
        try {
          unsubscribe();
        } catch (error) {
          log.error("subagent Pi late unsubscribe failed", { ...boundedError(error) });
        }
      }

      if (this.terminalClaim !== null) {
        this.throwIfStopped();
        return session;
      }

      if (invocation.relevantMemoryPrelude !== undefined) {
        await session.sendCustomMessage(invocation.relevantMemoryPrelude, { deliverAs: "nextTurn" });
      }
      if (this.terminalClaim !== null) {
        this.throwIfStopped();
        return session;
      }

      await session.sendUserMessage(invocation.prompt);
      this.throwIfStopped();
      return session;
    } finally {
      this.resolveActivationBarrier();
    }
  }

  private resolveActivationBarrier(): void {
    if (this.activationSettled) return;
    this.activationSettled = true;
    this.resolveActivation?.();
    this.resolveActivation = null;
  }

  private throwIfStopped(): void {
    if (this.terminalClaim === "stopped") {
      throw new SubagentExecutionStoppedError();
    }
  }

  private async waitForTerminal(): Promise<string> {
    const terminal = this.terminalPromise;
    if (terminal === null) {
      throw new Error("Subagent execution terminal promise was not initialized");
    }
    return await terminal;
  }

  private handleEvent(event: AgentSessionEvent): void {
    if (this.terminalClaim !== null) return;

    try {
      if (event.type === "message_start") {
        const message = event.message;
        if (this.isAssistantMessage(message)) {
          this.currentMessageDelta = "";
          this.currentMessageOpen = true;
        }
      } else if (event.type === "message_update") {
        const assistantMessageEvent = event.assistantMessageEvent;
        if (assistantMessageEvent.type === "text_delta") {
          this.currentMessageDelta += assistantMessageEvent.delta;
          this.currentMessageOpen = true;
        }
      } else if (event.type === "message_end") {
        const message = event.message;
        this.recordAssistantMessage(message);
        if (this.isAssistantMessage(message)) {
          this.currentMessageOpen = true;
          this.finishCurrentMessage(extractAssistantText(event as object));
        }
      } else if (event.type === "agent_end") {
        this.recordAssistantMessages(event.messages);
        this.finishCurrentMessage();
        if (event.willRetry === true) {
          // A retrying low-level attempt is not part of the user-visible
          // result. Its deltas, full messages, and error classification all
          // disappear before the next attempt starts.
          this.resetAttempt();
        } else {
          // agent_end.messages is the provider's authoritative assembled view
          // when present. Prefer it over deltas to handle missing or divergent
          // streams without duplicating text.
          const assembled = this.assistantTexts(event.messages);
          if (assembled.length > 0) {
            this.attemptTexts.length = 0;
            this.attemptTexts.push(...assembled);
          }
        }
      } else if (event.type === "agent_settled") {
        this.finishCurrentMessage();
        this.completeSuccessfully();
        return;
      }

      const callbacks: TurnCallbacks = {
        // dispatchAgentEvent emits a synthetic assistant error notice through
        // onTextDelta. Result text is tracked above, so this callback is
        // deliberately presentation-free and cannot contaminate the result.
        onTextDelta: () => {},
        onToolStart: (name) => this.emitStatus(`tool: ${name}`),
        onToolEnd: (name, isError) => this.emitStatus(
          isError ? `tool error: ${name}` : `tool ok: ${name}`,
        ),
        onStatusUpdate: (message) => this.emitStatus(message),
        onMessageStart: () => {},
        onMessageEnd: () => {},
        onAgentEnd: () => {},
      };
      dispatchAgentEvent(event, callbacks);
    } catch (error) {
      this.failExecution(error);
    }
  }

  private isAssistantMessage(message: unknown): boolean {
    return typeof message === "object" && message !== null &&
      (message as { role?: unknown }).role === "assistant";
  }

  private recordAssistantMessages(messages: readonly unknown[]): void {
    for (const message of messages) this.recordAssistantMessage(message);
  }

  private recordAssistantMessage(message: unknown): void {
    if (!this.isAssistantMessage(message)) return;
    const candidate = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
    this.latestAssistant = {
      ...(typeof candidate.stopReason === "string" ? { stopReason: candidate.stopReason } : {}),
      ...(typeof candidate.errorMessage === "string" ? { errorMessage: candidate.errorMessage } : {}),
    };
  }

  private finishCurrentMessage(fullText?: string): void {
    if (!this.currentMessageOpen) return;
    const text = fullText ?? this.currentMessageDelta;
    if (text.length > 0) this.attemptTexts.push(text);
    this.currentMessageDelta = "";
    this.currentMessageOpen = false;
  }

  private assistantTexts(messages: readonly unknown[]): string[] {
    const texts: string[] = [];
    for (const message of messages) {
      if (!this.isAssistantMessage(message)) continue;
      const text = extractAssistantText({ type: "message_end", message });
      if (text !== undefined && text.length > 0) texts.push(text);
    }
    return texts;
  }

  private resetAttempt(): void {
    this.attemptTexts.length = 0;
    this.currentMessageDelta = "";
    this.currentMessageOpen = false;
    this.latestAssistant = null;
  }

  private emitStatus(message: string): void {
    if (this.terminalClaim !== null) return;
    try {
      this.observer?.(message);
    } catch (error) {
      log.error("subagent status sink failed", { ...boundedError(error) });
      this.failExecution(error);
    }
  }

  private completeSuccessfully(): void {
    if (this.terminalClaim !== null) return;

    const assistant = this.latestAssistant;
    if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") {
      const detail = assistant.errorMessage || `Pi assistant message ended with ${assistant.stopReason}`;
      this.failExecution(new Error(detail));
      return;
    }

    // This is an operational reservation only. The coordinator persists
    // `completed` after host cleanup and MemoryStore.close() succeed.
    this.terminalClaim = "completed";
    try {
      this.completionObserver?.();
    } catch (error) {
      this.terminalClaim = "failed";
      void this.finishTerminalFailure(error);
      return;
    }
    void this.finishTerminalSuccess();
  }

  private failExecution(error: unknown): void {
    if (this.terminalClaim !== null) return;
    this.terminalClaim = "failed";
    void this.finishTerminalFailure(error);
  }

  private async finishTerminalSuccess(): Promise<void> {
    try {
      await this.cleanup(false);
      this.terminalResolve?.(this.attemptTexts.join(""));
    } catch (error) {
      log.error("subagent Pi completion cleanup failed", { ...boundedError(error) });
      this.terminalReject?.(error);
    }
  }

  private async finishTerminalFailure(error: unknown): Promise<void> {
    try {
      await this.cleanup(true);
      this.terminalReject?.(error);
    } catch (cleanupFailure) {
      log.error("subagent Pi error cleanup failed", { ...boundedError(cleanupFailure) });
      this.terminalReject?.(combineExecutionAndCleanupError(error, cleanupFailure));
    }
  }

  private cleanup(abort: boolean): Promise<void> {
    // Memoization race: the first cleanup() call to observe a session caches
    // its promise, and every later call returns that same promise regardless
    // of the `abort` flag it passes. So if a non-aborting cleanup(false) from
    // finishTerminalSuccess wins the race, a later aborting cleanup(true) from
    // stopInner will NOT call session.abort(). This is safe on the success
    // path because the agent has already settled (agent_settled fired) and
    // abort would be a no-op there; dispose still runs. The asymmetry only
    // matters if a stop arrives after success claimed the terminal, in which
    // case the agent is already done and skipping abort is harmless.
    if (this.cleanupPromise !== null) return this.cleanupPromise;

    const session = this.session;
    // Setup or a send may still produce a session after cancellation. Do not
    // cache an empty cleanup before the activation barrier settles; stop()
    // performs a second pass after that barrier.
    if (session === null && !this.activationSettled) return Promise.resolve();
    const unsubscribe = this.unsubscribe;
    this.session = null;
    this.unsubscribe = null;
    this.observer = null;
    this.completionObserver = null;

    this.cleanupPromise = (async () => {
      const errors: unknown[] = [];

      if (abort && session !== null) {
        try {
          await abortWithTimeout(session, this.runtime.abortTimeoutMs);
        } catch (error) {
          errors.push(error);
          log.error("subagent Pi abort failed", { ...boundedError(error) });
        }
      }

      if (unsubscribe !== null) {
        try {
          unsubscribe();
        } catch (error) {
          errors.push(error);
          log.error("subagent Pi unsubscribe failed", { ...boundedError(error) });
        }
      }

      if (session !== null) {
        try {
          session.dispose();
        } catch (error) {
          errors.push(error);
          log.error("subagent Pi dispose failed", { ...boundedError(error) });
        }
      }

      const skillSnapshotDir = this.skillSnapshotDir;
      this.skillSnapshotDir = null;
      if (skillSnapshotDir !== null) {
        try {
          rmSync(skillSnapshotDir, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
          log.error("subagent skill snapshot cleanup failed", { ...boundedError(error) });
        }
      }

      const failure = cleanupError(errors);
      if (failure !== null) throw failure;
    })();
    return this.cleanupPromise;
  }
}

async function abortWithTimeout(session: AgentSession, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => session.abort()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Pi session abort timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function deploymentPromptFilePaths(home: string): Set<string> {
  return new Set([
    resolve(soulMdPath(home)),
    resolve(agentsMdPath(home)),
    resolve(heartbeatMdPath(home)),
  ]);
}

interface ResourceLoaderResult {
  readonly loader: ResourceLoader | undefined;
  readonly skillSnapshotDir: string | null;
}

async function buildResourceLoader(
  home: string,
  plan: SubagentPreparation,
  systemPrompt: string | undefined,
  settingsManager: SettingsManager,
  ResourceLoaderCtor: typeof DefaultResourceLoader,
): Promise<ResourceLoaderResult> {
  const base = {
    cwd: plan.cwd,
    agentDir: piAgentDir(home),
    settingsManager,
  };

  if (plan.resource.kind === "named") {
    const loader = new ResourceLoaderCtor({
      ...base,
      noContextFiles: true,
      noSkills: true,
      additionalSkillPaths: [plan.resource.skillsDir],
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    });
    await loader.reload();
    return { loader, skillSnapshotDir: null };
  }

  let skillSnapshotDir: string | null = null;
  try {
    const skillPaths = plan.resource.skillSnapshots !== undefined
      ? (() => {
          skillSnapshotDir = mkdtempSync(join(tmpdir(), "little-goblin-subagent-skills-"));
          return plan.resource.skillSnapshots.map((skill, index) =>
            materializeSkillSnapshot(skill.snapshot, index, skillSnapshotDir!),
          );
        })()
      : [...plan.resource.skillPaths];
    const missing: string[] = [];
    for (const skillPath of skillPaths) {
      try {
        const stats = await stat(skillPath);
        if (!stats.isFile()) {
          throw new SkillResolutionError(`inherited skill path is not a file: ${skillPath}`);
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          missing.push(skillPath);
          continue;
        }
        throw error;
      }
    }
    if (missing.length > 0) {
      throw new SkillResolutionError(`inherited skill file(s) missing: ${missing.join(", ")}`);
    }

    const deploymentFiles = deploymentPromptFilePaths(home);
    const loader = new ResourceLoaderCtor({
      ...base,
      noSkills: true,
      additionalSkillPaths: skillPaths,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      agentsFilesOverride: ({ agentsFiles }: { agentsFiles: Array<{ path: string; content: string }> }) => ({
        agentsFiles: agentsFiles.filter((file) => !deploymentFiles.has(resolve(file.path))),
      }),
    });
    await loader.reload();
    const loadedPaths = new Set(loader.getSkills().skills.map((skill) => resolve(skill.filePath)));
    const notLoaded = skillPaths.filter((skillPath) => !loadedPaths.has(resolve(skillPath)));
    if (notLoaded.length > 0) {
      throw new SkillResolutionError(`inherited skill file(s) failed to load: ${notLoaded.join(", ")}`);
    }
    return { loader, skillSnapshotDir };
  } catch (error) {
    if (skillSnapshotDir !== null) {
      try {
        rmSync(skillSnapshotDir, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Pi subagent resource setup failed");
      }
    }
    throw error;
  }
}
