# message-buffer

## ADDED Requirements

### Requirement: Non-streaming reply sink for guest turns

The system SHALL provide a non-streaming reply sink (`GuestReplySink` or equivalent) that implements the `TurnCallbacks` interface by accumulating all `onTextDelta` text into a single `.text` field and discarding tool/status events (guest replies are one-shot; tool activity is not surfaced). The sink SHALL expose its accumulated text via a `.text` property, read by the caller after `runner.prompt()` resolves. The sink SHALL NOT call any Telegram API method during the turn — the reply is sent by the caller after the turn completes, via the intake module's `replyVia` call.

The existing `MessageBuffer` (streaming edits against a `chatId`) is unchanged. The guest sink is a separate, parallel implementation chosen by the guest intake path.

#### Scenario: Text deltas accumulate without Telegram calls

- **WHEN** the agent emits `onTextDelta("hello")` followed by `onTextDelta(" world")` during a guest turn
- **THEN** the sink SHALL accumulate `"hello world"` into its `.text` field
- **AND** SHALL NOT call `sendMessage`, `editMessageText`, or `answerGuestQuery` during the turn

#### Scenario: Tool events are ignored

- **WHEN** `onToolStart` / `onToolEnd` / `onStatusUpdate` fire during a guest turn
- **THEN** the sink SHALL accept the calls without error
- **AND** SHALL NOT surface tool activity in the final reply text

#### Scenario: onAgentEnd finalizes the accumulated text

- **WHEN** `onAgentEnd` fires after a guest turn
- **THEN** the sink's `.text` field SHALL hold the full accumulated text
- **AND** SHALL hold an empty string if no `onTextDelta` was emitted

#### Scenario: Turn error propagates via prompt() rejection

- **WHEN** the agent turn errors before `onAgentEnd`
- **THEN** `runner.prompt()` SHALL reject with the error (the sink itself does not expose a promise)
- **AND** the intake module SHALL handle the rejection by sending a short fallback reply via `replyVia` (so the summoner is not left without acknowledgment)
