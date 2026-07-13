import type { AdapterStartInput, ExternalAgentBackend, ExternalAgentEvent, ExternalAgentHandle, ProcessExit } from "./types.ts";
import { InteractiveRequiredError } from "./types.ts";
import { nowIso } from "./util.ts";

export class CodexAdapter {
  readonly backend: ExternalAgentBackend = "codex";

  async start(
    input: AdapterStartInput,
    emit: (event: ExternalAgentEvent) => void,
  ): Promise<ExternalAgentHandle> {
    const profile = input.permissionProfile === "workspace-write" ? "workspace-write" : "read-only";
    const command = [
      "codex",
      "--ask-for-approval",
      "never",
      "exec",
      "--skip-git-repo-check",
      "--json",
      "-C",
      input.projectDir,
      "--color",
      "never",
      "--sandbox",
      profile,
      "-",
    ];

    emit({ type: "status", at: nowIso(), message: `codex exec: ${command.join(" ")}` });

    const process = await input.processHost.spawn({
      command,
      cwd: input.projectDir,
      env: input.env,
      stdin: input.task,
      signal: input.signal,
    });

    let resolveExit!: (exit: ProcessExit) => void;
    let rejectExit!: (err: unknown) => void;
    const waitForExit = new Promise<ProcessExit>((resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    });

    const handle: ExternalAgentHandle = {
      cancel: () => process.kill(),
      waitForExit: () => waitForExit,
    };

    let hasOutput = false;
    let workStarted = false;
    let turnCompleted = false;
    let turnFailed = false;

    void (async () => {
      try {
        for await (const line of process.readLines()) {
          const events = parseCodexLine(line);
          for (const event of events) {
            if (event.type === "output") {
              hasOutput = true;
            }
            if (event.type === "status") {
              if (event.message?.startsWith("executing:") || event.message?.startsWith("tool:") || event.message?.startsWith("file change:")) {
                workStarted = true;
              }
            }
            if (event.type === "failed" && !turnCompleted && !workStarted && !hasOutput && isInteractiveError(event.error)) {
              rejectExit(new InteractiveRequiredError("codex", event.error ?? "interactive mode required"));
              return;
            }
            if (event.type === "completed") {
              turnCompleted = true;
            }
            if (event.type === "failed") {
              turnFailed = true;
            }
            emit(event);
          }
        }

        const exit = await process.waitForExit();

        if (turnCompleted || turnFailed) {
          resolveExit(exit);
          return;
        }

        const stderr = process.getStderr();
        if (isInteractiveError(stderr)) {
          rejectExit(new InteractiveRequiredError("codex", stderr || "interactive mode required"));
          return;
        }

        if (exit.exitCode === 0) {
          emit({ type: "failed", at: nowIso(), error: "codex exited without terminal event" });
        } else {
          emit({ type: "failed", at: nowIso(), error: stderr || `codex exited ${exit.exitCode}` });
        }
        resolveExit(exit);
      } catch (err) {
        rejectExit(err);
      }
    })();

    return handle;
  }
}

function isInteractiveError(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("interactive") ||
    lower.includes("tty") ||
    lower.includes("terminal") ||
    lower.includes("stdout is not a terminal") ||
    lower.includes("stdin is not a terminal")
  );
}

