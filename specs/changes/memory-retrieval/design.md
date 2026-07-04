# memory-retrieval design

## Architecture

This change adds a pure, file-native search layer on top of the existing `MemoryStore`. It does not alter memory storage, caps, git commits, safety filtering, or scope resolution for writes.

The new search flow is:

1. `memory_search` receives a query, optional limit, and optional `all_chats` flag.
2. The tool resolves the caller's active scope and chat boundary using the same `ActiveScope` already passed to memory tools.
3. A new search helper enumerates eligible scopes by combining `user.md`, `general/memory.md`, active topic scope, same-chat topic scopes from `MemoryStore.listIndex`, and named-agent persona scopes per the eligibility rules. `MemoryStore.listIndex` already returns chat-scoped topic listings (per canon `Cross-scope discovery defaults to the current chat`); no `listIndex` signature change is required. Persona scope enumeration uses the same `agents/` directory listing that `memory_read_index` already performs for the main agent.
4. Each memory file body is split by the existing `\n§\n` delimiter.
5. Each entry is parsed with `parseEntryMetadata`; reflected metadata is returned separately and stripped from the display text.
6. The query and entry text are normalized to lexical tokens.
7. Entries are scored and sorted deterministically.
8. The tool returns a JSON result containing query, searched scope count, and ranked entries.

Agent registration stays in `AgentRunner.init()`, where memory tools are currently appended after caller-supplied tools. The new tool is added between `memory_read_index` and `memory_write` so the model sees read/index/search before write.

Prompt-time relevant memory is optional and bounded. `AgentRunner.prompt()` can pass the current user text into `formatSnapshot(...)`. The formatter can call the same lexical search helper and append a `## relevant memory` section when matches exist. Follow-up steering remains unchanged: it does not inject a new snapshot.

Reflection category expansion is local to the existing deterministic extractor and metadata parser. The storage format remains the same HTML metadata comment plus human-readable body.

## Decisions

### File-native lexical search first

Chosen: implement lexical scoring over existing Markdown memory files.

Why: it improves practical recall without adding SQLite, embeddings, provider keys, index sync, or background indexing. Memory files are character-capped and scoped, so full file scans are acceptable for this single-user homelab shape.

Constraints: search quality is lexical rather than semantic. If this proves insufficient, a later semantic-memory proposal can add embeddings without changing the `memory_search` tool contract radically.

Spec links: `Memory search ranks entries lexically`, `Memory search defaults to current chat scopes`.

### Search entries, not files

Chosen: split files by the existing delimiter and return matching entries.

Why: returning whole files repeats the current `memory_read` weakness. Entry-level results are more compact and better suited to tool use and snapshot relevance.

Constraints: legacy plain entries and reflected metadata entries must both be supported.

Spec links: `Memory reads support cross-scope retrieval`.

### Default to current chat boundaries

Chosen: default search scope mirrors the existing cross-scope index boundary: current chat plus global user/general memory.

Why: topic memories are chat-scoped. Searching every chat by default would leak irrelevant context and violate existing progressive-disclosure expectations.

Constraints: an explicit `all_chats` option can broaden search for deliberate agent lookup.

Spec links: `Memory search defaults to current chat scopes`, `Cross-scope discovery defaults to the current chat` in canon.

### Keep scoring deterministic

Chosen: score using normalized token overlap, exact phrase bonus, target/scope boosts, category boosts, confidence, and updated_at recency when metadata exists. Concrete weights are implementation-defined; the spec pins only the relative signal ordering (overlap > exact phrase > boosts > recency). Unit tests in `search.test.ts` SHALL assert this relative ordering with crafted entries that isolate each signal.

Why: deterministic scoring is testable, cheap, and consistent with existing deterministic reflection. It avoids turning memory retrieval itself into another model call.

Constraints: scoring constants should live in one search module and be covered with direct unit tests.

Spec links: `Memory search ranks entries lexically`.

### Text normalization

Chosen: lowercase ASCII, strip leading/trailing whitespace, split on whitespace and punctuation into tokens. Unicode letters and digits are token characters; everything else is a separator. No stemming, no stop-word removal, no Unicode case folding beyond ASCII.

Why: simple, deterministic, testable. Handles the homelab's mostly-English memory corpus without false matches from aggressive normalization.

Constraints: non-ASCII scripts still tokenize by letter/digit runs, so accented and CJK text work but receive no special handling.

Spec links: `Memory search ranks entries lexically`.

### Include relevant memory in snapshots only when prompt text is available

Chosen: `formatSnapshot` gains optional prompt text and relevant-memory options, but existing callers that omit prompt text keep the same snapshot shape. The relevant-memory limit defaults to 3 and is clamped to a maximum of 5. The full snapshot section order is `## scope`, `## user.md`, `## memory.md`, `## relevant memory`, `## other scopes`. Deduplication: skip any search result whose display text already appears verbatim in the active scope's `## memory.md` body; entries from other scopes, `user.md`, or persona scopes that do not verbatim-match the active body are included normally.

