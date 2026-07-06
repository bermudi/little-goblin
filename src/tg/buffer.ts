import { InputFile } from "grammy";
import type { Bot } from "grammy";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnCallbacks } from "../agent/mod.ts";
import { log } from "../log.ts";
import { stripMdV2, isParseError } from "./format.ts";

/**
 * MessageBuffer turns AgentSession events (via TurnCallbacks) into Telegram
 * UI: a coalesced status line message and a streamed response message.
 *
 * Status line uses an ordered per-tool slot model:
 *   Line 1: "🤔 thinking…" (header, persists for the whole turn)
 *   Lines 2+: one slot per visible tool, in observation order
 * Each slot transitions independently: 🔧 → ✅ / ❌.
 */

export interface MessageBufferOptions {
  visibility?: string;
  /** Clock injection for deterministic throttle tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Approximate min ms between status edits. Defaults to 1100. */
  statusThrottleMs?: number;
  /**
   * Approximate min ms between response edits. Defaults to 1100.
   *
   * Telegram's per-chat write/edit budget is ~1/sec sustained. Going
   * faster (e.g. the old 200ms / 5-per-sec default) earns 429s with
   * `retry_after` of 20+ seconds, which then stalls the whole stream.
   */
  responseThrottleMs?: number;
  /** Chat-action ("typing") refresh interval in ms. Defaults to 4000. */
  chatActionMs?: number;
  /** Scheduler injection for tests. Defaults to global `setInterval`. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  /** Scheduler injection for tests. Defaults to global `clearInterval`. */
  clearIntervalFn?: (handle: unknown) => void;
  /**
   * Called once when a "topic not found" error is detected from Telegram.
   * Used to archive orphaned topic memory scopes.
   */
  onTopicNotFound?: () => void | Promise<void>;
  /** Called once after the turn's final status and response flushes. */
  onTurnEnd?: () => void | Promise<void>;
}

/** Per-tool slot tracking running/completed invocations and error state. */
export interface ToolSlot {
  /** Active concurrent invocations. Effective state is `running` while > 0. */
  runningCount: number;
  /** Total finished invocations (ok or err). */
  completedCount: number;
  /** Start time of the most recent `onToolStart` for this slot. */
  startedAt: number;
  /** End time of the most recent `onToolEnd` for this slot. */
  endedAt?: number;
  /** Outcome of the most recent completed invocation. */
  lastCompletedError: boolean;
}

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
  standard: ["bash", "write", "edit", "read", "grep", "spawn_subagent", "text_to_speech"],
  verbose: [
    "bash",
    "write",
    "edit",
    "read",
    "grep",
    "spawn_subagent",
    "text_to_speech",
    "revive_subagent",
    "list_subagents",
  ],
  debug: "*",
};

/** Default visibility when no level is configured or an unknown level is given. */
export const DEFAULT_VISIBILITY = "standard";

/**
 * Per-visibility slot cap and timing flags. Every level present in
 * `VISIBILITY_TOOLS` must have a matching entry here; a parity test
 * enforces this.
 */
export const VISIBILITY_LIMITS: Record<string, { cap: number; timing: boolean }> = {
  none:     { cap: 0,  timing: false },
  minimal:  { cap: 8,  timing: false },
  standard: { cap: 12, timing: false },
  verbose:  { cap: 20, timing: true },
  debug:    { cap: 25, timing: true },
};

/** Resolve the active level's limits, falling back to `DEFAULT_VISIBILITY`. */
export function getVisibilityLimits(visibility: string): { cap: number; timing: boolean } {
  return VISIBILITY_LIMITS[visibility] ?? VISIBILITY_LIMITS[DEFAULT_VISIBILITY]!;
}

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

/**
 * Adjust a rollover split point so it does not break an inline code span.
 * Counts unescaped backticks (`` ` ``) in `text[0..splitAt]`; if the count
 * is odd, the head would open a span that never closes. Moves the split
 * backward to just before the last backtick so the head is self-contained.
 * A backtick preceded by `\` is escaped and skipped.
 */
