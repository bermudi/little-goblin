# Memory tools merged into search and write

## Status

accepted

## Context

The current memory surface exposes four tools (`memory_read`, `memory_read_index`, `memory_search`, `memory_write`). The tool definitions cost tokens per turn and overlap in functionality. A two-tool surface reduces token usage while keeping the same recall and mutation capabilities.

## Decision

- The `memory_read` and `memory_read_index` tools SHALL be removed.
- `memory_search` SHALL subsume them: with `query` omitted and `scope` provided it returns entries; with `query` omitted and no `scope` it returns the index.
- `memory_write` SHALL remain as the sole mutation tool and SHALL resolve its `target` to the active `(scope, entry_kind)` pair.
- The `memory_search` tool SHALL support `corpus` (`"memory"`, `"transcripts"`, `"all"`) and `all_chats` parameters.

## Consequences

- Tool-definition token cost drops by roughly one third.
- The agent's recall interface is simpler: one tool to read, one tool to write.
- `memory_search` without a query behaves differently depending on `scope` presence, which must be documented in the tool description.