function parseCodexLine(line: string): ExternalAgentEvent[] {
  if (!line.trim()) return [];
  const at = nowIso();
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return [{ type: "status", at, message: "malformed codex line" }];
  }
  if (raw === null || typeof raw !== "object") {
    return [{ type: "status", at, message: "non-object codex line" }];
  }

  const obj = raw as Record<string, unknown>;

  const type = obj.type;
  if (typeof type !== "string") {
    return [{ type: "status", at, message: "codex event missing type" }];
  }

  if (type === "thread.started") return [{ type: "status", at, message: "codex thread started" }];
  if (type === "turn.started") return [{ type: "status", at, message: "codex turn started" }];

  if (type === "turn.completed") return [{ type: "completed", at }];

  if (type === "turn.failed") {
    const error = extractError(obj.error);
    return [{ type: "failed", at, error }];
  }

  if (type === "error") {
    const error = typeof obj.message === "string" ? obj.message : "codex error";
    return [{ type: "status", at, message: `codex error: ${error}` }];
  }

  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = obj.item;
    if (item === null || typeof item !== "object") {
      return [{ type: "status", at, message: "malformed codex item event" }];
    }
    const itemObj = item as Record<string, unknown>;
    const itemType = typeof itemObj.type === "string" ? itemObj.type : typeof itemObj.item_type === "string" ? itemObj.item_type : undefined;
    if (itemType === undefined) {
      return [{ type: "status", at, message: "unknown codex item type" }];
    }

    if (type === "item.started") {
      if (itemType === "command_execution" && typeof itemObj.command === "string") {
        return [{ type: "status", at, message: `executing: ${itemObj.command}` }];
      }
      if (itemType === "mcp_tool_call" && typeof itemObj.server === "string" && typeof itemObj.tool === "string") {
        return [{ type: "status", at, message: `tool: ${itemObj.server}/${itemObj.tool}` }];
      }
      if (itemType === "todo_list") return [{ type: "status", at, message: "todo list updated" }];
      return [{ type: "status", at, message: `item ${itemType} started` }];
    }

    if (type === "item.updated") {
      return [{ type: "status", at, message: `item ${itemType} updated` }];
    }

    // item.completed
    if (itemType === "agent_message" || itemType === "assistant_message" || itemType === "reasoning") {
      const text = typeof itemObj.text === "string" ? itemObj.text : "";
      return text.length > 0 ? [{ type: "output", at, output: text }] : [];
    }

    if (itemType === "command_execution") {
      const output = typeof itemObj.aggregated_output === "string" ? itemObj.aggregated_output : "";
      const status = itemObj.status;
      const command = typeof itemObj.command === "string" ? itemObj.command : "";
      const events: ExternalAgentEvent[] = [];
      if (command) events.push({ type: "status", at, message: `executed: ${command}` });
      if (output.length > 0) events.push({ type: "output", at, output });
      if (status === "failed") {
        events.push({ type: "status", at, message: `command failed: ${command}` });
      }
      return events;
    }

    if (itemType === "file_change") {
      const changes = Array.isArray(itemObj.changes) ? itemObj.changes : [];
      const paths = changes
        .map((c: unknown) => {
          if (c && typeof c === "object") return (c as Record<string, unknown>).path;
          return undefined;
        })
        .filter((p): p is string => typeof p === "string")
        .join(", ");
      return [{ type: "status", at, message: `file change: ${paths || "unknown"}` }];
    }

    if (itemType === "mcp_tool_call") {
      const server = typeof itemObj.server === "string" ? itemObj.server : "";
      const tool = typeof itemObj.tool === "string" ? itemObj.tool : "";
      const result = itemObj.result;
      let resultText = "";
      if (result && typeof result === "object") {
        const content = (result as Record<string, unknown>).content;
        if (Array.isArray(content)) {
          resultText = content
            .map((block: unknown) => {
              if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
                return String((block as Record<string, unknown>).text || "");
              }
              return "";
            })
            .join("");
        }
      }
      const events: ExternalAgentEvent[] = [{ type: "status", at, message: `tool: ${server}/${tool}` }];
      if (resultText.length > 0) events.push({ type: "output", at, output: resultText });
      if (itemObj.status === "failed") {
        const error = itemObj.error && typeof (itemObj.error as Record<string, unknown>).message === "string"
          ? (itemObj.error as Record<string, unknown>).message as string
          : `tool failed: ${server}/${tool}`;
        events.push({ type: "status", at, message: `tool failed: ${server}/${tool}: ${error}` });
      }
      return events;
    }

    if (itemType === "web_search") {
      const query = typeof itemObj.query === "string" ? itemObj.query : "";
      return [{ type: "status", at, message: `web search: ${query || "unknown"}` }];
    }

    if (itemType === "todo_list") {
      return [{ type: "status", at, message: "todo list completed" }];
    }

    if (itemType === "error") {
      const message = typeof itemObj.message === "string" ? itemObj.message : "item error";
      return [{ type: "status", at, message: `item error: ${message}` }];
    }

    return [{ type: "status", at, message: `item ${itemType} completed` }];
  }

  return [{ type: "status", at, message: `unknown codex event type: ${type}` }];
}

function extractError(error: unknown): string {
  if (error === null || error === undefined) return "codex turn failed";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string") return code;
    return JSON.stringify(error);
  }
  return String(error);
}
