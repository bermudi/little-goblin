import { afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import {
  MAX_FRAGMENTS,
  MAX_TOTAL_CHARS,
  TEXT_SPLIT_THRESHOLD,
  TEXT_SPLIT_WINDOW_MS,
  TextCoalescer,
  type CoalesceDispatch,
  type CoalesceInput,
  type CoalesceKey,
} from "./coalesce.ts";
import { dmSurface, surfaceId, topicSurface } from "../surface.ts";
import type { PromptContent } from "./intake.ts";
import type { TelegramIntakeMessage } from "./intake.ts";
import { completed, runtimeAdmission, UpdateGate, type AdmissionResult } from "../shutdown/mod.ts";

// --- helpers ---------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** A minimal fake `TelegramIntakeMessage` carrying an id so tests can assert
 * which fragment's message was passed on flush (D9). */
function makeMessage(id: number): TelegramIntakeMessage {
  return {
    surface: dmSurface(1),
    reply: async () => {},
    prepare: (c: PromptContent) => c,
    // Attach an out-of-band tag for identity assertions. The interface doesn't
    // carry it, but TS structural typing lets the object keep extra props.
    ...({ __id: id } as Record<string, unknown>),
  } as unknown as TelegramIntakeMessage;
}

const DEFAULT_KEY: CoalesceKey = { surfaceId: surfaceId(dmSurface(1)), fromUserId: 100 };

function makeInput(
  text: string,
  opts: { messageId: number; key?: CoalesceKey; isCommand?: boolean; messageIdFor?: number },
): CoalesceInput {
  const key = opts.key ?? DEFAULT_KEY;
  const id = opts.messageIdFor ?? opts.messageId;
  return {
    message: makeMessage(id),
    text,
    key,
    messageId: opts.messageId,
    isCommand: opts.isCommand ?? false,
  };
}

/** String of exactly `n` chars. */
function textOf(n: number, label = "x"): string {
  return label.repeat(n);
}

class TestCoalescer {
  readonly gate = new UpdateGate({
    closeCoalescer: async () => {},
    awaitBufferedTextAdmission: async () => {},
  });
  private readonly coalescer: TextCoalescer;

  constructor(dispatch: CoalesceDispatch) {
    this.coalescer = new TextCoalescer({ dispatch, gate: this.gate });
  }

  submit(input: CoalesceInput): Promise<void | undefined> {
    return this.gate.runUpdate<void>((claim) => this.coalescer.submit(input, claim));
  }

  close(): Promise<void> {
    return this.coalescer.close();
  }

  bufferedTextAdmission(): Promise<void> {
    return this.coalescer.bufferedTextAdmission();
  }
}

function testCoalescer(dispatch: CoalesceDispatch): TestCoalescer {
  return new TestCoalescer(dispatch);
}

function makeCoalescer(): { coalescer: TestCoalescer; dispatch: ReturnType<typeof mock> } {
  const dispatch = mock<CoalesceDispatch>(() => Promise.resolve(completed(undefined)));
  return { coalescer: testCoalescer(dispatch as unknown as CoalesceDispatch), dispatch };
}

/** Return the text (2nd arg) dispatched on the `n`-th call (0-indexed),
 * asserting the call exists. */
function dispatchedText(dispatch: ReturnType<typeof mock>, callIndex: number): string {
  const call = dispatch.mock.calls[callIndex];
  if (call === undefined) throw new Error(`dispatch was not called at index ${callIndex}`);
  return call[1];
}

/** Assert the id of the message passed on the `n`-th dispatch (0-indexed). */
function expectDispatchedMessageId(
  dispatch: ReturnType<typeof mock>,
  callIndex: number,
  expectedId: number,
): void {
  const call = dispatch.mock.calls[callIndex];
  if (call === undefined) throw new Error(`dispatch was not called at index ${callIndex}`);
  const passed = (call[0] as unknown as { __id?: number }).__id;
  expect(passed).toBe(expectedId);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// --- tests -----------------------------------------------------------------

describe("TextCoalescer — open / append / flush", () => {
  it("opens a buffer on a threshold-length message and flushes on timeout", () => {
    const { coalescer, dispatch } = makeCoalescer();
    const first = textOf(TEXT_SPLIT_THRESHOLD);
    const second = "tail";

    coalescer.submit(makeInput(first, { messageIdFor: 1, messageId: 1 }));
    expect(dispatch).not.toHaveBeenCalled();

    coalescer.submit(makeInput(second, { messageIdFor: 2, messageId: 2 }));
    expect(dispatch).not.toHaveBeenCalled();

    // Within the window: nothing flushed.
    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS - 1);
    expect(dispatch).not.toHaveBeenCalled();

    // Window elapses with no further adjacent fragment.
    vi.advanceTimersByTime(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedText(dispatch, 0)).toBe(first + second);
    // First fragment's message carried on flush.
    expectDispatchedMessageId(dispatch, 0, 1);
  });

  it("appends only adjacent fragments (message_id === lastBufferedId + 1)", () => {
    const { coalescer, dispatch } = makeCoalescer();
    const a = textOf(TEXT_SPLIT_THRESHOLD);
    const b = "B".repeat(10);
    const c = "C".repeat(10);

    coalescer.submit(makeInput(a, { messageIdFor: 1, messageId: 1 }));
    coalescer.submit(makeInput(b, { messageIdFor: 2, messageId: 2 }));

    // Non-adjacent gap (message_id 5, not 3): flush pending, handle fresh.
    const fresh = makeInput(c, { messageIdFor: 5, messageId: 5 });
    coalescer.submit(fresh);

    // The non-adjacent submit flushes the a+b buffer AND dispatches the short
    // `c` immediately — both synchronously in one submit call.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatchedText(dispatch, 0)).toBe(a + b);
    expectDispatchedMessageId(dispatch, 0, 1);
    expect(dispatchedText(dispatch, 1)).toBe(c);
  });

  it("restarts the debounce window on each appended fragment", () => {
    const { coalescer, dispatch } = makeCoalescer();
    coalescer.submit(makeInput(textOf(TEXT_SPLIT_THRESHOLD), { messageIdFor: 1, messageId: 1 }));
    coalescer.submit(makeInput("a", { messageIdFor: 2, messageId: 2 }));

    // Advance most of the window, then append again — timer restarts.
    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS - 5);
    coalescer.submit(makeInput("b", { messageIdFor: 3, messageId: 3 }));
    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS - 5);
    expect(dispatch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("flushes pending buffer on a non-monotonic message_id then handles fresh", () => {
    const { coalescer, dispatch } = makeCoalescer();
    const a = textOf(TEXT_SPLIT_THRESHOLD);
    coalescer.submit(makeInput(a, { messageIdFor: 1, messageId: 1 }));

    // Duplicate / out-of-order id (=== lastBufferedId): non-adjacent.
    const dup = makeInput("dup", { messageIdFor: 99, messageId: 1 });
    coalescer.submit(dup);

    expect(dispatch).toHaveBeenCalledTimes(2);
    // First: flushed buffer (a alone).
    expect(dispatchedText(dispatch, 0)).toBe(a);
    expectDispatchedMessageId(dispatch, 0, 1);
    // Second: the short "dup" handled fresh.
    expect(dispatchedText(dispatch, 1)).toBe("dup");
  });
});

describe("TextCoalescer — short messages", () => {
  it("passes short messages through immediately with no buffer open", () => {
    const { coalescer, dispatch } = makeCoalescer();
    coalescer.submit(makeInput("hi", { messageIdFor: 1, messageId: 1 }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedText(dispatch, 0)).toBe("hi");
    // Nothing pending after a pass-through.
    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS * 5);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("appends a short fragment to an already-open buffer (split tail)", () => {
    const { coalescer, dispatch } = makeCoalescer();
    const head = textOf(TEXT_SPLIT_THRESHOLD);
    coalescer.submit(makeInput(head, { messageIdFor: 1, messageId: 1 }));
    coalescer.submit(makeInput("tail", { messageIdFor: 2, messageId: 2 }));
    expect(dispatch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedText(dispatch, 0)).toBe(head + "tail");
  });
});

describe("TextCoalescer — hard caps", () => {
  it("flushes at the fragment cap and re-evaluates the overflow fragment fresh", () => {
    const { coalescer, dispatch } = makeCoalescer();
    // Open with a threshold fragment.
    coalescer.submit(makeInput(textOf(TEXT_SPLIT_THRESHOLD), { messageIdFor: 1, messageId: 1 }));
    // Append until we reach MAX_FRAGMENTS (the opener is fragment #1).
    for (let i = 2; i <= MAX_FRAGMENTS; i++) {
      coalescer.submit(makeInput(`f${i}`, { messageIdFor: i, messageId: i }));
    }
    expect(dispatch).not.toHaveBeenCalled();

    // 13th adjacent fragment: would exceed the cap → flush, then re-evaluate.
    const overflow = textOf(TEXT_SPLIT_THRESHOLD);
    coalescer.submit(makeInput(overflow, { messageIdFor: MAX_FRAGMENTS + 1, messageId: MAX_FRAGMENTS + 1 }));

    // First flush: the capped buffer.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expectDispatchedMessageId(dispatch, 0, 1);
    // Overflow opened a NEW buffer (it's threshold-length), not yet flushed.
    expect(dispatch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS);
    // Now the new buffer flushes.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatchedText(dispatch, 1)).toBe(overflow);
    expectDispatchedMessageId(dispatch, 1, MAX_FRAGMENTS + 1);
  });

  it("flushes at the total-chars cap and re-evaluates the overflow fragment fresh", () => {
    const { coalescer, dispatch } = makeCoalescer();
    // Fill a buffer close to the cap without tripping the fragment cap.
    const big = textOf(TEXT_SPLIT_THRESHOLD); // 4000
    coalescer.submit(makeInput(big, { messageIdFor: 1, messageId: 1 }));

    // 11 threshold fragments (count 11, total 44000). The next fragment must
    // exceed 6000 chars to cross MAX_TOTAL_CHARS without tripping the fragment
    // cap (11 + 1 = 12 ≤ 12). This is the only path that reaches the char-cap
    // branch before the fragment-cap branch.
    let id = 1;
    for (let i = 2; i < MAX_FRAGMENTS; i++) {
      coalescer.submit(makeInput(big, { messageIdFor: i, messageId: i }));
      id = i;
    }
    expect(dispatch).not.toHaveBeenCalled();

    const overflow = textOf(MAX_TOTAL_CHARS - (MAX_FRAGMENTS - 1) * TEXT_SPLIT_THRESHOLD + 1);
    coalescer.submit(makeInput(overflow, { messageIdFor: id + 1, messageId: id + 1 }));

    // Char-cap flush of the 11-fragment buffer.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expectDispatchedMessageId(dispatch, 0, 1);
    expect(dispatchedText(dispatch, 0).length).toBe((MAX_FRAGMENTS - 1) * TEXT_SPLIT_THRESHOLD);

    // Overflow is threshold-length → opens a new buffer.
    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatchedText(dispatch, 1)).toBe(overflow);
  });
});

describe("TextCoalescer — commands", () => {
  it("flushes a pending buffer then dispatches the command immediately, in order", () => {
    const { coalescer, dispatch } = makeCoalescer();
    const head = textOf(TEXT_SPLIT_THRESHOLD);
    coalescer.submit(makeInput(head, { messageIdFor: 1, messageId: 1 }));
    expect(dispatch).not.toHaveBeenCalled();

    coalescer.submit(
      makeInput("/cancel", { messageIdFor: 2, messageId: 2, isCommand: true }),
    );

    // Two dispatches: buffered text first, then the command.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatchedText(dispatch, 0)).toBe(head);
    expectDispatchedMessageId(dispatch, 0, 1);
    expect(dispatchedText(dispatch, 1)).toBe("/cancel");
  });

  it("dispatches a command immediately when no buffer is open", () => {
    const { coalescer, dispatch } = makeCoalescer();
    coalescer.submit(makeInput("/new", { messageIdFor: 1, messageId: 1, isCommand: true }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedText(dispatch, 0)).toBe("/new");
  });

  it("delivers buffered text exactly once and rejects new text after close", async () => {
    const { coalescer, dispatch } = makeCoalescer();
    coalescer.submit(makeInput(textOf(TEXT_SPLIT_THRESHOLD), { messageIdFor: 1, messageId: 1 }));

    await coalescer.close();
    expect(() => coalescer.submit(makeInput("late", { messageIdFor: 2, messageId: 2 })))
      .toThrow("text coalescer received update after close");
    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS * 2);

    // Buffered text was flushed exactly once; text submitted after close is dropped.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedText(dispatch, 0)).toBe(textOf(TEXT_SPLIT_THRESHOLD));
  });

  it("flushes multiple buffered fragments as one merged dispatch on close", async () => {
    const { coalescer, dispatch } = makeCoalescer();
    coalescer.submit(makeInput(textOf(TEXT_SPLIT_THRESHOLD), { messageIdFor: 1, messageId: 1 }));
    coalescer.submit(makeInput(textOf(5, "y"), { messageIdFor: 2, messageId: 2 }));

    await coalescer.close();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedText(dispatch, 0)).toBe(textOf(TEXT_SPLIT_THRESHOLD) + textOf(5, "y"));
  });

  it("settles every fragment in a merged group with one structural result", async () => {
    const decision = deferred<AdmissionResult<void>>();
    const dispatch = mock<CoalesceDispatch>(() => decision.promise);
    const coalescer = testCoalescer(dispatch as unknown as CoalesceDispatch);
    await coalescer.submit(makeInput(textOf(TEXT_SPLIT_THRESHOLD), { messageId: 1 }));
    await coalescer.submit(makeInput("tail", { messageId: 2 }));

    let drained = false;
    void coalescer.gate.runtimeAdmission().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS);
    decision.resolve(runtimeAdmission.handoff(undefined));
    await coalescer.gate.runtimeAdmission();
    expect(drained).toBe(true);
    await coalescer.close();
  });

  it("does not replay a returned immediate-dispatch failure during later close", async () => {
    const error = new Error("handled by grammy");
    const dispatch = mock<CoalesceDispatch>(() => Promise.reject(error));
    const coalescer = testCoalescer(dispatch as unknown as CoalesceDispatch);

    const returned = coalescer.submit(makeInput("short", { messageIdFor: 1, messageId: 1 }));
    await expect(returned!).rejects.toBe(error);
    await expect(coalescer.close()).resolves.toBeUndefined();
  });

  it("fails transferred claims when a buffered result is malformed", async () => {
    const dispatch = mock<CoalesceDispatch>(async () => undefined as never);
    const coalescer = testCoalescer(dispatch as unknown as CoalesceDispatch);
    await coalescer.submit(makeInput(textOf(TEXT_SPLIT_THRESHOLD), { messageId: 1 }));

    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS);
    await coalescer.gate.runtimeAdmission();
    await expect(coalescer.close()).rejects.toThrow(
      "without an admission decision",
    );
  });

  it("surfaces dispatch failures during close without swallowing them", async () => {
    const error = new Error("boom");
    const dispatch = mock<CoalesceDispatch>(() => Promise.reject(error));
    const coalescer = testCoalescer(dispatch as unknown as CoalesceDispatch);
    coalescer.submit(makeInput(textOf(TEXT_SPLIT_THRESHOLD), { messageIdFor: 1, messageId: 1 }));

    await expect(coalescer.close()).rejects.toBe(error);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("retains a detached rejection even when its reason is undefined", async () => {
    const dispatch = mock<CoalesceDispatch>(() => Promise.reject(undefined));
    const coalescer = testCoalescer(dispatch as unknown as CoalesceDispatch);
    coalescer.submit(makeInput(textOf(TEXT_SPLIT_THRESHOLD), { messageIdFor: 1, messageId: 1 }));

    let rejected = false;
    try {
      await coalescer.close();
    } catch (reason) {
      rejected = true;
      expect(reason).toBeUndefined();
    }
    expect(rejected).toBe(true);
  });

  it("awaits a timer-flushed dispatch and shares one close promise", async () => {
    const pending = deferred<AdmissionResult<void>>();
    const dispatch = mock<CoalesceDispatch>(() => pending.promise);
    const coalescer = testCoalescer(dispatch as unknown as CoalesceDispatch);
    coalescer.submit(makeInput(textOf(TEXT_SPLIT_THRESHOLD), { messageIdFor: 1, messageId: 1 }));
    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS);

    const firstClose = coalescer.close();
    expect(coalescer.close()).toBe(firstClose);
    let closed = false;
    void firstClose.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    pending.resolve(completed(undefined));
    await firstClose;
    expect(closed).toBe(true);
  });
});

describe("TextCoalescer — key isolation", () => {
  it("keeps fragments from different senders in separate buckets", () => {
    const { coalescer, dispatch } = makeCoalescer();
    const keyA: CoalesceKey = { surfaceId: surfaceId(dmSurface(1)), fromUserId: 100 };
    const keyB: CoalesceKey = { surfaceId: surfaceId(dmSurface(1)), fromUserId: 200 };
    const longA = textOf(TEXT_SPLIT_THRESHOLD, "A");

    // A opens a buffer. B's interleaving short message is under a different key
    // and is dispatched immediately, independent of A's buffer. The coalescer
    // evaluates adjacency per-bucket, so B's id space never touches A's.
    coalescer.submit(makeInput(longA, { messageIdFor: 1, messageId: 1, key: keyA }));
    coalescer.submit(makeInput("B-msg", { messageIdFor: 500, messageId: 500, key: keyB }));
    coalescer.submit(makeInput("A-tail", { messageIdFor: 2, messageId: 2, key: keyA }));

    // B dispatched immediately (short, no buffer). A still buffered (head+tail).
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedText(dispatch, 0)).toBe("B-msg");

    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS);
    // A's merged buffer flushes; B was never merged in.
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatchedText(dispatch, 1)).toBe(longA + "A-tail");
  });

  it("keeps fragments in different topics in separate buckets", () => {
    const { coalescer, dispatch } = makeCoalescer();
    const keyX: CoalesceKey = { surfaceId: surfaceId(topicSurface("supergroup", 1, 10)), fromUserId: 100 };
    const keyY: CoalesceKey = { surfaceId: surfaceId(topicSurface("supergroup", 1, 20)), fromUserId: 100 };
    const longX = textOf(TEXT_SPLIT_THRESHOLD, "X");

    coalescer.submit(makeInput(longX, { messageIdFor: 1, messageId: 1, key: keyX }));
    coalescer.submit(makeInput("Y-msg", { messageIdFor: 500, messageId: 500, key: keyY }));
    coalescer.submit(makeInput("X-tail", { messageIdFor: 2, messageId: 2, key: keyX }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatchedText(dispatch, 0)).toBe("Y-msg");

    vi.advanceTimersByTime(TEXT_SPLIT_WINDOW_MS);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatchedText(dispatch, 1)).toBe(longX + "X-tail");
  });
});
