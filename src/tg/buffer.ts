import type { Bot } from "grammy";
import type { TurnCallbacks } from "../agent/mod.ts";

/**
 * MessageBuffer turns AgentSession events (via TurnCallbacks) into Telegram
 * UI: a coalesced status line message and a streamed response message.
 *
 * Phase 2: status line state machine. Tool activity accumulates in
 * `toolStates` (insertion order preserved) and renders to a single status
 * string. Real Telegram edits, throttling, response streaming, rollover,
 * and file escape land in later phases.
 */

export interface MessageBufferOptions {
  visibility?: string;
}

export type ToolState = "running" | "success" | "error";

const TOOL_STATE_EMOJI: Record<ToolState, string> = {
  running: "🔧",
  success: "✅",
  error: "❌",
};

export class MessageBuffer implements TurnCallbacks {
  private bot: Bot;
  private chatId: number;
  private visibility: string;

  // Internal state — populated in later phases.
  private statusMessageId: number | undefined = undefined;
  private responseMessageId: number | undefined = undefined;
  private accumulatedText: string = "";
  private toolStates: Map<string, ToolState> = new Map();
  private lastEditTime: number = 0;
  private isStreaming: boolean = false;

  constructor(bot: Bot, chatId: number, options: MessageBufferOptions = {}) {
    this.bot = bot;
    this.chatId = chatId;
    this.visibility = options.visibility ?? "standard";
  }

  onTextDelta(_text: string): void {
    // Phase 4 wires response streaming. Phase 2 sets the streaming flag so
    // the status line can show "✍️ composing" between tool calls.
    this.isStreaming = true;
  }

  onToolStart(name: string, _input: unknown): void {
    this.toolStates.set(name, "running");
  }

  onToolEnd(name: string, isError: boolean): void {
    this.toolStates.set(name, isError ? "error" : "success");
  }

  onStatusUpdate(_message: string): void {
    // Reserved for agent status hints (e.g. "thinking...").
  }

  onAgentEnd(): void {
    this.isStreaming = false;
    // Phase 3 wires the real flush; force=true bypasses the throttle.
    this.flushStatus(true);
  }

  /** Build the rendered status line, e.g. "✅ read 🔧 bash ✍️ composing". */
  buildStatusLine(): string {
    const parts: string[] = [];
    for (const [name, state] of this.toolStates) {
      parts.push(`${TOOL_STATE_EMOJI[state]} ${name}`);
    }
    const hasRunning = [...this.toolStates.values()].includes("running");
    if (this.isStreaming && !hasRunning) {
      parts.push("✍️ composing");
    }
    return parts.join(" ");
  }

  /**
   * Flush the status message to Telegram. Phase 2 stub — phase 3 wires
   * `bot.api.sendMessage`/`editMessageText` with throttle and error
   * recovery. `force` bypasses the throttle (set by `onAgentEnd`).
   */
  private flushStatus(_force: boolean = false): void {
    // Stubbed in phase 2; implemented in phase 3.
  }

  /** Internal accessors for tests — not part of the public API. */
  _state() {
    return {
      bot: this.bot,
      chatId: this.chatId,
      visibility: this.visibility,
      statusMessageId: this.statusMessageId,
      responseMessageId: this.responseMessageId,
      accumulatedText: this.accumulatedText,
      toolStates: this.toolStates,
      lastEditTime: this.lastEditTime,
      isStreaming: this.isStreaming,
    };
  }
}
