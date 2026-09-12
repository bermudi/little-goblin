/**
 * Operator-requested restart exit policy — bounded drain, single exit.
 *
 * Owner: Settings restart (this module owns only the restart-side exit
 * policy; the composition root owns the shutdown path and process exit).
 * Lifetime: deployment process; the composition root constructs exactly one
 * trigger and wires it into the Settings server's `POST /api/restart`.
 * Authority: the trigger sequences the composition root's existing shutdown
 * path (signal-handler path: ShutdownCoordinator phases plus the Settings
 * handle close) under a bounded deadline — never a parallel phase list. The
 * restart exit code is always 0 so the operator-deployed systemd
 * `Restart=on-success` revives the process; drain-phase failures are logged
 * loudly, not fatal to the exit code. Persistence: none.
 */

import { boundedError, log } from "../log.ts";

/**
 * Bound for the whole restart drain. Comfortably covers the coordinator
 * phases (Telegram gate close, polling stop, subsystem drains); failing
 * closed at the deadline guarantees a hung phase cannot wedge the operator's
 * restart (in-flight requests complete or fail closed within this bound).
 */
export const RESTART_DRAIN_DEADLINE_MS = 10_000;

export interface RestartTriggerHooks {
  /**
   * The composition root's existing shutdown path (coordinator phases plus
   * the Settings-close ordering the restart path needs). Reused as-is.
   */
  runShutdown: () => Promise<void>;
  /**
   * Process terminator. Production wires `process.exit`; tests inject a
   * recorder so the runner is never killed.
   */
  exit: (code: number) => void;
  /** Drain bound in milliseconds; defaults to {@link RESTART_DRAIN_DEADLINE_MS}. */
  deadlineMs?: number;
}

export type RestartTrigger = () => void;

/**
 * Create the restart trigger wired into `POST /api/restart`. Single-flight:
 * the first invocation runs the shutdown path under the deadline and owns
 * the one `exit(0)`; later invocations are no-ops. The server's closing
 * state already answers further requests with 503 `shutting-down`, so this
 * latch is the no-double-exit backstop (a signal racing the restart
 * converges on the same single shutdown promise in the composition root).
 */
export function createRestartTrigger(hooks: RestartTriggerHooks): RestartTrigger {
  const deadlineMs = hooks.deadlineMs ?? RESTART_DRAIN_DEADLINE_MS;
  let fired = false;
  return () => {
    if (fired) return;
    fired = true;
    log.info("restart accepted; draining and exiting", { deadlineMs });
    const phases = hooks.runShutdown().catch((err: unknown) => {
      // Fail loud in the log, not in the exit code: the restart was accepted
      // and revival depends on a success exit (systemd Restart=on-success).
      log.error("restart shutdown path failed", boundedError(err));
    });
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(resolve, deadlineMs);
    });
    void Promise.race([phases, deadline]).then(() => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      hooks.exit(0);
    });
  };
}
