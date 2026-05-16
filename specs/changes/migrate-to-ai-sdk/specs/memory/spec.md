# memory

## MODIFIED Requirements

### Requirement: memory tool exposes add, replace, remove

The system SHALL expose a single mutator tool named `memory_write` defined via AI SDK's `tool()` helper with a zod schema accepting an `action` parameter of `"add" | "replace" | "remove" | "rewrite" | "set_description"` and a `target` parameter of `"memory" | "user" | "agent"`.

The `execute` function signature SHALL be `async (params, options) => result` where `params` is typed from the zod schema and `options` contains `{ abortSignal, messages }`. The tool behavior (add, replace, remove, rewrite, set_description) SHALL be identical to the pi-based implementation — only the tool definition wrapper and schema library change.

- `add` requires `content`. Appends a new entry to the resolved file.
- `replace` requires `old_text` and `content`. Substring-matches `old_text` and substitutes `content`.
- `remove` requires `old_text`. Substring-matches and removes the containing entry.
- `rewrite` requires `content`. Replaces the entire body (preserving frontmatter) with `content`. Subject to the cap.
- `set_description` requires `description`. Updates the `description` frontmatter without touching entries. Limited to one line, ≤200 characters.

The tool MUST NOT accept a `scope` argument. The active scope is derived from the calling session's `(chatId, topicId)` and named-agent identity.

#### Scenario: Add operation in active scope

- **WHEN** the tool is called with `{action: "add", target: "memory", content: "..."}`
- **THEN** the content SHALL be appended as a new entry to the active scope's `memory.md`

#### Scenario: Rewrite operation

- **WHEN** the tool is called with `{action: "rewrite", target: "memory", content: "<full body>"}`
- **THEN** the active scope's `memory.md` body SHALL be replaced with `<full body>`
- **AND** any existing frontmatter `description` line SHALL be preserved

#### Scenario: Missing required arg

- **WHEN** the tool is called with `{action: "replace", target: "user", content: "..."}` and no `old_text`
- **THEN** the tool SHALL return a validation error and MUST NOT write to disk

#### Scenario: Abort signal forwarded

- **WHEN** the tool receives `options.abortSignal` and the signal is aborted during a file write
- **THEN** the tool SHALL stop processing and propagate the abort

### Requirement: Memory reads support cross-scope retrieval

The `memory_read` tool SHALL be defined via AI SDK's `tool()` helper with a zod schema. The tool SHALL accept an optional `scope` argument as a discriminated union:

- absent or `"active"` — the calling session's active scope (default).
- `"general"` — the general scope file.
- `{topic: {chatId: <chatId>, topicId: <topicId>}}` — a topic scope (chatId must match the caller's chat).
- `{agent: {name: <name>}}` — a named-agent persona scope.

The `memory_read_index` tool SHALL be defined via AI SDK's `tool()` helper with a zod schema. It SHALL return an object with three fields: `general`, `topics`, and `agents`.

#### Scenario: Read from another topic

- **WHEN** `memory_read({target: "memory", scope: {topic: {chatId: -100123, topicId: 7}}})` is called from a session in topic `42` of chat `-100123`
- **AND** topic `7` has a non-empty `memory.md`
- **THEN** the tool SHALL return the contents of `topics/<chat>/7/memory.md`

#### Scenario: Index lists topics with descriptions

- **WHEN** `memory_read_index()` is called and topics `7`, `11`, and `42` exist in the calling chat
- **THEN** the response SHALL include a `general` field, a `topics` array with each topic's metadata, and an `agents` array
- **AND** archived scopes SHALL be excluded
