import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { errorString } from "./util.ts";
import { prepareEnv } from "./env.ts";
import { ExternalAgentHost, type AcpAgentConnection, type PermissionProfile, type QualifiedBackend } from "./host.ts";
import { DelegatedWorkHost } from "../delegated-work/host.ts";
import type { DurableDelegatedWorkOwnership } from "../delegated-work/types.ts";

const MAX_LAUNCH_TASK_CHARS = 8000;

// ---------------------------------------------------------------------------
// Delegated-run tool surface (decision 0041 + 0044 + 0045 + 0049).
//
// Model-selected launch input, captured not confined: explicit working
// directory, permission profile (omitted defaults to the unattended dangerous
// profile), and bounded invocation parameters (task), structurally validated
// and captured with the delegated-run record. The Devin model is not
// model-facing: it is the operator-owned Settings deployment default resolved
// at admission and captured with the record; the AI SHALL NOT override it and
// no substitute is silently launched. Child environments receive only the
// decision-0041 allowlist via prepareEnv(). Status, list, and cancel read the
// one host-owned delegated-run store; live ACP connections are held per run
// only to continue an input_required turn, never as run-state authority.
// New callers use createDelegatedExternalAgentTool.
// ---------------------------------------------------------------------------

export interface DelegatedExternalAgentToolOptions {
  workHost: DelegatedWorkHost;
  agentHost: ExternalAgentHost;
  enabledBackends: readonly QualifiedBackend[];
  buildOwnership: () => DurableDelegatedWorkOwnership;
  resolveDevinModel: () => string | undefined;
  onStatusUpdate?: (message: string) => void;
}

const DELEGATED_PERMISSION_PROFILES = ["default", "accept-edits", "dangerous"] as const;

function delegatedSchema() {
  return Type.Object({
    action: Type.Union([
      Type.Literal("start"),
      Type.Literal("status"),
      Type.Literal("cancel"),
      Type.Literal("message"),
      Type.Literal("list"),
    ]),
    agent: Type.Optional(Type.String()),
    task: Type.Optional(Type.String()),
    workingDirectory: Type.Optional(Type.String()),
    permissionProfile: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
  });
}

type DelegatedInput = Static<ReturnType<typeof delegatedSchema>>;

interface LiveDelegatedRun {
  connection: AcpAgentConnection;
  lastStopReason: string;
  lastAgentText: string;
}

export function createDelegatedExternalAgentTool(options: DelegatedExternalAgentToolOptions): ToolDefinition & { readonly liveRuns?: Map<string, LiveDelegatedRun> } {
  const schema = delegatedSchema();
  const live = new Map<string, LiveDelegatedRun>();
  const tool = defineTool({
    name: "external_agent",
    label: "External Agent",
    description: `Run or control an external agent with explicit launch selections. Supported backends: ${options.enabledBackends.join(", ") || "none enabled"}.

Actions:
- start: begin a run. Requires agent (claude|devin), task, workingDirectory.
- status: check a run by id.
- cancel: stop a run by id.
- message: send a message to an input_required run by id.
- list: list external runs from the delegated-run store.

Launch selections are structurally validated and captured with the delegated-run record. An omitted permissionProfile defaults to dangerous. The Devin model is operator-owned and never model-selectable.`,
    promptSnippet: "external_agent: run a task in a separate external agent (claude, devin) with explicit cwd and profile.",
    promptGuidelines: [
      "Use external_agent for self-contained work that can run in a separate process while you continue.",
      "Start with action: 'start' plus agent, task, workingDirectory, and permissionProfile.",
      "When a run reports input_required, use action: 'message' with the run id.",
      "Use action: 'cancel' to stop a run.",
      "Use action: 'list' to see runs from the delegated-run store.",
    ],
    parameters: schema,
    async execute(_toolCallId: string, params: DelegatedInput, signal?: AbortSignal) {
      const result = await handleDelegatedAction(options, live, params, signal);
      return {
        content: [{ type: "text" as const, text: result }],
        details: result,
      };
    },
  });
  return Object.assign(tool, { liveRuns: live });
}

function delegatedInvalid(reason: string): string {
  return `Error: ${reason}`;
}

function isNodeErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Coordinator-owned failures must never leave a running record behind a dead turn. */
function markInvocationFailed(
  workHost: DelegatedWorkHost,
  runId: string,
  index: number,
  message: string,
): void {
  try {
    workHost.failInvocation(runId, index, message);
  } catch {
    // The store already logged the secondary failure; report the original error.
  }
}

function validateWorkingDirectory(dir: string): string | null {
  if (dir.length === 0 || !isAbsolute(dir)) {
    return "workingDirectory must be an absolute path";
  }
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return `workingDirectory is not a directory: ${dir}`;
  } catch (err) {
    if (isNodeErrno(err) && err.code === "ENOENT") {
      return `workingDirectory does not exist: ${dir}`;
    }
    throw err;
  }
  return null;
}

