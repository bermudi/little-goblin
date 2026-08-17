import { log } from "../log.ts";
import type { UpdateGate } from "./update-gate.ts";

/**
 * The ordered shutdown phase names. This list is the testable authority for
 * causal ordering (decision 0046): close the Telegram gate before disposing
 * runtimes, start runtime disposal before awaiting Telegram drains, stop
 * polling before awaiting drains, then drain subsystems in order.
 *
 * A test that reorders disposal ahead of admission close fails against this
 * list — the `close-telegram-gate` phase must precede `dispose-runtimes`.
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
 * Owns the process shutdown phase list.
 *
 * The coordinator replaces the hand-ordered choreography that lived as
 * comments in `index.ts`. The causal ordering — close the Telegram gate,
 * let buffered text reach runtime admission, start runtime disposal before
 * awaiting the Telegram drains, stop polling, then drain subsystems in order
 * — is now data ({@link SHUTDOWN_PHASE_NAMES}) rather than comment
 * archaeology.
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
   * 1. Start `close-telegram-gate` (the gate drain — not awaited yet).
   * 2. Start `buffered-text-to-runtime-admission` (not awaited yet).
   * 3. Start `drain-scheduler` (not awaited yet).
   * 4. Start `dispose-runtimes` — awaits buffered text, then runtime
   *    admission, then runtime disposal. Not awaited yet.
   * 5. Await `stop-telegram-polling`.
   * 6. Await `dispose-runtimes`.
   * 7. Await `close-telegram-gate` (the gate drain).
   * 8. Await `drain-scheduler`.
   * 9. Await `dispose-external-agents`.
   * 10. Await `dispose-subagents`.
   * 11. Await `close-memory-engine`.
   *
   * Runtime disposal starts before the Telegram drains are awaited so a
   * handler blocked on a model operation (notably steering via `followUp`)
   * is released by runner disposal rather than hanging the fence.
   */
  shutdown(signal: string): Promise<ShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.runPhases(signal);
    return this.shutdownPromise;
  }

  private async runPhases(signal: string): Promise<ShutdownResult> {
    log.info(`received ${signal}, stopping bot`);
    const failures: unknown[] = [];
    const attempt = async (name: string, operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
        log.error("shutdown step failed", {
          step: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // 1–3: Start the gate drain, buffered-text drain, and scheduler drain
    // in parallel. Their starts are independent; their completions have
    // causal dependencies that are awaited below.
    const telegramDrain = this.options.gate.closeAdmission();
    void telegramDrain.catch(() => {});

    const bufferedAdmission = this.options.drainBufferedText();
    void bufferedAdmission.catch(() => {});

    const schedulerDrain = this.options.drainScheduler();
    void schedulerDrain.catch(() => {});

    // 4: Runtime disposal starts after buffered text reaches runtime
    // admission. Started before the Telegram drains are awaited so a
    // handler blocked on followUp steering is released by disposal.
    const runtimeDrain = (async (): Promise<void> => {
      await bufferedAdmission;
      await this.options.drainRuntimeAdmission();
      await this.options.disposeRuntimes();
    })();
    void runtimeDrain.catch(() => {});

    // 5–8: Await in causal order.
    await attempt("telegram polling", this.options.stopTelegramPolling);
    await attempt("conversation runtimes", () => runtimeDrain);
    await attempt("telegram admission", () => telegramDrain);
    await attempt("scheduler", () => schedulerDrain);

    // 9–11: Subsystem disposal in order.
    await attempt("external agents", this.options.disposeExternalAgents);
    await attempt("subagents", this.options.disposeSubagents);
    await attempt("memory engine", this.options.closeMemoryEngine);

    return { ok: failures.length === 0, failures: failures.length };
  }
}
