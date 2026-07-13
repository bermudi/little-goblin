import type { AdapterStartInput, ExternalAgentBackend, ExternalAgentEvent, ExternalAgentHandle, ProcessExit } from "./types.ts";
import { nowIso } from "./util.ts";

type AgentPtyCommand = "spawn" | "type" | "snapshot" | "wait-for-exit" | "kill" | "remove";

interface AgentPtyRequest {
  cmd: AgentPtyCommand;
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  owner?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  text?: string;
  format?: "text";
  timeout?: number;
  signal?: string;
}

interface AgentPtyResponse {
  ok: boolean;
  name?: string;
  pid?: number;
  owner?: string;
  text?: string;
  contentHash?: string;
  exited?: boolean;
  exitCode?: number | null;
  signal?: string | number | null;
  timedOut?: boolean;
  error?: string;
}

const MAX_OUTPUT_EVENT = 2000;

function asAgentPtyResponse(raw: object): AgentPtyResponse {
  const response = raw as AgentPtyResponse;
  if (typeof response.ok !== "boolean") {
    throw new Error("agent-pty response missing ok boolean");
  }
  return response;
}

export class AgentPtyAdapter {
  async start(
    input: AdapterStartInput,
    emit: (event: ExternalAgentEvent) => void,
  ): Promise<ExternalAgentHandle> {
    const { command, args } = getInteractiveCommand(input.backend, input.projectDir, input.permissionProfile, input.task);
    const sessionName = `goblin-${input.runId}`;
    const owner = `goblin:${input.sessionId}`;

    // Avoid persisting the task text in the normalized event log; the command
    // and args (including the task) are sent to the agent-pty daemon, but only
    // the backend name is shown in the status event.
    emit({ type: "status", at: nowIso(), message: `agent-pty spawn: ${input.backend}` });

    let spawnResult: AgentPtyResponse;
    try {
      spawnResult = await this.rpc(input.processHost, input.projectDir, input.env, {
        cmd: "spawn",
        name: sessionName,
        command,
        args,
        cwd: input.projectDir,
        owner,
        env: input.env,
        cols: 80,
        rows: 24,
      }, input.signal);
    } catch (err) {
      if (input.signal?.aborted) {
        await this.killRemove(input.processHost, input.projectDir, input.env, sessionName);
      }
      throw err;
    }

    if (!spawnResult.ok) {
      throw new Error(spawnResult.error ?? `agent-pty spawn failed for ${input.backend}`);
    }

    return new AgentPtyHandle(input.processHost, sessionName, emit, input.projectDir, input.env, input.signal);
  }

  private async rpc(
    processHost: AdapterStartInput["processHost"],
    cwd: string,
    env: Record<string, string>,
    request: AgentPtyRequest,
    signal?: AbortSignal,
  ): Promise<AgentPtyResponse> {
    const process = await processHost.spawn({
      command: ["agent-pty", "rpc"],
      cwd,
      env,
      signal,
      stdin: JSON.stringify(request) + "\n",
    });

    let lastLine = "";
    for await (const line of process.readLines()) {
      lastLine = line;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(lastLine) as unknown;
    } catch {
      throw new Error(`agent-pty returned invalid JSON: ${lastLine}`);
    }

    if (raw === null || typeof raw !== "object") {
      throw new Error("agent-pty returned non-object response");
    }

    return asAgentPtyResponse(raw);
  }

  private async killRemove(
    processHost: AdapterStartInput["processHost"],
    cwd: string,
    env: Record<string, string>,
    sessionName: string,
  ): Promise<void> {
    try {
      await this.rpc(processHost, cwd, env, { cmd: "kill", name: sessionName, signal: "SIGTERM" }, undefined);
    } catch {
      // ignore
    }
    try {
      await this.rpc(processHost, cwd, env, { cmd: "remove", name: sessionName }, undefined);
    } catch {
      // ignore
    }
  }
}

class AgentPtyHandle implements ExternalAgentHandle {
  private lastContentHash: string | undefined;
  private lastText = "";

