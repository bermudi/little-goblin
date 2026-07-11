# memory

## Requirements

### Requirement: Memory store filesystem layout

The system SHALL maintain a curated memory store at `$GOBLIN_HOME/state/memory/` containing:

- `user.md` — the global user identity file (preferences, recurring people, communication style).
- `general/memory.md` — the catch-all scope for DMs and supergroup-no-topic chats.
- `topics/<chatId>/<topicId>/memory.md` — one file per Telegram forum topic.
- `agents/<name>/memory.md` — one file per named subagent persona.
- `archive/topics/<chatId>/<topicId>/` — orphaned topic scopes moved here automatically.

All `memory.md` and `user.md` files MUST be created lazily on first write if missing. Intermediate scope directories SHALL be created with `mkdir -p` semantics.

#### Scenario: First write to user.md creates it

- **WHEN** `memory_write` is called with `target = "user"` and `user.md` does not exist
- **THEN** `$GOBLIN_HOME/state/memory/user.md` SHALL be created with the new entry as its only content

#### Scenario: First write to a new topic scope creates the tree

- **WHEN** `memory_write` is called with `target = "memory"` from a session in topic `42` and no scope file exists
- **THEN** `$GOBLIN_HOME/state/memory/topics/<chatId>/42/memory.md` SHALL be created with the new entry
- **AND** the parent directories SHALL be created if absent

#### Scenario: Loading absent files

- **WHEN** the snapshot formatter loads any scope file that does not exist
- **THEN** the loader SHALL treat the file as empty without throwing

### Requirement: Entry delimiter

Entries within each memory file SHALL be separated by the delimiter `\n§\n`. A file containing zero entries is the empty string. A file containing one entry MUST NOT contain the delimiter.

#### Scenario: First entry added

- **WHEN** `memory.add` writes the first entry to an empty file
- **THEN** the file contents SHALL equal the entry text with no surrounding delimiters

#### Scenario: Second entry added

- **WHEN** `memory.add` appends a second entry
- **THEN** the file contents SHALL be `<first><\n§\n><second>`

### Requirement: Enforce character caps with overflow errors

The system SHALL enforce hard character limits per file: 4000 characters for every `memory.md` (regardless of scope) and 2000 characters for `user.md`. Each scope's cap is independent — topic `7`'s 4000 budget is separate from topic `42`'s. The frontmatter `description` line is NOT counted against the entry budget; it has its own implicit one-line cap of 200 characters.

When an `add`, `replace`, or `rewrite` operation would push a file over its cap, the operation SHALL fail with an error message reporting the current size, the cap, and the overflow amount. The file MUST NOT be modified on overflow.

#### Scenario: Add under cap in a topic scope

- **WHEN** the resulting `topics/<chat>/42/memory.md` would be ≤ 4000 characters
- **THEN** the write SHALL succeed

#### Scenario: Add exceeds cap in one topic but not another

- **WHEN** topic `42`'s `memory.md` is at 3990 characters and an `add` would push it to 4100
- **THEN** the write to topic `42` SHALL fail with current=3990, cap=4000, overflow=100
- **AND** topic `7`'s independent budget SHALL be unaffected

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

### Requirement: Substring match for replace and remove

`replace` and `remove` SHALL locate the target entry by substring match on `old_text` within the file's contents. If `old_text` matches zero or more than one location, the operation SHALL fail with an error and the file MUST NOT be modified.

#### Scenario: Unique match

- **WHEN** `old_text` matches exactly one substring
- **THEN** that substring SHALL be replaced (or its containing entry removed)

#### Scenario: Ambiguous match

- **WHEN** `old_text` matches more than one substring
- **THEN** the tool SHALL return an error reporting the match count
- **AND** the file SHALL be unchanged

#### Scenario: No match

- **WHEN** `old_text` matches no substring
- **THEN** the tool SHALL return a "not found" error
- **AND** the file SHALL be unchanged

### Requirement: Atomic writes

Every memory file mutation SHALL use atomic write (write to temp file in `$GOBLIN_HOME/state/memory/`, then rename to final path).

