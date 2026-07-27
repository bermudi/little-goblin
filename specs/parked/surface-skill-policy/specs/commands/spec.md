# commands

## ADDED Requirements

### Requirement: Skills command inspects and changes Surface policy

The command registry SHALL provide `/skills`. With no arguments it SHALL inspect the invoking Surface without creating a Conversation and report each source mode plus resolvable skill name/path provenance. `/skills <goblin|environment|host> all|none` SHALL replace one source selection. `/skills <goblin|environment|host> only <name>...` SHALL store a selected set. `/skills reload` SHALL invalidate the current runtime without changing policy so filesystem edits are re-read.

Reads SHALL be instant. Mutations and reload SHALL use queue timing and quiesce the current runtime before replacement. Validation/resolution MUST complete before persistence or disposal; unknown sources/modes, invalid or missing names, and collisions SHALL produce actionable errors with no side effects.

#### Scenario: Inspect unbound Surface

- **WHEN** `/skills` is invoked on an unbound authorized Surface
- **THEN** it SHALL show effective policy/catalog status
- **AND** SHALL not create a Conversation

#### Scenario: Select one environment skill

- **WHEN** `/skills environment only youtube-transcript` resolves successfully
- **THEN** the Surface SHALL persist that selected set
- **AND** any current runtime SHALL be invalidated after its active turn settles

#### Scenario: Enable host skills explicitly

- **WHEN** `/skills host all` succeeds
- **THEN** the Surface MAY resolve exact `~/.agents/skills/` on its next runtime

#### Scenario: Missing selected skill

- **WHEN** `/skills environment only missing-skill` cannot resolve that name
- **THEN** the command SHALL reject before settings or runtime change

#### Scenario: Reload after filesystem edit

- **WHEN** `/skills reload` runs on a bound idle Surface
- **THEN** its runtime SHALL be disposed
- **AND** the next turn SHALL resolve catalogs again from unchanged policy

#### Scenario: Mutation waits for active turn

- **WHEN** a skill mutation is issued while a turn streams
- **THEN** it SHALL queue rather than interrupt
- **AND** stale runtime work SHALL not survive replacement