Why: this improves recall for new turns while preserving backwards-compatible snapshot behavior for tests and non-prompt callers. Verbatim dedup is the safest choice given the spec's "SHALL remain available and unchanged in meaning" constraint on `## memory.md`.

Constraints: follow-up steering (`AgentRunner.followUp()`) does not inject a new snapshot, so `## relevant memory` is never computed for steers.

Spec links: `Snapshot may include relevant memory`, `AgentRunner injects memory snapshot as per-turn aside` in canon.

### Add explicit commitment categories without inference

Chosen: extend `EntryCategory` with `commitment` and `standing_order`, and add deterministic regex rules for explicit phrasing only.

Why: scheduled-turns can later search for explicit standing orders without requiring inferred obligations in this proposal.

Constraints: vague intent like `I should probably...` remains ignored.

Spec links: `Reflection categorizes explicit commitments and standing orders`.

## File Changes

### `src/memory/search.ts`

Create a pure search module that exports:

- `MemorySearchInput`
- `MemorySearchResult`
- `searchMemoryEntries(...)`
- normalization/scoring helpers as needed for tests

Responsibilities:

- enumerate eligible scopes using `MemoryStore` and `ActiveScope`;
- split entries by `\n§\n`;
- parse and strip metadata with `parseEntryMetadata` / `stripEntryMetadata`;
- score and sort entries deterministically;
- enforce `limit` after ranking;
- never mutate files.

Relates to `Memory search ranks entries lexically` and `Memory search defaults to current chat scopes`.

### `src/memory/search.test.ts`

Add focused tests for:

- active-scope keyword match;
- same-chat topic inclusion and other-chat exclusion;
- `all_chats` inclusion;
- reflected metadata parsing;
- result limit;
- no-match empty results;
- deterministic ordering.

Relates to all memory search scenarios.

### `src/memory/tool.ts`

Add a `memorySearchSchema` and `createMemorySearchTool(...)`. The tool should accept:

- `query: string`
- `limit?: number`
- `all_chats?: boolean`

The tool should call `searchMemoryEntries(...)` with the active scope and return JSON. It should reject empty/whitespace-only queries with a validation or tool error.

Relates to `Memory reads support cross-scope retrieval`.

### `src/memory/mod.ts`

Export `createMemorySearchTool` and search result types.

Relates to `AgentRunner registers the memory write tool`.

### `src/agent/mod.ts`

Import and register `createMemorySearchTool` between `createMemoryReadIndexTool` and `createMemoryWriteTool` in the existing memory tool list.

Also pass prompt text into `formatSnapshot(...)` for plain text prompts and text blocks extracted from multimodal prompts. Follow-up steering stays unchanged.

Relates to `AgentRunner registers the memory write tool` and `Snapshot may include relevant memory`.

### `src/agent/mod.test.ts`

Update memory tool registration tests to expect `memory_search`. Add or adjust snapshot tests for prompt-specific relevant memory and unchanged follow-up behavior.

Relates to the agent spec delta and snapshot scenarios.

### `src/memory/snapshot.ts`

Extend `FormatSnapshotArgs` with optional prompt text and relevant-memory limit. When prompt text is present, call `searchMemoryEntries(...)` and append a bounded `## relevant memory` section after `## memory.md` and before `## other scopes`.

Existing calls without prompt text should continue to omit `## relevant memory`.

Relates to `Snapshot may include relevant memory`.

### `src/memory/snapshot.test.ts`

Add tests for relevant-memory inclusion, omission without prompt text, and bounded output.

Relates to `Snapshot may include relevant memory`.

### `src/memory/entry.ts`

Extend `EntryCategory` and category parsing with `commitment` and `standing_order`.

Relates to `Reflection categorizes explicit commitments and standing orders`.

### `src/memory/entry.test.ts`

Add parser/formatter tests for the new categories.

Relates to `Reflection categorizes explicit commitments and standing orders`.

### `src/memory/reflector.ts`

Add deterministic extraction rules for explicit commitment and standing-order phrasing. Keep vague intent excluded by rule shape and existing procedural-noise handling.

Relates to `Reflection categorizes explicit commitments and standing orders`.

### `src/memory/reflector.test.ts`

Add tests for explicit commitment extraction, explicit standing-order extraction, and non-extraction for vague intent.

Relates to `Reflection categorizes explicit commitments and standing orders`.

### `specs/glossary.md`

Glossary entries for `memory_search`, `standing order`, and `commitment` are deferred until wording stabilizes across both `memory-retrieval` and `scheduled-turns`. This deferral is tracked in `specs/backlog.md` so the work is not lost when this change archives.
