import {
  resolveCommand,
  type SideEffect,
  type DispatchResult,
  type DispatchDeps,
  type DispatchOpts,
} from "./registry.ts";

// Re-export for backward compatibility with dispatch.test.ts and other consumers.
export type { SideEffect, DispatchResult, DispatchDeps, DispatchOpts };

/**
 * Resolve a slash command token via the registry and dispatch to its handler.
 *
 * Timing (interrupt vs queue vs instant) is decided by the caller (`intake.ts`)
 * via `resolveTiming` *before* dispatch — only interrupt-timing commands get
 * this far while a turn is streaming, and they handle their own abort
 * (`/cancel` calls `interruptAndCascade` inside its handler). This function is
 * therefore Telegram-side-effect-free: it returns side effects the caller must
 * apply. It does not mutate the grammy Context, call bot.api.*, touch the
 * agentRunners map, or dispose runners.
 *
 * Returns `{ kind: "fallthrough" }` for unknown commands or grammy-only defs
 * (no handler), so the caller continues to normal agent routing.
 */
export async function handleCommand(opts: DispatchOpts): Promise<DispatchResult> {
  const def = resolveCommand(opts.command);
  if (!def || !def.handler) return { kind: "fallthrough" };
  return def.handler(opts);
}
