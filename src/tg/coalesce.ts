/**
 * Text coalescer: detects messages Telegram clients split at the 4096-char
 * limit and merges consecutive fragments into one logical message before
 * dispatching to intake.
 *
 * Length-gated (only >= THRESHOLD messages open a buffer), corroborated by
 * adjacent Telegram `message_id`s, trailing-debounced. See
 * `specs/changes/telegram-text-coalescing/` for the full rationale.
 */
import type { TelegramIntakeMessage } from "./intake.ts";

/** A fragment at or above this length is treated as a likely split first half. */
export const TEXT_SPLIT_THRESHOLD = 4000;

/** Trailing debounce window, restarted on each appended fragment. */
export const TEXT_SPLIT_WINDOW_MS = 1200;

/** Hard cap on fragments per buffer; reaching it forces an immediate flush. */
export const MAX_FRAGMENTS = 12;

/** Hard cap on total concatenated chars; reaching it forces an immediate flush. */
export const MAX_TOTAL_CHARS = 50_000;

/** Bucket key: chat + optional topic + sender. Splits from different senders,
 * different topics, or different DMs never merge. */
export interface CoalesceKey {
  chatId: number;
  topicId: number | undefined;
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
}

/** Callback the coalescer invokes to deliver a merged (or pass-through) message
 * to intake. Same signature as `intake.handleText`. */
export type CoalesceDispatch = (message: TelegramIntakeMessage, text: string) => void;

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

  constructor(options: TextCoalescerOptions) {
    this.dispatch = options.dispatch;
  }

  submit(input: CoalesceInput): void {
    // Commands never buffer. If a buffer is open for the key, flush it first
    // (buffered text reaches intake before the command), then dispatch the
    // command immediately.
    if (input.isCommand) {
      this.flush(input.key);
      this.dispatch(input.message, input.text);
      return;
    }

    const entry = this.buffers.get(keyToString(input.key));

    // No open buffer for this key: open one if the fragment is long enough,
    // otherwise pass through immediately with no added latency.
    if (entry === undefined) {
      if (input.text.length >= TEXT_SPLIT_THRESHOLD) {
        this.open(input);
      } else {
        this.dispatch(input.message, input.text);
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
        this.dispatch(input.message, input.text);
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
        this.dispatch(input.message, input.text);
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
    entry.timer = setTimeout(() => this.flush(input.key), TEXT_SPLIT_WINDOW_MS);
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
    };
    this.buffers.set(key, entry);
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
    this.dispatch(entry.message, entry.text);
  }
}

/** Stable string key for the `(chatId, topicId, fromUserId)` tuple. `topicId`
 * is `undefined` outside forum topics; encode it distinctly so DM/topic keys
 * never collide. */
function keyToString(key: CoalesceKey): string {
  return `${key.chatId}|${key.topicId ?? ""}|${key.fromUserId}`;
}
