# agent-events

## ADDED Requirements

### Requirement: Write turn summary on turn completion

The event handler SHALL write a compact turn summary entry to `turns.jsonl` when a turn completes. Turn completion is detected by tracking `agent_start`/`agent_end` pairs and collapsing auto-retry cycles into a single entry.

#### Scenario: Normal turn completes

- **WHEN** `agent_end` is received after an `agent_start` with no intervening `auto_retry_start`
- **THEN** a turn entry SHALL be appended to `turns.jsonl` with the turn's model, duration, token counts, stop reason, tool call count, `retried: false`, and `error: null`

#### Scenario: Turn with auto-retry completes successfully

- **WHEN** `auto_retry_end` with `success=true` is received after a failed `agent_end` and `auto_retry_start`
- **THEN** a turn entry SHALL be appended combining both attempts, with `retried: true`, `error` set to the original error message, and token counts from the successful retry

#### Scenario: Turn with auto-retry fails all attempts

- **WHEN** `auto_retry_end` with `success=false` is received
- **THEN** a turn entry SHALL be appended with `retried: true`, `error` set to the last error message, and token counts of `0`

### Requirement: Track per-turn state for summary

The event handler SHALL accumulate turn-level state (start time, model, token counts, tool call count, error messages) during a turn, reset at each `agent_start`, and emit the summary at turn completion.

#### Scenario: Turn state accumulation

- **WHEN** events arrive between `agent_start` and `agent_end`
- **THEN** the handler SHALL track: start timestamp, model name (from `message_end`), cumulative input/output tokens (from `message_end` usage), tool call count (from `tool_execution_start`), and any error message (from `message_end` with `stopReason=error`)

#### Scenario: Turn state reset

- **WHEN** `agent_start` is received
- **THEN** all accumulated turn state SHALL be reset to defaults