  constructor(
    private readonly processHost: AdapterStartInput["processHost"],
    private readonly sessionName: string,
    private readonly emit: (event: ExternalAgentEvent) => void,
    private readonly cwd: string,
    private readonly env: Record<string, string>,
    private readonly abortSignal: AbortSignal,
  ) {}

  async send(text: string): Promise<void> {
    const line = text.endsWith("\n") ? text : text + "\n";
    const response = await this.rpc({ cmd: "type", name: this.sessionName, text: line }, this.abortSignal);
    if (!response.ok) {
      throw new Error(response.error ?? "agent-pty type failed");
    }
  }

  async inspect(): Promise<void> {
    const response = await this.rpc({ cmd: "snapshot", name: this.sessionName, format: "text" }, this.abortSignal);
    if (!response.ok || response.text === undefined) return;
    if (response.contentHash !== undefined && response.contentHash === this.lastContentHash) return;
    if (response.contentHash === undefined && response.text === this.lastText) return;
    this.lastContentHash = response.contentHash;
    this.lastText = response.text;
    if (response.text.length === 0) return;

    const output = response.text.length > MAX_OUTPUT_EVENT ? response.text.slice(-MAX_OUTPUT_EVENT) : response.text;
    this.emit({ type: "output", at: nowIso(), output });

    if (looksLikePrompt(response.text)) {
      this.emit({ type: "input_required", at: nowIso(), message: "send a message" });
    }
  }

  async waitForExit(): Promise<ProcessExit> {
    while (true) {
      if (this.abortSignal.aborted) {
        throw new Error("Cancelled");
      }
      await this.inspect();
      if (this.abortSignal.aborted) {
        throw new Error("Cancelled");
      }
      const response = await this.rpc({ cmd: "wait-for-exit", name: this.sessionName, timeout: 1000 }, this.abortSignal);

      if (!response.ok) {
        throw new Error(response.error ?? "agent-pty wait-for-exit failed");
      }
      if (response.exited) {
        await this.inspect();
        return {
          exitCode: response.exitCode ?? null,
          signal: response.signal ? String(response.signal) : null,
        };
      }
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.rpc({ cmd: "kill", name: this.sessionName, signal: "SIGTERM" }, undefined);
    } catch {
      // ignore
    }
    try {
      await this.rpc({ cmd: "remove", name: this.sessionName }, undefined);
    } catch {
      // ignore
    }
  }

  private async rpc(request: AgentPtyRequest, abortSignal?: AbortSignal): Promise<AgentPtyResponse> {
    const process = await this.processHost.spawn({
      command: ["agent-pty", "rpc"],
      cwd: this.cwd,
      env: this.env,
      signal: abortSignal,
      stdin: JSON.stringify(request) + "\n",
    });

    let lastLine = "";
    for await (const line of process.readLines()) {
      lastLine = line;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(lastLine) as unknown;
    } catch {
      throw new Error(`agent-pty returned invalid JSON: ${lastLine}`);
    }

    if (raw === null || typeof raw !== "object") {
      throw new Error("agent-pty returned non-object response");
    }

    return asAgentPtyResponse(raw);
  }
}

function getInteractiveCommand(
  backend: ExternalAgentBackend,
  projectDir: string,
  profile: "read-only" | "workspace-write",
  task: string,
): { command: string; args: string[] } {
  switch (backend) {
    case "codex": {
      const sandbox = profile === "workspace-write" ? "workspace-write" : "read-only";
      return { command: "codex", args: ["-C", projectDir, "--color", "never", "--sandbox", sandbox, "--", task] };
    }
    case "claude": {
      const mode = profile === "workspace-write" ? "acceptEdits" : "plan";
      return { command: "claude", args: ["--permission-mode", mode, "--", task] };
    }
    case "devin": {
      const mode = profile === "workspace-write" ? "accept-edits" : "auto";
      return { command: "devin", args: ["--permission-mode", mode, "--", task] };
    }
    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error(`unknown backend: ${backend}`);
    }
  }
}

function looksLikePrompt(text: string): boolean {
  const lastLine = text.trimEnd().split("\n").pop() ?? "";
  return /[>$#:]\s*$/u.test(lastLine);
}
