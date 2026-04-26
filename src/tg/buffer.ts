import type { Bot } from "grammy";
import type { TurnCallbacks } from "../agent/mod.ts";

/**
 * MessageBuffer turns AgentSession events (via TurnCallbacks) into Telegram
 * UI: a coalesced status line message and a streamed response message.
 *
 * Phase 1: skeleton only — state fields tracked, callbacks stubbed. Later
 * phases wire in the state machine, edits, throttling, rollover, and file
 * escape.
 */

export interface MessageBufferOptions {
  visibility?: string;
}

export type ToolState = "running" | "success" | "error";

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
    // stubbed in phase 1
  }

  onToolStart(_name: string, _input: unknown): void {
    // stubbed in phase 1
  }

  onToolEnd(_name: string, _result: unknown): void {
    // stubbed in phase 1
  }

  onStatusUpdate(_message: string): void {
    // stubbed in phase 1
  }

  onAgentEnd(): void {
    // stubbed in phase 1
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