#### Scenario: Write succeeds

- **WHEN** `memory.add` writes a new entry
- **THEN** a temp file SHALL be written and renamed atomically to the target path

#### Scenario: Write interrupted

- **WHEN** the process crashes mid-write
- **THEN** the original file SHALL remain intact (the temp file may be left behind)

### Requirement: Git-backed versioning

The system SHALL initialize `$GOBLIN_HOME/state/memory/` as a git repository on first write if one does not already exist. After every successful `memory_write` operation, the system SHALL stage and commit the changed file(s) with a commit message of the form `memory: <action> in <target>` where:

- `action ∈ {add, replace, remove, rewrite, set_description}`
- `target` is one of: `user`, `general`, `topics/<chatId>/<topicId>`, `agents/<name>`

A single git repo at `$GOBLIN_HOME/state/memory/.git` covers all scopes; per-scope repos MUST NOT be created.

#### Scenario: Successful add in a topic commits with scope tag

- **WHEN** `memory_write({action: "add", target: "memory", ...})` succeeds from topic `42` in chat `-100123`
- **THEN** a git commit SHALL be created with the message `memory: add in topics/-100123/42`

#### Scenario: Successful set_description commits with scope tag

- **WHEN** `memory_write({action: "set_description", target: "memory", description: "..."})` succeeds in `general`
- **THEN** a git commit SHALL be created with the message `memory: set_description in general`

#### Scenario: First write initializes repo

- **WHEN** any `memory_write` action is called and `$GOBLIN_HOME/state/memory/.git` does not exist
- **THEN** `git init` SHALL run before the first commit

#### Scenario: Failed write does not commit

- **WHEN** any `memory_write` action fails (cap overflow, ambiguous match, target=agent for non-named caller)
- **THEN** no commit SHALL be created

### Requirement: Snapshot format for prompt injection

The system SHALL provide a snapshot formatter that produces the per-turn aside payload from the current memory store contents resolved against the calling session's active scope. The formatter SHALL accept a caller descriptor (as defined in `Memory context assembly is caller-typed`) instead of raw policy knobs. The payload SHALL begin with the literal header `[goblin memory snapshot]` followed by the sections defined in `Per-turn snapshot includes active scope and cross-scope index`. Empty sections SHALL render `(empty)`. The formatter MUST return `null` when all sources are empty AND no cross-scope index entries exist.

#### Scenario: Topic-bound session, only user.md populated

- **WHEN** the formatter is invoked for a main-goblin caller whose active scope is topic `42`, topic `42`'s `memory.md` is empty, `user.md` has content, and no other scopes exist
- **THEN** the formatter SHALL return a non-null payload
- **AND** the payload SHALL include `## scope` (topic `42`), `## user.md` with content, and `## memory.md` with `(empty)`
- **AND** the `## other scopes` section SHALL be omitted

#### Scenario: DM session with cross-scope topics available

