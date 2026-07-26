# agent

## ADDED Requirements

### Requirement: Agent runtime stamps transcript events from its capture

Every user-visible main-agent transcript write SHALL use the source SurfaceId in the runtime's captured memory context. The event callback SHALL pass that immutable value to the transcript module and MUST NOT look up the current binding. Explicit internal AgentRunner paths SHALL use the transcript module's internal writer context and omit Surface provenance.

#### Scenario: Binding changes during an event

- **WHEN** a runtime on Surface X emits a final message event while lifecycle invalidation is occurring
- **THEN** any accepted transcript write from that runtime SHALL carry X
- **AND** SHALL not be attributed to a replacement Surface Y

## MODIFIED Requirements

### Requirement: Reflection uses scoped memory context

Dreaming SHALL derive promotion scope from event-time transcript source-Surface provenance. Light sleep MUST NOT accept a session-level ActiveScope from the scheduler or runner. It SHALL read provenance-bearing transcript lines through the transcript module, project each validated source Surface through the shared memory scope module, and associate every extraction candidate with its source line range.

REM and deep sleep SHALL aggregate provenance-derived scopes rather than loading Conversation/session state. The accepted highest-origin-count, latest-update, then scope-name ordering SHALL remain. If all relevant source lines are legacy, invalid, internal, or conflicting without a deterministic accepted winner, promotion SHALL fall back to `general` under decision 0025. The internal dreaming model context SHALL remain Surface-free and is never a promotion target.

#### Scenario: Current binding differs from source

- **GIVEN** a Conversation entry was produced on topic Surface X and the Conversation is now bound to Y
- **WHEN** light sleep promotes a candidate from that entry
- **THEN** it SHALL target X's projected topic scope
- **AND** SHALL not inspect Y

#### Scenario: Candidate spans proven conflicting scopes

- **WHEN** one extracted candidate's line range contains entries from different proven MemoryScopes and no accepted aggregation winner exists
- **THEN** the candidate SHALL not be silently assigned to either current Surface
- **AND** SHALL be quarantined or deterministically handled under the documented aggregation policy

#### Scenario: Legacy candidate falls back to general

- **WHEN** no source line for a candidate has valid Surface provenance
- **THEN** promotion SHALL use `general`
- **AND** SHALL not derive scope from Conversation state
