# config

## MODIFIED Requirements

### Requirement: Validate config with Zod schema

The system SHALL validate the fully resolved config object against its Zod schema. `skillSources` SHALL no longer be a runtime configuration field. An existing `skillSources` key MUST fail validation with actionable guidance to remove it and use Surface `/skills` policy; it SHALL NOT be silently stripped or affect resolution. Other unknown or invalid typed fields retain existing validation behavior.

#### Scenario: Legacy skillSources is rejected visibly

- **WHEN** config contains `skillSources: "goblin-only"` or `"user"`
- **THEN** validation SHALL fail naming the obsolete field
- **AND** the error SHALL direct the operator to remove it

#### Scenario: No skillSources

- **WHEN** config omits `skillSources`
- **THEN** validation SHALL succeed without adding a process-wide skill policy

### Requirement: Expose typed Config interface

The `Config` interface SHALL expose validated deployment configuration but MUST NOT expose `skillSources`. Skill source selection SHALL enter runtime construction through the explicit skill policy/resolution interfaces instead.

#### Scenario: Config consumer

- **WHEN** a caller uses typed Config
- **THEN** model, auth, logging, Telegram, voice, external-agent, and MCP fields SHALL remain available as currently specified
- **AND** `skillSources` SHALL not be a Config property

## REMOVED Requirements

### Requirement: skillSources config field
