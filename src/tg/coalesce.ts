/**
 * Text coalescer: detects messages Telegram clients split at the 4096-char
 * limit and merges consecutive fragments into one logical message before
 * dispatching to intake.
 *
 * Length-gated (only >= THRESHOLD messages open a buffer), corroborated by
 * adjacent Telegram `message_id`s, trailing-debounced. Historical rationale:
 * `specs/changes/archive/2026-07-09-telegram-text-coalescing/`.
 */
import { log } from "../log.ts";
import type { TelegramIntakeMessage } from "./intake.ts";
import type { UpdateHandle } from "../shutdown/mod.ts";

/** A fragment at or above this length is treated as a likely split first half. */
export const TEXT_SPLIT_THRESHOLD = 4000;

/** Trailing debounce window, restarted on each appended fragment. */
export const TEXT_SPLIT_WINDOW_MS = 1200;

/** Hard cap on fragments per buffer; reaching it forces an immediate flush. */
export const MAX_FRAGMENTS = 12;

/** Hard cap on total concatenated chars; reaching it forces an immediate flush. */
export const MAX_TOTAL_CHARS = 50_000;

/** Bucket key: canonical surface identity + sender. Splits from different
 * senders, different surfaces, or different topic containers never merge. */
export interface CoalesceKey {
  surfaceId: string;
  fromUserId: number;
}

/** Input to `TextCoalescer.submit`. */
export interface CoalesceInput {
  message: TelegramIntakeMessage;
  text: string;
  key: CoalesceKey;
  messageId: number;
  /** True when the first Telegram entity is `bot_command`. Commands bypass and
   * flush the buffer; they never open one. */
  isCommand: boolean;
  /** Handle for the Telegram update that owns this text. The coalescer
   * releases it when the merged message reaches runtime admission. */
  handle?: UpdateHandle;
}

/** Callback the coalescer invokes to deliver a merged (or pass-through) message
 * to intake. Same signature as `intake.handleText`. */
export type CoalesceDispatch = (
  message: TelegramIntakeMessage,
  text: string,
  handle: UpdateHandle | undefined,
) => Promise<void>;

interface BufferEntry {
  /** The first fragment's message — retained at open time and passed to
   * `dispatch` on every flush path (design D9). Never overwritten on append.
   *
   * `message.prepare` (built from the first fragment's grammy `ctx`) carries
   * that fragment's `entities`/`caption_entities`. On flush it is applied to
   * the *merged* text, so later-fragment entity offsets are not represented
   * here. The practical consequence: `stripBotMention`'s entity path runs on
   * first-fragment entities only — but its plain-text fallback (user-context.ts)
   * still strips bare `@handle` occurrences anywhere in the merged text. So a
   * bot mention in a later fragment is stripped via the fallback as long as no
   * entity-range match was found in the first fragment. Re-basing per-fragment
   * entity offsets onto the merged text would be the full fix; the current
   * behavior is accepted as benign and rare (a >4096-char message with bot
   * mentions split across the boundary). */
  message: TelegramIntakeMessage;
  text: string;
  lastMessageId: number;
  fragmentCount: number;
  totalChars: number;
  /** Wall-clock timestamp of the most recent fragment for this buffer. Used to
   * enforce the 1200 ms wall-clock window even when a setTimeout callback is
   * delayed by the event loop. */
  lastReceivedAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** Handles for every fragment in this buffer, released in order when the
   * merged message reaches runtime admission. */
  handles: UpdateHandle[];
}

export interface TextCoalescerOptions {
  dispatch: CoalesceDispatch;
}

/**
 * One instance per `buildBot` call. Holds transient buffer state keyed on the
 * stringified `CoalesceKey`. `submit` is synchronous; the debounce fires
 * asynchronously via `setTimeout`. Fire-and-forget, matching the shape of
 * `intake.handleText`'s callers.
 */
