export interface CompactRunner {
  compact(customInstructions?: string): Promise<{ tokensBefore: number }>;
}

export interface CompactCommandDeps {
  hasSession: boolean;
  rawText: string;
  runner: CompactRunner | null;
}

export type CompactCommandResult =
  | { kind: "no-session"; reply: string }
  | { kind: "no-runner"; reply: string }
  | { kind: "compacted"; reply: string; tokensBefore: number }
  | { kind: "failed"; reply: string };

export const NO_ACTIVE_SESSION_TO_COMPACT_REPLY = "No active session to compact.";
export const NO_ACTIVE_RUNNER_TO_COMPACT_REPLY = "No active runner to compact.";

export function parseCompactInstructions(rawText: string): string | undefined {
  const instructions = rawText.replace(/^\/compact(?:@\w+)?(?:\s+)?/, "").trim();
  return instructions.length === 0 ? undefined : instructions;
}

export function formatCompactReply(tokensBefore: number): string {
  return `Compacted from ~${Math.round(tokensBefore / 1000)}K tokens.`;
}

export async function executeCompact(deps: CompactCommandDeps): Promise<CompactCommandResult> {
  if (!deps.hasSession) {
    return { kind: "no-session", reply: NO_ACTIVE_SESSION_TO_COMPACT_REPLY };
  }
  if (deps.runner === null) {
    return { kind: "no-runner", reply: NO_ACTIVE_RUNNER_TO_COMPACT_REPLY };
  }

  try {
    const result = await deps.runner.compact(parseCompactInstructions(deps.rawText));
    return {
      kind: "compacted",
      reply: formatCompactReply(result.tokensBefore),
      tokensBefore: result.tokensBefore,
    };
  } catch (err) {
    return { kind: "failed", reply: err instanceof Error ? err.message : String(err) };
  }
}
