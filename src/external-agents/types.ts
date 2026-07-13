import { Readable } from "node:stream";

export type ExternalAgentBackend = "codex" | "claude" | "devin";

export type ExternalAgentPermissionProfile = "read-only" | "workspace-write";

export const TerminalStatuses = ["completed", "failed", "cancelled", "timed_out", "interrupted"] as const;
export type TerminalStatus = (typeof TerminalStatuses)[number];
export type ExternalAgentStatus = "starting" | "running" | "input_required" | TerminalStatus;

export interface ExternalAgentRunRecord {
  id: string;
  ownerSessionId: string;
  backend: ExternalAgentBackend;
  projectDir: string;
  status: ExternalAgentStatus;
  createdAt: string;
  updatedAt: string;
  adapterKind: "native" | "pty";
  eventsTruncated: boolean;
  resultTruncated: boolean;
  inputRequired: string | undefined;
  terminalError: string | undefined;
}

export interface ExternalAgentRunSummary {
  id: string;
  backend: ExternalAgentBackend;
  status: ExternalAgentStatus;
  createdAt: string;
  updatedAt: string;
  projectDir: string;
  eventsTruncated: boolean;
  resultTruncated: boolean;
}

export interface ExternalRunDetail extends ExternalAgentRunSummary {
  recentEvents: ExternalAgentEvent[];
  recentOutput: string;
  result: string;
  inputRequired: string | undefined;
  error: string | undefined;
}

export interface ExternalAgentEvent {
  type: "status" | "output" | "completed" | "failed" | "cancelled" | "timed_out" | "interrupted" | "input_required" | "truncation";
  at: string;
  message?: string;
  output?: string;
  error?: string;
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

export interface ExternalAgentHandle {
  send?(text: string): Promise<void>;
  inspect?(): Promise<void>;
  waitForExit?(): Promise<ProcessExit>;
  cancel(): Promise<void>;
}

export interface AdapterStartInput {
  runId: string;
  sessionId: string;
  backend: ExternalAgentBackend;
  task: string;
  projectDir: string;
  env: Record<string, string>;
  timeoutMs: number;
  permissionProfile: ExternalAgentPermissionProfile;
  processHost: ProcessHost;
  signal: AbortSignal;
}

export interface ExternalAgentAdapter {
  backend: ExternalAgentBackend;
  start(input: AdapterStartInput, emit: (event: ExternalAgentEvent) => void): Promise<ExternalAgentHandle>;
}

export interface InternalRun extends ExternalAgentRunRecord {
  sessionId: string;
  task: string;
  terminal: boolean;
  terminalError: string | undefined;
  handle: ExternalAgentHandle | undefined;
  timeout: ReturnType<typeof setTimeout> | undefined;
  abortController: AbortController;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
  meta: ExternalAgentRunRecord;
  eventsBytes: number;
  result: string;
  inputRequired: string | undefined;
  fallback: boolean;
  runPromise?: Promise<void>;
}

export class ExternalAgentError extends Error {
  constructor(message: string, public readonly safeToRetry = false) {
    super(message);
    this.name = "ExternalAgentError";
  }
}

export class InteractiveRequiredError extends ExternalAgentError {
  public readonly backend: ExternalAgentBackend;
  constructor(backend: ExternalAgentBackend, message: string) {
    super(message, true);
    this.backend = backend;
    this.name = "InteractiveRequiredError";
  }
}