export function adjustForCodeSpan(text: string, splitAt: number): number {
  let count = 0;
  let lastBacktick = -1;
  for (let i = 0; i < splitAt; i++) {
    if (text[i] === "`" && text[i - 1] !== "\\") {
      count++;
      lastBacktick = i;
    }
  }
  if (count % 2 === 1 && lastBacktick > 0) {
    return lastBacktick;
  }
  return splitAt;
}

export class MessageBuffer implements TurnCallbacks {
  private bot: Bot;
  private chatId: number;
  private topicId: number | undefined;
  private visibility: string;

  // Telegram message tracking.
  private statusMessageId: number | undefined = undefined;
  private responseMessageId: number | undefined = undefined;
  private accumulatedText: string = "";
  private lastEditTime: number = 0;
  private isStreaming: boolean = false;

  // Per-tool slot state. Ordered by first observation (Map insertion order).
  private slots: Map<string, ToolSlot> = new Map();
  /** Once true, `flushStatus` becomes a no-op (set on `onAgentEnd`). */
  private statusFrozen: boolean = false;
  /** Tracks whether the eager placeholder has been emitted. */
  private placeholderSent: boolean = false;
  /**
   * The rendered status text most recently committed to Telegram (or
   * attempted, in the success path). Used to suppress no-op edits when
   * the same text would be rewritten — Telegram rejects identical edits
   * with a 400, and the user-visible chat doesn't change anyway. Also
   * caps the typical turn at 3 writes (placeholder + working + done).
   */
  private lastRenderedStatusText: string = "";
  /**
   * Mirror of `lastRenderedStatusText` for the response message. Suppresses
   * no-op `editMessageText` calls when the throttle re-fires with no new
   * text (e.g. a force-flush at `onAgentEnd` after the last delta already
   * landed). Telegram would otherwise return 400 "message is not modified".
   * Reset to "" whenever the response message is recreated or goes away.
   */
  private lastRenderedResponseText: string = "";
  /**
   * Sticky flag: once a MarkdownV2 parse error forces a plain-text retry,
   * subsequent response sends/edits skip `parse_mode` for the rest of the
   * current response message's lifetime. Reset whenever `responseMessageId`
   * is cleared (tool boundary seal, rollover, file escape).
   */
  private responseIsPlainText: boolean = false;

  private now: () => number;
  private statusThrottleMs: number;
  private responseThrottleMs: number;
  private lastResponseEditTime: number = 0;

  private chatActionMs: number;
  private setIntervalFn: (fn: () => void, ms: number) => unknown;
  private clearIntervalFn: (handle: unknown) => void;
  private chatActionHandle: unknown = undefined;

  /** Called once when a "topic not found" error is detected. */
  private onTopicNotFound: (() => void | Promise<void>) | undefined;
  /** Called once after the turn's final status and response flushes. */
  private onTurnEnd: (() => void | Promise<void>) | undefined;
  /** Ensures onTopicNotFound is only called once. */
  private topicNotFoundReported: boolean = false;

  /**
   * Promise tracking an in-flight `sendMessage` that is creating the response
   * message. Any concurrent flush whose throttle window opens before the send
   * resolves would otherwise see `responseMessageId === undefined` and call
   * `sendMessage` a second time — producing duplicate Telegram messages.
   * Non-force flushes skip when this is set; force flushes await it.
   */
  private creatingResponse: Promise<void> | null = null;

  /**
   * Promise tracking an in-flight status edit (send or edit). Concurrent
   * status events (e.g. four sequential `onToolStart` in rapid succession)
   * all see the in-flight promise and bail; the loop inside the in-flight
   * promise re-renders `buildStatusLine()` after each round-trip and picks
   * up whatever state mutated during the wait. This collapses N events
   * into ≤2 Telegram round-trips per turn.
   */
  private editingStatus: Promise<void> | null = null;

  /**
   * Promise tracking an in-flight `editMessageText` against the response
   * message. Telegram does NOT guarantee ordering across concurrent edits
   * to the same message: a later-issued edit can land first and a stale
   * earlier edit overwrite it. Without serialization, the final text the
   * user sees can be a partial mid-stream snapshot. New flushes await this
   * (force=true) or skip (non-force, the natural throttle picks it up
   * later). The agent_end force flush therefore always lands LAST, with
   * the full accumulated text.
   */
  private editingResponse: Promise<void> | null = null;

