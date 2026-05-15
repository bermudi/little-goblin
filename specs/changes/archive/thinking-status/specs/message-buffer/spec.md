# message-buffer

## MODIFIED Requirements

### Requirement: Status placeholder sent eagerly on agent_start

The buffer SHALL send a placeholder status message on the first event of a turn that indicates actual model activity — specifically `onStatusUpdate("thinking...")` (fired when the model emits thinking/reasoning tokens), or as a fallback the first `onToolStart` / `onTextDelta`. The status message SHALL be sent strictly before any response message, guaranteeing deterministic position above the response in the chat.

The `agent_start` event SHALL NOT trigger the placeholder. The buffer MUST NOT send a status message until the model produces observable output (thinking tokens, text, or tool calls).

#### Scenario: Eager placeholder on thinking tokens

- **WHEN** the model emits thinking tokens and `onStatusUpdate("thinking...")` is called
- **AND** visibility is not "none"
- **THEN** the buffer SHALL send a status message with the rendered "thinking" phase
- **AND** the status `message_id` SHALL be tracked before any response message is created

#### Scenario: No placeholder on agent_start alone

- **WHEN** `agent_start` fires but the model has not yet produced thinking tokens, text, or tool calls
- **THEN** the buffer SHALL NOT have sent any status message

#### Scenario: Fallback placeholder on first tool or text

- **WHEN** the model does not produce thinking tokens but does emit a tool call or text
- **THEN** the buffer SHALL send the placeholder on the first `onToolStart` or `onTextDelta`

#### Scenario: Status precedes response

- **WHEN** `onStatusUpdate` and `onTextDelta` arrive within the same tick
- **THEN** the status `sendMessage` SHALL be initiated before the response `sendMessage`
- **AND** the resulting status message_id SHALL be lower than the response message_id

#### Scenario: No placeholder when visibility is none

- **WHEN** visibility is "none"
- **AND** `onStatusUpdate("thinking...")` is called
- **THEN** the buffer SHALL NOT send a status message

### Requirement: Status renders per-tool slots in observation order

The buffer SHALL render the status line as a multi-line message:

- **Line 1 (header)** — `"🤔 thinking…"` while the model is producing thinking/reasoning tokens. The header SHALL appear when the first `thinking_start` event arrives and persist through `thinking_end`, transitioning to the per-tool slot phase once tools begin. If the model produces no thinking tokens but does produce tool calls or text, the header SHALL appear on first observable output and persist through `onAgentEnd`.
- **Subsequent lines (slots)** — one slot per visible tool name, in first-observation order. Each slot transitions in place between three states:
  - `running` → `"🔧 <name>"`
  - `ok` → `"✅ <name>"`
  - `err` → `"❌ <name>"`

Repeat invocations of the same visible tool name (sequential or parallel) MUST update the existing slot rather than create a new one. The slot's display count SHALL equal the total number of `onToolStart` events observed for that slot. When the display count is greater than 1, the slot SHALL render with a multiplier suffix `" ×<count>"`.

A slot's effective state SHALL be determined as follows: `running` while at least one `onToolStart` for that slot has not yet been matched by a corresponding `onToolEnd`; otherwise `err` if the most recent completed invocation reported `isError === true`; otherwise `ok`. Across folded sequential retry invocations, the slot SHALL reflect the latest completed outcome so a successful retry renders as success while preserving the total attempt count.

The buffer SHALL NOT collapse multiple distinct tool names into a single `"working: a, b, c"` line.

#### Scenario: Header appears on thinking tokens

- **WHEN** the model emits thinking tokens
- **THEN** the rendered status SHALL begin with `"🤔 thinking…"` on line 1

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
