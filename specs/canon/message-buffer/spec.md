# message-buffer

## Requirements

### Requirement: MessageBuffer implements TurnCallbacks interface

The `MessageBuffer` class SHALL implement the `TurnCallbacks` interface with methods `onTextDelta`, `onToolStart`, `onToolEnd`, `onStatusUpdate`, `onAgentEnd`.

#### Scenario: Callback dispatch

- **WHEN** `AgentRunner` calls `buffer.onTextDelta("hello")`
- **THEN** the buffer SHALL accumulate the delta internally
- **AND** WHEN `buffer.onAgentEnd()` is called, the buffer SHALL flush accumulated content

### Requirement: Status line coalesces tool activity

The buffer SHALL maintain a single status message per turn rendered via the per-tool slot model described in **Status renders per-tool slots in observation order**. Per-tool state changes that produce a different rendered text MAY each trigger an edit, subject to the throttle and in-flight coalescing.

The `lastRenderedStatusText` guard SHALL suppress edits when the rendered text has not changed (e.g. a state change in a slot that is currently elided by the cap, or a duplicate edit issued during throttle coalescing).

For a turn with `T` distinct visible tools, no errors, and no slot re-entries, the buffer SHALL issue at most `2T + 2` Telegram writes in the worst case (one send for the placeholder, one edit per `running` transition, one edit per `ok` / `err` transition, one final edit on `onAgentEnd`). Each subsequent re-entry of an existing slot (a new `onToolStart` for a name whose prior invocations have all completed) SHALL add at most two further worst-case writes (re-enter `running`, re-complete). The actual count SHALL be lower whenever the throttle, the in-flight coalescing in `flushStatus`, or the `lastRenderedStatusText` guard collapses adjacent edits.

#### Scenario: Single-tool turn

- **WHEN** the turn progresses thinking → one tool starts → one tool ends → agent ends
- **THEN** the buffer SHALL issue exactly one `sendMessage` (placeholder)
- **AND** at most three `editMessageText` calls (slot enters running, slot enters ok, final flush)

#### Scenario: Many sequential tools coalesce via throttle

- **WHEN** four distinct visible tools start and end within a 500 ms window
- **THEN** the buffer SHALL issue strictly fewer than the worst-case `2T + 2 = 10` Telegram writes
- **AND** the final rendered status SHALL reflect the cumulative state with all four slots present

#### Scenario: Same tool repeated does not multiply edits

- **WHEN** the same visible tool name fires `onToolStart`/`onToolEnd` 10 times in succession
- **THEN** the buffer SHALL issue at most one edit per increment that the throttle does not absorb
- **AND** the final rendered slot SHALL be `"✅ <name> ×10"`

### Requirement: Status line throttle at ~1 edit per second

The buffer SHALL not edit the status message more than once per second. Intermediate state changes SHALL be coalesced.

#### Scenario: Rapid tool activity

- **WHEN** 10 tool events fire within 500ms
- **THEN** at most 2 edits SHALL be sent to Telegram API
- **AND** the final edit SHALL reflect the cumulative state

#### Scenario: Drop when rate limited

- **WHEN** Telegram returns 429 (rate limit)
- **THEN** the buffer SHALL drop the pending edit and continue
- **AND** it SHALL NOT retry or throw
- **AND** if the response carries `parameters.retry_after`, the buffer SHALL push its throttle clock forward by that interval so subsequent flushes within the window short-circuit

### Requirement: Response text streams via edits

Text deltas from `onTextDelta` SHALL accumulate into a response message, edited periodically (not per-delta), and roll over to a new message at 4096 characters. Each contiguous run of assistant text between tool calls forms one such response message; tool boundaries seal the current message and start a new one as described in **Response message segments at tool boundaries**. Within a single segment, behavior is unchanged.

#### Scenario: Text accumulation

- **WHEN** `onTextDelta` is called 50 times with ~10 chars each within a single segment (no tool boundary)
- **THEN** the buffer SHALL accumulate into one string
- **AND** send at most ~1 edit per second (≥1100ms minimum between edits) to stay under Telegram's per-chat write budget

