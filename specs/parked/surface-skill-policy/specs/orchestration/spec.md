# orchestration

## ADDED Requirements

### Requirement: Runtime skill context derives from Conversation and Surface

Before runner construction, orchestration SHALL combine the bound Conversation's immutable Execution Environment with the destination Surface's effective SkillPolicy and pass both to `SkillCatalogResolver`. It SHALL retain a canonical policy fingerprint and resolved skill-manifest fingerprint in runtime context identity. An existing runner MUST NOT be returned when its Surface binding, environment, or stored policy fingerprint no longer matches; filesystem catalog edits take effect through explicit `/skills reload` or ordinary runtime recreation rather than per-turn rescanning.

#### Scenario: Destination policy builds runtime

- **GIVEN** a project Conversation is bound to a Surface with Goblin none, environment all, host none
- **WHEN** the runner is created
- **THEN** only the exact project environment catalog SHALL be supplied

#### Scenario: Policy change invalidates cache

- **WHEN** a Surface policy changes after a runner was cached
- **THEN** orchestration SHALL synchronously remove that runner/queue identity before cleanup
- **AND** SHALL not return the stale runner on the next turn

#### Scenario: Conversation moves between compatible Surfaces

- **GIVEN** two Surfaces share an Execution Environment but have different skill policies
- **WHEN** a Conversation moves between them
- **THEN** the destination runtime SHALL resolve the destination Surface policy
- **AND** Conversation history/environment SHALL remain unchanged

### Requirement: Skill policy transitions are observable and atomic

Orchestration SHALL expose one operation that validates/resolves a candidate Surface policy, waits behind the current turn, atomically persists the policy, synchronously invalidates runtime identity, and then performs asynchronous cleanup without requiring command callers to coordinate those steps. Failure before persistence SHALL leave policy/runtime unchanged. Once persistence succeeds, context comparison and synchronous invalidation MUST prevent the old runner from regaining authority even if cleanup fails.

#### Scenario: Candidate collision

- **WHEN** a candidate policy selects duplicate names from distinct source files
- **THEN** transition SHALL fail before persistence and disposal

#### Scenario: Cleanup fails

- **WHEN** runtime disposal throws after identity invalidation
- **THEN** the error SHALL be logged with Surface and Conversation identity
- **AND** the invalidated runner SHALL not be reused