async function handleDelegatedAction(
  options: DelegatedExternalAgentToolOptions,
  live: Map<string, LiveDelegatedRun>,
  params: DelegatedInput,
  signal?: AbortSignal,
): Promise<string> {
  const { workHost, agentHost, enabledBackends } = options;
  switch (params.action) {
    case "start": {
      const raw = params as unknown as Record<string, unknown>;
      if (raw["model"] !== undefined || raw["devinModel"] !== undefined) {
        return delegatedInvalid("devin model is operator-owned and cannot be selected or overridden by the model");
      }
      const backend = params.agent as QualifiedBackend | undefined;
      if (backend === undefined || backend.length === 0) {
        return delegatedInvalid(`agent is required for action=start. Enabled backends: ${enabledBackends.join(", ")}`);
      }
      if (backend !== "claude" && backend !== "devin") {
        return delegatedInvalid(`backend ${backend} is not supported. Supported backends: claude, devin`);
      }
      if (!enabledBackends.includes(backend)) {
        return delegatedInvalid(`backend ${backend} is not enabled. Enabled backends: ${enabledBackends.join(", ")}`);
      }
      const workingDirectory = params.workingDirectory;
      if (workingDirectory === undefined || workingDirectory.length === 0) {
        return delegatedInvalid("workingDirectory is required for action=start and must be an absolute path");
      }
      const dirError = validateWorkingDirectory(workingDirectory);
      if (dirError !== null) return delegatedInvalid(dirError);
      const profileRaw = params.permissionProfile;
      const permissionProfile: PermissionProfile = profileRaw === undefined ? "dangerous" : (profileRaw as PermissionProfile);
      if (!DELEGATED_PERMISSION_PROFILES.includes(permissionProfile as (typeof DELEGATED_PERMISSION_PROFILES)[number])) {
        return delegatedInvalid(`permissionProfile must be one of ${DELEGATED_PERMISSION_PROFILES.join(", ")}`);
      }
      const task = params.task?.trim();
      if (task === undefined || task.length === 0) {
        return delegatedInvalid("task is required for action=start");
      }
      if (task.length > MAX_LAUNCH_TASK_CHARS) {
        return delegatedInvalid(`task must be at most ${MAX_LAUNCH_TASK_CHARS} characters`);
      }
      let devinModel: string | null = null;
      if (backend === "devin") {
        let resolved: string | undefined;
        try {
          resolved = options.resolveDevinModel()?.trim();
        } catch (err) {
          return delegatedInvalid(errorString(err));
        }
        if (resolved === undefined || resolved.length === 0) {
          return delegatedInvalid("devin launch requires the resolved operator-owned model; no substitute is launched");
        }
        devinModel = resolved;
      }
      const runId = randomUUID();
      const ownership = options.buildOwnership();
      let recordId: string = runId;
      try {
        const created = workHost.createExternalRecord(runId, backend, ownership, {
          workingDirectory,
          permissionProfile,
          ...(devinModel === null ? { devinModel: null } : { devinModel }),
          task,
        });
        recordId = created.record.id;
      } catch (err) {
        return delegatedInvalid(errorString(err));
      }
      options.onStatusUpdate?.("starting external agent");
      let connection: AcpAgentConnection;
      try {
        connection = await agentHost.connect({
          backend,
          workingDirectory,
          permissionProfile,
          env: prepareEnv(),
          ...(backend === "devin" && devinModel !== null ? { devinModel } : {}),
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (err) {
        markInvocationFailed(workHost, recordId, 0, errorString(err));
        return delegatedInvalid(errorString(err));
      }
      try {
        workHost.captureExternalSession(recordId, connection.sessionId);
      } catch (err) {
        await connection.dispose().catch(() => {});
        markInvocationFailed(workHost, recordId, 0, errorString(err));
        return delegatedInvalid(errorString(err));
      }
      let outcome: { stopReason: string; agentText: string };
      try {
        outcome = await connection.prompt(task, () => {});
      } catch (err) {
        try {
          workHost.failInvocation(recordId, 0, errorString(err));
        } catch {
          // record failure already logged by the store; report the prompt error
        }
        await connection.dispose().catch(() => {});
        return delegatedInvalid(errorString(err));
      }
      live.set(recordId, { connection, lastStopReason: outcome.stopReason, lastAgentText: outcome.agentText });
      options.onStatusUpdate?.("external agent started");
      if (outcome.stopReason === "input_required") {
        return `Started external ${backend} run ${recordId} (status: input_required). Working directory ${workingDirectory}, profile ${permissionProfile}${devinModel !== null ? `, model ${devinModel}` : ""}. Send action:message to continue.`;
      }
      try {
        workHost.completeInvocation(recordId, 0, outcome.agentText);
      } catch (err) {
        markInvocationFailed(workHost, recordId, 0, errorString(err));
        await connection.dispose().catch(() => {});
        live.delete(recordId);
        return delegatedInvalid(errorString(err));
      }
      await connection.dispose().catch(() => {});
      live.delete(recordId);
      return `Started external ${backend} run ${recordId} (status: completed). Working directory ${workingDirectory}, profile ${permissionProfile}${devinModel !== null ? `, model ${devinModel}` : ""}.`;
    }
    case "status": {
      const id = params.id;
      if (!id) return delegatedInvalid("id is required for action=status");
      const record = workHost.loadRecord(id);
      if (record === null || record.kind !== "external-agent") return delegatedInvalid(`run ${id} not found`);
      const invocation = record.invocations.at(-1);
      const entry = live.get(id);
      const status = entry !== undefined && entry.lastStopReason === "input_required" && invocation?.status === "running"
        ? "input_required"
        : (invocation?.status ?? "unknown");
      const ext = record.external;
      const parts = [
        `run ${record.id} [${ext.backend}] status: ${status}`,
        `workingDirectory: ${ext.workingDirectory ?? "unknown"}`,
        `permissionProfile: ${ext.permissionProfile ?? "unknown"}`,
      ];
      if (ext.backend === "devin") parts.push(`model: ${ext.devinModel ?? "unknown"}`);
      if (entry !== undefined && entry.lastAgentText.length > 0) {
        parts.push(`output:\n${entry.lastAgentText.slice(-2000)}`);
      }
      return parts.join("\n");
    }
    case "cancel": {
      const id = params.id;
      if (!id) return delegatedInvalid("id is required for action=cancel");
      const record = workHost.loadRecord(id);
      if (record === null || record.kind !== "external-agent") return delegatedInvalid(`run ${id} not found or already terminal`);
      const last = record.invocations.at(-1);
      if (last === undefined || last.status !== "running") return delegatedInvalid(`run ${id} not found or already terminal`);
      try {
        workHost.cancelInvocation(id, last.index);
      } catch (err) {
        return delegatedInvalid(errorString(err));
      }
      const entry = live.get(id);
      if (entry !== undefined) {
        await entry.connection.dispose().catch(() => {});
        live.delete(id);
      }
      return `Cancelled run ${id}.`;
    }
    case "message": {
      const id = params.id;
      const text = params.message?.trim();
      if (!id) return delegatedInvalid("id is required for action=message");
      if (text === undefined || text.length === 0) return delegatedInvalid("message is required for action=message");
      const record = workHost.loadRecord(id);
      if (record === null || record.kind !== "external-agent") return delegatedInvalid(`run ${id} not found`);
      const last = record.invocations.at(-1);
      if (last === undefined || last.status !== "running") return delegatedInvalid(`run ${id} is already terminal`);
      const entry = live.get(id);
      if (entry === undefined || entry.lastStopReason !== "input_required") {
        return delegatedInvalid(`run ${id} is not awaiting input`);
      }
      let outcome: { stopReason: string; agentText: string };
      try {
        options.onStatusUpdate?.("sending message to external agent");
        outcome = await entry.connection.prompt(text, () => {});
        options.onStatusUpdate?.("message sent to external agent");
      } catch (err) {
        markInvocationFailed(workHost, id, last.index, errorString(err));
        await entry.connection.dispose().catch(() => {});
        live.delete(id);
        return delegatedInvalid(errorString(err));
      }
      entry.lastStopReason = outcome.stopReason;
      entry.lastAgentText = outcome.agentText.length > 0 ? outcome.agentText : entry.lastAgentText;
      if (outcome.stopReason === "input_required") {
        return `Message sent to run ${id} (status: input_required).`;
      }
      try {
        workHost.completeInvocation(id, last.index, outcome.agentText);
      } catch (err) {
        markInvocationFailed(workHost, id, last.index, errorString(err));
        await entry.connection.dispose().catch(() => {});
        live.delete(id);
        return delegatedInvalid(errorString(err));
      }
      await entry.connection.dispose().catch(() => {});
      live.delete(id);
      return `Message sent to run ${id} (status: completed).`;
    }
    case "list": {
      const ids = workHost.listRecordIds();
      const lines: string[] = [];
      for (const rid of ids) {
        const record = workHost.loadRecord(rid);
        if (record === null || record.kind !== "external-agent") continue;
        const st = record.invocations.at(-1)?.status ?? "unknown";
        lines.push(`- ${record.id} [${record.external.backend}] ${st}`);
      }
      if (lines.length === 0) return "No external runs.";
      return lines.join("\n");
    }
    default: {
      const unknown: never = params.action;
      return delegatedInvalid(`unknown action ${unknown}`);
    }
  }
}
