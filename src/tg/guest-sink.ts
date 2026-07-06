import type { TurnCallbacks } from "../agent/mod.ts";

/**
 * Non-streaming reply sink for guest turns.
 *
 * Guest replies use Telegram's one-shot `answerGuestQuery` API, which accepts
 * a single complete `InlineQueryResult` per `guest_query_id` and does not
 * support edit-in-place. This sink accumulates the full assistant text via
 * `onTextDelta`, ignores tool/status telemetry (the summoner only sees the
 * final answer), and exposes the assembled `.text` after `prompt()` resolves.
 *
 * The runner resolves `prompt()` on agent_end, so `onAgentEnd` is a no-op —
 * the caller reads `.text` after awaiting `runner.prompt(text, sink)`.
 */
export class GuestReplySink implements TurnCallbacks {
  private buf = "";

  /** The accumulated assistant text. Read after `runner.prompt()` resolves. */
  get text(): string {
    return this.buf;
  }

  onTextDelta(text: string): void {
    this.buf += text;
  }

  onToolStart(_name: string, _input: unknown): void {
    // no-op — tool telemetry is invisible to the guest summoner
  }

  onToolEnd(_name: string, _isError: boolean): void {
    // no-op
  }

  onStatusUpdate(_message: string): void {
    // no-op
  }

  onAgentEnd(): void {
    // no-op — the caller reads `.text` after `prompt()` resolves.
  }
}
