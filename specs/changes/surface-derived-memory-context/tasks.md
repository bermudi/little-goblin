# surface-derived-memory-context — Tasks

## Phase 1: Establish Surface-derived memory authority

- [x] Verify `telegram-surface-identity` provides canonical `Surface`, `SurfaceId`, `surfaceId`, and `parseSurfaceId` APIs before changing memory authority.
- [x] Replace the locator-based projection in `src/memory/scope.ts` with exhaustive `resolveActiveScope(surface)` handling for every topic container, DM, topicless supergroup, and guest; keep ActiveScope-to-MemoryScope conversion in the same module.
- [x] Remove named-agent identity from `ActiveScope` and make `MemoryCaller` the sole persona/visibility authority.
- [x] Add Surface-backed captured authority and explicit Surface-free internal context types in `src/memory/runtime-context.ts`; reject zero-chat compatibility values as Telegram identity.
- [x] Update memory fixtures and conversion consumers without changing curated keys or caller visibility, and add exhaustive projection/internal-boundary tests.
- [x] Run focused scope/context/runtime-context tests and `bun run typecheck`.

## Phase 2: Capture memory before runtime registration

- [x] Implement `captureRuntimeMemoryContext` so source SurfaceId, ActiveScope, caller, frozen summary, and deduplication bodies are complete before it resolves.
- [x] Refactor snapshot formatting to consume immutable capture inputs and prove post-capture memory writes cannot alter frozen summary text or deduplication bodies.
- [x] Require `CapturedMemoryContext` in `AgentRunnerOptions`; remove locator, binding, and raw memory-policy inputs from summary, relevant-memory, and tool construction.
- [x] Make dispatcher runtime creation await capture, deduplicate concurrent creation with one in-flight promise per compatibility runtime identity, and register only completed runners.
- [x] Recheck the current runtime/binding generation after capture so stale or failed captures cannot become current; update all affected callers to await creation.
- [x] Add capture-timing, lazy-init, concurrent-create, failure, stale-guard, and replacement-runtime tests; run focused snapshot/agent/dispatcher tests and `bun run typecheck`.

## Phase 3: Enforce captured search and tool boundaries

- [ ] Make frozen cross-scope discovery, scope index, relevant-memory assembly, and Surface-backed transcript filtering derive chat only from captured ActiveScope.
- [ ] Preserve explicit `all_chats`, existing caller visibility, ranking/result schemas, summary/relevant-memory bounds, and explicit internal all-transcript search without constructing a Surface.
- [ ] Make `memory_write target = memory` consume captured ActiveScope and `target = agent` consume caller identity; reject model-supplied scope, Surface, chat, Conversation, and policy fields.
- [ ] Keep main, generic-subagent, and named-subagent memory tool schemas identical and preserve caller-supplied AgentRunner tools.
- [ ] Add moved-destination discovery, general/guest, persona parity, internal search, schema parity, and frozen-summary tests; run focused memory tool/search/snapshot tests and `bun run typecheck`.

## Phase 4: Capture subagent invocation context

- [ ] Replace subagent locator/live-`activeScope` inputs with parent `SurfaceMemoryAuthority`, deriving generic or named caller descriptors separately.
- [ ] Capture a fresh invocation-lifetime frozen summary at spawn and recursively pass the same inherited Surface authority to children.
- [ ] Close spawn and nested tool factories over the invocation capture; remove binding access from subagent execution and memory tools.
- [ ] Require revival callers to provide the reviving parent's capture, preserve pi history, and treat persisted legacy `activeScope` as audit/migration metadata only.
- [ ] Keep internal dreaming extraction outside ordinary subagent memory capture and tool registration.
- [ ] Add single-harness subagent suites for movement after spawn, recursive inheritance, named persona separation, revival after movement/restart, missing parent context, legacy metadata, and internal exclusion; run `bun test src/subagents/mod.test.ts` and `bun run typecheck`.

## Phase 5: Remove duplicate authority paths

- [ ] Remove locator-based `resolveActiveScope`, duplicate Surface/ActiveScope conversions, live subagent-meta resolution, and raw caller-policy construction paths.
- [ ] Add static boundary tests proving memory scope code depends on Surface identity and subagent execution cannot resolve current bindings.
- [ ] Add an integration fixture proving one source Surface capture remains frozen across main runtime tools and recursive subagents, while a replacement runtime captures destination context.
- [ ] Verify capture failures and invalid/internal authority paths emit bounded structured logs; run `bun test`, `bun run typecheck`, and `litespec validate surface-derived-memory-context --strict`.
