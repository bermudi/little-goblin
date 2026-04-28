# message-buffer

## ADDED Requirements

### Requirement: Status renders per-tool slots in observation order

The buffer SHALL render the status line as a multi-line message:

- **Line 1 (header)** — `"🤔 thinking…"` for the entire turn from placeholder send through `onAgentEnd`. The header SHALL persist across phase transitions.
- **Subsequent lines (slots)** — one slot per visible tool name, in first-observation order. Each slot transitions in place between three states:
  - `running` → `"🔧 <name>"`
  - `ok` → `"✅ <name>"`
  - `err` → `"❌ <name>"`

Repeat invocations of the same visible tool name (sequential or parallel) MUST update the existing slot rather than create a new one. The slot's display count SHALL equal the total number of `onToolStart` events observed for that slot. When the display count is greater than 1, the slot SHALL render with a multiplier suffix `" ×<count>"`.

A slot's effective state SHALL be determined as follows: `running` while at least one `onToolStart` for that slot has not yet been matched by a corresponding `onToolEnd`; otherwise `err` if any prior `onToolEnd` reported `isError === true` (sticky); otherwise `ok`. The sticky-error rule SHALL hold across folded invocations: once any invocation of a slot has ended with `isError === true`, the slot SHALL render as `err` for the remainder of the turn even if later invocations succeed.

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

#### Scenario: Mixed success and error sticks to error

- **WHEN** `read` runs once successfully and a later invocation ends with `isError === true`
- **THEN** the final slot rendering SHALL be `"❌ read ×2"`

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

- **WHEN** visibility is `"standard"` (cap 12) and 16 distinct visible tools have been observed, with 8 currently in state `running` and 8 completed
- **THEN** the rendered status SHALL contain the header plus all 8 running slot lines plus the 4 most-recently-completed slot lines
- **AND** the footer SHALL be `"… +4 earlier"` reflecting the 4 elided completed slots

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Status renders coalesced phases, not per-tool entries
