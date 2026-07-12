# orchestration

## ADDED Requirements

### Requirement: Disposing a session runner cancels its subagents

When `TurnDispatcher.disposeRunner(sessionId)` is called, the dispatcher SHALL
first cancel all subagents spawned by that session by calling
`SubagentRunner.cancelBySession(sessionId)`. The cascade SHALL complete before
the runner is disposed and removed from the cache. `disposeRunner` SHALL be
async (`Promise<void>`) so callers can await the full cleanup.

`cancelPending(sessionId)` SHALL NOT cascade to subagents. It aborts a queued
prompt but the session remains alive — its subagents may still be doing useful
work. A code-level comment or JSDoc on `cancelPending` SHALL document this
non-cascading behavior so future maintainers do not add it by mistake.

#### Scenario: disposeRunner cancels subagents before disposing the runner

- **WHEN** `disposeRunner("session-abc")` is called
- **AND** subagent A has `spawnedBy === "session-abc"` and status `running`
- **THEN** A SHALL be cancelled via `cancelBySession`
- **AND** the runner for "session-abc" SHALL be disposed and removed from the
  cache only after the cascade completes

#### Scenario: disposeRunner with no subagents is a no-op for the cascade

- **WHEN** `disposeRunner("session-xyz")` is called
- **AND** no active subagent has `spawnedBy === "session-xyz"`
- **THEN** `cancelBySession` SHALL return without error
- **AND** the runner SHALL be disposed normally

#### Scenario: cancelPending does not cascade

- **WHEN** `cancelPending("session-abc")` is called
- **AND** subagent A has `spawnedBy === "session-abc"` and status `running`
- **THEN** A SHALL NOT be cancelled
- **AND** A SHALL continue running
- **AND** only the queued prompt for "session-abc" SHALL be aborted

#### Scenario: `applySideEffects` is async and awaits `disposeRunner`

- **WHEN** `applySideEffects` processes a `runner-disposed` side effect
- **THEN** `applySideEffects` SHALL be declared `async` and return
  `Promise<void>`
- **AND** `applySideEffects` SHALL `await` `disposeRunner(effect.sessionId)`
- **AND** the `handleText` call sites that invoke `applySideEffects` SHALL also
  `await` it

#### Scenario: disposeRunner is awaited before the next side effect

- **WHEN** a command returns a `runner-disposed` side effect
- **THEN** intake SHALL await `disposeRunner` before processing the next side
  effect
- **AND** if the next side effect is `runner-created` (e.g. `/new`, `/resume`),
  the new runner SHALL be created only after the old session's subagents are
  cancelled