#### Scenario: 4096 rollover

- **WHEN** accumulated text within a single segment exceeds 4096 characters
- **THEN** the current message SHALL be sent as-is
- **AND** a new response message SHALL be started for subsequent deltas in the same segment

### Requirement: Big output escapes to file attachment

When response text exceeds ~20KB, the buffer SHALL send the full content as a `reply.md` file attachment with a short summary text message.

#### Scenario: Large output

- **WHEN** accumulated text exceeds 20000 characters
- **THEN** content SHALL be written to a temp file
- **AND** sent as `InputFile` with caption "Full response attached"
- **AND** the text message SHALL contain first 500 chars + "... [truncated, see file]"

### Requirement: Tool visibility config filters status display

The buffer SHALL accept a `visibility` config (`none` | `minimal` | `standard` | `verbose` | `debug`) that constrains which tool names produce a slot in the rendered status. Each non-`none` level SHALL also declare a slot cap (per **Status line caps oldest completed slots**) and a timing flag (per **Verbose and debug levels render per-tool elapsed time**). Every visibility level present in the tool-filter mapping SHALL also be present in the cap/timing mapping with both fields defined; a level present in only one mapping is a build error.

The visibility-to-tool mapping SHALL be:

- `none` — no slots, no header, no placeholder
- `minimal` — `bash`, `write`, `edit`, `spawn_subagent`
- `standard` — `bash`, `write`, `edit`, `read`, `grep`, `spawn_subagent`
- `verbose` — `standard` set ∪ `revive_subagent`, `list_subagents`
- `debug` — every tool name observed

#### Scenario: Visibility = none

- **WHEN** visibility is `"none"`
- **THEN** no status placeholder SHALL be sent
- **AND** no header line and no slots SHALL be rendered

#### Scenario: Visibility = minimal filters out read

- **WHEN** visibility is `"minimal"` and a `read` tool runs alongside `bash`
- **THEN** the rendered status SHALL contain a `bash` slot and SHALL NOT contain a `read` slot

#### Scenario: Visibility = standard

- **WHEN** visibility is `"standard"` and `read`, `bash`, and `revive_subagent` run
- **THEN** the rendered status SHALL contain `read` and `bash` slots
- **AND** SHALL NOT contain a `revive_subagent` slot

#### Scenario: Visibility = verbose includes subagent management

- **WHEN** visibility is `"verbose"`
- **THEN** `revive_subagent` and `list_subagents` SHALL produce slots when they run

#### Scenario: Visibility = debug surfaces every tool

- **WHEN** visibility is `"debug"`
- **THEN** every observed tool name SHALL produce a slot

### Requirement: Chat action refreshed while active

The buffer SHALL call `bot.api.sendChatAction` every ~4 seconds while a turn is active.

#### Scenario: Long-running turn

- **WHEN** a turn runs for 30 seconds
- **THEN** `sendChatAction` SHALL be called ~7-8 times with "typing"

#### Scenario: Action stops on turn end

- **WHEN** `onAgentEnd` is called
- **THEN** no further `sendChatAction` calls SHALL occur

### Requirement: MessageBuffer never crashes goblin

All buffer operations SHALL be wrapped in try/catch. Errors SHALL be logged and swallowed; they SHALL NOT propagate to crash the bot.

#### Scenario: Telegram API error

- **WHEN** an edit fails due to deleted message
- **THEN** the error SHALL be logged
- **AND** the buffer SHALL continue operating

### Requirement: Status placeholder sent eagerly on agent_start

The buffer SHALL send a placeholder status message on the first agent event of a turn (received via `onStatusUpdate("thinking...")` from `agent_start`, or as a fallback the first `onToolStart` / `onTextDelta`). The status message SHALL be sent strictly before any response message, guaranteeing deterministic position above the response in the chat.

#### Scenario: Eager placeholder on agent_start

