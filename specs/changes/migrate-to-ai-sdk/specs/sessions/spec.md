# sessions

## MODIFIED Requirements

### Requirement: Write transcript entries on message completion

The system SHALL append transcript entries to `transcript.jsonl` derived from AI SDK stream events. Entries SHALL be written on step completion events from AI SDK's `fullStream` or step results.

#### Scenario: Assistant message completed

- **WHEN** an assistant response step completes
- **THEN** the system SHALL extract the text, usage, model info
- **AND** normalize it into a transcript entry with `ts`, `role`, `timestamp`, `content`, `usage`
- **AND** append the entry as a single JSONL line to `transcript.jsonl`

#### Scenario: Tool result completed

- **WHEN** a tool execution step completes
- **THEN** the system SHALL record `toolName`, `toolCallId`, `isError`, and a summary of the result
- **AND** append the entry as a single JSONL line

#### Scenario: Non-completion events

- **WHEN** intermediate stream events (text-delta, reasoning-delta, etc.) arrive
- **THEN** the system SHALL NOT write to `transcript.jsonl`
