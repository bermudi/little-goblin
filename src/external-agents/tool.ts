import { Type, type Static } from "@sinclair/typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExternalAgentBackend } from "./types.ts";
import type { ExternalAgentRunner } from "./runner.ts";
import { errorString } from "./util.ts";

const MAX_TOOL_RESULT_CHARS = 16000;

export interface CreateExternalAgentToolOptions {
  runner: ExternalAgentRunner;
  sessionId: string;
  projectDir: string | undefined;
  enabledBackends: readonly ExternalAgentBackend[];
  onStatusUpdate?: (message: string) => void;
}

function createSchema(enabledBackends: readonly ExternalAgentBackend[]) {
  return Type.Object({
    action: Type.Union([
      Type.Literal("start"),
      Type.Literal("status"),
      Type.Literal("cancel"),
      Type.Literal("message"),
      Type.Literal("list"),
    ], { description: "Action to perform on the external agent runner." }),
    agent: Type.Optional(
      Type.String({
        description: `Backend to start. Enabled backends: ${enabledBackends.join(", ")}`,
      }),
    ),
    task: Type.Optional(
      Type.String({
        description: "Task prompt for the external agent. Required when action=start.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: "Run ID. Required for status, cancel, and message.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Message text to send to an interactive run. Required when action=message.",
      }),
    ),
  });
}

export function createExternalAgentTool(options: CreateExternalAgentToolOptions): ToolDefinition {
  const { enabledBackends } = options;
  const schema = createSchema(enabledBackends);
  type Input = Static<typeof schema>;

  return defineTool({
    name: "external_agent",
    label: "External Agent",
    description: buildDescription(enabledBackends),
    promptSnippet: "external_agent: run a task in a separate external agent (codex, claude, devin).",
    promptGuidelines: [
      "Use external_agent for self-contained work that can run in a separate process while you continue.",
      "Start with action: 'start', then poll action: 'status' for progress.",
      "When a run reports input_required, use action: 'message' with the run id.",
      "Use action: 'cancel' to stop a run.",
      "Use action: 'list' to see active runs.",
    ],
    parameters: schema,
    async execute(_toolCallId: string, params: Input, signal?: AbortSignal) {
      const result = await handleExternalAction({ ...options, params, signal });
      return {
        content: [{ type: "text" as const, text: result }],
        details: result,
      };
    },
  });
}

function buildDescription(enabledBackends: readonly ExternalAgentBackend[]): string {
  const backends = enabledBackends.length > 0 ? enabledBackends.join(", ") : "none enabled";
  return `Run or control an external agent in the current project directory. Supported backends: ${backends}.

Actions:
- start: begin a run. Requires agent and task.
- status: check a run by id.
- cancel: stop a run by id.
- message: send a message to an interactive run by id.
- list: list active runs.

The current project directory is used as the agent's working directory.`;
}

interface ActionContext extends CreateExternalAgentToolOptions {
  params: Static<ReturnType<typeof createSchema>>;
  signal?: AbortSignal;
}