- **WHEN** `onStatusUpdate("thinking...")` is called as the first event of a turn
- **AND** visibility is not "none"
- **THEN** the buffer SHALL send a status message with the rendered "thinking" phase
- **AND** the status `message_id` SHALL be tracked before any response message is created

#### Scenario: Status precedes response

- **WHEN** `onStatusUpdate` and `onTextDelta` arrive within the same tick
- **THEN** the status `sendMessage` SHALL be initiated before the response `sendMessage`
- **AND** the resulting status message_id SHALL be lower than the response message_id

#### Scenario: No placeholder when visibility is none

- **WHEN** visibility is "none"
- **AND** `onStatusUpdate("thinking...")` is called
- **THEN** the buffer SHALL NOT send a status message

### Requirement: Final status state is a resting summary

On `onAgentEnd`, the buffer SHALL force-flush the status line so the resting message contains the header plus every retained per-tool slot in its final state (`ok` or `err`), the footer if the cap was exceeded, and any per-tool timing dictated by the visibility level. The buffer SHALL NOT edit the status message again for that turn.

#### Scenario: Status frozen after agent_end

- **WHEN** `onAgentEnd` has fired and the resting status reflects the final per-tool slots
- **AND** any later spurious event were to arrive
- **THEN** the buffer SHALL NOT issue further `editMessageText` for the status message

#### Scenario: Zero-tool turn rests on the header

- **GIVEN** the placeholder has been sent (e.g. via `onStatusUpdate("thinking...")`)
- **WHEN** a turn ends with `onAgentEnd` and no visible `onToolStart` has fired
- **THEN** the resting status SHALL be `"🤔 thinking…"` with no slot lines and no footer

#### Scenario: Zero-tool turn with no placeholder remains empty

- **GIVEN** visibility is `"none"` OR no `onStatusUpdate` and no `onToolStart` ever fired
- **WHEN** `onAgentEnd` fires
- **THEN** the buffer SHALL NOT have sent any status message
- **AND** SHALL NOT issue any `editMessageText` for a status message

### Requirement: Response message segments at tool boundaries

The buffer SHALL seal the current response message when a visible-or-invisible tool starts mid-turn after assistant text has already streamed. The next assistant text after the tool SHALL begin a fresh response message rather than appending to the prior one. This produces one Telegram bubble per text segment between tool calls, so a turn that emits `text → tool → text → tool → text` produces three response bubbles in chat order, interleaved with the agent's tool activity (which remains summarized in the single status line, unchanged).

Sealing semantics:

- The seal SHALL force-flush the accumulated text before resetting state, so the just-completed segment lands in its bubble in full.
- The seal SHALL clear `responseMessageId` (so the next text triggers a `sendMessage`), `accumulatedText`, and `lastRenderedResponseText`.
- If a tool starts when no text has accumulated since the last seal (or since turn start), the buffer SHALL NOT send anything and SHALL NOT mutate state. A naked-tool-call turn (no preamble) therefore produces exactly one response bubble after the tool, not an empty stub before it.
- If new text arrives during the in-flight seal flush (race not expected in practice — LLM tool calls do not interleave mid-token with text — but defended against), the buffer SHALL skip the seal and keep accumulating into the existing message. The next tool boundary or `onAgentEnd` will land it.

#### Scenario: Text → tool → text produces two bubbles

- **GIVEN** the agent has streamed `"Got it. Running bash now."` and `onTextDelta` has flushed it
- **WHEN** `onToolStart("bash", ...)` fires, then later `onToolEnd("bash", false)` fires, then `onTextDelta("Done. Output was 42.")` fires
- **THEN** the first bubble SHALL contain `"Got it. Running bash now."`
- **AND** a second response bubble SHALL be created via `sendMessage` for `"Done. Output was 42."`
- **AND** the second bubble SHALL NOT be an edit of the first

#### Scenario: Naked tool call emits no stub bubble

