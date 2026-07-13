import type { AdapterStartInput, ExternalAgentBackend, ExternalAgentEvent, ExternalAgentHandle, ProcessExit } from "./types.ts";
import { InteractiveRequiredError } from "./types.ts";
import { nowIso } from "./util.ts";

export class ClaudeAdapter {
  readonly backend: ExternalAgentBackend = "claude";

  async start(
    input: AdapterStartInput,
    emit: (event: ExternalAgentEvent) => void,
  ): Promise<ExternalAgentHandle> {
    const profile = input.permissionProfile === "workspace-write" ? "acceptEdits" : "plan";
    const command = [
      "claude",
      "-p",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--permission-mode",
      profile,
    ];

    emit({ type: "status", at: nowIso(), message: `claude -p: ${command.join(" ")}` });

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

    const state: ClaudeState = { assistantText: "" };
    let hasOutput = false;
    let workStarted = false;

    void (async () => {
      try {
        for await (const line of process.readLines()) {
          const events = parseClaudeLine(line, state);
          for (const event of events) {
            if (event.type === "output" && event.output && hasOutput) {
              continue;
            }
            if (event.type === "output" && event.output) {
              hasOutput = true;
            }
            if (event.type === "status" && event.message) {
              if (event.message.startsWith("tool:")) {
                workStarted = true;
              }
            }
            if (event.type === "failed" && !workStarted && !hasOutput && isInteractiveError(event.error)) {
              rejectExit(new InteractiveRequiredError("claude", event.error ?? "interactive mode required"));
              return;
            }
            emit(event);
          }
        }

        const exit = await process.waitForExit();

        const stderr = process.getStderr();
        if (isInteractiveError(stderr) && !workStarted && !hasOutput) {
          rejectExit(new InteractiveRequiredError("claude", stderr || "interactive mode required"));
          return;
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
    lower.includes("permission") ||
    lower.includes("approval") ||
    lower.includes("trust")
  );
}

interface ClaudeState {
  assistantText: string;
}

function parseClaudeLine(line: string, state: ClaudeState): ExternalAgentEvent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return [{ type: "status", at: nowIso(), message: `malformed stream-json line` }];
  }
  if (raw === null || typeof raw !== "object") {
    return [{ type: "status", at: nowIso(), message: "non-object stream-json line" }];
  }

  const obj = raw as Record<string, unknown>;
  const at = nowIso();
  const type = obj.type;
  if (typeof type !== "string") return [];

  switch (type) {
    case "system": {
      const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
      if (subtype === "api_retry") {
        const error = typeof obj.error === "string" ? obj.error : "api retry";
        return [{ type: "status", at, message: `api retry: ${error}` }];
      }
      return [{ type: "status", at, message: `system: ${subtype}` }];
    }
    case "rate_limit_event":
      return [];
    case "assistant": {
      const message = extractMessage(obj.message);
      const events: ExternalAgentEvent[] = [];
      if (message.text.length > 0) {
        state.assistantText = message.text;
      }
      for (const tool of message.tools) {
        events.push({ type: "status", at, message: `tool: ${tool}` });
      }
      return events;
    }
    case "user": {
      const message = extractMessage(obj.message);
      const events: ExternalAgentEvent[] = [];
      if (message.text.length > 0) {
        events.push({ type: "status", at, message: `tool result: ${message.text}` });
      }
      for (const tool of message.tools) {
        events.push({ type: "status", at, message: `tool: ${tool}` });
      }
      return events;
    }
    case "stream_event": {
      const eventObj = obj.event;
      if (eventObj === null || typeof eventObj !== "object") return [];
      const event = eventObj as Record<string, unknown>;
      const eventType = typeof event.type === "string" ? event.type : "";
      if (eventType === "content_block_delta") {
        const delta = event.delta;
        if (delta && typeof delta === "object") {
          const deltaObj = delta as Record<string, unknown>;
          if (deltaObj.type === "text_delta" && typeof deltaObj.text === "string") {
            state.assistantText = (state.assistantText || "") + deltaObj.text;
            return [];
          }
          if (deltaObj.type === "input_json_delta" && typeof deltaObj.partial_json === "string") {
            return [{ type: "status", at, message: `tool input: ${deltaObj.partial_json}` }];
          }
        }
      }
      if (eventType === "content_block_start") {
        const contentBlock = event.content_block;
        if (contentBlock && typeof contentBlock === "object") {
          const block = contentBlock as Record<string, unknown>;
          if (block.type === "tool_use" && typeof block.name === "string") {
            return [{ type: "status", at, message: `tool: ${block.name}` }];
          }
        }
      }
      return [];
    }
    case "result": {
      const isError = obj.is_error === true;
      const result = typeof obj.result === "string" ? obj.result : "";
      const error = typeof obj.error === "string" ? obj.error : result || "claude error";
      if (isError) {
        return [{ type: "failed", at, error }];
      }
      const events: ExternalAgentEvent[] = [];
      const output = result.length > 0 ? result : state.assistantText;
      if (output.length > 0) {
        events.push({ type: "output", at, output });
      }
      events.push({ type: "completed", at });
      return events;
    }
    default:
      return [{ type: "status", at, message: `claude event: ${type}` }];
  }
}

function extractMessage(message: unknown): { text: string; tools: string[] } {
  if (message === null || typeof message !== "object") {
    return { text: "", tools: [] };
  }
  const msg = message as Record<string, unknown>;
  const content = msg.content;
  if (!Array.isArray(content)) {
    return { text: "", tools: [] };
  }

  const textParts: string[] = [];
  const tools: string[] = [];

  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const blockObj = block as Record<string, unknown>;
    if (blockObj.type === "text" && typeof blockObj.text === "string") {
      textParts.push(blockObj.text);
    } else if (blockObj.type === "tool_use" && typeof blockObj.name === "string") {
      tools.push(blockObj.name);
    } else if (blockObj.type === "tool_result") {
      const toolResult = blockObj.content;
      if (typeof toolResult === "string") {
        textParts.push(toolResult);
      } else if (Array.isArray(toolResult)) {
        for (const inner of toolResult) {
          if (inner === null || typeof inner !== "object") continue;
          const innerObj = inner as Record<string, unknown>;
          if (innerObj.type === "text" && typeof innerObj.text === "string") {
            textParts.push(innerObj.text);
          }
        }
      }
    }
  }

  return { text: textParts.join(""), tools };
}
