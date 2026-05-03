# Scoped Memory — Tasks

## Phase 1: Scope types and path resolution

- [x] Create `src/memory/scope.ts`:
  - Export `MemoryScope` discriminated union: `"general" | {topic: {chatId: number; topicId: number}} | {agent: {name: string}}`.
  - Export `ActiveScope` bundle: `{topicScope: {chatId, topicId} | "general"; namedAgent: {name: string} | null}`.
  - Export `resolveActiveScope(locator: ChatLocator, namedAgent?: string): ActiveScope`.
  - Export `scopeTag(scope: MemoryScope): string` — returns `"user"`, `"general"`, `"topics/<chat>/<topic>"`, or `"agents/<name>"` for git commit subjects. Note `"user"` is not in the union but `scopeTag` accepts it as a special-case input alongside `MemoryScope` values used in commit subjects.
- [x] Update `src/memory/paths.ts`:
  - Replace `memoryFilePath` / `userFilePath` with:
    - `scopeMemoryPath(home: string, scope: MemoryScope): string`.
    - `userPath(home: string): string`.
    - `archiveTopicPath(home: string, chatId: number, topicId: number): string`.
  - Internal helper `topicScopeDir(home, chatId, topicId)` for parent-dir creation.
- [x] Unit tests in `src/memory/scope.test.ts`:
  - `resolveActiveScope` for DM (no topicId), topic, and named subagent forms.
  - `scopeTag` for every scope kind including `"user"`.
- [x] Unit tests in `src/memory/paths.test.ts`:
  - Path resolution for each scope kind.
  - Archive path mirrors topic path under `archive/`.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 1: scope types, scope.ts, paths.ts updates`

## Phase 2: MemoryStore refactor

- [x] Rewrite `src/memory/store.ts` around the new layout:
  - `MemoryStore.add(scope, content)`, `replace(scope, oldText, content)`, `remove(scope, oldText)`, `rewrite(scope, body)`, `setDescription(scope, description)`. Each funnels into a private `mutate(scope, op)` helper.
  - `mutate` is the single chokepoint: resolve path → read current → apply op → validate body cap (4000 / 2000) → atomic write (tmp + rename) → single git commit with `memory: <action> in <scopeTag>` subject.
  - `read(scope): {description?: string; body: string}` — parses frontmatter `--- description: ... ---` and returns the body separately.
  - `listIndex({chatId?: number; includeAgents: boolean}): {topics: Array<{topicId, chatId, description}>; agents: Array<{name, description}>}`. Default `chatId` filter is the caller's; `chatId` undefined or explicit `all_chats: true` returns everything. Excludes `archive/` subtrees.
  - `archiveOrphan(chatId, topicId): boolean` — moves `topics/<chat>/<topic>/` to `archive/topics/<chat>/<topic>/` via `renameSync`. Returns `true` if moved, `false` if source missing (idempotent). Commits with subject `memory: archive orphan topics/<chat>/<topic>`.
- [x] Frontmatter parser:
  - Recognizes `--- description: <one-line> ---` followed by a blank line.
  - Description ≤ 200 chars, single line. Reject multi-line on write.
  - Body cap calculation excludes frontmatter bytes.
- [x] Cap enforcement is per-scope-file, applied to body length only.
- [x] Atomic-write primitive preserved (`tmp` in same dir, `renameSync`).
- [x] Update `src/memory/store.test.ts`:
  - Per-scope cap independence.
  - Frontmatter round-trip on every action.
  - `set_description` preserves body; empty description removes header.
  - `rewrite` preserves frontmatter.
  - Scope-tagged commit subjects (`memory: add in topics/-100/42`).
  - `archiveOrphan` happy path + missing-source idempotency.
  - `listIndex` filters by `chatId` by default; opt-in returns all.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 2: scope-aware MemoryStore with frontmatter, rewrite, archive`

## Phase 3: Snapshot formatter rewrite

- [x] Rewrite `src/memory/snapshot.ts`:
  - New signature: `formatSnapshot({store, activeScope, includePersona?: {name}, getTopicName?: (chatId, topicId) => Promise<string | null>}): Promise<string | null>`.
  - Section order: header, `## scope`, `## user.md`, `## memory.md`, optional `## agent persona`, optional `## other scopes`.
  - Empty source → `(empty)`. All-empty → `null`. `## other scopes` omitted if no peer scopes.
  - `## other scopes` is filtered to the active scope's `chatId` (current-chat default per the just-locked decision).
  - `getTopicName` is best-effort and async; on miss, render `topics/<chat>/<topic>` literal.
