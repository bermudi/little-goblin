# sessions

## ADDED Requirements

### Requirement: Turn index file

Each session directory SHALL contain a `turns.jsonl` file that stores one compact JSON entry per completed turn. A "turn" is bounded by `agent_start` and `agent_end` events from pi. Auto-retry cycles (where pi retries a failed turn internally) SHALL be collapsed into a single turn entry with retry metadata.

#### Scenario: Turn completed successfully

- **WHEN** an `agent_end` event is received after a normal turn
- **THEN** a turn entry SHALL be appended to `turns.jsonl` containing: `turn` (zero-based index), `startTs` (ISO-8601 of turn start), `endTs` (ISO-8601 of turn end), `durationMs`, `model`, `stopReason`, `tokensIn`, `tokensOut`, `error` (nullable), `retried` (boolean), `toolCalls` (count)

#### Scenario: Turn errored without retry

- **WHEN** an `agent_end` event is received with `stopReason=error` and no preceding `auto_retry_start`
- **THEN** the turn entry SHALL have `error` set to the error message, `retried: false`, and `stopReason: "error"`

#### Scenario: Turn errored then auto-retried successfully

- **WHEN** a turn ends with `stopReason=error`
- **AND** is followed by `auto_retry_start` and `auto_retry_end` with `success=true`
- **THEN** the turn entry SHALL be written at the point of `auto_retry_end`
- **AND** `retried` SHALL be `true`
- **AND** `error` SHALL contain the original error message
- **AND** `stopReason` and token counts SHALL reflect the successful retry
- **AND** `durationMs` SHALL be measured from the original turn start to the retry's completion

#### Scenario: Turn retried multiple times

- **WHEN** a turn is retried multiple times (attempt 1 fails, attempt 2 fails, attempt 3 succeeds)
- **THEN** a single turn entry SHALL be written with `retryAttempts` set to the total number of retry attempts
- **AND** `error` SHALL contain the last error message before the successful retry, or the final error if all retries failed

#### Scenario: Session created with no turns

- **WHEN** a new session is created via `createForChat()`
- **THEN** `turns.jsonl` SHALL NOT be created until the first turn completes
- **AND** reading turns for this session SHALL return an empty array

### Requirement: Read turn index

`SessionManager` SHALL provide a `readTurns(sessionId)` method that reads and parses `turns.jsonl` from a session directory.

#### Scenario: Session with turns

- **WHEN** `readTurns("c392e5ace1")` is called for a session with 5 turns
- **THEN** it SHALL return an array of 5 parsed turn entries, ordered chronologically

#### Scenario: Session with no turns file

- **WHEN** `readTurns(sessionId)` is called for a session with no `turns.jsonl`
- **THEN** it SHALL return an empty array without throwing

#### Scenario: Corrupted turn entry

- **WHEN** `readTurns(sessionId)` encounters a malformed JSON line
- **THEN** it SHALL skip that line and continue parsing
- **AND** it SHOULD log a warning

### Requirement: Search sessions

`SessionManager` SHALL provide a `search(query)` method that finds sessions matching structured criteria across all sessions.

#### Scenario: Search by time range

- **WHEN** `search({ after: "2026-05-13T08:00:00", before: "2026-05-13T10:00:00" })` is called
- **THEN** it SHALL return sessions whose `createdAt` falls within that range
- **AND** each result SHALL include the session state and matching turn entries

#### Scenario: Search by model name

- **WHEN** `search({ model: "kimi-k2.6" })` is called
- **THEN** it SHALL return sessions whose `state.modelName` matches the query

#### Scenario: Search by error

- **WHEN** `search({ errors: true })` is called
- **THEN** it SHALL return sessions that have at least one turn entry with `stopReason=error`

#### Scenario: Search by transcript content

- **WHEN** `search({ text: "Update site/" })` is called
- **THEN** it SHALL return sessions whose `transcript.jsonl` contains a case-insensitive substring match
- **AND** each result SHALL include the matching entry and a snippet of surrounding context

#### Scenario: Combined search

- **WHEN** `search({ after: "2026-05-13", model: "kimi-k2.6", errors: true })` is called
- **THEN** it SHALL return sessions matching ALL criteria (AND semantics)

#### Scenario: Empty result

- **WHEN** `search({ text: "xyzzy_no_match" })` is called
- **THEN** it SHALL return an empty array without error

#### Scenario: No criteria

- **WHEN** `search({})` is called
- **THEN** it SHALL return the most recent sessions up to a default limit of 10
- **AND** results SHALL be sorted by `createdAt` descending (newest first)
