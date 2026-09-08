import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client as acpClient,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSession,
  type AgentCapabilities,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { ProcessExit, ProcessHandle, ProcessHost } from "./types.ts";
import { errorString } from "./util.ts";

/**
 * External-agent execution host (decision 0040): owns provider/process
 * protocol mechanics for the two qualified backends (decision 0044). One deep
 * module; run authority, delivery, and cancellation stay in the delegated-work
 * subsystem — this host never writes delegated-run records.
 *
 * Capability scope: the client advertises no filesystem or terminal capability
 * and implements no such handlers; unimplemented client methods fail closed
 * through the transport's method-not-found error. The permission profile
 * selected for the run is applied explicitly on every new, resumed, or loaded
 * connection and never inferred from prior connection state; an omitted
 * selection defaults to the unattended dangerous profile (decision 0044).
 * Devin's `--model` is the operator-owned Settings deployment default resolved
 * at admission (decision 0049) — the host never defaults or substitutes, and
 * the AI never overrides it. Productive prompts carry no elapsed-time cutoff:
 * a prompt ends by backend stop reason, explicit cancellation, abort, or
 * transport loss; time bounds apply only to local shutdown escalation.
 */

export const CLAUDE_ACP_BRIDGE_PACKAGE = "@agentclientprotocol/claude-agent-acp";

/** Decision-qualified baseline. Requalification re-runs the compatibility tests. */
export const CLAUDE_ACP_BRIDGE_PIN = "0.64.2";

export type QualifiedBackend = "claude" | "devin";

/**
 * Structured permission profile (decision 0041). "dangerous" is the
 * unattended profile: the backend is told to act without interactive approval
 * and permission requests that still reach Goblin are answered with allow.
 * Profiles are operational affordances, not confinement.
 */
export type PermissionProfile = "default" | "accept-edits" | "dangerous";

/**
 * The per-backend capability expectations qualified by decision 0044's
 * executable evidence. One compatibility contract, checked by compat tests;
 * changing a backend's expectations requires new evidence.
 */
export interface BackendContract {
  /** Method that continues a completed run's provider context. */
  continuationMethod: "session/resume" | "session/load";
  /** Method that intentionally retires a completed run's provider context. */
  retirementMethod: "session/close" | "session/delete";
  /** Whether the backend advertises `session/resume`. */
  supportsSessionResume: boolean;
}

export const BACKEND_CONTRACTS: Record<QualifiedBackend, BackendContract> = {
  claude: {
    continuationMethod: "session/resume",
    retirementMethod: "session/close",
    supportsSessionResume: true,
  },
  devin: {
    continuationMethod: "session/load",
    retirementMethod: "session/delete",
    supportsSessionResume: false,
  },
};

/**
 * Permission profile → ACP session mode id, per backend. Claude's vocabulary
 * is evidenced by the pinned bridge (decision 0044); Devin's is its CLI flag
 * vocabulary and is applied best-effort (see applyModePolicy).
 */
const PROFILE_MODE_IDS: Record<QualifiedBackend, Record<PermissionProfile, string>> = {
  claude: { "default": "default", "accept-edits": "acceptEdits", "dangerous": "bypassPermissions" },
  devin: { "default": "default", "accept-edits": "accept-edits", "dangerous": "auto" },
};

/** Devin launch-flag vocabulary for the permission profile. */
const DEVIN_PROFILE_FLAGS: Record<PermissionProfile, string | undefined> = {
  "default": undefined,
  "accept-edits": "accept-edits",
  "dangerous": "auto",
};

export interface ResolvedBridge {
  entryPath: string;
  packageJsonPath: string;
  version: string;
}

/**
 * Resolve the pinned Claude bridge package as installed. The compat tests
 * assert the resolved version against the pin; a missing or unpackaged bridge
 * is a hard configuration error, not an ENOENT-derived null.
 */
export function resolveClaudeBridge(): ResolvedBridge {
  const nodeRequire = createRequire(import.meta.url);
  let packageJsonPath: string;
  try {
    packageJsonPath = nodeRequire.resolve(`${CLAUDE_ACP_BRIDGE_PACKAGE}/package.json`);
  } catch (err) {
    throw new AcpHostError(
      `claude ACP bridge ${CLAUDE_ACP_BRIDGE_PACKAGE}@${CLAUDE_ACP_BRIDGE_PIN} is not resolvable: ${errorString(err)}`,
      "spawn-failed",
    );
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
    version?: string;
    bin?: Record<string, string> | string;
  };
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.["claude-agent-acp"];
  if (bin === undefined) {
    throw new AcpHostError(
      `claude ACP bridge ${CLAUDE_ACP_BRIDGE_PACKAGE} has no "claude-agent-acp" bin entry`,
      "spawn-failed",
    );
  }
  return { entryPath: join(dirname(packageJsonPath), bin), packageJsonPath, version: packageJson.version ?? "" };
}