- [x] Update `src/memory/snapshot.test.ts`:
  - Topic-bound snapshot with peer topics renders index.
  - DM snapshot uses `general` and lists current-chat topics only.
  - Named-subagent snapshot includes `## agent persona`.
  - Cross-chat topics excluded from snapshot index.
  - All-empty returns `null`.
  - Partial-empty renders `(empty)` placeholders.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 3: snapshot formatter for scoped memory`

## Phase 4: Tool surface split (read / read_index / write)

- [x] Replace `createMemoryTool` in `src/memory/tool.ts` with three factories:
  - `createMemoryReadTool({store, activeScope})`:
    - Schema: `{target: "memory"|"user"|"agent", scope?: "active"|"general"|{topic:{chatId,topicId}}|{agent:{name}}}`.
    - Resolves `target=user` to `userPath` (ignores `scope`).
    - Resolves `target=memory` with `scope=active` (default) to active scope; otherwise to the supplied discriminated value (only same-`chatId` topic reads allowed by default; `all_chats` extension TBD if needed).
    - Resolves `target=agent` to `activeScope.namedAgent` for the read; reject with error if unset.
    - Returns `{description?: string, body: string}`.
  - `createMemoryReadIndexTool({store, activeChatId, includeAgents})`:
    - Schema: `{all_chats?: boolean}`.
    - Calls `store.listIndex({chatId: all_chats ? undefined : activeChatId, includeAgents})`.
    - Returns `{topics: [...], agents: [...]}`. `agents` always empty when `includeAgents=false`.
  - `createMemoryWriteTool({store, activeScope})`:
    - Schema: `{action: "add"|"replace"|"remove"|"rewrite"|"set_description", target: "memory"|"user"|"agent", content?: string, old_text?: string, description?: string}`. **No `scope` property.**
    - Resolver: `target=memory` → `activeScope.topicScope ?? generalScope`; `target=user` → user path; `target=agent` → `activeScope.namedAgent` or error.
    - Per-action required-arg validation (missing → tool error, no write).
    - Funnels into `MemoryStore` mutators.
- [x] Update `src/memory/tool.test.ts`:
  - Schema parity across runner types (write schema has no `scope` key).
  - `target=agent` rejected for callers without `namedAgent`.
  - `target=memory` from a topic-bound `activeScope` writes to that topic's scope.
  - `memory_read_index` default returns only current-chat topics; `all_chats: true` returns all.
  - `memory_read` with cross-topic `scope` reads but does not write.
  - Required-arg validation per action.
  - `set_description` with >200 chars rejected.
- [x] Update `src/memory/mod.ts` re-exports.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 4: split memory tool into read / read_index / write`

## Phase 5: AgentRunner integration

- [x] Update `AgentRunnerOptions` in `src/agent/mod.ts` to accept `locator: ChatLocator`.
- [x] In `init()` (or eagerly in constructor), build `activeScope` from `locator` via `resolveActiveScope(locator)`. `namedAgent: null` for the main agent.
- [x] Replace single `memory` tool registration with the three factories, each given `{store, activeScope}` (read tool also gets `includeAgents: true` for the index).
- [x] Replace `formatSnapshot(this.memoryStore)` call with the new async signature, passing `getTopicName` that calls `bot.api.getForumTopic` lazily with a small in-memory cache (cache lives on the runner).
- [x] Update `src/agent/mod.test.ts`:
  - Runner registers exactly three memory tools plus any `customTools`.
  - Snapshot building integrates `activeScope` for DM (`general`) vs topic.
  - System prompt unchanged across turns despite memory writes.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 5: AgentRunner uses scoped memory tools and snapshot`

## Phase 6: SubagentRunner integration

- [x] In `src/subagents/runner.ts` (the `SubagentRunner.spawn` path) and `src/subagents/execution.ts` (where `customTools` is assembled inside `_runInstanceInner` via `ExecutionDeps.buildTools`):
  - Anonymous: `activeScope = parent.activeScope` verbatim. `namedAgent: null`.
  - Named: `activeScope = {topicScope: parent.activeScope.topicScope, namedAgent: {name: <sanitized>}}`.
  - Register the same three memory tool factories with the child's `activeScope`.
- [x] When dispatching the per-turn snapshot for a subagent (via `sendCustomMessage`), use `formatSnapshot` with `includePersona: {name}` for named subagents only.
- [x] Subagent tests in `src/subagents/mod.test.ts`:
  - Anonymous subagent in topic writes to parent's topic scope.
  - Named subagent persona file populated by `target: agent` writes; not affected by `target: memory` writes.
  - `target=agent` rejected for anonymous.
  - Tool schemas byte-identical to the main agent's.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 6: SubagentRunner inherits parent scope, named subagents get persona`

## Phase 7: Bot-layer wiring + orphan archival

- [x] In `src/bot.ts`, pass `locator` to every `new AgentRunner({...})` call site (the `/new` branch and the lazy first-message construction).
- [x] Identify the failure path where Telegram returns "topic not found" (likely the `MessageBuffer` flush via `bot.api.editMessageText` / `sendMessage`). Add a hook that:
  - Catches the specific error class / description fragment.
  - Calls `memoryStore.archiveOrphan(chatId, topicId)` once.
  - Continues to propagate the original error so the rest of the pipeline behaves unchanged.
- [ ] Manual smoke test: create a topic, send a message to populate `topics/<chat>/<topic>/memory.md`, delete the topic in Telegram, send another message, verify the directory is moved to `archive/topics/`.
- [x] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 7: bot.ts threads locator and archives orphan scopes`

## Phase 8: Validation and archive

- [x] `litespec validate scoped-memory --strict`.
- [x] `litespec preview scoped-memory` to inspect canonical spec diff.
- [x] Verify decision 0002 `topic-ui-is-user-owned` is referenced by the design (already true).
- [x] Update glossary entries (memory scope, active scope, persona memory, scope description) — done as part of this change.
- [x] Update backlog: strike `v1.x: subagent memory access` (resolved by this change), add `v1.x: PII redaction in memory writes`.
- [ ] User runs `litespec archive scoped-memory` when satisfied. (Agent does NOT archive; that's the user's stamp.)
