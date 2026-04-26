# Status Line Redesign — Proposal

## Motivation

The status message produced by `MessageBuffer` ships, but real-world testing surfaces UX issues that no amount of incremental polish will fix without rethinking how the status line earns its place in the chat:

1. **Non-deterministic position.** The status message is sent lazily on the first `onToolStart` and the response message is sent lazily on the first `onTextDelta`. Whichever event fires first wins the top slot. Across turns, the user sees status sometimes above the response, sometimes below — the same UI in different positions.

2. **Edit churn.** Every `onToolStart`/`onToolEnd` edits the status. A turn with 4 tools = 8 edits (throttled, but still ~1/sec). Each edit is a visual blink in Telegram. Edits per turn scale with `2 * tool_count`.

3. **Low information density per edit.** Each edit adjusts a single emoji on a single tool. The status text grows linearly with tool count, never gets aggregated into something more readable.

4. **`✍️ composing` duplicates `chat_action`.** Both signal "agent is producing text". The chat_action lives in Telegram's native UI; the status repetition is noise.

5. **Status persists as historical clutter.** After the turn ends, the status message remains in the chat with stale tool history. After 10 turns, the user has 10 status messages mixed with 10 responses.

The user has explicitly asked to keep the **idea** of a separate status line above the response, but executed with discipline: predictable position, fewer edits, summary-shaped final state.

## Scope

This change modifies the `message-buffer` capability:

- **Eager placeholder on turn start.** On `agent_start`, `MessageBuffer` immediately sends a placeholder status message (`"🤔 thinking…"`). Subsequent flushes edit it. This guarantees status is always sent **before** the response message, fixing position determinism.

- **Phase-coalesced state machine.** Replace per-tool emoji tracking with three coarse phases:
  - **Thinking** — agent_start fired, no tools or text yet.
  - **Working** — at least one tool started, listed by name (e.g. `"🔧 working: bash, read"`).
  - **Done** — all tools finished, agent emitting text or turn ending. Renders as a final summary (`"✅ bash, read"` or `"❌ bash failed"`).

  Edits per turn drop to **at most 3** regardless of tool count.

- **Drop `✍️ composing`.** The `chat_action("typing")` already serves this role. Remove the redundant text indicator from the status line.

- **Final state is the resting summary.** On `agent_end`, the status is force-flushed to its final form (Done/Failed) and is not edited again. The "what tools ran" record persists as the resting state, not as a live tally.

- **Skip status entirely for zero-tool turns.** If `agent_end` fires with no tools observed and visibility allows, edit the placeholder to a near-empty state (`""`) which deletes the message via Telegram's empty-text contract — *or* skip placement entirely if zero-tool turns are detectable up front. Decision on which approach lives in `design.md`.

- **Keep the visibility levels and per-turn buffer lifecycle from the existing change.** Visibility filtering still applies (`none` suppresses everything; `minimal`/`standard`/`verbose`/`debug` constrain which tool names appear in the working/done phases).

## Non-Goals

- **No multi-turn status reuse.** Each turn still creates its own status message. Long-term clutter is real but separate work.
- **No reactions API.** Reaction-based status (🔧/✅ on the user's message) is a different UX choice; not in this change.
- **No subagent status (`onStatusUpdate`).** Still parked in the backlog. This change focuses purely on tool-driven status.
- **No tool argument display, no timing data, no per-tool durations.** Phase + name-list only. Richer detail lives in `events.jsonl` and is out of scope.
- **No new visibility level.** Five levels stay; semantics for each level remain.
- **No changes to response streaming, rollover, file escape, or chat_action refresh** — those parts of `message-buffer` are working as designed.
- **No retroactive cleanup of pre-existing status messages from past turns** — historical clutter is accepted as-is.
