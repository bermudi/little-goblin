# commands

## ADDED Requirements

### Requirement: Implement /sessions command

The system SHALL provide a `/sessions` command that searches and lists sessions based on optional query parameters. The command SHALL work in both DMs and forum topics.

#### Scenario: /sessions with no arguments

- **WHEN** a user sends `/sessions` with no arguments
- **THEN** the bot SHALL reply with the 10 most recent sessions, showing: session ID, title (or "(untitled)"), model name, creation date, and turn count

#### Scenario: /sessions with time range

- **WHEN** a user sends `/sessions today`
- **THEN** the bot SHALL reply with sessions created today in the current chat surface's timezone
- **WHEN** a user sends `/sessions after 2026-05-13 before 2026-05-14`
- **THEN** the bot SHALL reply with sessions matching the ISO date range

#### Scenario: /sessions with error filter

- **WHEN** a user sends `/sessions errors`
- **THEN** the bot SHALL reply with sessions that have at least one errored turn
- **AND** each result SHALL show the error message and which turn failed

#### Scenario: /sessions with text search

- **WHEN** a user sends `/sessions "Update site/"`
- **THEN** the bot SHALL reply with sessions whose transcripts contain that text
- **AND** each result SHALL include a snippet of the matching message

#### Scenario: /sessions with model filter

- **WHEN** a user sends `/sessions model:kimi-k2.6`
- **THEN** the bot SHALL reply with sessions that used that model

#### Scenario: /sessions with combined filters

- **WHEN** a user sends `/sessions today errors`
- **THEN** the bot SHALL return sessions created today that have errors

#### Scenario: /sessions with no results

- **WHEN** `/sessions` returns no matching sessions
- **THEN** the bot SHALL reply "No sessions found."


