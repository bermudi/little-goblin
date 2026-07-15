import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  RequestError,
  type ContentBlock,
  type PermissionOption,
  type ReadTextFileRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import { atomicWrite } from "../fs.ts";
import type { AdapterStartInput, ExternalAgentBackend, ExternalAgentEvent, ExternalAgentHandle } from "./types.ts";
import { errorString, isPathWithinProject, nowIso } from "./util.ts";

const CANCELLED = Symbol("devin-session-cancelled");

export class DevinAdapter {
  readonly backend: ExternalAgentBackend = "devin";

  async start(
    input: AdapterStartInput,
    emit: (event: ExternalAgentEvent) => void,
  ): Promise<ExternalAgentHandle> {
    const profile = input.permissionProfile === "workspace-write" ? "accept-edits" : "auto";
    const command = ["devin", "--permission-mode", profile, "--sandbox", "acp"];

    emit({ type: "status", at: nowIso(), message: `devin: ${command.join(" ")}` });

    const process = await input.processHost.spawn({
      command,
      cwd: input.projectDir,
      env: input.env,
      signal: input.signal,
    });

    const stream = ndJsonStream(Writable.toWeb(process.stdin), Readable.toWeb(process.stdout));
    const acpClient = client({ name: "goblin" });

    registerHandlers(acpClient, input.projectDir, input.permissionProfile);

    const connection = acpClient.connect(stream);

    const session = await connection.agent.buildSession(input.projectDir).start();

    emit({ type: "status", at: nowIso(), message: `devin session ${session.sessionId} started` });

    let resolveCancel: ((value: typeof CANCELLED) => void) | undefined;
    const cancelPromise = new Promise<typeof CANCELLED>((resolve) => {
      resolveCancel = resolve;
    });

    const handle: ExternalAgentHandle = {
      cancel: async () => {
        // Resolve the cancel signal BEFORE disposing the session. The ACP SDK's
        // session.dispose() synchronously rejects the pending nextUpdate()
        // promise; if that rejection settles before cancelPromise, Promise.race
        // in the update loop would reject instead of resolving with CANCELLED,
        // emitting a spurious "failed" event. Settling cancelPromise first
        // guarantees the loop observes CANCELLED and emits "cancelled".
        resolveCancel?.(CANCELLED);
        // Request graceful ACP session disposal if available. The SDK does not
        // expose a client-side session/cancel request, so we dispose update
        // routing and close the connection; the agent observes the closed
        // connection and stops on its own.
        try {
          session.dispose();
        } catch {
          // ignore — best-effort cleanup
        }
        try {
          connection.close();
        } catch {
          // ignore — best-effort; do not let a close failure skip process.kill
        }
        await process.kill();
      },
    };

    void session.prompt(input.task).catch(() => {
      // ignore; nextUpdate will surface the same error
    });

    void (async () => {
      try {
        while (true) {
          const nextUpdatePromise = session.nextUpdate();
          const msg = await Promise.race([nextUpdatePromise, cancelPromise]);
          if (msg === CANCELLED) {
            // Consume the abandoned nextUpdate promise so a connection-close
            // rejection cannot create an unhandled rejection.
            nextUpdatePromise.catch(() => {});
            emit({ type: "cancelled", at: nowIso() });
            break;
          }
          if (msg === undefined) {
            emit({ type: "failed", at: nowIso(), error: "devin session ended without a terminal event" });
            break;
          }

          if (msg.kind === "session_update") {
            handleSessionUpdate(msg.update, emit);
            continue;
          }

          switch (msg.stopReason as string) {
            case "end_turn": {
              emit({ type: "completed", at: nowIso() });
              break;
            }
            case "cancelled": {
              emit({ type: "cancelled", at: nowIso() });
              break;
            }
            case "input_required": {
              emit({ type: "input_required", at: nowIso(), message: "send a message" });
              continue;
            }
            default: {
              emit({ type: "failed", at: nowIso(), error: `devin stopped: ${msg.stopReason}` });
              break;
            }
          }
          break;
        }
      } catch (err) {
        emit({ type: "failed", at: nowIso(), error: errorString(err) });
      }
    })();

    return handle;
  }
}

