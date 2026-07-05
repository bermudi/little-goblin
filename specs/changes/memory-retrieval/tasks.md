# memory-retrieval tasks

## Phase 1: Add lexical search core

- [x] Create `src/memory/search.ts` with entry enumeration, metadata parsing, lexical scoring, ranking, and limit enforcement for `Memory search ranks entries lexically`.
- [x] Add `src/memory/search.test.ts` coverage for active-scope matches, metadata parsing, no matches, limits, deterministic ordering, empty/whitespace query rejection, invalid limit clamping, and the relative signal ordering (overlap > exact phrase > boosts > recency) with crafted entries that isolate each signal.
- [x] Run `bun test src/memory/search.test.ts`.
- [x] Run `bun run typecheck`.

## Phase 2: Add memory_search tool

- [x] Add `createMemorySearchTool` and schema validation to `src/memory/tool.ts` for `Memory reads support cross-scope retrieval`.
- [x] Export the search tool and types from `src/memory/mod.ts`.
- [x] Add tool tests for default same-chat scope boundaries, `all_chats`, empty query rejection, invalid limit clamping, persona scope eligibility (main agent vs named subagent vs anonymous), and entry-level results.
- [x] Run `bun test src/memory/tool.test.ts src/memory/search.test.ts`.
- [x] Run `bun run typecheck`.

## Phase 3: Register memory_search in AgentRunner

- [ ] Register `memory_search` in `src/agent/mod.ts` between `memory_read_index` and `memory_write` for `AgentRunner registers the memory write tool`.
- [ ] Update `src/agent/mod.test.ts` assertions for the four memory tools while preserving caller-supplied tool ordering.
- [ ] Add tests asserting persona scope eligibility: main agent searches all persona scopes, named subagent searches own only, anonymous searches none.
- [ ] Run `bun test src/agent/mod.test.ts`.
- [ ] Run `bun run typecheck`.

## Phase 4: Add prompt-relevant snapshot memory

- [ ] Extend `formatSnapshot` to accept optional prompt text and append bounded `## relevant memory` for `Snapshot may include relevant memory`.
- [ ] Implement verbatim dedup against the active `## memory.md` body and the full section order (`## scope`, `## user.md`, `## memory.md`, `## relevant memory`, `## other scopes`).
- [ ] Pass prompt text from `AgentRunner.prompt()` for string and text-block prompts without changing `followUp()` snapshot behavior.
- [ ] Add snapshot and agent tests for relevant-memory inclusion, omission without prompt text, bounded output (default 3, max 5), verbatim dedup of active scope, section order, and no snapshot injection on follow-up.
- [ ] Run `bun test src/memory/snapshot.test.ts src/agent/mod.test.ts`.
- [ ] Run `bun run typecheck`.

## Phase 5: Add explicit commitment categories

- [ ] Extend `EntryCategory` parsing/formatting in `src/memory/entry.ts` with `commitment` and `standing_order`.
- [ ] Add deterministic reflection rules for explicit commitment and standing-order phrasing in `src/memory/reflector.ts`.
- [ ] Add tests for new categories, explicit extraction, and vague-intent non-extraction.
- [ ] Run `bun test src/memory/entry.test.ts src/memory/reflector.test.ts`.
- [ ] Run `litespec validate memory-retrieval`.
- [ ] Run `bun test`.
- [ ] Run `bun run typecheck`.