export class TextCoalescer {
  private readonly dispatch: CoalesceDispatch;
  private readonly buffers = new Map<string, BufferEntry>();
  private readonly activeDispatches = new Set<Promise<void>>();
  private readonly activeBufferedAdmissions = new Set<Promise<void>>();
  private readonly dispatchFailures: unknown[] = [];
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: TextCoalescerOptions) {
    this.dispatch = options.dispatch;
  }

  /** Observe every admitted dispatch so close can drain it. Only detached
   * dispatches retain failures for close; returned promises belong to callers.
   *
   * The coalescer wraps the incoming handle(s) in a tracking handle that
   * resolves `bufferedAdmission` on release, so intake sees a single
   * {@link UpdateHandle} and calls `releaseRuntimeAdmission()` at the runtime
   * hand-off boundary. The settle paths also call it as a safety net — the
   * handle's idempotency guarantees exactly-once release. */
  private dispatchTracked(
    message: TelegramIntakeMessage,
    text: string,
    detached: boolean,
    buffered: boolean,
    handles: UpdateHandle[],
  ): Promise<void> {
    let admit: () => void = () => {};
    let released = false;
    const bufferedAdmission = buffered
      ? new Promise<void>((resolve) => {
        admit = resolve;
      })
      : undefined;
    if (bufferedAdmission) this.activeBufferedAdmissions.add(bufferedAdmission);
    const release = (): void => {
      if (released) return;
      released = true;
      for (const h of handles) h.releaseRuntimeAdmission();
      admit();
      if (bufferedAdmission) this.activeBufferedAdmissions.delete(bufferedAdmission);
    };
    // The handle intake receives: a single wrapper whose release triggers
    // all fragment handles and the buffered-admission promise.
    const dispatchHandle: UpdateHandle = { releaseRuntimeAdmission: release };
    let dispatch: Promise<void>;
    try {
      dispatch = this.dispatch(message, text, dispatchHandle);
    } catch (error) {
      release();
      dispatch = Promise.reject(error);
    }
    this.activeDispatches.add(dispatch);
    const settleSuccess = (): void => {
      // A dispatch implementation that does not expose an earlier admission
      // point still must not leave the shutdown barrier pending forever.
      release();
      this.activeDispatches.delete(dispatch);
    };
    const settleFailure = (error: unknown): void => {
      release();
      this.activeDispatches.delete(dispatch);
      if (!detached) return;
      // Rejection is an outcome independent of its reason: Promise.reject()
      // is still a failure even though the reason is undefined.
      this.dispatchFailures.push(error);
      log.error("detached coalescer dispatch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    };
    void dispatch.then(settleSuccess, settleFailure);
    return dispatch;
  }

  submit(input: CoalesceInput): Promise<void> | undefined {
    if (this.closed) {
      log.info("telegram text dropped after admission closed", { surfaceId: input.key.surfaceId });
      input.handle?.releaseRuntimeAdmission();
      return;
    }
    // Commands never buffer. If a buffer is open for the key, flush it first
    // (buffered text reaches intake before the command), then dispatch the
    // command immediately.
    if (input.isCommand) {
      this.flush(input.key);
      return this.dispatchTracked(input.message, input.text, false, false, input.handle ? [input.handle] : []);
    }

    const entry = this.buffers.get(keyToString(input.key));

    // No open buffer for this key: open one if the fragment is long enough,
    // otherwise pass through immediately with no added latency.
    if (entry === undefined) {
      if (input.text.length >= TEXT_SPLIT_THRESHOLD) {
        this.open(input);
      } else {
        return this.dispatchTracked(input.message, input.text, false, false, input.handle ? [input.handle] : []);
      }
      return;
    }

    // Buffer is open. Decide append vs flush-then-handle on adjacency and
    // wall-clock window. A fragment is adjacent only if its message_id is
    // exactly one greater than the last buffered id AND it arrived within the
    // 1200 ms wall-clock window from the prior fragment. The wall-clock check
    // prevents a late fragment from extending the window when the setTimeout
    // callback has not yet fired.
    const isAdjacent =
      input.messageId === entry.lastMessageId + 1 &&
      Date.now() - entry.lastReceivedAt <= TEXT_SPLIT_WINDOW_MS;

    if (!isAdjacent) {
      // Non-adjacent (gap > 1, non-monotonic / duplicate, or window elapsed):
      // the open buffer and the incoming message are not fragments of one
      // logical message.
      this.flush(input.key);
      // Re-evaluate the incoming fragment as if fresh.
      if (input.text.length >= TEXT_SPLIT_THRESHOLD) {
        this.open(input);
      } else {
        return this.dispatchTracked(input.message, input.text, false, false, input.handle ? [input.handle] : []);
      }
      return;
    }

    // Adjacent. Honor hard caps before appending: if appending would cross a
    // cap, flush the current buffer first, then re-evaluate the incoming as
    // fresh.
    if (
      entry.fragmentCount + 1 > MAX_FRAGMENTS ||
      entry.totalChars + input.text.length > MAX_TOTAL_CHARS
    ) {
      this.flush(input.key);
      if (input.text.length >= TEXT_SPLIT_THRESHOLD) {
        this.open(input);
      } else {
        return this.dispatchTracked(input.message, input.text, false, false, input.handle ? [input.handle] : []);
      }
      return;
    }

    // Append: clear + restart the timer, update text/ids/counts. The retained
    // first-fragment `message` is never overwritten.
    clearTimeout(entry.timer);
    entry.text += input.text;
    entry.lastMessageId = input.messageId;
    entry.fragmentCount += 1;
    entry.totalChars += input.text.length;
    entry.lastReceivedAt = Date.now();
    if (input.handle) entry.handles.push(input.handle);
    entry.timer = setTimeout(() => this.flush(input.key), TEXT_SPLIT_WINDOW_MS);
    return;
  }

  /** Open a new buffer for `input`'s key, capturing its message as the
   * retained first-fragment message. Starts the trailing debounce. */
  private open(input: CoalesceInput): void {
    const key = keyToString(input.key);
    const entry: BufferEntry = {
      message: input.message,
      text: input.text,
      lastMessageId: input.messageId,
      fragmentCount: 1,
      totalChars: input.text.length,
      lastReceivedAt: Date.now(),
      timer: setTimeout(() => this.flush(input.key), TEXT_SPLIT_WINDOW_MS),
      handles: input.handle ? [input.handle] : [],
    };
    this.buffers.set(key, entry);
  }

  /**
   * Stop accepting Telegram text and deliver the fragments already accepted
   * into coalescing buffers exactly once. New submissions after close are
   * rejected; buffered fragments are flushed and their dispatches awaited so
   * shutdown never silently drops user text that was already admitted.
   * Dispatch failures are logged, not swallowed.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    const entries = [...this.buffers.values()];
    for (const entry of entries) clearTimeout(entry.timer);
    this.buffers.clear();
    for (const entry of entries) {
      void this.dispatchTracked(entry.message, entry.text, true, true, entry.handles);
    }

    while (this.activeDispatches.size > 0) {
      await Promise.allSettled([...this.activeDispatches]);
    }

    const failures = this.dispatchFailures.splice(0);
    log.info("telegram text admission closed", {
      bufferedFragments: entries.length,
      dispatchFailures: failures.length,
    });
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Telegram text dispatch failed");
  }

  /**
   * Wait only until text that was held in a coalescing buffer has reached its
   * runtime admission call. This is intentionally separate from `close()`,
   * which drains complete dispatch handlers.
   */
  async bufferedTextAdmission(): Promise<void> {
    while (this.activeBufferedAdmissions.size > 0) {
      await Promise.allSettled([...this.activeBufferedAdmissions]);
    }
  }

  /** Flush an open buffer for `key`: concatenate buffered fragments with no
   * separator, dispatch using the retained first-fragment message, clear the
   * timer, and delete the entry. No-op when no buffer is open. */
  private flush(key: CoalesceKey): void {
    const k = keyToString(key);
    const entry = this.buffers.get(k);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.buffers.delete(k);
    void this.dispatchTracked(entry.message, entry.text, true, true, entry.handles);
  }
}

/** Stable string key for the `(SurfaceId, fromUserId)` tuple. */
function keyToString(key: CoalesceKey): string {
  return `${key.surfaceId}|${key.fromUserId}`;
}
