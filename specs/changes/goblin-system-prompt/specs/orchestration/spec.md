# orchestration

## ADDED Requirements

### Requirement: Startup preflights Goblin prompt files

Startup SHALL validate Goblin prompt files before starting Telegram polling. Missing `$GOBLIN_HOME/SOUL.md` SHALL fail startup. Missing `$GOBLIN_HOME/AGENTS.md` SHALL produce a warning but SHALL NOT fail startup.

#### Scenario: SOUL missing at startup

- **WHEN** the process starts and `$GOBLIN_HOME/SOUL.md` is missing
- **THEN** startup SHALL fail before the bot starts polling Telegram
- **AND** the error SHALL use the shared prompt validation error contract telling the operator to run onboarding or create `SOUL.md`

#### Scenario: AGENTS missing at startup

- **WHEN** the process starts and `$GOBLIN_HOME/AGENTS.md` is missing
- **THEN** startup SHALL log a warning
- **AND** the bot MAY continue if `SOUL.md` exists

### Requirement: Onboarding creates deployment prompt files

Onboarding SHALL create `$GOBLIN_HOME/SOUL.md` and `$GOBLIN_HOME/AGENTS.md` when missing. It MUST NOT overwrite existing files. When creating `SOUL.md`, onboarding SHALL ask for the conversational agent name and write it into a concise public-safe voice template.

#### Scenario: Fresh prompt setup

- **WHEN** onboarding runs and neither prompt file exists
- **THEN** onboarding SHALL ask for the conversational agent name
- **AND** write `SOUL.md` from the identity-plus-voice template
- **AND** write `AGENTS.md` from the modest operating-rules template

#### Scenario: Existing files preserved

- **WHEN** onboarding runs and `SOUL.md` or `AGENTS.md` already exists
- **THEN** onboarding SHALL NOT overwrite the existing file

#### Scenario: Existing AGENTS without SOUL

- **WHEN** onboarding runs and `AGENTS.md` exists but `SOUL.md` is missing
- **THEN** onboarding SHALL warn that existing `AGENTS.md` may contain old identity or voice content
- **AND** onboarding SHALL create a fresh `SOUL.md` template without copying content from `AGENTS.md`
