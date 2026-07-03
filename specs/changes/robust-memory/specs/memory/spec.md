# memory

## ADDED Requirements

### Requirement: Memory entries carry provenance metadata

Memory bodies MAY contain plain legacy entries, but every entry written by the reflection pipeline SHALL include lightweight Markdown metadata with `created_at`, `updated_at`, `source_session`, `source_role`, `category`, and `confidence`. The store SHALL preserve legacy plain entries and metadata-bearing entries without migration.

#### Scenario: Reflection writes a metadata-bearing entry

- **WHEN** the reflection pipeline persists a new durable project fact from session `s1`
- **THEN** the new entry SHALL include metadata identifying session `s1`, the source role, category, confidence, `created_at`, and `updated_at`
- **AND** the entry body SHALL remain human-readable Markdown

#### Scenario: Legacy entry remains readable

- **WHEN** an existing `memory.md` entry has no metadata block
- **THEN** `memory_read` and the snapshot formatter SHALL continue to return it unchanged

### Requirement: Memory safety filter rejects secrets and sensitive identifiers

Before any explicit or automatic memory write reaches disk, the system SHALL run a deterministic safety filter over the proposed content. The filter MUST reject obvious API keys, bearer tokens, private keys, passwords, cookies, Telegram bot tokens, high-risk financial identifiers, and known secret-like patterns. Rejected content MUST NOT be written to trusted memory.

#### Scenario: Explicit memory write contains a token

- **WHEN** `memory_write({action: "add", target: "memory", content: "Bearer sk-..."})` is invoked
- **THEN** the tool SHALL reject the write with a redaction/safety error
- **AND** no memory file SHALL be modified
- **AND** no git commit SHALL be created

#### Scenario: Reflection candidate contains sensitive content

- **WHEN** the reflection pipeline extracts a candidate containing an API key or password
- **THEN** the candidate SHALL be rejected before persistence to `memory.md` or `user.md`
- **AND** the rejection SHALL be recorded outside trusted memory for audit

### Requirement: Quarantine stores rejected memory candidates outside snapshots

The system SHALL maintain `$GOBLIN_HOME/memory/quarantine.jsonl` for rejected automatic candidates that are unsafe, low-confidence, or need review. Quarantine records SHALL include timestamp, source session, target scope, category, reason, and a redacted candidate preview. Quarantine contents MUST NOT appear in per-turn snapshots, `memory_read`, or `memory_read_index`.

#### Scenario: Unsafe candidate is quarantined

- **WHEN** a reflection candidate is rejected because it resembles a secret
- **THEN** a redacted record SHALL be appended to `quarantine.jsonl`
- **AND** the candidate SHALL NOT be appended to the target memory file

#### Scenario: Low-confidence candidate is quarantined

- **WHEN** reflection extracts a candidate below the configured confidence threshold and the candidate is not otherwise unsafe
- **THEN** a record SHALL be appended to `quarantine.jsonl` with reason `low_confidence`
- **AND** the candidate SHALL NOT be appended to the target memory file

#### Scenario: Snapshots exclude quarantine

- **WHEN** `quarantine.jsonl` contains rejected candidates and all trusted memory files are empty
- **THEN** the snapshot formatter SHALL return `null`
- **AND** `memory_read_index` SHALL NOT mention quarantine

### Requirement: Reflection candidates consolidate with existing entries

Automatic memory writes SHALL prefer consolidation over append-only accumulation. When a new candidate is a near-duplicate of, or update to, an existing entry in the resolved target, the pipeline SHALL replace or rewrite the existing entry while preserving the original `created_at` and original `source_session`, updating `updated_at`, and recording the newest observed source session in an `updated_source_session` metadata field. It MUST NOT append redundant entries that express the same durable fact.

#### Scenario: Candidate updates an existing preference

- **GIVEN** `user.md` contains a preference entry about communication style
- **WHEN** reflection extracts a newer correction to that preference
- **THEN** the pipeline SHALL update the existing entry rather than appending a contradictory duplicate
- **AND** `updated_at` SHALL change
- **AND** the original `source_session` SHALL remain in the entry metadata
- **AND** the newer session SHALL be recorded as `updated_source_session`

#### Scenario: Distinct candidate appends

- **WHEN** a candidate is high-confidence and not similar to any existing entry in the target file
- **THEN** the pipeline SHALL append it as a new entry subject to the target file cap

### Requirement: Reflection filters procedural noise before persistence

The reflection pipeline SHALL reject obvious procedural commands, tiny fragments, small talk, and unsupported guesses before trusted memory persistence. These filters MUST run before consolidation. Rejected low-confidence or review-worthy candidates SHALL go to quarantine; obvious noise MAY be skipped without quarantine.

#### Scenario: Procedural command is skipped

- **WHEN** transcript text contains a one-off procedural command such as “run the tests now”
- **THEN** reflection SHALL NOT persist it to `memory.md` or `user.md`

#### Scenario: Durable correction survives filtering

- **WHEN** transcript text contains a stable correction such as “remember, I prefer concise summaries with test output”
- **THEN** reflection SHALL keep it as a candidate for `user.md` subject to safety and consolidation

### Requirement: Snapshot marks memory as auxiliary and possibly stale

The per-turn memory snapshot SHALL explicitly state that memory may be stale or incomplete and that the current user message, recent tool results, and explicit instructions override memory. This warning MUST appear near the snapshot header and MUST NOT be omitted when a non-null snapshot is produced.

#### Scenario: Non-empty snapshot includes guardrail text

- **WHEN** the snapshot formatter returns a payload for non-empty memory
- **THEN** the payload SHALL begin with `[goblin memory snapshot]`
- **AND** it SHALL include text stating memory may be stale or incomplete
- **AND** it SHALL state current context overrides memory

## MODIFIED Requirements

### Requirement: memory tool exposes add, replace, remove

The system SHALL expose a single mutator tool named `memory_write` that accepts an `action` parameter of `"add" | "replace" | "remove" | "rewrite" | "set_description"` and a `target` parameter of `"memory" | "user" | "agent"`.

All mutation actions that write body text (`add`, `replace`, and `rewrite`) MUST pass the shared memory safety filter before disk persistence. `set_description` MUST pass a one-line description safety check before updating frontmatter. Failed safety checks SHALL return an error and MUST NOT modify files or create git commits.

- `add` requires `content`. Appends a new entry to the resolved file.
- `replace` requires `old_text` and `content`. Substring-matches `old_text` and substitutes `content`.
- `remove` requires `old_text`. Substring-matches and removes the containing entry.
- `rewrite` requires `content`. Replaces the entire body (preserving frontmatter) with `content`. Subject to the cap and safety filter.
- `set_description` requires `description`. Updates the `description` frontmatter without touching entries. Limited to one line, ≤200 characters, and subject to description safety checks.

The tool MUST NOT accept a `scope` argument. The active scope is derived from the calling session's `(chatId, topicId)` and named-agent identity.

#### Scenario: Add operation in active scope

- **WHEN** the tool is called with `{action: "add", target: "memory", content: "..."}` and content passes the safety filter
- **THEN** the content SHALL be appended as a new entry to the active scope's `memory.md`

#### Scenario: Unsafe rewrite is rejected

- **WHEN** the tool is called with `{action: "rewrite", target: "user", content: "password: hunter2"}`
- **THEN** the tool SHALL return a safety error
- **AND** `user.md` SHALL remain unchanged