export function claudeBridgeEntryPath(): string {
  return resolveClaudeBridge().entryPath;
}

export interface AcpConnectSpec {
  backend: QualifiedBackend;
  /** Absolute model-selected working directory (decision 0041). */
  workingDirectory: string;
  /**
   * Explicit profile applied on this connection; never inherited. An omitted
   * selection defaults to the unattended dangerous profile (decision 0044).
   */
  permissionProfile?: PermissionProfile;
  /** Allowlist child environment (decision 0041); the host adds nothing. */
  env: Record<string, string>;
  /**
   * Operator-owned Settings deployment default for Devin, resolved at
   * admission (decision 0049). Required for devin launches: a missing or
   * empty selection fails the launch without spawning and without a
   * substitute, and the AI never overrides it.
   */
  devinModel?: string;
  signal?: AbortSignal;
}

export type AcpHostEvent =
  | { type: "agent_message"; text: string }
  | { type: "tool_status"; toolCallId: string; title: string; kind?: string; status?: string }
  | { type: "status"; message: string };

export interface AcpPromptOutcome {
  /** Terminal stop reason as reported by the backend (e.g. "end_turn", "input_required"). */
  stopReason: string;
  /** Agent message text accumulated during the turn. */
  agentText: string;
}

export type AcpHostErrorReason =
  | "invalid-input"
  | "spawn-failed"
  | "protocol"
  | "aborted"
  | "process-exit"
  | "connection-lost"
  | "disposed";

export class AcpHostError extends Error {
  readonly reason: AcpHostErrorReason;

  constructor(message: string, reason: AcpHostErrorReason) {
    super(message);
    this.name = "AcpHostError";
    this.reason = reason;
  }
}

export interface ExternalAgentHostOptions {
  processHost: ProcessHost;
}

let goblinClientInfoCache: { name: string; version: string } | undefined;

function goblinClientInfo(): { name: string; version: string } {
  if (goblinClientInfoCache === undefined) {
    let version = "unknown";
    try {
      const nodeRequire = createRequire(import.meta.url);
      const pkg = JSON.parse(readFileSync(nodeRequire.resolve("../../package.json"), "utf-8")) as {
        version?: string;
      };
      if (typeof pkg.version === "string") {
        version = pkg.version;
      }
    } catch {
      // Identity stays useful even if the manifest is unreadable.
    }
    goblinClientInfoCache = { name: "goblin", version };
  }
  return goblinClientInfoCache;
}

export class ExternalAgentHost {
  constructor(private readonly options: ExternalAgentHostOptions) {}

  /**
   * Spawn the backend server, initialize it ACP-style with no client-hosted
   * capability, open a session in the selected working directory, and apply
   * the selected permission profile to this fresh connection. An omitted
   * profile defaults to dangerous; a devin launch without the resolved
   * operator model is refused before spawning — no substitute is launched.
   */
  async connect(spec: AcpConnectSpec): Promise<AcpAgentConnection> {
    if (!isAbsolute(spec.workingDirectory)) {
      throw new AcpHostError(`working directory must be absolute: ${spec.workingDirectory}`, "invalid-input");
    }
    const permissionProfile = spec.permissionProfile ?? "dangerous";
    let command: string[];
    if (spec.backend === "claude") {
      command = [process.execPath, resolveClaudeBridge().entryPath];
    } else {
      if (spec.devinModel === undefined || spec.devinModel.length === 0) {
        throw new AcpHostError(
          "devin launch requires the resolved operator-owned model (decision 0049); no substitute is launched",
          "invalid-input",
        );
      }
      command = devinCommand(permissionProfile, spec.devinModel);
    }

    const handle = await this.options.processHost.spawn({
      command,
      cwd: spec.workingDirectory,
      env: spec.env,
      signal: spec.signal,
    });

    const connection = openClientConnection(handle, permissionProfile);
    try {
      const initializeResponse = (await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // Decision 0044: no client filesystem or terminal capability.
        clientCapabilities: {},
        clientInfo: goblinClientInfo(),
      })) as InitializeResponse;
      const session = await connection.agent.buildSession({
        cwd: spec.workingDirectory,
        mcpServers: [],
      }).start();
      await applyPermissionProfile(connection, spec.backend, permissionProfile, session.sessionId, session.modes);
      return new AcpAgentConnection(spec, initializeResponse, handle, connection, session);
    } catch (err) {
      // Nothing may dangle after a failed connect.
      try {
        connection.close();
      } catch {
        // already closed — the kill below still runs
      }
      await handle.kill();
      throw err;
    }
  }
}

