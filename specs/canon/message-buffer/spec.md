# message-buffer

## Requirements

### Requirement: MessageBuffer implements TurnCallbacks interface

The `MessageBuffer` class SHALL implement the `TurnCallbacks` interface with methods `onTextDelta`, `onToolStart`, `onToolEnd`, `onStatusUpdate`, `onAgentEnd`.

#### Scenario: Callback dispatch

- **WHEN** `AgentRunner` calls `buffer.onTextDelta("hello")`
- **THEN** the buffer SHALL accumulate the delta internally
- **AND** WHEN `buffer.onAgentEnd()` is called, the buffer SHALL flush accumulated content

### Requirement: Status line coalesces tool activity

The buffer SHALL maintain a single status message per turn rendered via the phase state machine described in **Status renders coalesced phases**. The buffer MUST NOT issue more than one edit per phase transition. For a typical turn (Thinking → Working → Done) this SHALL produce at most three Telegram writes per turn (one send + two edits) regardless of tool count.

#### Scenario: Phase transitions

- **WHEN** the turn progresses thinking → first tool starts → all tools finish → agent ends
- **THEN** the buffer SHALL issue exactly one `sendMessage` (placeholder) and at most two `editMessageText` calls (entering Working, entering Done)

#### Scenario: Many tools collapse to one Working edit

- **WHEN** four tools start and finish during the turn
- **THEN** the buffer SHALL NOT edit the status more than once per phase boundary
- **AND** intermediate per-tool transitions SHALL NOT cause additional edits

#### Scenario: Composing indicator removed

- **WHEN** `onTextDelta` fires while no tool is running
- **THEN** the rendered status SHALL NOT include `"✍️ composing"`
- **AND** liveness SHALL be conveyed by `chat_action("typing")` only

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

The buffer SHALL accept a `visibility` config (`none` | `minimal` | `standard` | `verbose` | `debug`) that constrains which tool names appear in the Working and Done phase renderings. Visibility levels and tool lists are unchanged from the existing capability.

#### Scenario: Visibility = none

- **WHEN** visibility is "none"
- **THEN** no status placeholder SHALL be sent and no edits SHALL fire

#### Scenario: Visibility = minimal

- **WHEN** visibility is "minimal" and a `read` tool runs alongside `bash`
- **THEN** the Working phase SHALL render `"🔧 working: bash"` (read filtered)
- **AND** the Done phase SHALL render `"✅ bash"`

#### Scenario: Visibility = standard

- **WHEN** visibility is "standard" and `read`, `bash`, and `revive_subagent` run
- **THEN** the rendered phases SHALL include `read` and `bash`
- **AND** `revive_subagent` SHALL be filtered out

#### Scenario: Visibility = verbose

- **WHEN** visibility is "verbose"
- **THEN** γ tools (`revive_subagent`, `list_subagents`) SHALL appear in the rendered phases

#### Scenario: Visibility = debug

- **WHEN** visibility is "debug"
- **THEN** every observed tool name SHALL appear in the rendered phases

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

### Requirement: Status renders coalesced phases, not per-tool entries

The buffer SHALL render the status line as one of three coarse phases:

- **Thinking** (no tool has started) → `"🤔 thinking…"`
- **Working** (at least one tool has started; agent has not yet moved on to its final answer) → `"🔧 working: <comma-separated visible tool names>"`
- **Done** (the agent has moved on — either it has begun emitting its final text after all tools completed, or `onAgentEnd` has fired) → `"✅ <names>"` if no errors, `"❌ <names>"` if any tool errored

The Working→Done transition SHALL fire on the FIRST `onTextDelta` after all visible tools are done, OR on `onAgentEnd`, whichever comes first. It SHALL NOT fire merely on `onToolEnd` (the agent might still fire another tool sequentially). A new `onToolStart` from a non-Working phase SHALL pull the buffer back into Working.

The buffer SHALL NOT show progressive per-tool emoji transitions ("🔧 bash" → "✅ bash") in the rendered status line.

#### Scenario: Thinking phase

- **WHEN** the placeholder has been sent and no tools have started
- **THEN** the rendered status SHALL be `"🤔 thinking…"`

#### Scenario: Working phase with multiple tools

- **WHEN** `onToolStart("bash", ...)` and `onToolStart("read", ...)` have fired and neither has ended
- **THEN** the rendered status SHALL be `"🔧 working: bash, read"`

#### Scenario: Done phase, no errors

- **WHEN** `onToolStart`/`onToolEnd(name, false)` have fired for `bash` and `read`, AND the agent has begun emitting text (or `onAgentEnd` has fired)
- **THEN** the rendered status SHALL be `"✅ bash, read"`

#### Scenario: Done phase, at least one error

- **WHEN** any tool ended with `isError === true` AND the Done transition has fired
- **THEN** the rendered status SHALL begin with `"❌"` and include the failing tool name

#### Scenario: Sequential tool re-enters Working

- **WHEN** the buffer is in Done with `["write"]` AND `onToolStart("read", ...)` fires
- **THEN** the phase SHALL transition back to Working
- **AND** the rendered status SHALL become `"🔧 working: write, read"`

#### Scenario: Filtered tools do not appear

- **WHEN** visibility is `"minimal"` and a `read` tool runs
- **THEN** `read` SHALL NOT appear in any phase rendering

### Requirement: Final status state is a resting summary

On `onAgentEnd`, the buffer SHALL force-flush the status line to its terminal phase ("Done" or "Failed") and SHALL NOT edit the status message again for that turn.

#### Scenario: Status frozen after agent_end

- **WHEN** `onAgentEnd` has fired and the status reflects the final phase
- **AND** any later spurious event were to arrive
- **THEN** the buffer SHALL NOT issue further `editMessageText` for the status message

#### Scenario: Zero-tool turn collapses placeholder

- **WHEN** a turn ends with `onAgentEnd` and no `onToolStart` has fired
- **THEN** the placeholder status message SHALL either be edited to an empty/minimal final state or be left untouched as the resting "thinking…" indicator
- **AND** no per-tool detail SHALL appear in the final state
