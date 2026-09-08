import { TerminalStatuses as TerminalStatusArray, type ExternalAgentStatus, type TerminalStatus } from "./types.ts";

export const TerminalStatuses: ReadonlySet<TerminalStatus> = new Set(TerminalStatusArray);

export function isTerminal(status: ExternalAgentStatus): status is TerminalStatus {
  return TerminalStatuses.has(status as TerminalStatus);
}

export function errorString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
