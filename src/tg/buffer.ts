import type { Bot } from "grammy";
import type { TurnCallbacks } from "../agent/mod.ts";
import { log } from "../log.ts";

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
  /** Clock injection for deterministic throttle tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Approximate min ms between status edits. Defaults to 1000. */
  statusThrottleMs?: number;
  /** Approximate min ms between response edits (~5/sec). Defaults to 200. */
  responseThrottleMs?: number;
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

  private now: () => number;
  private statusThrottleMs: number;
  private responseThrottleMs: number;
  private lastResponseEditTime: number = 0;

  constructor(bot: Bot, chatId: number, options: MessageBufferOptions = {}) {
    this.bot = bot;
    this.chatId = chatId;
    this.visibility = options.visibility ?? "standard";
    this.now = options.now ?? Date.now;
    this.statusThrottleMs = options.statusThrottleMs ?? 1000;
    this.responseThrottleMs = options.responseThrottleMs ?? 200;
  }

  onTextDelta(delta: string): void {
    this.accumulatedText += delta;
    this.isStreaming = true;
    void this.flushStatus();
    void this.flushResponse();
  }

  onToolStart(name: string, _input: unknown): void {
    this.toolStates.set(name, "running");
    void this.flushStatus();
  }

  onToolEnd(name: string, isError: boolean): void {
    this.toolStates.set(name, isError ? "error" : "success");
    void this.flushStatus();
  }

  onStatusUpdate(_message: string): void {
    // Reserved for agent status hints (e.g. "thinking...").
  }

  onAgentEnd(): void {
    this.isStreaming = false;
    // force=true bypasses the throttle so the final state always lands.
    void this.flushStatus(true);
    void this.flushResponse(true);
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
   * Flush the rendered status line to Telegram. Internal but exposed for
   * tests. `force` bypasses the ~1/sec throttle (used by `onAgentEnd`).
   *
   * Behavior:
   *   - First call: `sendMessage` and remember `statusMessageId`.
   *   - Subsequent calls: `editMessageText` against `statusMessageId`.
   *   - Throttled: skip if last edit was less than `statusThrottleMs` ago.
   *   - 429 rate-limit: log and skip; throttle window already prevents
   *     re-attempts in tight loops.
   *   - Message-gone (400): drop `statusMessageId` so the next flush re-sends.
   *   - All errors are swallowed; we never throw out of this method.
   */
  async flushStatus(force: boolean = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastEditTime < this.statusThrottleMs) return;

    const text = this.buildStatusLine();
    if (!text) return;

    // Set the throttle window before awaiting so concurrent events coalesce.
    this.lastEditTime = now;

    try {
      if (this.statusMessageId === undefined) {
        const msg = await this.bot.api.sendMessage(this.chatId, text);
        this.statusMessageId = msg.message_id;
      } else {
        await this.bot.api.editMessageText(
          this.chatId,
          this.statusMessageId,
          text,
        );
      }
    } catch (err) {
      this.handleStatusError(err);
    }
  }

  private handleStatusError(err: unknown): void {
    this.handleApiError(err, "status", () => {
      this.statusMessageId = undefined;
    });
  }

  /**
   * Flush accumulated response text to Telegram. Phase 4 implements basic
   * streaming with a ~5/sec throttle. Phase 5 will add 4096 rollover; phase
   * 6 will add 20KB file escape.
   */
  async flushResponse(force: boolean = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastResponseEditTime < this.responseThrottleMs)
      return;

    if (this.accumulatedText.length === 0) return;

    this.lastResponseEditTime = now;

    try {
      if (this.responseMessageId === undefined) {
        const msg = await this.bot.api.sendMessage(
          this.chatId,
          this.accumulatedText,
        );
        this.responseMessageId = msg.message_id;
      } else {
        await this.bot.api.editMessageText(
          this.chatId,
          this.responseMessageId,
          this.accumulatedText,
        );
      }
    } catch (err) {
      this.handleResponseError(err);
    }
  }

  private handleResponseError(err: unknown): void {
    this.handleApiError(err, "response", () => {
      this.responseMessageId = undefined;
    });
  }

  /**
   * Shared error policy for status and response flushes. 429 → log + skip;
   * 400 message-gone → reset id via `onMessageGone`; otherwise log.
   */
  private handleApiError(
    err: unknown,
    kind: "status" | "response",
    onMessageGone: () => void,
  ): void {
    const e = err as { error_code?: number; description?: string };
    const code = e?.error_code;
    const description = e?.description ?? String(err);

    if (code === 429) {
      log.warn(`${kind} edit rate-limited, skipping`, { description });
      return;
    }
    if (code === 400 && /not found|can't be edited|to edit/i.test(description)) {
      log.warn(`${kind} message gone, will re-create on next flush`, {
        description,
      });
      onMessageGone();
      return;
    }
    log.warn(`${kind} flush failed`, { description });
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
      lastResponseEditTime: this.lastResponseEditTime,
      isStreaming: this.isStreaming,
    };
  }
}