function registerHandlers(
  acpClient: ReturnType<typeof client>,
  projectDir: string,
  profile: "read-only" | "workspace-write",
): void {
  acpClient.onRequest(methods.client.fs.readTextFile, (ctx: { params: ReadTextFileRequest }) => {
    const path = resolve(projectDir, ctx.params.path);
    if (!isPathWithinProject(path, projectDir)) {
      throw new RequestError(-32603, `Path outside project: ${path}`);
    }
    try {
      const content = readFileSync(path, "utf-8");
      return { content };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new RequestError(-32603, `ENOENT`);
      }
      throw new RequestError(-32603, errorString(err));
    }
  });

  acpClient.onRequest(methods.client.fs.writeTextFile, (ctx: { params: WriteTextFileRequest }) => {
    const path = resolve(projectDir, ctx.params.path);
    const { content } = ctx.params;
    if (profile !== "workspace-write") {
      throw new RequestError(-32603, "Write not allowed in current permission profile");
    }
    if (!isPathWithinProject(path, projectDir)) {
      throw new RequestError(-32603, `Path outside project: ${path}`);
    }
    try {
      atomicWrite(path, content);
      return {};
    } catch (err) {
      throw new RequestError(-32603, errorString(err));
    }
  });

  acpClient.onRequest(methods.client.session.requestPermission, (ctx: { params: RequestPermissionRequest }) => {
    return buildPermissionResponse(ctx.params.options);
  });

  acpClient.onRequest(methods.client.elicitation.create, () => {
    throw new RequestError(-32603, "Elicitation not supported");
  });

  acpClient.onNotification(methods.client.elicitation.complete, () => {
    // Notifications have no response channel; ignore. Elicitation is not
    // supported, but throwing here would create an unhandled rejection.
  });

  acpClient.onRequest(methods.client.terminal.create, () => {
    throw new RequestError(-32603, "Terminal not supported");
  });
  acpClient.onRequest(methods.client.terminal.output, () => {
    throw new RequestError(-32603, "Terminal not supported");
  });
  acpClient.onRequest(methods.client.terminal.release, () => {
    throw new RequestError(-32603, "Terminal not supported");
  });
  acpClient.onRequest(methods.client.terminal.waitForExit, () => {
    throw new RequestError(-32603, "Terminal not supported");
  });
  acpClient.onRequest(methods.client.terminal.kill, () => {
    throw new RequestError(-32603, "Terminal not supported");
  });

}

function handleSessionUpdate(update: SessionUpdate, emit: (event: ExternalAgentEvent) => void): void {
  const at = nowIso();

  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const text = textFromContent(update.content);
      if (text.length > 0) {
        emit({ type: "output", at, output: text });
      }
      break;
    }
    case "tool_call":
    case "tool_call_update": {
      const title = "title" in update ? String(update.title) : "tool";
      emit({ type: "status", at, message: `tool: ${title}` });
      break;
    }
    case "plan":
    case "plan_update":
    case "plan_removed":
    case "available_commands_update":
    case "current_mode_update":
    case "config_option_update":
    case "session_info_update":
    case "usage_update":
    case "user_message_chunk": {
      emit({ type: "status", at, message: update.sessionUpdate });
      break;
    }
    default: {
      const _exhaustive: never = update;
      void _exhaustive;
    }
  }
}

function textFromContent(content: ContentBlock | undefined): string {
  if (content === undefined || content === null) return "";
  if (content.type === "text") {
    return content.text;
  }
  return "";
}

/**
 * Build the ACP permission response for an automated client.
 *
 * Selects a reject option when available so the agent sees an explicit denial
 * of the specific action. Never selects an allow option: Goblin is an
 * automated client and must not grant permissions the user did not pre-approve
 * via the configured permission profile. When no reject option is offered,
 * denies by cancelling the permission request.
 *
 * Exported for unit testing.
 */
export function buildPermissionResponse(options: PermissionOption[] | undefined): RequestPermissionResponse {
  const rejectOption = options?.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
  if (rejectOption) {
    return { outcome: { outcome: "selected", optionId: rejectOption.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}