- **WHEN** the formatter is invoked for a main-goblin caller whose active scope is `general`, `general/memory.md` has content, and topics `7` and `42` have non-empty `memory.md` files with descriptions
- **THEN** the payload SHALL include `## scope` (general), `## user.md`, `## memory.md` (general's contents), and `## other scopes` listing topics `7` and `42` with descriptions

#### Scenario: Everything empty

- **WHEN** `user.md`, the active scope's `memory.md`, and every other scope are empty or absent
- **THEN** the formatter SHALL return `null`

### Requirement: Memory scopes by chat surface and named agent

The system SHALL key each memory scope by one of:
- `general` — DMs and supergroup-no-topic chats. Resolves on disk to `$GOBLIN_HOME/state/memory/general/memory.md`.
- A topic scope identified by `(chatId, topicId)`. Resolves to `$GOBLIN_HOME/state/memory/topics/<chatId>/<topicId>/memory.md`.
- A named-agent persona scope identified by `<name>` where `<name>` is a sanitized named-agent identifier. Resolves to `$GOBLIN_HOME/state/memory/agents/<name>/memory.md`.

Topic-scope keying SHALL use the numeric Telegram topic ID, not the topic's display name. Renaming a forum topic in Telegram MUST NOT change the resolved on-disk path. The `general` scope file is shared across every DM and every supergroup-no-topic chat.

`user.md` is global and lives at `$GOBLIN_HOME/state/memory/user.md`. There is no per-scope `user.md`.

#### Scenario: First write in a topic creates its scope tree

- **WHEN** `memory_write` is called with `target = "memory"` from a session bound to `(chatId=-100123, topicId=42)` and the scope file does not exist
- **THEN** `$GOBLIN_HOME/state/memory/topics/-100123/42/memory.md` SHALL be created with the new entry as its only content
- **AND** intermediate directories (`topics/`, `topics/-100123/`, `topics/-100123/42/`) SHALL be created with `mkdir -p` semantics

#### Scenario: First write in a DM resolves to general scope

- **WHEN** `memory_write` is called with `target = "memory"` from a DM session and `general/memory.md` does not exist
- **THEN** `$GOBLIN_HOME/state/memory/general/memory.md` SHALL be created with the new entry as its only content

#### Scenario: First write to a named agent's persona resolves to that agent's scope

- **WHEN** `memory_write` is called with `target = "agent"` from a named subagent `researcher` and `agents/researcher/memory.md` does not exist
- **THEN** `$GOBLIN_HOME/state/memory/agents/researcher/memory.md` SHALL be created with the new entry as its only content

#### Scenario: Topic rename does not move the scope file

- **WHEN** the user renames the forum topic with id `42` in Telegram from `Health` to `Wellness`
- **THEN** the on-disk path `$GOBLIN_HOME/state/memory/topics/<chatId>/42/memory.md` SHALL remain unchanged
- **AND** subsequent reads and writes SHALL continue to use the same file

### Requirement: Per-turn snapshot includes active scope and cross-scope index

The snapshot formatter SHALL produce a payload composed of, in order, when non-empty inputs are available:

1. A `## scope` section describing the active scope (e.g. `Topic: <chatId>/<topicId>`, `General (DM/supergroup-no-topic)`, or `Agent: <name>`).
2. A `## user.md` section with the contents of `$GOBLIN_HOME/state/memory/user.md`.
3. A `## memory.md` section with the contents of the active scope's `memory.md`.
4. A `## other scopes` section listing the available cross-scope memories with their one-line descriptions.

The header `[goblin memory snapshot]` SHALL be the first line of the payload. An individual `## memory.md` or `## user.md` section whose source file is empty or absent SHALL render the literal placeholder `(empty)` as its body. The `## other scopes` section SHALL be omitted when no other scopes exist (i.e. the only scope on disk is the active one).

The formatter SHALL return `null` when ALL of the following are true: `user.md` is empty/absent, the active scope's `memory.md` is empty/absent, and no other scopes exist.

#### Scenario: Active scope is a topic, other topics exist

- **WHEN** the snapshot is built for a session in topic `(chatId=-100123, topicId=42)` and topics `(-100123, 7)` and `(-100123, 11)` also have non-empty `memory.md` files
- **THEN** the payload SHALL include a `## scope` section identifying topic `42`
- **AND** a `## memory.md` section with `topics/-100123/42/memory.md` contents
- **AND** a `## other scopes` section listing topics `7` and `11` with their descriptions

#### Scenario: Named subagent snapshot includes persona memory

- **WHEN** the snapshot is built for a named subagent `researcher` spawned from a topic-bound parent
- **THEN** the payload SHALL include `## user.md`, the parent's active scope `## memory.md`, and an additional `## agent persona` section with the contents of `agents/researcher/memory.md`
- **AND** the `## scope` section SHALL identify both the active topic and the named agent

#### Scenario: All scopes empty

- **WHEN** `user.md`, the active scope's `memory.md`, and any agent persona file are all empty or absent, and no other scopes exist
- **THEN** the formatter SHALL return `null`

### Requirement: Scope description provides progressive disclosure

Each scope's `memory.md` MAY carry a one-line `description` stored in a YAML-style frontmatter header:

    ---
    description: <one-line summary>
    ---

    <entries>

The description SHALL appear in the `## other scopes` section of every snapshot rendered in a different scope, formatted as `- <scope-id> — <description>`. When a scope has no description, the section SHALL fall back to the Telegram topic name for topic scopes (best-effort lookup) or the literal string `(no description)` otherwise.

The `memory_write` tool SHALL expose a `set_description` action that updates this header without modifying entry contents.

#### Scenario: Set description on a topic scope

- **WHEN** `memory_write` is called with `{action: "set_description", target: "memory", description: "homelab + dotfiles"}` from a session bound to topic `7`
- **THEN** the file `topics/<chat>/7/memory.md` SHALL be written with the frontmatter `description: homelab + dotfiles`
- **AND** existing entries SHALL be preserved

#### Scenario: Snapshot uses descriptions for cross-scope index

- **WHEN** the snapshot is built and topic `7` has description "homelab + dotfiles"
- **THEN** the `## other scopes` section SHALL contain a line `- topics/<chat>/7 — homelab + dotfiles`

### Requirement: Orphan topic scopes move to archive on failed resolve

When goblin attempts a Telegram operation against a topic and Telegram responds with a not-found error, the system SHALL move the topic's scope directory to `$GOBLIN_HOME/state/memory/archive/topics/<chatId>/<topicId>/` via `renameSync`. After the move, the scope SHALL NOT appear in `memory_read_index` results.

The `general` scope and named-agent persona scopes are NOT subject to orphan handling. Detection SHALL NOT poll Telegram; the move is triggered only on the next failed resolve.

#### Scenario: Topic deleted in Telegram, next operation surfaces 404

- **WHEN** the user deletes a forum topic in Telegram
- **AND** goblin next attempts to send or edit a message in that topic
- **AND** Telegram returns a "topic not found" error
- **THEN** the matching `state/memory/topics/<chatId>/<topicId>/` directory SHALL be moved to `state/memory/archive/topics/<chatId>/<topicId>/`
- **AND** subsequent `memory_read_index` calls SHALL omit the orphaned scope

#### Scenario: General scope is exempt

- **WHEN** any failed resolve occurs
- **THEN** `state/memory/general/` SHALL NOT be moved or otherwise modified

### Requirement: Memory writes are restricted to the active scope

The `memory_write` tool SHALL resolve its target's scope from the calling session's `(chatId, topicId)` (or named-agent identity for `target: "agent"`). The tool's input schema MUST NOT accept an arbitrary scope argument on writes. Attempts by the agent to write to any scope other than the active one SHALL be impossible by construction.

The `target` parameter on `memory_write` accepts only:
- `"memory"` — the active topic scope, or `general` for DMs/supergroup-no-topic.
- `"user"` — the global `user.md`.
- `"agent"` — the calling named subagent's persona memory. Rejected with an error when the caller is the main agent or an anonymous subagent.

#### Scenario: Write from a topic targets that topic's scope

- **WHEN** `memory_write({action: "add", target: "memory", content: "..."})` is called from a session bound to topic `42`
- **THEN** the entry SHALL be appended to `topics/<chat>/42/memory.md`
- **AND** no other scope file SHALL be modified

#### Scenario: target=agent rejected for main agent

- **WHEN** `memory_write({action: "add", target: "agent", content: "..."})` is called from the main goblin agent
- **THEN** the tool SHALL return an error stating that `target = "agent"` is only valid for named subagents
- **AND** no file SHALL be modified

### Requirement: Memory reads support cross-scope retrieval

The `memory_read` tool SHALL accept an optional `scope` argument as a discriminated union. The accepted values are absent or `"active"`, `"general"`, `{topic: {chatId, topicId}}`, and `{agent: {name}}`. The `scope` argument SHALL NOT be a free-form string path. The `memory_read_index` tool SHALL return an object with three fields: `general` (the `general` scope's description, or `null` if unset), `topics` (an array of topic scopes with their IDs, best-effort Telegram names, and descriptions), and `agents` (an array of named-agent persona scopes with their names and descriptions, only when called by the main goblin agent). It MUST NOT include archived or orphaned scopes.

> **Note:** The `memory_read` and `memory_read_index` behavior above is restated canon (existing implemented behavior) and is not modified by this change. It is included here as context for the new `memory_search` addition. Only the `memory_search` paragraph and its scenarios below are new in this change.

The system SHALL additionally expose a `memory_search` tool for ranked entry-level retrieval. `memory_search` SHALL accept a text query, optional `limit`, and optional `all_chats` boolean. Unlike `memory_read`, `memory_search` returns ranked entries rather than whole file bodies.

#### Scenario: Read from another topic

- **WHEN** `memory_read({target: "memory", scope: {topic: {chatId: -100123, topicId: 7}}})` is called from a session in topic `42` of chat `-100123`
- **AND** topic `7` has a non-empty `memory.md`
- **THEN** the tool SHALL return the contents of `topics/<chat>/7/memory.md`
- **AND** SHALL NOT modify any file

#### Scenario: Search returns entries rather than files

- **WHEN** `memory_search({query: "backups"})` matches two entries in a scope with five total entries
- **THEN** the tool SHALL return the two matching entries
- **AND** SHALL NOT return the unmatched full file body

#### Scenario: Index lists topics with descriptions

- **WHEN** `memory_read_index()` is called by the main goblin agent and topics `7`, `11`, and `42` exist in the calling chat
- **THEN** the response SHALL include a `general` field with the general scope's description (or `null` if unset)
- **AND** the `topics` array SHALL include each topic's `topicId`, `chatId`, best-effort `name`, and `description` (fields absent if unset)
- **AND** the `agents` array SHALL list named-agent persona scopes with their names and descriptions
- **AND** archived scopes SHALL be excluded

#### Scenario: Index omits agents for named subagents

- **WHEN** `memory_read_index()` is called by a named subagent
- **THEN** the response SHALL include `general` and `topics` fields
- **AND** the `agents` field SHALL be absent or empty

### Requirement: Cross-scope discovery defaults to the current chat

The `memory_read_index` tool and the snapshot's `## other scopes` section SHALL default to listing only scopes within the calling session's `chatId`. Topic scopes whose `chatId` differs from the caller's chat MUST NOT appear by default in either the index or the snapshot.

`memory_read_index` SHALL accept an optional boolean parameter `all_chats` (default `false`). When `all_chats: true`, the response SHALL include topic scopes from every `chatId` under `topics/`, with the chat id rendered alongside the topic id in each entry. The snapshot's `## other scopes` section is NOT influenced by this parameter — it is always current-chat-only — to keep per-turn context bounded.

The `general` scope and named-agent persona scopes are not chat-scoped and SHALL appear in every index response. In snapshots, `general` appears in the `## other scopes` section only when it is not the active scope (to avoid repeating the active scope). Named-agent persona scopes appear in `## other scopes` when the caller is the main goblin agent.

This default exists for two reasons: (1) `chatId` is a privacy boundary, not just an organizational one — facts in a household supergroup should not bleed into a personal DM by default; (2) bounding the index to the current chat keeps the snapshot's `## other scopes` payload small and predictable.

#### Scenario: Default index from chat A excludes chat B's topics

- **GIVEN** topics exist at `topics/A/1`, `topics/A/2`, and `topics/B/9`
- **WHEN** `memory_read_index()` is called from a session in chat `A`
- **THEN** the returned `topics` array SHALL contain entries for `A/1` and `A/2`
- **AND** the array SHALL NOT contain an entry for `B/9`
- **AND** the response SHALL include a `general` field (the `general` scope is always included regardless of chat filter)

#### Scenario: all_chats opt-in surfaces every topic

- **WHEN** `memory_read_index({all_chats: true})` is called from a session in chat `A`
- **THEN** the returned `topics` array SHALL include scopes from every `chatId` (e.g. both `A/1` and `B/9`)

#### Scenario: Snapshot other-scopes is current-chat regardless of opt-in

- **WHEN** the per-turn snapshot is built for a session in chat `A`
- **THEN** the `## other scopes` section SHALL list only `A/*` topics plus `general`
- **AND** SHALL NOT list topic scopes from any other `chatId`

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

The system SHALL maintain `$GOBLIN_HOME/state/memory/quarantine.jsonl` for rejected automatic candidates that are unsafe, low-confidence, or need review. Quarantine records SHALL include timestamp, source session, target scope, category, reason, and a redacted candidate preview. Quarantine contents MUST NOT appear in per-turn snapshots, `memory_read`, or `memory_read_index`.

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

### Requirement: Memory search ranks entries lexically

The system SHALL provide deterministic file-native memory search over curated memory entries. Search SHALL split memory files using the existing `\n§\n` delimiter, parse reflected-entry metadata when present, normalize query and entry text, and rank entries using lexical signals without embeddings or external indexes.

Text normalization SHALL lowercase both query and entry text, strip leading/trailing whitespace, and split on whitespace and punctuation into tokens. Unicode letters and digits SHALL be preserved as token characters; non-letter/digit code points act as token separators. No stemming, stop-word removal, or Unicode case folding beyond ASCII lowercasing is applied.

Search scoring SHALL consider token overlap, exact phrase matches, scope/target boosts, reflected-entry category, confidence metadata, and recency metadata when available. The relative signal ordering SHALL be: token overlap dominates, then exact phrase bonus, then scope/target/category boosts, then recency as a tiebreaker. Concrete weights are implementation-defined and SHALL be pinned by unit tests that assert the relative ordering of these named signals. Search MUST NOT modify any memory file.

The `limit` parameter SHALL default to 10 when absent and SHALL be clamped to the range `[1, 50]`. Values `<= 0` SHALL be treated as the default (10); values `> 50` SHALL be clamped to 50.

#### Scenario: Search active memory by keyword

- **WHEN** `memory_search({query: "homelab backups"})` is called from a session whose active scope contains matching entries
- **THEN** the tool SHALL return ranked entry results from the active scope
- **AND** SHALL include each result's scope id, target, score, and entry text

#### Scenario: Search parses reflected metadata

- **WHEN** a matching entry begins with a reflected metadata comment
- **THEN** the search result SHALL include parsed metadata fields such as category, confidence, source session, and updated timestamp
- **AND** the result text SHALL be the human-readable entry body without the metadata comment

#### Scenario: No matches

- **WHEN** no searched entry has lexical overlap with the query
- **THEN** `memory_search` SHALL return an empty results array
- **AND** SHALL NOT throw

#### Scenario: Empty or whitespace query rejected

- **WHEN** `memory_search({query: "   "})` or `memory_search({query: ""})` is called
- **THEN** the tool SHALL return a validation error
- **AND** SHALL NOT scan any memory file

#### Scenario: Invalid limit clamped

- **WHEN** `memory_search({query: "backups", limit: 0})` is called
- **THEN** the tool SHALL behave as if `limit = 10` was supplied
- **AND** SHALL NOT return more than 10 results

#### Scenario: Limit capped at maximum

- **WHEN** `memory_search({query: "backups", limit: 999})` is called
- **THEN** the tool SHALL return at most 50 results

### Requirement: Memory search defaults to current chat scopes

Memory search SHALL default to searching `user.md`, the active scope, the current chat's topic scopes, and eligible named-agent persona scopes. "Eligible named-agent persona scopes" SHALL mean: all `agents/<name>/memory.md` persona scopes when the caller is the main goblin agent, and only the calling named subagent's own persona scope when the caller is a named subagent. Anonymous subagents SHALL NOT search any named-agent persona scope. Topic scopes from other chats MUST NOT be searched unless `all_chats = true` is supplied. The search input SHALL NOT accept free-form filesystem paths.

#### Scenario: Same-chat topics searched by default

- **WHEN** `memory_search({query: "deployment"})` is called from chat `-100123` topic `42` by the main goblin agent
- **THEN** the search SHALL consider `user.md`, `topics/-100123/42/memory.md`, other topic scopes under `topics/-100123/`, general memory, and every `agents/<name>/memory.md` persona scope
- **AND** SHALL NOT consider topic scopes under a different chat id

#### Scenario: Named subagent searches own persona only

- **WHEN** `memory_search({query: "deployment"})` is called by named subagent `researcher`
- **THEN** the search SHALL consider `user.md`, the parent active scope, same-chat topic scopes, and `agents/researcher/memory.md`
- **AND** SHALL NOT consider other named-agent persona scopes such as `agents/writer/memory.md`

#### Scenario: Cross-chat search opt-in

- **WHEN** `memory_search({query: "deployment", all_chats: true})` is called
- **THEN** the search SHALL include topic scopes from any chat
- **AND** each result SHALL identify its source scope
- **AND** persona scope eligibility rules SHALL remain unchanged by `all_chats`

#### Scenario: Result limit applied

- **WHEN** `memory_search` is called with `limit = 3`
- **THEN** the returned results SHALL contain at most three entries after ranking

### Requirement: Snapshot may include relevant memory

The snapshot formatter SHALL optionally accept the current prompt text and include a bounded `## relevant memory` section when lexical search finds entries relevant to that prompt. This section SHALL be omitted when no prompt text is supplied, when no relevant entries are found, or when all memory sources are empty. The existing `## user.md`, `## memory.md`, and `## other scopes` sections SHALL remain available and unchanged in meaning.

The relevant-memory limit SHALL default to 3 entries when no limit is supplied and SHALL be clamped to a maximum of 5. The full snapshot section order SHALL be: `## scope`, `## user.md`, `## memory.md`, `## relevant memory`, `## other scopes`. The `## relevant memory` section SHALL sit between `## memory.md` and `## other scopes`.

The `## relevant memory` section SHALL skip any entry whose display text already appears verbatim in the active scope's `## memory.md` body, so the active scope is not duplicated. Entries from other scopes, `user.md`, or persona scopes that do not verbatim-match the active body SHALL be included normally.

#### Scenario: Prompt-specific relevant memory included

- **WHEN** a new prompt mentions a phrase that matches an entry in another same-chat topic scope
- **THEN** the snapshot SHALL include a `## relevant memory` section with the matching entry and scope id
- **AND** the active `## memory.md` section SHALL still contain only the active scope's body

#### Scenario: No query omits relevant memory

- **WHEN** the snapshot formatter is called without current prompt text
- **THEN** the snapshot SHALL omit `## relevant memory`

#### Scenario: Relevant memory is bounded

- **WHEN** more than the configured relevant-memory result limit matches the prompt
- **THEN** the snapshot SHALL include only the highest-ranked bounded set
- **AND** the default bound SHALL be 3 entries

#### Scenario: Relevant memory deduplicates active scope

- **GIVEN** the active scope's `## memory.md` body contains an entry whose text matches a search result verbatim
- **WHEN** the snapshot formatter builds `## relevant memory`
- **THEN** that entry SHALL be omitted from `## relevant memory`
- **AND** entries from other scopes that do not verbatim-match the active body SHALL still appear

#### Scenario: Follow-up steering does not inject relevant memory

- **WHEN** `AgentRunner.followUp()` is called with steer text
- **THEN** no new snapshot SHALL be injected
- **AND** no `## relevant memory` section SHALL be computed or appended for the steer

#### Scenario: Section order preserved

- **WHEN** the snapshot includes `## relevant memory`
- **THEN** the section order SHALL be `## scope`, `## user.md`, `## memory.md`, `## relevant memory`, `## other scopes`

### Requirement: Reflection categorizes explicit commitments and standing orders

The reflection pipeline SHALL support `commitment` and `standing_order` entry categories for explicit durable statements. Extraction SHALL remain deterministic and MUST NOT infer commitments from vague intent or ordinary task requests.

#### Scenario: Explicit commitment candidate

- **WHEN** a transcript entry contains an explicit durable commitment such as `I commit to reviewing invoices every Friday`
- **THEN** the default candidate extractor SHALL produce a `commitment` memory candidate

#### Scenario: Explicit standing order candidate

- **WHEN** a transcript entry contains an explicit durable instruction such as `standing order: remind me to check backups weekly`
- **THEN** the default candidate extractor SHALL produce a `standing_order` memory candidate

#### Scenario: Vague request is not inferred

- **WHEN** a transcript entry says `I should probably check backups sometime`
- **THEN** the default candidate extractor SHALL NOT produce a commitment or standing-order candidate solely from that vague text

### Requirement: Active-scope-to-memory-scope conversion has one home

The system SHALL provide the `ActiveScope → MemoryScope` conversion in exactly one module: `src/memory/scope.ts`. The conversion SHALL be exported from `scope.ts` and imported by every consumer. No other module SHALL define a private `activeMemoryScopeFor` or `activeMemoryScope` function.

The four existing private copies (`reflector.ts:450`, `tool.ts:340`, `snapshot.ts:172`, `search.ts:306`) SHALL be removed and replaced with imports from `scope.ts`.

#### Scenario: Single source for the conversion

- **WHEN** any module needs to convert an `ActiveScope` to a `MemoryScope`
- **THEN** it SHALL import the conversion from `src/memory/scope.ts`
- **AND** SHALL NOT define its own copy of the function

#### Scenario: Existing consumers are unchanged in behavior

- **WHEN** the conversion is centralized
- **THEN** each of `reflector.ts`, `tool.ts`, `snapshot.ts`, and `search.ts` SHALL resolve the same `MemoryScope` for a given `ActiveScope` as before
- **AND** no memory file path or scope tag SHALL change

### Requirement: Memory context assembly is caller-typed

The system SHALL provide a memory-context module that builds the memory context for a given caller behind a caller-typed interface, rather than exposing raw policy knobs (`includePersona`, `includeAgents`, `persona`, `promptText`) at every call site.

The module SHALL own caller-kind discrimination (main goblin / named subagent / anonymous subagent), active-scope resolution (via the centralized conversion from `Active-scope-to-memory-scope conversion has one home`), persona policy, relevant-memory retrieval, and snapshot formatting. Callers SHALL pass a caller descriptor, not a bag of policy knobs.

The visibility rules SHALL be preserved exactly as they exist today:
- The main goblin agent sees `user.md`, the active scope, same-chat topic scopes, and every named-agent persona scope.
- A named subagent sees `user.md`, the parent active scope, same-chat topic scopes, and its own persona scope only.
- An anonymous subagent sees `user.md`, the parent active scope, and same-chat topic scopes, and SHALL NOT see any named-agent persona scope.

#### Scenario: Main goblin agent context includes all personas

- **WHEN** the context is built for the main goblin agent in a topic-bound session
- **THEN** the assembled context SHALL include `user.md`, the active topic scope, same-chat topic scopes, and every named-agent persona scope

#### Scenario: Named subagent context includes only its own persona

- **WHEN** the context is built for a named subagent `researcher` spawned from a topic-bound parent
- **THEN** the assembled context SHALL include `user.md`, the parent's active scope, same-chat topic scopes, and `agents/researcher/memory.md`
- **AND** SHALL NOT include other named-agent persona scopes such as `agents/writer/memory.md`

#### Scenario: Anonymous subagent context excludes all personas

- **WHEN** the context is built for an anonymous subagent
- **THEN** the assembled context SHALL include `user.md`, the parent's active scope, and same-chat topic scopes
- **AND** SHALL NOT include any named-agent persona scope

#### Scenario: Callers pass a descriptor, not policy knobs

- **WHEN** `AgentRunner` or a subagent execution path requests the per-turn memory context
- **THEN** it SHALL pass a caller descriptor identifying the caller kind and (for named subagents) the agent name
- **AND** SHALL NOT pass `includeAgents`, `includePersona`, or `persona` knobs directly into `formatSnapshot` or `searchMemoryEntries`