export class AcpAgentConnection {
  readonly backend: QualifiedBackend;
  readonly sessionId: string;
  readonly agentCapabilities: AgentCapabilities;

  private disposed = false;
  private abortRequested = false;
  private exit: ProcessExit | undefined;
  private readonly spec: AcpConnectSpec;
  private readonly handle: ProcessHandle;
  private readonly connection: ClientConnection;
  private readonly session: ActiveSession;
  private readonly abortListener: (() => void) | undefined;

  constructor(
    spec: AcpConnectSpec,
    initializeResponse: InitializeResponse,
    handle: ProcessHandle,
    connection: ClientConnection,
    session: ActiveSession,
  ) {
    this.spec = spec;
    this.backend = spec.backend;
    this.handle = handle;
    this.connection = connection;
    this.session = session;
    this.sessionId = session.sessionId;
    this.agentCapabilities = initializeResponse.agentCapabilities ?? {};

    void handle.waitForExit().then(
      (exit) => {
        this.exit = exit;
      },
      () => {},
    );

    if (spec.signal) {
      this.abortListener = () => {
        this.abortRequested = true;
        void this.dispose().catch(() => {});
      };
      spec.signal.addEventListener("abort", this.abortListener, { once: true });
    }
  }

  /**
   * Drive one prompt through `session/prompt` → `session/update` → stop
   * reason. The connection stays usable for follow-up prompts (e.g. a turn
   * stopped at `input_required`).
   */
  async prompt(text: string, emit: (event: AcpHostEvent) => void): Promise<AcpPromptOutcome> {
    if (this.disposed) {
      throw new AcpHostError("ACP connection is already disposed", "disposed");
    }
    const promptSettled = this.session.prompt(text).then(
      () => undefined,
      () => undefined,
    );
    try {
      const { response, agentText } = await this.driveTurn(emit);
      return { stopReason: response.stopReason, agentText };
    } finally {
      await promptSettled;
    }
  }

  /**
   * Explicit operator/model cancellation (decision 0044): notify the backend
   * that the turn should stop. The in-flight prompt resolves with whatever
   * stop reason the backend reports; use dispose() for bounded local teardown.
   * Productive prompts carry no elapsed-time cutoff — without an explicit
   * cancel, abort, or transport loss the turn runs until the backend stops.
   */
  async cancel(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
    } catch {
      // Best-effort: transport loss surfaces honestly through the prompt loop.
    }
  }

  /**
   * Bounded local cleanup: graceful transport closure first, then process
   * termination via the process host's kill escalation. A local process exit
   * never by itself retires completed provider context (decision 0044).
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.abortListener && this.spec.signal) {
      this.spec.signal.removeEventListener("abort", this.abortListener);
    }
    try {
      this.session.dispose();
    } catch {
      // best-effort teardown; the kill below is the guarantee
    }
    try {
      this.connection.close();
    } catch {
      // best-effort teardown; the kill below is the guarantee
    }
    await this.handle.kill();
  }

  private async driveTurn(emit: (event: AcpHostEvent) => void): Promise<{
    response: { stopReason: string };
    agentText: string;
  }> {
    // No elapsed-time cutoff (decision 0044): the turn runs until the backend
    // reports a stop reason or the loop fails via abort, dispose, process
    // exit, or transport loss.
    const agentChunks: string[] = [];
    for (;;) {
      let message: Awaited<ReturnType<ActiveSession["nextUpdate"]>>;
      try {
        message = await this.session.nextUpdate();
      } catch (error) {
        throw this.classifyLoopError(error, `backend ${this.backend} ended the prompt turn with an error`);
      }
      if (message.kind === "stop") {
        return { response: message.response, agentText: agentChunks.join("") };
      }
      mapUpdate(message.update, emit, agentChunks);
    }
  }

  private classifyLoopError(error: unknown, context: string): AcpHostError {
    const stderr = this.handle.getStderr();
    const stderrTail = stderr.length > 0 ? `; stderr: ${stderr.slice(-2000).trim()}` : "";
    if (this.abortRequested) {
      return new AcpHostError(`${context}: aborted: ${errorString(error)}`, "aborted");
    }
    if (this.disposed) {
      return new AcpHostError(`${context}: connection disposed: ${errorString(error)}`, "disposed");
    }
    if (this.exit !== undefined) {
      const how = this.exit.signal !== null ? `killed by ${this.exit.signal}` : `exit code ${this.exit.exitCode}`;
      return new AcpHostError(`${context}: backend process ${how}${stderrTail}`, "process-exit");
    }
    return new AcpHostError(`${context}: connection lost: ${errorString(error)}${stderrTail}`, "connection-lost");
  }
}

function devinCommand(profile: PermissionProfile, model: string): string[] {
  const flag = DEVIN_PROFILE_FLAGS[profile];
  return [
    "devin",
    ...(flag === undefined ? [] : ["--permission-mode", flag]),
    "--sandbox",
    "acp",
    "--model",
    model,
  ];
}

function openClientConnection(handle: ProcessHandle, profile: PermissionProfile): ClientConnection {
  const app = acpClient({ name: "goblin" });
  app.onRequest(methods.client.session.requestPermission, (c) => buildPermissionResponse(c.params, profile));
  // Deliberately no fs or terminal handlers: unimplemented client methods fail
  // closed at the transport (method-not-found), and Goblin advertises no such
  // capability in initialize (decision 0044).
  return app.connect(ndJsonStream(Writable.toWeb(handle.stdin), Readable.toWeb(handle.stdout)));
}

/**
 * Explicitly apply the selected profile to this connection (decision 0044):
 * Claude's mode vocabulary is part of the pinned-bridge compatibility
 * contract, so a session that does not offer the mapped mode is a hard
 * protocol error; Devin's is applied best-effort because its launch flags
 * already carry the profile on this fresh connection.
 */
