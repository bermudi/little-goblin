# message-buffer

## ADDED Requirements

### Requirement: MessageBuffer implements TurnCallbacks interface

The `MessageBuffer` class SHALL implement the `TurnCallbacks` interface with methods `onTextDelta`, `onToolStart`, `onToolEnd`, `onStatusUpdate`, `onAgentEnd`.

#### Scenario: Callback dispatch
- **WHEN** `AgentRunner` calls `buffer.onTextDelta("hello")`
- **THEN** the buffer SHALL accumulate the delta internally
- **AND** WHEN `buffer.onAgentEnd()` is called, the buffer SHALL flush accumulated content

### Requirement: Status line coalesces tool activity

The buffer SHALL maintain a single status message per turn that accumulates tool state and is edited no more than once per second.

#### Scenario: Tool starts
- **WHEN** `onToolStart("bash", {command: "ls"})` is called
- **THEN** the status line SHALL show "🔧 bash"
- **AND** the status message SHALL be created if not exists

#### Scenario: Tool ends successfully
- **WHEN** `onToolEnd("bash", false)` is called after a start
- **THEN** the status line SHALL update to show "✅ bash"

#### Scenario: Tool ends with error
- **WHEN** `onToolEnd("bash", true)` is called after a start
- **THEN** the status line SHALL show "❌ bash"

#### Scenario: Multiple tools
- **WHEN** three tools run in sequence
- **THEN** the status line SHALL show all three states (e.g., "✅ read 🔧 bash ✍️ composing")

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

### Requirement: Response text streams via edits

Text deltas from `onTextDelta` SHALL accumulate into a response message, edited periodically (not per-delta), and roll over to a new message at 4096 characters.

#### Scenario: Text accumulation
- **WHEN** `onTextDelta` is called 50 times with ~10 chars each
- **THEN** the buffer SHALL accumulate into one string
- **AND** send at most 5 edits per second (200ms minimum between edits)

#### Scenario: 4096 rollover
- **WHEN** accumulated text exceeds 4096 characters
- **THEN** the current message SHALL be sent as-is
- **AND** a new response message SHALL be started for subsequent deltas

### Requirement: Big output escapes to file attachment

When response text exceeds ~20KB, the buffer SHALL send the full content as a `reply.md` file attachment with a short summary text message.

#### Scenario: Large output
- **WHEN** accumulated text exceeds 20000 characters
- **THEN** content SHALL be written to a temp file
- **AND** sent as `InputFile` with caption "Full response attached"
- **AND** the text message SHALL contain first 500 chars + "... [truncated, see file]"

### Requirement: Tool visibility config filters status display

The buffer SHALL accept a `visibility` config (`none` | `minimal` | `standard` | `verbose` | `debug`) and filter which tools appear in the status line.

#### Scenario: Visibility = none
- **WHEN** visibility is "none"
- **THEN** no status line SHALL be shown
- **AND** no `onToolStart`/`onToolEnd` events affect Telegram UI

#### Scenario: Visibility = minimal
- **WHEN** visibility is "minimal"
- **THEN** only stateful tools (bash, write, edit, spawn_subagent) SHALL appear
- **AND** read, grep SHALL be hidden

#### Scenario: Visibility = standard
- **WHEN** visibility is "standard"
- **THEN** all α tools (bash, read, edit, write, grep, spawn_subagent) SHALL appear
- **AND** γ tools (revive_subagent, list_subagents) SHALL NOT appear

#### Scenario: Visibility = verbose
- **WHEN** visibility is "verbose"
- **THEN** α + γ tools (revive_subagent, list_subagents) SHALL appear

#### Scenario: Visibility = debug
- **WHEN** visibility is "debug"
- **THEN** everything including internal events SHALL appear

### Requirement: Chat action refreshed while active

The buffer SHALL call `bot.api.sendChatAction` every ~4 seconds while a turn is active.

#### Scenario: Long-running turn
- **WHEN** a turn runs for 30 seconds
- **THEN** `sendChatAction` SHALL be called ~7-8 times with "typing"

#### Scenario: Action stops on turn end
- **WHEN** `onAgentEnd` is called
- **THEN** no further `sendChatAction` calls SHALL occur

### Requirement: onStatusUpdate callbacks are forwarded

The buffer SHALL implement `onStatusUpdate(status)` to receive status updates from subagents and display them in the status line.

#### Scenario: Subagent status update
- **WHEN** `onStatusUpdate("Researcher analyzing...")` is called
- **THEN** the status line SHALL include the subagent name prefix
- **AND** the status SHALL be formatted as "🧠 Researcher analyzing..."

### Requirement: MessageBuffer never crashes goblin

All buffer operations SHALL be wrapped in try/catch. Errors SHALL be logged and swallowed; they SHALL NOT propagate to crash the bot.

#### Scenario: Telegram API error
- **WHEN** an edit fails due to deleted message
- **THEN** the error SHALL be logged
- **AND** the buffer SHALL continue operating
