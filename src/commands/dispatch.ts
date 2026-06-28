import { DEFAULT_CASCADE_TIMEOUT_MS } from "../interrupt.ts";
import { formatCascadeTimeoutSuffix } from "./cancel.ts";
import {
  resolveCommand,
  CANCEL_CAPABLE_COMMANDS,
  type SideEffect,
  type DispatchResult,
  type DispatchDeps,
  type DispatchOpts,
} from "./registry.ts";

// Re-export for backward compatibility with dispatch.test.ts and other consumers.
export { CANCEL_CAPABLE_COMMANDS };
export type { SideEffect, DispatchResult, DispatchDeps, DispatchOpts };

/**
 * Resolve a slash command token via the registry and dispatch to its handler.
 *
 * For cancel-capable commands, runs `interruptAndCascade` before the handler.
 * Returns `{ kind: "fallthrough" }` for unknown commands or grammy-only defs
 * (no handler), so the caller continues to normal agent routing.
 *
 * This function is Telegram-side-effect-free: it returns side effects the
 * caller must apply. It does not mutate the grammy Context, call bot.api.*,
 * touch the agentRunners map, or dispose runners.
 */
export async function handleCommand(opts: DispatchOpts): Promise<DispatchResult> {
  const { command, deps, existingRunner, session } = opts;
  const def = resolveCommand(command);
  if (!def || !def.handler) return { kind: "fallthrough" };

  let cascade = null;
  if (def.cancelCapable) {
    cascade = await deps.interruptAndCascade(
      existingRunner,
      deps.subagentRunner,
      DEFAULT_CASCADE_TIMEOUT_MS,
      session?.id ?? null,
    );
  }
  const suffix = () => cascade ? formatCascadeTimeoutSuffix(cascade, DEFAULT_CASCADE_TIMEOUT_MS) : "";

  return def.handler({ ...opts, cascade, suffix });
}
