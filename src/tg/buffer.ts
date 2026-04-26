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

/** Telegram's hard message length limit. */
export const MAX_MESSAGE_LEN = 4096;

/**
 * Pick a split index <= `maxLen` that does not cut a UTF-16 surrogate pair.
 * If the character at `maxLen - 1` is a high surrogate, the matching low
 * surrogate sits at `maxLen`; backing up by one keeps the pair intact.
 */
export function findSafeSplit(text: string, maxLen: number): number {
  if (text.length <= maxLen) return text.length;
  const codeAtCut = text.charCodeAt(maxLen - 1);
  if (codeAtCut >= 0xd800 && codeAtCut <= 0xdbff) {
    return maxLen - 1;
  }
  return maxLen;
}

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
   * Flush accumulated response text to Telegram. Implements ~5/sec
   * throttle, 4096 rollover (phase 5), and basic error recovery. Phase 6
   * will add 20KB file escape.
   */
  async flushResponse(force: boolean = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastResponseEditTime < this.responseThrottleMs)
      return;

    if (this.accumulatedText.length === 0) return;

    this.lastResponseEditTime = now;

    // Drain any overflow first; this may send/edit several messages.
    await this.maybeRollover();

    if (this.accumulatedText.length === 0) return;

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

  /**
   * Split `accumulatedText` across multiple Telegram messages whenever it
   * exceeds `MAX_MESSAGE_LEN`. The current `responseMessageId` is finalized
   * with the head (edit if it exists, send if it does not), then a fresh
   * tail becomes the new active message. Loops until the tail fits.
   *
   * Returns true if at least one rollover occurred.
   */
  private async maybeRollover(): Promise<boolean> {
    let rolled = false;
    while (this.accumulatedText.length > MAX_MESSAGE_LEN) {
      const splitAt = findSafeSplit(this.accumulatedText, MAX_MESSAGE_LEN);
      const head = this.accumulatedText.slice(0, splitAt);
      const tail = this.accumulatedText.slice(splitAt);
      try {
        if (this.responseMessageId !== undefined) {
          await this.bot.api.editMessageText(
            this.chatId,
            this.responseMessageId,
            head,
          );
        } else {
          await this.bot.api.sendMessage(this.chatId, head);
        }
        // The previous message is now "closed"; the tail starts a new one.
        this.responseMessageId = undefined;
        this.accumulatedText = tail;
        rolled = true;
      } catch (err) {
        this.handleResponseError(err);
        return rolled;
      }
    }
    return rolled;
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
