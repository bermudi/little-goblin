# memory

## ADDED Requirements

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

## MODIFIED Requirements

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
