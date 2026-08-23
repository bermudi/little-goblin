import { log } from "../log.ts";
import type { UpdateGate } from "./update-gate.ts";

/**
 * The ordered shutdown phase names. These names are the source of truth for
 * the `ShutdownPhaseName` type used to label every step in
 * {@link ShutdownCoordinator.runPhases}. The causal ordering is enforced by
 * the code in `runPhases`, not by the array itself; the array makes the
 * ordering testable and the labels type-safe (decision 0046).
 *
 * A test that reorders disposal ahead of admission close fails against the
 * phase-name order documented and implemented in `runPhases`.
 */
export const SHUTDOWN_PHASE_NAMES = [
  "close-telegram-gate",
  "buffered-text-to-runtime-admission",
  "dispose-runtimes",
  "stop-telegram-polling",
  "drain-telegram-admission",
  "drain-scheduler",
  "dispose-external-agents",
  "dispose-subagents",
  "close-memory-engine",
] as const;

export type ShutdownPhaseName = (typeof SHUTDOWN_PHASE_NAMES)[number];

export interface ShutdownCoordinatorOptions {
  /** The process-level update gate. */
  gate: UpdateGate;
  /** Stop Telegram long-polling (`bot.stop()`). */
  stopTelegramPolling: () => Promise<void>;
  /** Wait for buffered text to reach runtime admission
   * (`gate.bufferedTextAdmission()`). */
  drainBufferedText: () => Promise<void>;
  /** Wait for every admitted update to reach the runtime hand-off
   * (`gate.runtimeAdmission()`). */
  drainRuntimeAdmission: () => Promise<void>;
  /** Dispose all conversation runtimes (`runtimeHost.disposeAll()`). */
  disposeRuntimes: () => Promise<void>;
  /** Drain the scheduler (`scheduler.stopAndDrain()`). */
  drainScheduler: () => Promise<void>;
  /** Dispose external agents (`externalAgentRunner?.dispose()`). */
  disposeExternalAgents: () => Promise<void>;
  /** Dispose subagents (`subagentRunner.dispose()`). */
  disposeSubagents: () => Promise<void>;
  /** Close the memory engine (`memoryEngine.close()`). */
  closeMemoryEngine: () => Promise<void>;
}

export interface ShutdownResult {
  /** True when every phase completed without failure. */
  readonly ok: boolean;
  /** Number of phases that failed. */
  readonly failures: number;
}

/**
 * Owns the process shutdown phase list and its execution order.
 *
 * The coordinator replaces the hand-ordered choreography that lived as
 * comments in `index.ts`. The causal ordering — close the Telegram gate,
 * let buffered text reach runtime admission, start runtime disposal before
 * awaiting the Telegram drains, stop polling, then drain subsystems in order
 * — is enforced by the typed `runPhases` sequence and validated against
 * {@link SHUTDOWN_PHASE_NAMES}; the phase list is the typed source of truth,
 * not the executor itself.
 *
 * The coordinator does not call `process.exit`; it returns a
 * {@link ShutdownResult} and the caller owns the exit decision.
 */
export class ShutdownCoordinator {
  readonly phaseNames: readonly ShutdownPhaseName[] = SHUTDOWN_PHASE_NAMES;
  private readonly options: ShutdownCoordinatorOptions;
  private shutdownPromise: Promise<ShutdownResult> | undefined;

  constructor(options: ShutdownCoordinatorOptions) {
    this.options = options;
  }

  /**
   * Run the shutdown phase list. Idempotent and single-flight.
   *
   * The execution preserves the causal ordering documented in
   * {@link SHUTDOWN_PHASE_NAMES}:
   *
   * 1. Start `close-telegram-gate` (not awaited yet).
   * 2. Start `buffered-text-to-runtime-admission` (not awaited yet).
   * 3. Start `drain-scheduler` (not awaited yet).
   * 4. Start `dispose-runtimes` — awaits buffered text, starts runtime
   *    disposal, and awaits it together with the runtime-admission drain.
   *    Not awaited yet.
   * 5. Await `stop-telegram-polling`.
   * 6. Await `dispose-runtimes`.
   * 7. Await `drain-telegram-admission`.
   * 8. Await `drain-scheduler`.
   * 9. Await `dispose-external-agents`.
   * 10. Await `dispose-subagents`.
   * 11. Await `close-memory-engine`.
   *
   * Runtime disposal starts before the Telegram drains are awaited so a
   * handler blocked on a model operation (notably steering via `followUp`)
   * is released by runner disposal rather than hanging the fence. A
   * `buffered-text-to-runtime-admission` rejection is reported as its own
   * phase failure while still allowing `dispose-runtimes` to drain.
   */
  shutdown(signal: string): Promise<ShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runPhases(signal);
    return this.shutdownPromise;
  }

  private async runPhases(signal: string): Promise<ShutdownResult> {
    log.info(`received ${signal}, stopping bot`);
    const failures: unknown[] = [];
    const attempt = async (name: ShutdownPhaseName, operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
        log.error("shutdown phase failed", {
          phase: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // 1–3: Start the gate close, buffered-text drain, and scheduler drain
    // in parallel. Their starts are independent; their completions have
    // causal dependencies that are awaited below. Each is wrapped in attempt
    // so a failure is reported even if its await is sequenced later.
    const closeGateAttempt = attempt("close-telegram-gate", () => this.options.gate.closeAdmission());
    const bufferedTextAttempt = attempt("buffered-text-to-runtime-admission", this.options.drainBufferedText);
    const schedulerAttempt = attempt("drain-scheduler", this.options.drainScheduler);

    // 4: Runtime disposal starts after buffered text reaches runtime
    // admission. Started before the Telegram drains are awaited so a
    // handler blocked on followUp steering is released by disposal.
    await bufferedTextAttempt;
    // Start disposal before polling stops or the Telegram admission drain is
    // awaited. Disposal is what releases handlers blocked on a runner.
    let disposal: Promise<void>;
    try {
      disposal = this.options.disposeRuntimes();
    } catch (error) {
      disposal = Promise.reject(error);
    }
    void disposal.catch(() => {});
    const runtimeDrain = (async (): Promise<void> => {
      const [admissionResult, disposalResult] = await Promise.allSettled([
        this.options.drainRuntimeAdmission(),
        disposal,
      ]);
      const failures: unknown[] = [];
      if (admissionResult.status === "rejected") failures.push(admissionResult.reason);
      if (disposalResult.status === "rejected") failures.push(disposalResult.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Runtime shutdown drain failed");
    })();
    void runtimeDrain.catch(() => {});

    // 5–8: Await in documented phase order.
    await attempt("stop-telegram-polling", this.options.stopTelegramPolling);
    await attempt("dispose-runtimes", () => runtimeDrain);
    await attempt("drain-telegram-admission", () => closeGateAttempt);
    await attempt("drain-scheduler", () => schedulerAttempt);

    // 9–11: Subsystem disposal in order.
    await attempt("dispose-external-agents", this.options.disposeExternalAgents);
    await attempt("dispose-subagents", this.options.disposeSubagents);
    await attempt("close-memory-engine", this.options.closeMemoryEngine);

    return { ok: failures.length === 0, failures: failures.length };
  }
}
