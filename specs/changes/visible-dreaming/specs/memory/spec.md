# memory

## ADDED Requirements

### Requirement: Dream distillation after REM sleep

After REM sleep completes and has promoted at least one recurring theme, the dreaming pipeline SHALL generate a first-person dream fragment from the detected theme tags and their session counts. The fragment SHALL be produced via the existing `enqueueInternalTurn` mechanism using the `__goblin_dreaming__` internal session. The distillation prompt SHALL instruct the model to write a short first-person passage (≤400 characters) that reflects on the recurring themes as goblin's own interior experience, not as analysis of the user. The prompt SHALL explicitly forbid naming the user, quoting private conversation content, or framing the dream as "you did X today."

The fragment SHALL be grounded in the theme tags that triggered the REM promotion — the model receives the tag names and session counts, not raw transcript text. This ensures the dream is anchored in real cross-session patterns without exposing private conversation details to the distillation prompt.

When REM sleep promotes zero recurring themes, no fragment SHALL be produced. Quiet nights stay quiet.

#### Scenario: REM sleep promotes themes and produces a fragment

- **WHEN** REM sleep completes and promoted one or more recurring themes (tags appearing in 3+ sessions)
- **THEN** the pipeline SHALL dispatch a distillation turn via `enqueueInternalTurn`
- **AND** the model SHALL receive the promoted theme tags and their session counts
- **AND** the model SHALL NOT receive raw transcript text
- **AND** the resulting fragment SHALL be stored in `fragment.json`

#### Scenario: REM sleep promotes zero themes

- **WHEN** REM sleep completes and promoted zero recurring themes
- **THEN** the pipeline SHALL NOT dispatch a distillation turn
- **AND** `fragment.json` SHALL NOT be modified
- **AND** no dream fragment aside SHALL be injected on subsequent turns

#### Scenario: Distillation prompt forbids user analysis

- **WHEN** the distillation prompt is constructed
- **THEN** it SHALL instruct the model to write from goblin's own perspective
- **AND** it SHALL forbid naming the user or quoting private conversation content
- **AND** it SHALL forbid framing the dream as analysis of the user's behavior

#### Scenario: Fragment exceeds character limit

- **WHEN** the distillation model returns a fragment exceeding 400 characters
- **THEN** the pipeline SHALL truncate the fragment to 400 characters at the nearest word boundary
- **AND** the truncated fragment SHALL be stored in `fragment.json`

### Requirement: Dream fragment store

The system SHALL maintain a dream fragment at `$GOBLIN_HOME/state/memory/dreams/fragment.json` containing the most recent dream fragment. The file SHALL be written atomically (tmp + renameSync) and SHALL contain a JSON object with the following fields:

- `text` — the fragment text (≤400 chars)
- `dreamtAt` — ISO-8601 timestamp of when the fragment was generated
- `phase` — the dreaming phase that produced it (`"REM"`)
- `themes` — an array of theme tag strings that grounded the fragment

The store SHALL expose a `readFragment(home: string): DreamFragment | null` function that reads `fragment.json`, validates the parsed object against the `DreamFragment` schema, and returns the parsed fragment. It SHALL return `null` when the file is absent (ENOENT is expected) or when the file content is malformed or does not match the schema. Non-ENOENT read errors SHALL propagate. The store SHALL expose a `writeFragment(home: string, fragment: DreamFragment): void` function that writes atomically.

#### Scenario: Fragment written atomically

- **WHEN** `writeFragment` is called with a new fragment
- **THEN** a temp file SHALL be written and renamed atomically to `fragment.json`
- **AND** the file SHALL contain valid JSON with all required fields

#### Scenario: Read absent fragment

- **WHEN** `readFragment` is called and `fragment.json` does not exist
- **THEN** it SHALL return `null`

#### Scenario: Read existing fragment

- **WHEN** `readFragment` is called and `fragment.json` exists and is valid
- **THEN** it SHALL return the parsed `DreamFragment` object

#### Scenario: Read malformed fragment

- **WHEN** `readFragment` is called and `fragment.json` exists but contains malformed JSON or fields that do not match the `DreamFragment` schema
- **THEN** it SHALL return `null`
- **AND** non-ENOENT read errors SHALL propagate

### Requirement: Dream message preferences

