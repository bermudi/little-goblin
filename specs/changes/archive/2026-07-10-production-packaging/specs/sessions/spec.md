# sessions

## ADDED Requirements

### Requirement: Startup preflight verifies filesystem persistence

The system SHALL run a persistence check before starting long polling that proves the `GOBLIN_HOME` state directory is writable and that atomic write + rename works as expected.

#### Scenario: Atomic write test succeeds

- **WHEN** the preflight persistence check runs
- **THEN** it SHALL write a temporary file under `state/`, rename it to a target name, read it back, verify contents match, and delete it

#### Scenario: State directory is not writable

- **WHEN** the preflight persistence check cannot write to `state/`
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

#### Scenario: Atomic rename fails

- **WHEN** the preflight persistence check writes successfully but cannot rename the temp file
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

### Requirement: Startup preflight verifies workspace and scratch writability

The system SHALL verify that the `workspace/` and `scratch/` directories are writable before starting the bot, because prompt files, memory writes, and subagent work depend on them.

#### Scenario: Workspace is read-only

- **WHEN** the preflight check cannot write to `workspace/`
- **THEN** it SHALL fail with a clear error and prevent the bot from starting

#### Scenario: Scratch is read-only

- **WHEN** the preflight check cannot write to `scratch/`
- **THEN** it SHALL fail with a clear error and prevent the bot from starting