  /**
   * Promise tracking the whole response flush, including 4096 rollover.
   * Rollover mutates `accumulatedText` and `responseMessageId` across multiple
   * Telegram calls, so serializing only send/edit is insufficient: a concurrent
   * force flush can observe the half-rolled state and duplicate the tail bubble.
   */
  private flushingResponse: Promise<void> | null = null;

  constructor(bot: Bot, chatId: number, topicId: number | undefined, options: MessageBufferOptions = {}) {
    this.bot = bot;
    this.chatId = chatId;
    this.topicId = topicId;
    this.visibility = options.visibility ?? DEFAULT_VISIBILITY;
    this.now = options.now ?? Date.now;
    this.statusThrottleMs = options.statusThrottleMs ?? 1100;
    this.responseThrottleMs = options.responseThrottleMs ?? 1100;
    this.chatActionMs = options.chatActionMs ?? 4000;
    this.setIntervalFn =
      options.setIntervalFn ??
      ((fn, ms) => setInterval(fn, ms) as unknown);
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
    this.onTopicNotFound = options.onTopicNotFound;
    this.onTurnEnd = options.onTurnEnd;
  }

  onTextDelta(delta: string): void {
    const prevLen = this.accumulatedText.length;
    this.accumulatedText += delta;
    this.isStreaming = true;
    this.startChatAction();
    // No status flush per delta — the phase machine only edits the status
    // on phase transitions (thinking tokens → onStatusUpdate, tools →
    // onToolStart/onToolEnd). Liveness is conveyed by the chat-action above.
    log.debug("response: delta", {
      deltaLen: delta.length,
      accLen: this.accumulatedText.length,
      accGrow: prevLen === 0,
      msgId: this.responseMessageId,
    });
    void this.flushResponse();
  }

  onToolStart(name: string, _input: unknown): void {
    // Force-flush any accumulated response text before the tool runs,
    // regardless of whether this tool is visible in the status line.
    // Without this, text that arrived after the last throttle window
    // sits invisible in accumulatedText for the entire tool execution,
    // so the user sees a truncated prefix (e.g. "Let" instead of
    // "Let me check the pi docs...").
    if (this.accumulatedText.length > 0) {
      log.debug("response: seal segment before tool", {
        tool: name,
        accLen: this.accumulatedText.length,
        msgId: this.responseMessageId,
      });
      // Seal the current response segment: force-flush so the just-completed
      // text lands in its bubble, then clear response state so the next text
      // delta after the tool creates a fresh bubble. The snapshot guard
      // prevents losing text if a delta sneaks in during the in-flight flush
      // (not expected — LLM tool calls don't interleave with text — but
      // cheap defense). See spec: "Response message segments at tool
      // boundaries" in canon/message-buffer.
      const sealedTextSnapshot = this.accumulatedText;
      const sealedMsgIdSnapshot = this.responseMessageId;
      void (async () => {
        await this.flushResponse(true);
        // Guard: skip cleanup only if text changed WITHOUT a message id change.
        // This happens when a concurrent text delta arrived during the flush.
        // Rollover changes BOTH text (head removed) AND msgId (undefined→new),
        // so we DO cleanup after rollover — the tail message was already sent.
        const textChanged = this.accumulatedText !== sealedTextSnapshot;
        const msgIdChanged = this.responseMessageId !== sealedMsgIdSnapshot;
        if (textChanged && !msgIdChanged) {
          return;
        }
        this.responseMessageId = undefined;
        this.accumulatedText = "";
        this.lastRenderedResponseText = "";
        this.responseIsPlainText = false;
      })();
    }

    if (!shouldShowTool(name, this.visibility)) return;
    const existing = this.slots.get(name);
    if (existing) {
      existing.runningCount++;
      existing.startedAt = this.now();
      existing.endedAt = undefined;
    } else {
      this.slots.set(name, {
        runningCount: 1,
        completedCount: 0,
        startedAt: this.now(),
        endedAt: undefined,
        lastCompletedError: false,
      });
    }
    this.commitStatus();
  }

