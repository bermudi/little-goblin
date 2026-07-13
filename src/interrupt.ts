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
import type { ExternalAgentRunSummary } from "./external-agents/types.ts";
import { isTerminal } from "./external-agents/util.ts";

/** Minimal shape we need from `AgentRunner` — keeps testing trivial. */
export interface InterruptableRunner {
  readonly isStreaming: boolean;
  /** True when a prior abort() timed out and the runner is wedged. */
  readonly isAbortTimedOut: boolean;
  abort(): Promise<void>;
  /**
   * Optional hook called by the cascade when `abort()` doesn't resolve
   * within the timeout. Implementations should flip into a terminal
   * "abort gave up" state so subsequent cancel-capable commands don't
   * re-attempt the same wedged abort.
   */
  markAbortTimedOut?(): void;
}

/** Minimal shape we need from `SubagentRunner` — keeps testing trivial. */
export interface InterruptableSubagentRunner {
  list(): ReadonlyArray<{ id: string; status: string; spawnedBy?: string | null }>;
  cancel(id: string): Promise<void>;
  /** Cancel every subagent in the spawn tree rooted at the given session id. */
  cancelBySession?(sessionId: string): Promise<void>;
}

/** Minimal shape we need from `ExternalAgentRunner` — keeps testing trivial. */
export interface InterruptableExternalAgentRunner {
  list(sessionId?: string): ExternalAgentRunSummary[];
  cancelBySession(sessionId?: string): Promise<number>;
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
  /** True iff the main runner was streaming or wedged when the cascade started. */
  attemptedMain: boolean;
  /** Number of subagents in `running` status at cascade-start. */
  attemptedSubagents: number;
  /** Number of external agents in non-terminal status at cascade-start. */
  attemptedExternalAgents: number;
  /** True iff the main runner's `abort()` did not resolve within the timeout. */
  timedOutMain: boolean;
  /** Number of subagent `cancel()`s that did not resolve within the timeout. */
  timedOutSubagents: number;
  /** Number of external agent `cancel()`s that did not resolve within the timeout. */
  timedOutExternalAgents: number;
  /** True iff the main runner was already wedged (abort timed out earlier) and was not re-aborted. */
  wedgedMain: boolean;
}

/** Default cascade timeout. Long enough to cover real network aborts; short enough to not feel hung. */
export const DEFAULT_CASCADE_TIMEOUT_MS = 5000;

/** Poll interval while waiting for a runner to return to the idle state. */
const IDLE_POLL_MS = 10;
/** Max time we wait for isStreaming → false after abort() resolves. */
const IDLE_MAX_WAIT_MS = 500;

/**
 * Poll `runner.isStreaming` until it flips false or `maxMs` elapses.
 * Non-blocking by design: tight bound, never throws. Returns true when
 * idle, false on max-wait timeout (logged by caller if needed).
 */
async function waitForIdle(
  runner: InterruptableRunner,
  pollMs: number,
  maxMs: number,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (runner.isStreaming) {
    if (Date.now() >= deadline) {
      log.warn("runner remained streaming after abort resolved", { maxMs });
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

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
 *
 * When `sessionId` is provided, the cascade only touches subagents
 * reachable from that session via the `spawnedBy` chain — i.e. direct
 * children and their transitive descendants. Subagents belonging to
 * other sessions are left alone. Pass `null`/undefined to cancel every
 * live subagent process-wide (legacy behaviour, still used in tests).
 */
export async function interruptAndCascade(
  runner: InterruptableRunner | null,
  subagentRunner: InterruptableSubagentRunner,
  cascadeTimeoutMs: number = DEFAULT_CASCADE_TIMEOUT_MS,
  sessionId?: string | null,
  externalAgentRunner?: InterruptableExternalAgentRunner | null,
): Promise<CascadeResult> {
  const result: CascadeResult = {
    attemptedMain: false,
    attemptedSubagents: 0,
    attemptedExternalAgents: 0,
    timedOutMain: false,
    timedOutSubagents: 0,
    timedOutExternalAgents: 0,
    wedgedMain: false,
  };

  if (runner?.isStreaming || runner?.isAbortTimedOut) {
    result.attemptedMain = true;
    if (runner.isAbortTimedOut) {
      result.wedgedMain = true;
      log.warn("main runner is already wedged after abort timed out", { timeoutMs: cascadeTimeoutMs });
    } else {
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
        // Flip the runner into a "gave up" state so the next cancel-capable
        // command doesn't re-enter abort() on a wedged pi session.
        runner.markAbortTimedOut?.();
      } else {
        // abort() resolved. pi sometimes resolves `session.abort()` before
        // `isStreaming` has flipped back to false — a trailing tick may
        // still be flushing event handlers. Poll briefly so callers who
        // rename the session directory immediately afterwards (`/new`,
        // `/archive`) don't race an in-flight transcript.jsonl append.
        await waitForIdle(runner, IDLE_POLL_MS, IDLE_MAX_WAIT_MS);
      }
    }
  }

  const snapshot = subagentRunner.list();
  const running = snapshot.filter((s) => s.status === "running");
  // When a sessionId is supplied, walk spawnedBy transitively: a subagent
  // belongs to this session iff its spawnedBy is the session itself or
  // any other subagent already in the set. Iterate to fixed point — the
  // list is small (bounded by MAX_SUBAGENT_DEPTH branching) so a couple
  // of passes is fine.
  let live: typeof running;
  if (sessionId) {
    const reachable = new Set<string>([sessionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of snapshot) {
        if (s.spawnedBy && reachable.has(s.spawnedBy) && !reachable.has(s.id)) {
          reachable.add(s.id);
          changed = true;
        }
      }
    }
    live = running.filter((s) => s.spawnedBy !== undefined && s.spawnedBy !== null && reachable.has(s.spawnedBy));
  } else {
    live = running;
  }
  result.attemptedSubagents = live.length;

  if (sessionId && subagentRunner.cancelBySession) {
    const cancelPromise = subagentRunner.cancelBySession(sessionId).catch((err) => {
      log.warn("subagent cancelBySession failed during cascade", {
        error: String(err),
        sessionId,
      });
    });
    const outcome = await withTimeout(cancelPromise, cascadeTimeoutMs);
    if (outcome === TIMEOUT_SENTINEL) {
      result.timedOutSubagents = live.length;
      log.warn("subagent cancelBySession timed out", { sessionId, timeoutMs: cascadeTimeoutMs });
    }
  } else {
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
  }

  if (externalAgentRunner) {
    const liveExternal = externalAgentRunner.list(sessionId ?? undefined).filter((r) => !isTerminal(r.status));
    result.attemptedExternalAgents = liveExternal.length;

    const externalCancelPromise = externalAgentRunner.cancelBySession(sessionId ?? undefined).catch((err) => {
      log.warn("external agent cancelBySession failed during cascade", {
        error: String(err),
        sessionId: sessionId ?? "all",
      });
    });
    const externalOutcome = await withTimeout(externalCancelPromise, cascadeTimeoutMs);
    if (externalOutcome === TIMEOUT_SENTINEL) {
      result.timedOutExternalAgents = liveExternal.length;
      log.warn("external agent cancelBySession timed out", { timeoutMs: cascadeTimeoutMs });
    }
  }

  return result;
}