async function handleExternalAction(ctx: ActionContext): Promise<string> {
  const { runner, sessionId, enabledBackends, params } = ctx;

  switch (params.action) {
    case "start": {
      const agent = params.agent as ExternalAgentBackend | undefined;
      if (!agent) {
        return `Error: agent is required for action=start. Enabled backends: ${enabledBackends.join(", ")}`;
      }
      if (!enabledBackends.includes(agent)) {
        return `Error: backend ${agent} is not enabled. Enabled backends: ${enabledBackends.join(", ")}`;
      }
      if (!ctx.projectDir) {
        return "Error: external_agent start requires a project directory (active scope or workspace binding).";
      }
      const task = params.task?.trim();
      if (!task) {
        return "Error: task is required for action=start.";
      }
      try {
        ctx.onStatusUpdate?.("starting external agent");
        const summary = await runner.start({ backend: agent, task, sessionId, projectDir: ctx.projectDir, signal: ctx.signal });
        ctx.onStatusUpdate?.("external agent started");
        return `Started external ${summary.backend} run ${summary.id} (status: ${summary.status}).`;
      } catch (err) {
        return `Error: ${errorString(err)}`;
      }
    }

    case "status": {
      const id = params.id;
      if (!id) return "Error: id is required for action=status.";
      try {
        const detail = await runner.status(id, sessionId);
        if (!detail) return `Error: run ${id} not found.`;
        return formatDetail(detail);
      } catch (err) {
        return `Error: ${errorString(err)}`;
      }
    }

    case "cancel": {
      const id = params.id;
      if (!id) return "Error: id is required for action=cancel.";
      try {
        const ok = await runner.cancel(id, sessionId);
        return ok ? `Cancelled run ${id}.` : `Error: run ${id} not found or already terminal.`;
      } catch (err) {
        return `Error: ${errorString(err)}`;
      }
    }

    case "message": {
      const id = params.id;
      const text = params.message?.trim();
      if (!id) return "Error: id is required for action=message.";
      if (!text) return "Error: message is required for action=message.";
      try {
        ctx.onStatusUpdate?.("sending message to external agent");
        await runner.message(id, sessionId, text);
        ctx.onStatusUpdate?.("message sent to external agent");
      } catch (err) {
        return `Error: ${errorString(err)}`;
      }
      return `Message sent to run ${id}.`;
    }

    case "list": {
      try {
        const runs = runner.list(sessionId);
        if (runs.length === 0) return "No external runs.";
        return runs.map((r) => `- ${r.id} [${r.backend}] ${r.status} (updated ${r.updatedAt})`).join("\n");
      } catch (err) {
        return `Error: ${errorString(err)}`;
      }
    }

    default: {
      const unknown: never = params.action;
      return `Error: unknown action ${unknown}`;
    }
  }
}

export function formatDetail(detail: {
  status: string;
  recentOutput?: string;
  error?: string;
  inputRequired?: string;
  eventsTruncated?: boolean;
  resultTruncated?: boolean;
  recentEvents: { type: string; at: string; message?: string; output?: string; error?: string }[];
}): string {
  const headerParts: string[] = [`status: ${detail.status}`];
  if (detail.error) {
    const maxError = Math.floor(MAX_TOOL_RESULT_CHARS / 4);
    const error = detail.error.length > maxError ? detail.error.slice(0, maxError) : detail.error;
    headerParts.push(`error: ${error}`);
  }
  if (detail.inputRequired) {
    const maxInput = Math.floor(MAX_TOOL_RESULT_CHARS / 4);
    const input = detail.inputRequired.length > maxInput ? detail.inputRequired.slice(0, maxInput) : detail.inputRequired;
    headerParts.push(`input_required: ${input}`);
  }
  if (detail.eventsTruncated || detail.resultTruncated) {
    const truncated = [];
    if (detail.eventsTruncated) truncated.push("events");
    if (detail.resultTruncated) truncated.push("result");
    headerParts.push(`truncated: ${truncated.join(", ")}`);
  }
  const header = headerParts.join("\n\n");

  const output = detail.recentOutput?.trim() || "";
  const events = detail.recentEvents
    .map((e) => `[${e.type}] ${e.message ?? e.output ?? e.error ?? ""}`)
    .join("\n");

  const outputText = output ? `output:\n${output}` : "";
  const eventsText = events ? `recent events:\n${events}` : "";

  const SEP = "\n\n";
  const maxBody = MAX_TOOL_RESULT_CHARS - header.length - SEP.length;
  if (maxBody <= 0) {
    return header.slice(0, MAX_TOOL_RESULT_CHARS);
  }

  let body = [eventsText, outputText].filter(Boolean).join(SEP);
  if (body.length > maxBody) {
    const ellipsis = "...";
    body = ellipsis + body.slice(-(maxBody - ellipsis.length));
  }

  return body ? `${header}${SEP}${body}` : header;
}