- **WHEN** `onToolStart("bash", ...)` fires as the very first content event of a turn (no `onTextDelta` yet)
- **THEN** no `sendMessage` SHALL be issued for the response message
- **AND** `responseMessageId` SHALL remain `undefined`
- **AND** the first `onTextDelta` after the tool ends SHALL be the one that creates the response message

#### Scenario: Three text segments around two tools produce three bubbles

- **WHEN** the turn unfolds as `text "A." → tool → text "B." → tool → text "C."`
- **THEN** exactly three response messages SHALL be sent (one `sendMessage` each)
- **AND** none of them SHALL be edited to contain another segment's text

#### Scenario: Final segment lands fully on agent_end

- **GIVEN** the agent emitted `text → tool → text` and the final text is mid-stream when `onAgentEnd` fires
- **WHEN** `onAgentEnd` runs
- **THEN** the second (final) bubble SHALL be force-flushed to its complete accumulated text
- **AND** the first bubble SHALL be untouched

### Requirement: Status renders per-tool slots in observation order

The buffer SHALL render the status line as a multi-line message:

- **Line 1 (header)** — `"🤔 thinking…"` for the entire turn from placeholder send through `onAgentEnd`. The header SHALL persist across phase transitions.
- **Subsequent lines (slots)** — one slot per visible tool name, in first-observation order. Each slot transitions in place between three states:
  - `running` → `"🔧 <name>"`
  - `ok` → `"✅ <name>"`
  - `err` → `"❌ <name>"`

Repeat invocations of the same visible tool name (sequential or parallel) MUST update the existing slot rather than create a new one. The slot's display count SHALL equal the total number of `onToolStart` events observed for that slot. When the display count is greater than 1, the slot SHALL render with a multiplier suffix `" ×<count>"`.

A slot's effective state SHALL be determined as follows: `running` while at least one `onToolStart` for that slot has not yet been matched by a corresponding `onToolEnd`; otherwise `err` if the most recent completed invocation reported `isError === true`; otherwise `ok`. Across folded sequential retry invocations, the slot SHALL reflect the latest completed outcome so a successful retry renders as success while preserving the total attempt count.

The buffer SHALL NOT collapse multiple distinct tool names into a single `"working: a, b, c"` line.

#### Scenario: Header persists across phase transitions

- **WHEN** the placeholder has been sent and a tool subsequently starts and ends
- **THEN** the rendered status SHALL begin with `"🤔 thinking…"` on line 1
- **AND** subsequent lines SHALL render the per-tool slots

#### Scenario: Single tool slot transitions through running and ok

- **WHEN** `onToolStart("bash", ...)` fires, then `onToolEnd("bash", false)` fires
- **THEN** the rendered status SHALL be `"🤔 thinking…\n🔧 bash"` after start
- **AND** SHALL be `"🤔 thinking…\n✅ bash"` after end

#### Scenario: Multiple tools each get their own line in observation order

- **WHEN** `onToolStart("bash")`, `onToolStart("read")`, `onToolEnd("bash", false)`, `onToolEnd("read", false)` fire in that order
- **THEN** the final rendered status SHALL be `"🤔 thinking…\n✅ bash\n✅ read"`

#### Scenario: Repeat invocations fold into a count

- **WHEN** `onToolStart("read")`, `onToolEnd("read", false)`, `onToolStart("read")`, `onToolEnd("read", false)`, `onToolStart("read")`, `onToolEnd("read", false)` fire
- **THEN** the rendered status SHALL contain exactly one `read` slot rendered as `"✅ read ×3"`

#### Scenario: Re-entry from ok back to running

- **WHEN** a `read` slot is in `ok` state and a new `onToolStart("read")` fires
- **THEN** the slot SHALL transition back to `running` and render as `"🔧 read ×2"`
- **AND** the display count SHALL increment by 1

#### Scenario: Parallel invocations stay running until all ends arrive

- **WHEN** `onToolStart("bash")` fires twice, then `onToolEnd("bash", false)` fires once
- **THEN** the rendered status SHALL be `"🤔 thinking…\n🔧 bash ×2"`
- **AND** WHEN the second `onToolEnd("bash", false)` fires
- **THEN** the rendered status SHALL be `"🤔 thinking…\n✅ bash ×2"`

