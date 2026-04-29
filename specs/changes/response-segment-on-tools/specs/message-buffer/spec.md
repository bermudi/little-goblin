# message-buffer

## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Response text streams via edits

Text deltas from `onTextDelta` SHALL accumulate into a response message, edited periodically (not per-delta), and roll over to a new message at 4096 characters. Each contiguous run of assistant text between tool calls forms one such response message; tool boundaries seal the current message and start a new one as described in **Response message segments at tool boundaries**. Within a single segment, behavior is unchanged.

#### Scenario: Text accumulation

- **WHEN** `onTextDelta` is called 50 times with ~10 chars each within a single segment (no tool boundary)
- **THEN** the buffer SHALL accumulate into one string
- **AND** send at most 5 edits per second (200ms minimum between edits)

#### Scenario: 4096 rollover

- **WHEN** accumulated text within a single segment exceeds 4096 characters
- **THEN** the current message SHALL be sent as-is
- **AND** a new response message SHALL be started for subsequent deltas in the same segment
