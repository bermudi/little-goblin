import { InputFile } from "grammy";
import type { Bot } from "grammy";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnCallbacks } from "../agent/mod.ts";
import { log } from "../log.ts";

/**
 * MessageBuffer turns AgentSession events (via TurnCallbacks) into Telegram
 * UI: a coalesced status line message and a streamed response message.
 *
 * Status line uses a three-phase state machine:
 *   thinking → working → done
 *
 * Each phase transition triggers at most one Telegram edit, regardless of
 * how many tools fired. The `✅` / `❌` decision in the Done phase is
 * driven by the cumulative `hadError` flag.
 */

export interface MessageBufferOptions {
  visibility?: string;
  /** Clock injection for deterministic throttle tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Approximate min ms between status edits. Defaults to 1000. */
  statusThrottleMs?: number;
  /** Approximate min ms between response edits (~5/sec). Defaults to 200. */
  responseThrottleMs?: number;
  /** Chat-action ("typing") refresh interval in ms. Defaults to 4000. */
  chatActionMs?: number;
  /** Scheduler injection for tests. Defaults to global `setInterval`. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  /** Scheduler injection for tests. Defaults to global `clearInterval`. */
  clearIntervalFn?: (handle: unknown) => void;
}

/** Coarse phase the status message reflects. */
export type StatusPhase = "thinking" | "working" | "done";

/** Telegram's hard message length limit. */
export const MAX_MESSAGE_LEN = 4096;

/**
 * Threshold above which response text is escaped to a `reply.md` attachment
 * instead of being split across multiple Telegram messages. Past ~5 messages
 * (5 * 4096 = 20480) readability suffers; files are friendlier.
 */
export const BIG_OUTPUT_THRESHOLD = 20000;

/** Number of characters from the head of the response shown alongside the file. */
export const SUMMARY_PREFIX_LEN = 500;

/**
 * Tool visibility levels and the tool names each level surfaces in the
 * status line. Unknown levels fall back to `standard`. The string "*"
 * means "every tool" (debug).
 *
 *   none     no status line at all
 *   minimal  destructive / state-changing tools only
 *   standard all α tools (default)
 *   verbose  α + γ (subagent management)
 *   debug    every tool ever observed
 */
export const VISIBILITY_TOOLS: Record<string, readonly string[] | "*"> = {
  none: [],
  minimal: ["bash", "write", "edit", "spawn_subagent"],
  standard: ["bash", "write", "edit", "read", "grep", "spawn_subagent"],
  verbose: [
    "bash",
    "write",
    "edit",
    "read",
    "grep",
    "spawn_subagent",
    "revive_subagent",
    "list_subagents",
  ],
  debug: "*",
};

/** Default visibility when no level is configured or an unknown level is given. */
export const DEFAULT_VISIBILITY = "standard";

/**
 * Returns true if the given tool should appear in the status line for the
 * given visibility level. Unknown levels fall back to `DEFAULT_VISIBILITY`.
 */
