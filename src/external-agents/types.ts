import { Readable } from "node:stream";

/** Qualified backends behind the capability-scoped ACP execution host (decision 0044). */
export type ExternalAgentBackend = "claude" | "devin";

export const TerminalStatuses = ["completed", "failed", "cancelled", "timed_out", "interrupted"] as const;
export type TerminalStatus = (typeof TerminalStatuses)[number];
export type ExternalAgentStatus = "starting" | "running" | "input_required" | TerminalStatus;

export interface ExternalAgentRunSummary {
  id: string;
  backend: ExternalAgentBackend;
  status: ExternalAgentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessExit {
  exitCode: number | null;
  signal: string | null;
}

export interface ProcessHandle {
  readonly stdin: import("node:stream").Writable;
  readonly stdout: Readable;
  readLines(): AsyncIterable<string>;
  waitForExit(): Promise<ProcessExit>;
  kill(): Promise<void>;
  getStderr(): string;
}

export interface ProcessSpawnArgs {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
}

export interface ProcessHost {
  spawn(args: ProcessSpawnArgs): Promise<ProcessHandle>;
}