#### Scenario: Mixed success and error reflects latest completed outcome

- **WHEN** `read` runs once with `isError === true` and a later invocation ends with `isError === false`
- **THEN** the final slot rendering SHALL be `"✅ read ×2"`

#### Scenario: Successful retry after failures renders success with total attempts

- **WHEN** `edit` runs twice with `isError === true` and a later invocation ends with `isError === false`
- **THEN** the final slot rendering SHALL be `"✅ edit ×3"`

#### Scenario: Filtered tools do not produce a slot

- **WHEN** visibility is `"minimal"` and a `read` tool runs alongside `bash`
- **THEN** no `read` slot SHALL appear in the rendered status
- **AND** the rendered status SHALL contain only the `bash` slot under the header

### Requirement: Status line caps oldest completed slots

Each visibility level SHALL declare a maximum number of slot lines (the cap). When the count of slots exceeds the cap, the buffer SHALL elide the oldest *completed* slots (effective state `ok` or `err`) and render a footer line `"… +<N> earlier"` where `N` is the number elided. Slots whose effective state is `running` SHALL never be elided regardless of age, even if this pushes the rendered slot-line count above the cap.

The cap by visibility level SHALL be:

- `minimal` — 8
- `standard` — 12
- `verbose` — 20
- `debug` — 25

Levels `none` SHALL NOT render any status, so the cap does not apply.

#### Scenario: Under cap renders all slots

- **WHEN** visibility is `"standard"` and 5 distinct visible tools have run
- **THEN** the rendered status SHALL contain the header plus 5 slot lines and no footer

#### Scenario: Over cap elides oldest completed slots

- **WHEN** visibility is `"standard"` and 15 distinct visible tools have run, all completed
- **THEN** the rendered status SHALL contain the header, exactly 12 slot lines (the most recent 12 by observation order), and a footer `"… +3 earlier"`

#### Scenario: Running slots are exempt from elision

- **WHEN** visibility is `"standard"` and 13 distinct visible tools have been observed, with the very oldest still in state `running`
- **THEN** the oldest slot SHALL still appear in the rendered status
- **AND** the footer SHALL count only completed slots that were elided

#### Scenario: Many concurrent running slots beyond the cap all render

- **WHEN** visibility is `"debug"` (cap 25) and 32 distinct visible tools have been observed, with 16 currently in state `running` and 16 completed
- **THEN** the rendered status SHALL contain the header plus all 16 running slot lines plus the 9 most-recently-completed slot lines
- **AND** the footer SHALL be `"… +7 earlier"` reflecting the 7 elided completed slots

### Requirement: Verbose and debug levels render per-tool elapsed time

When visibility is `"verbose"` or `"debug"`, every slot whose effective state is `ok` or `err` SHALL render with an elapsed-time suffix `" (<seconds>s)"` rounded to one decimal place, computed from `endedAt - startedAt` of the most recent invocation. Slots whose effective state is `running` SHALL NOT render elapsed time. Re-entry resets `startedAt`; the suffix therefore reflects the most recent invocation, not cumulative time across folded invocations.

When visibility is `"none"`, `"minimal"`, or `"standard"`, the buffer SHALL NOT render elapsed time on any slot.

#### Scenario: Verbose renders timing on completed slots

- **WHEN** visibility is `"verbose"` and a `bash` invocation took 2.13 seconds
- **THEN** the rendered slot SHALL be `"✅ bash (2.1s)"`

#### Scenario: Standard does not render timing

- **WHEN** visibility is `"standard"` and a `bash` invocation took 2.13 seconds
- **THEN** the rendered slot SHALL be `"✅ bash"` with no elapsed-time suffix

#### Scenario: Running slot has no timing under verbose

- **WHEN** visibility is `"verbose"` and a `bash` slot is currently in state `running`
- **THEN** the rendered slot SHALL be `"🔧 bash"` with no elapsed-time suffix
