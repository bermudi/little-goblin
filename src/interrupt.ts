/**
 * Interrupt helper.
 *
 * Cancel-capable commands (`/cancel`, `/new`, `/archive`, `/debug`) abort
 * any active stream on the main agent **and** every live subagent before
 * the command's own logic runs.
 *
 * Cascade is best-effort: a stuck subagent never blocks the command.
 * Individual cancels swallow their errors via `.catch()`; the main runner
 * abort is wrapped in try/catch and logged.
 */

import { log } from "./log.ts";

/** Minimal shape we need from `AgentRunner` — keeps testing trivial. */
export interface InterruptableRunner {
  readonly isStreaming: boolean;
  abort(): Promise<void>;
}

/** Minimal shape we need from `SubagentRunner` — keeps testing trivial. */
export interface InterruptableSubagentRunner {
  list(): ReadonlyArray<{ id: string; status: string }>;
  cancel(id: string): Promise<void>;
}

/**
 * Abort the main runner if streaming, then cascade-cancel every live
 * subagent. Resolves only after all cancels have settled.
 */
export async function interruptAndCascade(
  runner: InterruptableRunner | null,
  subagentRunner: InterruptableSubagentRunner,
): Promise<void> {
  if (runner?.isStreaming) {
    try {
      await runner.abort();
    } catch (err) {
      log.error("abort failed during interrupt", { error: String(err) });
      // continue — command still executes even if abort fails
    }
  }

  const live = subagentRunner.list().filter((s) => s.status === "running");
  await Promise.all(
    live.map((s) =>
      subagentRunner.cancel(s.id).catch((err) => {
        log.warn("subagent cancel failed during cascade", {
          id: s.id,
          error: String(err),
        });
      }),
    ),
  );
}
