/**
 * Interrupt helper.
 *
 * Cancel-capable commands (`/cancel`, `/new`, `/archive`, `/debug`) abort
 * any active stream on the main agent **and** every live subagent before
 * the command's own logic runs.
 *
 * Cascade is best-effort with a hard timeout per cancel: a stuck
 * subagent (or main agent) never blocks the user's command. The returned
 * `CascadeResult` tells the caller exactly what was attempted, what
 * resolved, and what timed out — so the reply text can be honest
 * ("Cancelled. (1 subagent didn't respond in 5s and may still be
 * running.)") instead of silently hanging the handler.
 *
 * The proposal's non-goal "no kill-9 fallback" is preserved: we don't
 * forcibly kill timed-out subagents, we just stop waiting on them.
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
 * Summary of what `interruptAndCascade` actually did.
 *
 * Counts are over the snapshot taken at the start of the call: i.e.
 * `attemptedSubagents` is the number of subagents observed `running` at
 * cascade-start. A subagent whose `cancel()` rejects (rare — most
 * reject paths are already swallowed inside `SubagentRunner`) is
 * counted as aborted, not timed out: the abort path completed, just
 * unhappily.
 */
export interface CascadeResult {
  /** True iff the main runner was streaming when the cascade started. */
  attemptedMain: boolean;
  /** Number of subagents in `running` status at cascade-start. */
  attemptedSubagents: number;
  /** True iff the main runner's `abort()` did not resolve within the timeout. */
  timedOutMain: boolean;
  /** Number of subagent `cancel()`s that did not resolve within the timeout. */
  timedOutSubagents: number;
}

/** Default cascade timeout. Long enough to cover real network aborts; short enough to not feel hung. */
export const DEFAULT_CASCADE_TIMEOUT_MS = 5000;

const TIMEOUT_SENTINEL: unique symbol = Symbol("cascade-timeout");
type Timeout = typeof TIMEOUT_SENTINEL;

/**
 * Race a promise against a timeout. Returns `TIMEOUT_SENTINEL` if the
 * timeout wins. The underlying promise is left dangling — its rejection
 * (if any) is swallowed via `.catch` to avoid unhandled-rejection noise.
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | Timeout> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Timeout>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
  });
  // Swallow late rejections from the racing promise to avoid unhandled-rejection noise.
  p.catch(() => {});
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Abort the main runner if streaming, then cascade-cancel every live
 * subagent, each bounded by `cascadeTimeoutMs`. Resolves with a summary
 * of what was attempted and what timed out.
 */
export async function interruptAndCascade(
  runner: InterruptableRunner | null,
  subagentRunner: InterruptableSubagentRunner,
  cascadeTimeoutMs: number = DEFAULT_CASCADE_TIMEOUT_MS,
): Promise<CascadeResult> {
  const result: CascadeResult = {
    attemptedMain: false,
    attemptedSubagents: 0,
    timedOutMain: false,
    timedOutSubagents: 0,
  };

  if (runner?.isStreaming) {
    result.attemptedMain = true;
    const abortPromise = (async () => {
      try {
        await runner.abort();
      } catch (err) {
        log.error("abort failed during interrupt", { error: String(err) });
        // continue — command still executes even if abort throws
      }
    })();
    const outcome = await withTimeout(abortPromise, cascadeTimeoutMs);
    if (outcome === TIMEOUT_SENTINEL) {
      result.timedOutMain = true;
      log.warn("main runner abort timed out", { timeoutMs: cascadeTimeoutMs });
    }
  }

  const live = subagentRunner.list().filter((s) => s.status === "running");
  result.attemptedSubagents = live.length;

  await Promise.all(
    live.map(async (s) => {
      const cancelPromise = subagentRunner.cancel(s.id).catch((err) => {
        log.warn("subagent cancel failed during cascade", {
          id: s.id,
          error: String(err),
        });
      });
      const outcome = await withTimeout(cancelPromise, cascadeTimeoutMs);
      if (outcome === TIMEOUT_SENTINEL) {
        result.timedOutSubagents += 1;
        log.warn("subagent cancel timed out", { id: s.id, timeoutMs: cascadeTimeoutMs });
      }
    }),
  );

  return result;
}