  onToolEnd(name: string, isError: boolean): void {
    if (!shouldShowTool(name, this.visibility)) return;
    const slot = this.slots.get(name);
    if (!slot) return;
    slot.runningCount--;
    slot.completedCount++;
    slot.endedAt = this.now();
    slot.lastCompletedError = isError;
    this.commitStatus();
  }

  onStatusUpdate(_message: string): void {
    // Fired by agent_start (turn start), thinking_start / thinking_delta,
    // and compaction. We use this as the cue to send the eager placeholder,
    // guaranteeing the status message exists before any response message
    // can be created. Starting the chat-action here (not just in
    // onTextDelta) means the typing indicator shows from turn start even
    // on plain-text turns where no thinking block arrives.
    this.startChatAction();
    if (!this.placeholderSent) this.commitStatus();
  }

  onAgentEnd(): void {
    this.isStreaming = false;
    this.stopChatAction();
    log.debug("response: agent_end", {
      accLen: this.accumulatedText.length,
      msgId: this.responseMessageId,
    });

    // Flush BEFORE freezing so this final write is the one that survives.
    // The `lastRenderedStatusText` guard inside flushStatus skips the
    // edit if Done was already committed by the last onToolEnd — keeping
    // typical turns at ≤3 writes per the spec.
    if (this.visibility !== "none" && this.buildStatusLine().length > 0) {
      this.placeholderSent = true;
      void this.flushStatus(true);
    }
    this.statusFrozen = true;
    void this.flushResponse(true);
    void Promise.resolve(this.onTurnEnd?.());
  }