export function shouldShowTool(name: string, visibility: string): boolean {
  const list =
    VISIBILITY_TOOLS[visibility] ?? VISIBILITY_TOOLS[DEFAULT_VISIBILITY]!;
  if (list === "*") return true;
  return list.includes(name);
}

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

  // Telegram message tracking.
  private statusMessageId: number | undefined = undefined;
  private responseMessageId: number | undefined = undefined;
  private accumulatedText: string = "";
  private lastEditTime: number = 0;
  private isStreaming: boolean = false;

  // Status phase state machine.
  private phase: StatusPhase = "thinking";
  /** Visible tool names in the order they were first observed this turn. */
  private toolsObserved: string[] = [];
  /** Visible tools currently running (not yet ended). */
  private toolsRunning: Set<string> = new Set();
  /** Set true if any tool ended with `isError === true`. */
  private hadError: boolean = false;
  /** Once true, `flushStatus` becomes a no-op (set on `onAgentEnd`). */
  private statusFrozen: boolean = false;
  /** Tracks whether the eager placeholder has been emitted. */
  private placeholderSent: boolean = false;

  private now: () => number;
  private statusThrottleMs: number;
  private responseThrottleMs: number;
  private lastResponseEditTime: number = 0;

  private chatActionMs: number;
  private setIntervalFn: (fn: () => void, ms: number) => unknown;
  private clearIntervalFn: (handle: unknown) => void;
  private chatActionHandle: unknown = undefined;

  /**
   * Promise tracking an in-flight `sendMessage` that is creating the response
   * message. Any concurrent flush whose throttle window opens before the send
   * resolves would otherwise see `responseMessageId === undefined` and call
   * `sendMessage` a second time — producing duplicate Telegram messages.
   * Non-force flushes skip when this is set; force flushes await it.
   */
  private creatingResponse: Promise<void> | null = null;

  constructor(bot: Bot, chatId: number, options: MessageBufferOptions = {}) {
    this.bot = bot;
    this.chatId = chatId;
    this.visibility = options.visibility ?? DEFAULT_VISIBILITY;
    this.now = options.now ?? Date.now;
    this.statusThrottleMs = options.statusThrottleMs ?? 1000;
    this.responseThrottleMs = options.responseThrottleMs ?? 200;
    this.chatActionMs = options.chatActionMs ?? 4000;
    this.setIntervalFn =
      options.setIntervalFn ??
      ((fn, ms) => setInterval(fn, ms) as unknown);
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
  }

  onTextDelta(delta: string): void {
    this.accumulatedText += delta;
    this.isStreaming = true;
    this.startChatAction();
    void this.flushStatus();
    void this.flushResponse();
  }

  onToolStart(name: string, _input: unknown): void {
    if (!shouldShowTool(name, this.visibility)) return;
    if (!this.toolsObserved.includes(name)) this.toolsObserved.push(name);
    this.toolsRunning.add(name);
    // Phase transition + flush wiring lands in phase 2.
  }

  onToolEnd(name: string, isError: boolean): void {
    if (!shouldShowTool(name, this.visibility)) return;
    this.toolsRunning.delete(name);
    if (isError) this.hadError = true;
    // Phase transition + flush wiring lands in phase 2.
  }

  onStatusUpdate(_message: string): void {
    // Reserved for agent status hints (e.g. "thinking...").
  }

  onAgentEnd(): void {
    this.isStreaming = false;
    this.stopChatAction();
    // force=true bypasses the throttle so the final state always lands.
    void this.flushStatus(true);
    void this.flushResponse(true);
  }

  /**
   * Begin (or no-op if already running) the periodic "typing" chat-action
   * refresh. Telegram shows the indicator for ~5s after each call, so we
   * refresh every 4s while the agent is producing text. The first call
   * fires immediately so the indicator appears without waiting one tick.
   */
  private startChatAction(): void {
    if (this.chatActionHandle !== undefined) return;
    this.sendChatActionSafe();
    this.chatActionHandle = this.setIntervalFn(
      () => this.sendChatActionSafe(),
      this.chatActionMs,
    );
  }

  /** Stop the periodic chat-action refresh. Idempotent. */
  private stopChatAction(): void {
    if (this.chatActionHandle === undefined) return;
    this.clearIntervalFn(this.chatActionHandle);
    this.chatActionHandle = undefined;
  }

  /** Best-effort `sendChatAction("typing")`; never throws out. */
  private sendChatActionSafe(): void {
    Promise.resolve(this.bot.api.sendChatAction(this.chatId, "typing")).catch(
      (err: unknown) => {
        log.warn("sendChatAction failed", { error: String(err) });
      },
    );
  }

  /**
   * Build the rendered status line based on the current phase.
   *
   *   thinking  → "🤔 thinking…"
   *   working   → "🔧 working: <comma-joined visible tools>"
   *   done      → "✅ <names>"  or  "❌ <names>"  (per `hadError`)
   *
   * Visibility "none" suppresses the line entirely. The `✍️ composing`
   * indicator was removed: liveness is conveyed by `chat_action("typing")`.
   */
  buildStatusLine(): string {
    if (this.visibility === "none") return "";
    if (this.phase === "thinking") return "🤔 thinking…";
    if (this.phase === "working") {
      const names = this.toolsObserved.join(", ");
      return names.length > 0 ? `🔧 working: ${names}` : "🔧 working…";
    }
    // done
    const names = this.toolsObserved.join(", ");
    if (names.length === 0) return "";
    return `${this.hadError ? "❌" : "✅"} ${names}`;
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

    // Coalesce concurrent sends. If the response message is being created by
    // an earlier flush, a non-force flush skips (the next throttle tick will
    // edit, by which time `responseMessageId` is set). A force flush — used
    // by `onAgentEnd` to land the final state — must wait, otherwise it
    // would see `responseMessageId === undefined` and issue a duplicate
    // `sendMessage`. See test "does not duplicate-send when sendMessage is
    // slower than the throttle window".
    if (this.responseMessageId === undefined && this.creatingResponse) {
      if (!force) return;
      await this.creatingResponse;
    }

    this.lastResponseEditTime = now;

    // Big output? Escape to file before doing anything else; we do not want
    // to spam many rollover messages for a 50KB code dump.
    if (await this.maybeFileEscape()) return;

    // Drain any overflow first; this may send/edit several messages.
    await this.maybeRollover();

    if (this.accumulatedText.length === 0) return;

    try {
      if (this.responseMessageId === undefined) {
        // Publish the in-flight promise BEFORE awaiting so concurrent flushes
        // can observe it and skip/wait. Clear it after the send resolves
        // (success or failure), regardless of which branch handled the error.
        const inFlight = (async () => {
          try {
            const msg = await this.bot.api.sendMessage(
              this.chatId,
              this.accumulatedText,
            );
            this.responseMessageId = msg.message_id;
          } catch (err) {
            this.handleResponseError(err);
          }
        })();
        this.creatingResponse = inFlight;
        try {
          await inFlight;
        } finally {
          if (this.creatingResponse === inFlight) {
            this.creatingResponse = null;
          }
        }
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
   * If `accumulatedText` exceeds `BIG_OUTPUT_THRESHOLD`, write it to a temp
   * file, upload it as `reply.md`, and send a short summary text. Resets
   * the response state in either success or failure so the buffer does not
   * keep retrying with the same huge payload.
   *
   * Returns true if the escape was triggered (regardless of API success).
   */
  private async maybeFileEscape(): Promise<boolean> {
    if (this.accumulatedText.length <= BIG_OUTPUT_THRESHOLD) return false;

    const text = this.accumulatedText;
    const summary =
      text.slice(0, SUMMARY_PREFIX_LEN) +
      "... [truncated, see attached reply.md]";
    const tmpName = `goblin-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
    const tmpPath = join(tmpdir(), tmpName);

    let wrote = false;
    try {
      await writeFile(tmpPath, text, "utf-8");
      wrote = true;
      await this.bot.api.sendDocument(
        this.chatId,
        new InputFile(tmpPath, "reply.md"),
      );
      await this.bot.api.sendMessage(this.chatId, summary);
    } catch (err) {
      this.handleResponseError(err);
    } finally {
      if (wrote) await unlink(tmpPath).catch(() => {});
    }

    // The active in-memory text has been "spent" — clear regardless of
    // outcome so we do not loop trying to upload it again.
    this.accumulatedText = "";
    this.responseMessageId = undefined;
    return true;
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
      phase: this.phase,
      toolsObserved: this.toolsObserved,
      toolsRunning: this.toolsRunning,
      hadError: this.hadError,
      statusFrozen: this.statusFrozen,
      placeholderSent: this.placeholderSent,
      /**
       * Legacy field kept solely so the still-unmigrated test suite
       * compiles between phases 1 and 3. Always empty; not used by
       * production code. Removed when tests are rewritten in phase 3.
       */
      toolStates: new Map<string, "running" | "success" | "error">(),
      lastEditTime: this.lastEditTime,
      lastResponseEditTime: this.lastResponseEditTime,
      isStreaming: this.isStreaming,
      chatActionHandle: this.chatActionHandle,
    };
  }
}