The system SHALL maintain dream message preferences at `$GOBLIN_HOME/state/memory/dreams/prefs.json` containing a JSON object with a single boolean field `enabled` (default `false`). The file SHALL be written atomically. The store SHALL expose `readDreamPrefs(home: string): { enabled: boolean }` returning `{ enabled: false }` when the file is absent, and `writeDreamPrefs(home: string, prefs: { enabled: boolean }): void`.

#### Scenario: Default preferences when file absent

- **WHEN** `readDreamPrefs` is called and `prefs.json` does not exist
- **THEN** it SHALL return `{ enabled: false }`

#### Scenario: Preferences written atomically

- **WHEN** `writeDreamPrefs` is called with `{ enabled: true }`
- **THEN** a temp file SHALL be written and renamed atomically to `prefs.json`
- **AND** a subsequent `readDreamPrefs` SHALL return `{ enabled: true }`

### Requirement: Dream message delivery

After a dream fragment is produced and stored, if dream messages are enabled in `prefs.json`, the scheduler loop SHALL deliver the fragment as a proactive Telegram message to the user's primary session via `enqueueScheduledTurn`. The message SHALL be prefixed with `🌙 ` and framed as a dream, not as a response to a user message. Delivery SHALL be throttled to at most one dream message per 24 hours.

The "primary session" SHALL be resolved as the user's DM session if one exists and is not archived. If no DM session exists, the most recently created non-archived, non-internal session SHALL be used (tie-breaking by the session with the lexicographically greatest `createdAt`). If no suitable session exists, delivery SHALL be silently skipped with a debug log.

A delivery record SHALL be persisted at `$GOBLIN_HOME/state/memory/dreams/delivered.json` containing the `deliveredAt` timestamp of the last successful delivery. This record SHALL be written atomically after successful delivery. A new fragment SHALL be delivered only when no delivery record exists or `now - deliveredAt >= 24 hours`.

#### Scenario: Dream message delivered when enabled

- **WHEN** a dream fragment is produced and `prefs.json` has `enabled: true`
- **AND** no delivery record exists or the last `deliveredAt` is more than 24 hours ago
- **AND** a primary session is resolved
- **THEN** the fragment SHALL be delivered as a proactive message via `enqueueScheduledTurn`
- **AND** a delivery record with the current `deliveredAt` SHALL be written to `delivered.json`

#### Scenario: Dream message suppressed when disabled

- **WHEN** a dream fragment is produced and `prefs.json` has `enabled: false`
- **THEN** no proactive message SHALL be sent
- **AND** no delivery record SHALL be written

#### Scenario: Dream message throttled

- **WHEN** a dream fragment is produced and `prefs.json` has `enabled: true`
- **AND** a delivery record exists with `deliveredAt` within the last 24 hours
- **THEN** no proactive message SHALL be sent
- **AND** no new delivery record SHALL be written

#### Scenario: No session available for delivery

- **WHEN** a dream fragment is produced and delivery is enabled
- **AND** no non-archived, non-internal session exists
- **THEN** delivery SHALL be silently skipped
- **AND** a debug log SHALL be emitted

### Requirement: Dream diary summary line for /dreams command

The dreaming pipeline SHALL expose a `readDreamDiarySummary(home: string, nights: number): DreamDiaryNight[]` function that reads the operational dream history (`$GOBLIN_HOME/state/memory/dreams/history.json`) for the last `nights` nights and returns a summary array. Each entry SHALL contain the date string, whether a fragment was produced that night (recorded in the history when `distillDream` successfully persists a fragment), and a one-line theme summary. Nights with no history entry or with `fragmentProduced: false` SHALL be represented as `{ date, hasFragment: false, summary: "quiet" }`. The markdown `dreams/YYYY-MM-DD.md` files are export-only views and are not read by application code.

#### Scenario: Summary for 7 nights with mixed activity

- **WHEN** `readDreamDiarySummary` is called with `nights: 7`
- **AND** history entries exist for 5 of the last 7 nights, 3 of which record `fragmentProduced: true`
- **THEN** the returned array SHALL have 7 entries
- **AND** entries with `fragmentProduced: true` SHALL have `hasFragment: true` and a theme summary
- **AND** entries for nights with history but `fragmentProduced: false` SHALL have `hasFragment: false, summary: "quiet"`
- **AND** entries for nights with no history entry SHALL have `hasFragment: false, summary: "quiet"`

#### Scenario: No history entries exist

- **WHEN** `readDreamDiarySummary` is called and no history entries exist
- **THEN** it SHALL return an array of `nights` entries, all with `hasFragment: false, summary: "quiet"`