  /**
   * Single entry point for any state-changing status flush: phase
   * transitions and eager placeholders. Marks the placeholder as sent (so
   * future entries don't re-trigger the eager path) and fires exactly one
   * `flushStatus(force=true)`. Visibility "none" suppresses everything.
   */
  private commitStatus(): void {
    if (this.visibility === "none") return;
    this.placeholderSent = true;
    void this.flushStatus(true);
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

  /** Build API options with message_thread_id if topicId is set. */
  private withThread(opts: Record<string, unknown> = {}): Record<string, unknown> {
    if (this.topicId !== undefined) {
      return { ...opts, message_thread_id: this.topicId };
    }
    return opts;
  }

  /**
   * Response-path send options: `parse_mode: "MarkdownV2"` unless the sticky
   * `responseIsPlainText` flag is set (set by a 400 parse-error fallback).
   * Status-line sends use `withThread()` directly — they stay plain text.
   */
  private responseOpts(): Record<string, unknown> {
    if (this.responseIsPlainText) return this.withThread();
    return this.withThread({ parse_mode: "MarkdownV2" });
  }

  /**
   * Response-path send text: when the sticky `responseIsPlainText` flag is
   * set (after a 400 parse-error fallback), markdown is stripped so the text
   * is readable as plain text. Without the flag, the raw text is returned
   * (Telegram renders it as MarkdownV2). Accepts an optional `text`
   * parameter for derived slices (e.g. rollover head, file-escape summary);
   * defaults to the full `accumulatedText`.
   */
  private responseText(text: string = this.accumulatedText): string {
    if (this.responseIsPlainText) return stripMdV2(text);
    return text;
  }

  /** Best-effort `sendChatAction("typing")`; never throws out. */
  private sendChatActionSafe(): void {
    Promise.resolve(this.bot.api.sendChatAction(this.chatId, "typing", this.withThread())).catch(
      (err: unknown) => {
        log.warn("sendChatAction failed", { error: String(err) });
      },
    );
  }

  /**
   * Build the rendered status line based on the per-tool slot model.
   *
   *   Line 1 (header): "🤔 thinking…" — persists for the whole turn.
   *   Lines 2+: one line per slot, in observation order.
   *     running → "🔧 <name>"
   *     ok      → "✅ <name>"
   *     err     → "❌ <name>"
   *   Repeat invocations fold: "✅ read ×3"
   *
   * Visibility "none" suppresses the line entirely.
   */
  buildStatusLine(): string {
    if (this.visibility === "none") return "";
    if (!this.placeholderSent && this.slots.size === 0) return "";

    const lines: string[] = ["🤔 thinking…"];
    const { cap, timing } = getVisibilityLimits(this.visibility);

    // Determine which slots to elide. Running slots are never elided.
    const elided = new Set<string>();
    if (cap > 0 && this.slots.size > cap) {
      let kept = this.slots.size;
      for (const [name, slot] of this.slots) {
        if (kept <= cap) break;
        const effectiveState =
          slot.runningCount > 0 ? "running" : slot.lastCompletedError ? "err" : "ok";
        if (effectiveState !== "running") {
          elided.add(name);
          kept--;
        }
      }
    }

    for (const [name, slot] of this.slots) {
      if (elided.has(name)) continue;
      const effectiveState =
        slot.runningCount > 0 ? "running" : slot.lastCompletedError ? "err" : "ok";
      const icon =
        effectiveState === "running" ? "🔧" : effectiveState === "err" ? "❌" : "✅";
      const count = slot.runningCount + slot.completedCount;
      const countSuffix = count > 1 ? ` ×${count}` : "";
      const timingSuffix =
        timing && effectiveState !== "running" && slot.endedAt !== undefined
          ? ` (${((slot.endedAt - slot.startedAt) / 1000).toFixed(1)}s)`
          : "";
      lines.push(`${icon} ${name}${countSuffix}${timingSuffix}`);
    }

    if (elided.size > 0) {
      lines.push(`… +${elided.size} earlier`);
    }

    return lines.join("\n");
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
    // Once the turn is finished, the status text is the resting summary.
    // Refuse any further edits — stray async events SHALL NOT mutate it.
    if (this.statusFrozen) return;
    const now = this.now();
    if (!force && now - this.lastEditTime < this.statusThrottleMs) return;

    // Quick-exit before scheduling: nothing to render OR nothing changed.
    const initial = this.buildStatusLine();
    if (!initial) return;
    if (initial === this.lastRenderedStatusText) return;

    // Coalesce concurrent flushes. If an edit is in flight, just bail —
    // the in-flight loop below re-renders `buildStatusLine()` after each
    // round-trip and picks up whatever state was mutated during the wait.
    if (this.editingStatus) return;

    this.lastEditTime = now;

    const inFlight: Promise<void> = (async () => {
      // Yield to a microtask before the first network call. Synchronous
      // siblings that fired alongside this flush (e.g. four onToolStart
      // in a row) all bail at the `editingStatus` check above; by the
      // time we resume, their state mutations are visible in
      // `buildStatusLine()`, so the FIRST edit captures the full set.
      await Promise.resolve();

      while (true) {
        if (this.statusFrozen) return;
        const t = this.buildStatusLine();
        if (!t || t === this.lastRenderedStatusText) return;
        try {
          if (this.statusMessageId === undefined) {
            const msg = await this.bot.api.sendMessage(this.chatId, t, this.withThread());
            this.statusMessageId = msg.message_id;
          } else {
            await this.bot.api.editMessageText(
              this.chatId,
              this.statusMessageId,
              t,
              this.withThread(),
            );
          }
          this.lastRenderedStatusText = t;
        } catch (err) {
          this.handleStatusError(err);
          // Don't loop on errors; the next non-duplicate transition will
          // re-trigger via the normal flushStatus path.
          return;
        }
        // Loop continues; checks above re-render to see if state mutated
        // during the round-trip and another edit is needed.
      }
    })();

    this.editingStatus = inFlight;
    inFlight.finally(() => {
      if (this.editingStatus === inFlight) this.editingStatus = null;
    });
    // Awaiting here makes `await buffer.flushStatus(...)` deterministic
    // for tests; in production the call site uses `void flushStatus(...)`
    // so this await never blocks event-handler return.
    await inFlight;
  }

  private async handleStatusError(err: unknown): Promise<void> {
    await this.handleApiError(err, "status", () => {
      // Message gone — reset both id and lastRenderedStatusText so the
      // next flush re-sends a fresh placeholder.
      this.statusMessageId = undefined;
      this.lastRenderedStatusText = "";
    });
  }

  /**
   * Flush accumulated response text to Telegram. Implements ~5/sec
   * throttle, 4096 rollover (phase 5), and basic error recovery. Phase 6
   * will add 20KB file escape.
   */
  async flushResponse(force: boolean = false): Promise<void> {
    // Ensure the status message lands before creating the first response
    // message, so the status appears above the response in the chat.
    // editingStatus is set synchronously by commitStatus/flushStatus and
    // cleared when the status sendMessage resolves. Once the status
    // exists this is a no-op (editingStatus is null).
    if (this.responseMessageId === undefined && this.editingStatus) {
      await this.editingStatus;
    }

    if (this.flushingResponse) {
      if (!force) {
        log.debug("response: skip (flush in-flight)", { accLen: this.accumulatedText.length });
        return;
      }
      log.debug("response: await flush in-flight (force)", { accLen: this.accumulatedText.length });
      await this.flushingResponse;
    }

    const inFlight = this.flushResponseOnce(force);
    this.flushingResponse = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.flushingResponse === inFlight) {
        this.flushingResponse = null;
      }
    }
  }

  private async flushResponseOnce(force: boolean = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastResponseEditTime < this.responseThrottleMs) {
      log.debug("response: skip (throttled)", {
        elapsed: now - this.lastResponseEditTime,
        throttleMs: this.responseThrottleMs,
        accLen: this.accumulatedText.length,
      });
      return;
    }

    if (this.accumulatedText.length === 0) return;

    // Coalesce concurrent sends. If the response message is being created by
    // an earlier flush, a non-force flush skips (the next throttle tick will
    // edit, by which time `responseMessageId` is set). A force flush — used
    // by `onAgentEnd` to land the final state — must wait, otherwise it
    // would see `responseMessageId === undefined` and issue a duplicate
    // `sendMessage`. See test "does not duplicate-send when sendMessage is
    // slower than the throttle window".
    if (this.responseMessageId === undefined && this.creatingResponse) {
      if (!force) {
        log.debug("response: skip (send in-flight)", { accLen: this.accumulatedText.length });
        return;
      }
      log.debug("response: await send in-flight (force)", { accLen: this.accumulatedText.length });
      await this.creatingResponse;
    }

    // Serialize edits. Telegram does not guarantee ordering for concurrent
    // edits against the same message; a stale edit can land last and
    // overwrite the latest text. A non-force flush whose throttle window
    // opened while another edit is in flight just skips — the next window
    // will pick up the latest accumulatedText. The force flush from
    // onAgentEnd MUST wait, so the final write contains the full text.
    if (this.editingResponse) {
      if (!force) {
        log.debug("response: skip (edit in-flight)", { accLen: this.accumulatedText.length });
        return;
      }
      log.debug("response: await edit in-flight (force)", { accLen: this.accumulatedText.length });
      await this.editingResponse;
    }

    log.debug("response: flush", {
      force,
      accLen: this.accumulatedText.length,
      op: this.responseMessageId === undefined ? "send" : "edit",
      msgId: this.responseMessageId,
    });

    // Big output? Escape to file before doing anything else; we do not want
    // to spam many rollover messages for a 50KB code dump.
    if (await this.maybeFileEscape()) {
      this.lastResponseEditTime = now;
      return;
    }

    // Drain any overflow first; this may send/edit several messages.
    await this.maybeRollover();

    if (this.accumulatedText.length === 0) return;

    // Idempotence guard for the edit path: if the message already has
    // this exact text we'd just earn a 400 "message is not modified".
    // Returning early here means we also do NOT touch
    // `lastResponseEditTime` — otherwise a subsequent real delta would
    // get throttled-out by a fake "edit" that never happened.
    if (
      this.responseMessageId !== undefined &&
      this.accumulatedText === this.lastRenderedResponseText
    ) {
      log.debug("response: skip (no-op edit)", {
        msgId: this.responseMessageId,
        accLen: this.accumulatedText.length,
      });
      return;
    }

    this.lastResponseEditTime = now;

    try {
      if (this.responseMessageId === undefined) {
        // Publish the in-flight promise BEFORE awaiting so concurrent flushes
        // can observe it and skip/wait. Clear it after the send resolves
        // (success or failure), regardless of which branch handled the error.
        const sentText = this.accumulatedText;
        const inFlight = (async () => {
          try {
            const msg = await this.bot.api.sendMessage(
              this.chatId,
              this.responseText(sentText),
              this.responseOpts(),
            );
            this.responseMessageId = msg.message_id;
            // Seed the idempotence guard so a force-flush at agent_end
            // with the same text becomes a no-op rather than a 400.
            // Track the raw captured text (not the stripped render) so the
            // guard compares raw-to-raw and correctly detects no-op edits.
            this.lastRenderedResponseText = sentText;
            log.debug("response: sent", {
              msgId: msg.message_id,
              accLen: sentText.length,
            });
          } catch (err) {
            await this.handleResponseError(err);
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
        // Capture the text at scheduling time. The serialization above
        // ensures the LATEST flush sees the LATEST accumulatedText,
        // since each edit awaits prior edits. The no-op guard against
        // an unchanged text already fired above.
        const text = this.accumulatedText;
        const messageId = this.responseMessageId;
        const inFlight = (async () => {
          try {
            await this.bot.api.editMessageText(this.chatId, messageId, this.responseText(text), this.responseOpts());
            this.lastRenderedResponseText = text;
            log.debug("response: edited", {
              msgId: messageId,
              accLen: text.length,
            });
          } catch (err) {
            await this.handleResponseError(err);
            if (force && this.responseMessageId === undefined && this.accumulatedText.length > 0) {
              const msg = await this.bot.api.sendMessage(this.chatId, this.responseText(), this.responseOpts());
              this.responseMessageId = msg.message_id;
              this.lastRenderedResponseText = this.accumulatedText;
            }
          }
        })();
        this.editingResponse = inFlight;
        try {
          await inFlight;
        } finally {
          if (this.editingResponse === inFlight) {
            this.editingResponse = null;
          }
        }
      }
    } catch (err) {
      await this.handleResponseError(err);
    }
  }

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
        this.withThread(),
      );
      await this.bot.api.sendMessage(this.chatId, this.responseText(summary), this.responseOpts());
    } catch (err) {
      await this.handleResponseError(err);
    } finally {
      if (wrote) await unlink(tmpPath).catch(() => {});
    }

    // The active in-memory text has been "spent" — clear regardless of
    // outcome so we do not loop trying to upload it again.
    this.accumulatedText = "";
    this.responseMessageId = undefined;
    this.lastRenderedResponseText = "";
    this.responseIsPlainText = false;
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
      let splitAt = findSafeSplit(this.accumulatedText, MAX_MESSAGE_LEN);
      // Inline-code-span safety: if the split point has an odd number of
      // unescaped backticks before it, the head would open a code span that
      // never closes (Telegram rejects unterminated spans in MarkdownV2).
      // Move the split backward to before the last backtick so the head is
      // self-contained and the tail starts fresh.
      splitAt = adjustForCodeSpan(this.accumulatedText, splitAt);
      const head = this.responseText(this.accumulatedText.slice(0, splitAt));
      const tail = this.accumulatedText.slice(splitAt);
      try {
        if (this.responseMessageId !== undefined) {
          await this.bot.api.editMessageText(
            this.chatId,
            this.responseMessageId,
            head,
            this.responseOpts(),
          );
        } else {
          await this.bot.api.sendMessage(this.chatId, head, this.responseOpts());
        }
        // The previous message is now "closed"; the tail starts a new one.
        this.responseMessageId = undefined;
        this.lastRenderedResponseText = "";
        this.responseIsPlainText = false;
        this.accumulatedText = tail;
        rolled = true;
      } catch (err) {
        await this.handleResponseError(err);
        return rolled;
      }
    }
    return rolled;
  }

  private async handleResponseError(err: unknown): Promise<void> {
    // MarkdownV2 parse error: strip markdown and retry as plain text. The
    // sticky `responseIsPlainText` flag keeps subsequent sends/edits plain
    // for the rest of this response message's lifetime, so we don't loop.
    if (!this.responseIsPlainText && isParseError(err)) {
      this.responseIsPlainText = true;
      log.warn("response MarkdownV2 parse error, falling back to plain text", {
        description: (err as { description?: string }).description,
      });
      // Retry once with stripped markdown and no parse_mode. If the retry
      // also fails, fall through to the normal error handler.
      try {
        if (this.responseMessageId === undefined) {
          const msg = await this.bot.api.sendMessage(
            this.chatId,
            this.responseText(),
            this.responseOpts(),
          );
          this.responseMessageId = msg.message_id;
          this.lastRenderedResponseText = this.accumulatedText;
        } else {
          await this.bot.api.editMessageText(
            this.chatId,
            this.responseMessageId,
            this.responseText(),
            this.responseOpts(),
          );
          this.lastRenderedResponseText = this.accumulatedText;
        }
        return;
      } catch (retryErr) {
        log.warn("response plain-text retry failed", { error: String(retryErr) });
        // Fall through to handleApiError for the retry error.
        await this.handleApiError(retryErr, "response", () => {
          this.responseMessageId = undefined;
          this.lastRenderedResponseText = "";
          this.responseIsPlainText = false;
        });
        return;
      }
    }
    await this.handleApiError(err, "response", () => {
      this.responseMessageId = undefined;
      this.lastRenderedResponseText = "";
      this.responseIsPlainText = false;
    });
  }

  /**
   * Shared error policy for status and response flushes. 429 → log + skip;
   * 400 message-gone → reset id via `onMessageGone`; otherwise log.
   * Also detects "topic not found" errors to trigger orphan archival.
   */
  private async handleApiError(
    err: unknown,
    kind: "status" | "response",
    onMessageGone: () => void,
  ): Promise<void> {
    const e = err as {
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    const code = e?.error_code;
    const description = e?.description ?? String(err);

    if (code === 429) {
      // Honor `retry_after` (seconds) so we don't keep slamming the API and
      // making the server angrier. Store the synthetic "last edit" time that
      // makes the next flush eligible exactly when retry_after expires.
      const retryAfterSec = e?.parameters?.retry_after;
      if (retryAfterSec && retryAfterSec > 0) {
        const until = this.now() + retryAfterSec * 1000;
        if (kind === "response") {
          this.lastResponseEditTime = Math.max(this.lastResponseEditTime, until - this.responseThrottleMs);
        } else {
          this.lastEditTime = Math.max(this.lastEditTime, until - this.statusThrottleMs);
        }
      }
      log.warn(`${kind} edit rate-limited, backing off`, {
        description,
        retryAfterSec,
      });
      return;
    }

    // Detect "topic not found" errors (distinct from "message not found")
    // Telegram returns these when the topic/thread ID is invalid (deleted topic)
    if (code === 400 && /topic not found|message thread not found|invalid message thread id/i.test(description)) {
      log.warn(`${kind} topic not found, archiving orphaned scope`, { description });
      if (!this.topicNotFoundReported && this.onTopicNotFound) {
        this.topicNotFoundReported = true;
        try {
          await this.onTopicNotFound();
        } catch (cbErr) {
          log.error("onTopicNotFound callback failed", { error: String(cbErr) });
        }
      }
      return;
    }

    if (code === 400 && /not found|can't be edited|to edit/i.test(description)) {
      log.warn(`${kind} message gone, will re-create on next flush`, {
        description,
      });
      onMessageGone();
      return;
    }
    if (code === 400 && /message is not modified/i.test(description)) {
      // Telegram already has the desired content — duplicate edit is a
      // no-op, not a failure. Belt-and-braces alongside the local
      // `lastRendered*Text` guards: covers any edge case where the
      // guard misses (e.g. concurrent edits with the same final text).
      log.debug(`${kind} edit not modified, skipping`, { description });
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
      slots: Array.from(this.slots.entries()),
      statusFrozen: this.statusFrozen,
      placeholderSent: this.placeholderSent,
      lastEditTime: this.lastEditTime,
      lastResponseEditTime: this.lastResponseEditTime,
      isStreaming: this.isStreaming,
      chatActionHandle: this.chatActionHandle,
    };
  }
}