async function applyPermissionProfile(
  connection: ClientConnection,
  backend: QualifiedBackend,
  profile: PermissionProfile,
  sessionId: string,
  modes: { currentModeId: string; availableModes: Array<{ id: string }> } | null | undefined,
): Promise<void> {
  const wanted = PROFILE_MODE_IDS[backend][profile];
  if (modes === undefined || modes === null) {
    return;
  }
  const offered = modes.availableModes.some((mode) => mode.id === wanted);
  if (!offered && backend === "claude") {
    throw new AcpHostError(
      `claude bridge does not offer permission mode "${wanted}" for profile "${profile}"`,
      "protocol",
    );
  }
  if (offered) {
    await connection.agent.request(methods.agent.session.setMode, { sessionId, modeId: wanted });
  }
}

/**
 * Automated permission response for the selected profile. Dangerous (unattended):
 * prefer allow_always, then allow_once, so the backend acts without further
 * interactive approval. Otherwise: prefer an explicit reject option; cancelled
 * when no suitable option is offered (fail closed).
 */
export function buildPermissionResponse(
  params: RequestPermissionRequest,
  profile: PermissionProfile,
): RequestPermissionResponse {
  const options = params.options ?? [];
  if (profile === "dangerous") {
    const allowAlways = options.find((option) => option.kind === "allow_always");
    if (allowAlways !== undefined) {
      return { outcome: { outcome: "selected", optionId: allowAlways.optionId } };
    }
    const allowOnce = options.find((option) => option.kind === "allow_once");
    if (allowOnce !== undefined) {
      return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }
  const rejectOnce = options.find((option) => option.kind === "reject_once");
  if (rejectOnce !== undefined) {
    return { outcome: { outcome: "selected", optionId: rejectOnce.optionId } };
  }
  const rejectAlways = options.find((option) => option.kind === "reject_always");
  if (rejectAlways !== undefined) {
    return { outcome: { outcome: "selected", optionId: rejectAlways.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function mapUpdate(
  update: SessionUpdate,
  emit: (event: AcpHostEvent) => void,
  agentChunks: string[],
): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textFromContent(update.content);
      if (text.length > 0) {
        agentChunks.push(text);
        emit({ type: "agent_message", text });
      }
      return;
    }
    case "tool_call":
    case "tool_call_update": {
      const title = update.title ?? update.toolCallId;
      const kind = update.kind ?? undefined;
      const status = update.status ?? undefined;
      if (kind === undefined && status === undefined) {
        emit({ type: "tool_status", toolCallId: update.toolCallId, title });
        return;
      }
      emit({
        type: "tool_status",
        toolCallId: update.toolCallId,
        title,
        ...(kind === undefined ? {} : { kind }),
        ...(status === undefined ? {} : { status }),
      });
      return;
    }
    case "agent_thought_chunk": {
      emit({ type: "status", message: "agent thought" });
      return;
    }
    default: {
      emit({ type: "status", message: update.sessionUpdate });
    }
  }
}

function textFromContent(content: ContentBlock | undefined): string {
  if (content === undefined || content === null) {
    return "";
  }
  return content.type === "text" ? content.text : "";
}
