# debug skills and context tokens

## MODIFIED Requirements

- The `Diagnostics` interface keeps its existing `skillsLoaded: number | null` and `contextTokens: number | null` fields; `gatherDiagnostics` now populates them from the runner instead of hardcoding `null`.
- `AgentRunner` exposes `skillsLoaded` and `contextTokens` getters that delegate to the live `AgentSession` when available.
  - `skillsLoaded`: number of skills returned by `session.resourceLoader.getSkills().skills.length`. Returns `null` when the session is not yet initialized. `skillsLoaded` is unaffected by compaction; it always reflects the count of currently loaded skills.
  - `contextTokens`: `session.getContextUsage()?.tokens ?? null`. Returns `null` when the session is not yet initialized or when the token count is unknown (e.g. right after compaction).
- `gatherDiagnostics` reads `skillsLoaded` and `contextTokens` from `runner` instead of hardcoding `null`, falling back to `null` when the runner is null or uninitialized.
- `formatDiagnostics` renders `skillsLoaded` and `contextTokens` as numbers when available, and as "unavailable" when the value is `null`.

#### Scenario: /debug with initialized runner showing live counts

- **GIVEN** a session whose runner has been initialized (at least one prompt sent)
- **WHEN** the user runs `/debug`
- **THEN** `Skills loaded` shows the actual count of loaded skills
- **AND** `Context` shows the estimated token count (or "unavailable" if unknown)

#### Scenario: /debug before first prompt

- **GIVEN** a session whose runner has never been initialized
- **WHEN** the user runs `/debug`
- **THEN** `Skills loaded` shows "unavailable"
- **AND** `Context` shows "unavailable"

#### Scenario: /debug right after compaction with unknown token count

- **GIVEN** a session whose runner is initialized but just finished compaction
- **WHEN** the user runs `/debug`
- **THEN** `Skills loaded` shows the actual count of loaded skills
- **AND** `Context` shows "unavailable" because token count is unknown post-compaction
