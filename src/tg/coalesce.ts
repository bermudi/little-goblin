/**
 * Text coalescer: detects messages Telegram clients split at the 4096-char
 * limit and merges consecutive fragments into one logical message before
 * dispatching to intake.
 *
 * Length-gated (only >= THRESHOLD messages open a buffer), corroborated by
 * adjacent Telegram `message_id`s, trailing-debounced. Historical rationale:
 * `specs/changes/archive/2026-07-09-telegram-text-coalescing/`.
 */
import type { TelegramIntakeMessage } from "./intake.ts";
import type {
  AdmissionResult,
  TransferredAdmission,
  UpdateClaim,
  UpdateGate,
} from "../shutdown/mod.ts";

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
}

/** Callback the coalescer invokes to deliver a merged (or pass-through) message
 * to intake. It returns the authoritative structural result for the group. */
export type CoalesceDispatch = (
  message: TelegramIntakeMessage,
  text: string,
) => Promise<AdmissionResult<void>>;

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
  /** Gate-owned fragment claims. One merged result settles the whole group in
   * one synchronous loop; no fragment can observe a different decision. */
  claims: UpdateClaim<void>[];
}

export interface TextCoalescerOptions {
  dispatch: CoalesceDispatch;
  gate: UpdateGate;
}

/**
 * One instance per `buildBot` call. Holds transient buffer state keyed on the
 * stringified `CoalesceKey`. `submit` is synchronous; the debounce fires
 * asynchronously via `setTimeout`. Fire-and-forget, matching the shape of
 * `intake.handleText`'s callers.
 */
export class TextCoalescer {
  private readonly dispatch: CoalesceDispatch;
  private readonly gate: UpdateGate;
  private readonly buffers = new Map<string, BufferEntry>();
  private readonly activeBufferedAdmissions = new Set<Promise<AdmissionResult<void>>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: TextCoalescerOptions) {
    this.dispatch = options.dispatch;
    this.gate = options.gate;
  }

  /** Settle transferred claims at the structural decision. UpdateGate keeps
   * every original update boundary pending through the shared completion. */
  private dispatchTracked(
    message: TelegramIntakeMessage,
    text: string,
    buffered: boolean,
    claims: UpdateClaim<void>[],
  ): Promise<AdmissionResult<void>> {
    let decision: Promise<AdmissionResult<void>>;
    try {
      decision = this.dispatch(message, text);
    } catch (error) {
      decision = Promise.reject(error);
    }
    if (buffered) this.activeBufferedAdmissions.add(decision);

    const settleClaims = (admissionResult: AdmissionResult<void>): AdmissionResult<void> => {
      if (buffered) this.activeBufferedAdmissions.delete(decision);
      try {
        this.gate.settleTransferred(claims, admissionResult);
      } catch (error) {
        // A malformed or contradictory group result is failed-before-decision
        // for every claim that did not already reach a terminal state.
        this.gate.failUndecidedTransferred(claims, error);
        throw error;
      }
      return admissionResult;
    };
    const rejectClaims = (error: unknown): never => {
      if (buffered) this.activeBufferedAdmissions.delete(decision);
      this.gate.failTransferred(claims, error);
      throw error;
    };
    const settledDecision = decision.then(settleClaims, rejectClaims);
    void decision.catch(() => {});
    void settledDecision.catch(() => {});
    return settledDecision;
  }

  submit(
    input: CoalesceInput,
    claim: UpdateClaim<void>,
  ): Promise<AdmissionResult<void>> | TransferredAdmission<void> {
    if (this.closed) {
      throw new Error(`text coalescer received update after close for ${input.key.surfaceId}`);
    }
    // Commands never buffer. If a buffer is open for the key, flush it first
    // (buffered text reaches intake before the command), then dispatch the
    // command immediately.
    if (input.isCommand) {
      this.flush(input.key);
      return this.dispatchTracked(input.message, input.text, false, []);
    }

    const entry = this.buffers.get(keyToString(input.key));
    if (entry === undefined) {
      return input.text.length >= TEXT_SPLIT_THRESHOLD
        ? this.open(input, claim)
        : this.dispatchTracked(input.message, input.text, false, []);
    }

    const isAdjacent =
      input.messageId === entry.lastMessageId + 1 &&
      Date.now() - entry.lastReceivedAt <= TEXT_SPLIT_WINDOW_MS;

    if (!isAdjacent) {
      this.flush(input.key);
      return input.text.length >= TEXT_SPLIT_THRESHOLD
        ? this.open(input, claim)
        : this.dispatchTracked(input.message, input.text, false, []);
    }

    if (
      entry.fragmentCount + 1 > MAX_FRAGMENTS ||
      entry.totalChars + input.text.length > MAX_TOTAL_CHARS
    ) {
      this.flush(input.key);
      return input.text.length >= TEXT_SPLIT_THRESHOLD
        ? this.open(input, claim)
        : this.dispatchTracked(input.message, input.text, false, []);
    }

    clearTimeout(entry.timer);
    entry.text += input.text;
    entry.lastMessageId = input.messageId;
    entry.fragmentCount += 1;
    entry.totalChars += input.text.length;
    entry.lastReceivedAt = Date.now();
    entry.claims.push(claim);
    entry.timer = setTimeout(() => this.flush(input.key), TEXT_SPLIT_WINDOW_MS);
    return this.gate.transferUpdate(claim);
  }

  /** Open a new buffer and transfer this update's opaque claim into it. */
  private open(input: CoalesceInput, claim: UpdateClaim<void>): TransferredAdmission<void> {
    const key = keyToString(input.key);
    const entry: BufferEntry = {
      message: input.message,
      text: input.text,
      lastMessageId: input.messageId,
      fragmentCount: 1,
      totalChars: input.text.length,
      lastReceivedAt: Date.now(),
      timer: setTimeout(() => this.flush(input.key), TEXT_SPLIT_WINDOW_MS),
      claims: [claim],
    };
    this.buffers.set(key, entry);
    return this.gate.transferUpdate(claim);
  }

  /**
   * Stop accepting Telegram text and deliver buffered fragments exactly once.
   * New submissions are rejected; buffered fragments are flushed while
   * UpdateGate keeps their original boundaries pending through completion.
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
      void this.dispatchTracked(entry.message, entry.text, true, entry.claims);
    }
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
    void this.dispatchTracked(entry.message, entry.text, true, entry.claims);
  }
}

/** Stable string key for the `(SurfaceId, fromUserId)` tuple. */
function keyToString(key: CoalesceKey): string {
  return `${key.surfaceId}|${key.fromUserId}`;
}
