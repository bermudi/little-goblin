# Design: scoped-memory

## Architecture

Memory becomes a *scoped* store keyed by the calling session's locator and (for
named subagents) named-agent identity. The on-disk layout, the snapshot
formatter, and the tool surface are the three things that change. Everything
else — git versioning, atomic writes, character cap enforcement, substring-match
semantics for `replace`/`remove` — is preserved and ported into the new shape.

```diagram
╭───────────────────────────────────────────────────────────────────╮
│  $GOBLIN_HOME/memory/                                             │
│  ├── .git/                              (single repo, all scopes) │
│  ├── user.md                            (global identity tier)    │
│  ├── general/memory.md                  (DM + supergroup-no-topic)│
│  ├── topics/<chatId>/<topicId>/memory.md   (one per forum topic)  │
│  ├── agents/<name>/memory.md            (per named subagent)      │
│  └── archive/topics/<chatId>/<topicId>/    (orphaned topics)      │
╰───────────────────────────────────────────────────────────────────╯

per-turn snapshot (topic-bound session):
╭──────────────────────────────────────╮
│  [goblin memory snapshot]            │
│  ## scope                            │
│  Topic: <chatId>/<topicId>           │
│  ## user.md                          │
│  <global identity>                   │
│  ## memory.md                        │
│  <topics/<chat>/<topic>/memory.md>   │
│  ## other scopes                     │
│  - topics/<chat>/<id> — <desc>       │
│  - general — <desc>                  │
╰──────────────────────────────────────╯
```

The active scope is *resolved server-side* from the calling context. The agent
never supplies a scope on writes — the schema does not contain that argument.
Reads accept a typed discriminated `scope` union (`"active" | "general" |
{topic: ID} | {agent: name}`) so cross-scope reads cannot devolve into raw path
traversal.

`MemoryStore` becomes the single chokepoint for writes (atomic, cap-checked,
git-committed). When v2 swarm parallelism lands, that's where a write lock or
branch-per-writer goes — out of scope for this change.

Named subagents get a third snapshot tier (`## agent persona`) sourced from
`agents/<name>/memory.md`. This is the agent's continuity across invocations,
distinct from any single topic's domain memory.

## Decisions

### D1. Scope key is `(chatId, topicId)`, not topic name

**Chosen:** Topic scopes are addressed by their numeric Telegram topic ID,
mirroring the existing `bindings.ts` model. This aligns with decision [0002-topic-ui-is-user-owned](../decisions/0002-topic-ui-is-user-owned.md).

**Why:** Telegram IDs are stable across renames. Renaming a topic from `Health`
to `Wellness` keeps the same memory; deleting and re-creating a topic gets a
fresh scope (intentional — recreate is rare and recovery is `mv` on disk).
Name-keying produces silent data loss on rename and collisions on duplicate
names.

**Constraint:** the `ChatLocator` already encodes `(chatId, topicId?)`; the
memory layer reuses it without inventing a parallel addressing scheme.

### D2. `user.md` stays global

**Chosen:** A single `$GOBLIN_HOME/memory/user.md` is shared across every scope
and every named subagent.

**Why:** `user.md` describes the human (preferences, recurring people, comms
style). That cuts across every domain and every subagent. Splitting it would
require curating a separate identity per topic, which is exactly the kind of
fragmentation we don't want. The 2000-char cap stays meaningful precisely
because the file is identity-only.

### D3. Tool surface split by mutability

**Chosen:** Three tools — `memory_read`, `memory_read_index`, `memory_write` —
instead of one mega-tool.

**Why:** Reads and writes have fundamentally different gating. Writes need cap
enforcement, atomic write, git commit, and active-scope resolution. Reads need
none of that. Splitting them lets the *write* tool's schema omit the `scope`
argument entirely — Q4's "writes locked to active scope" is enforced by the
type system rather than runtime validation. A 7-action mega-tool also makes the
model think harder ("which action again?"); two tools, one with a discriminated
`action`, is the sweet spot.

**Trade-off:** The agent now sees two memory tools in its tool list instead of
one. Trivial cost relative to the schema-level guarantee.

### D4. Active scope resolution is *not* an agent input

**Chosen:** `memory_write({target: "memory"})` resolves the disk path
server-side from the calling session's `(chatId, topicId)`. The agent never
supplies a scope on writes.

**Why:** Q4's locked rule. Cross-scope writes are a category of bug we forbid
by construction. The model cannot pass a "write to topic 7" argument because
the schema does not contain one.

**Constraint:** `AgentRunner` and `SubagentRunner` must each know their bound
locator at the moment of tool registration. They already do — `AgentRunner` is
constructed with `sessionId` and resolves the locator via `state.json`;
`SubagentRunner` inherits the parent's locator at spawn time.

### D5. Cross-scope discovery uses one-line descriptions, not full content

**Chosen:** The snapshot includes a `## other scopes` index of one-line
descriptions, not the contents of those scopes. Full content is fetched via
`memory_read({scope: ...})` only when the agent decides the connection
warrants it.

**Why:** Progressive disclosure. The skill's frontier pattern: "descriptions
are cheap, content is expensive." A 5-topic index at ~50 chars/line is ~250
tokens per turn — cheap enough to always inject. Loading every scope every
turn would scale with the number of topics and could easily exceed the active
scope's own budget.

**Trade-off:** Descriptions need to be accurate. If they drift, the agent
makes bad cross-scope decisions. The agent maintains them via
`memory_write({action: "set_description"})`; falling back to the Telegram
topic name is the v1 default for new scopes.

### D6. Named subagents get a persona memory file

**Chosen:** Each named subagent has `agents/<name>/memory.md` (4000-char cap),
loaded into its snapshot as a `## agent persona` section regardless of which
parent scope spawned it.

**Why:** Named agents are *specialists* — `researcher`, `homelab-ops`,
`coach`. Their accumulated methodology and self-knowledge ("PubMed paywall
workaround", "user dislikes nagging at night", "DNS misbehaves on Tuesdays")
should persist across invocations and across spawning topics. Without
persona memory, named agents reset their methodology every spawn and the only
way to "teach" them is to hand-edit `AGENTS.md` — which is the system prompt,
not a memory tier.

**Constraint:** Concurrency safety becomes a real concern in v2 (when two
parents spawn `researcher` simultaneously). The `MemoryStore` is the unified
write surface; that's where a future lock lives. Not implemented now.

### D7. Three tools, identical schemas across runners

**Chosen:** The JSON schema for `memory_write` is byte-identical between the
main `AgentRunner`, anonymous `SubagentRunner` instances, and named
`SubagentRunner` instances. Differences are entirely in the *resolution* of
`target` (active scope per caller) and in whether `target: "agent"` is
accepted.

**Why:** Schema parity means the agent's mental model is the same everywhere.
The schema-level rejection of `target: "agent"` for non-named callers is a
runtime check at the resolver, not a schema branch. This keeps the contract
boring and predictable; named-agent identity is a runtime fact, not a tool
shape.

### D8. Orphan topics archive on failed resolve, not on poll

**Chosen:** When goblin's next operation against a topic fails with a "topic
not found" error from Telegram, the corresponding `memory/topics/<chat>/<id>/`
directory is moved to `memory/archive/topics/<chat>/<id>/`.

**Why:** Polling Telegram for "is this topic still alive?" is expensive and
not part of any existing flow. Negative-resolution detection is free — it
piggybacks on operations the bot is already doing. The trade-off is silent
orphans for topics that are deleted and never accessed again. Acceptable for
v1; an explicit `/scopes prune` can be added later if it bites.

**Why move, not delete:** Topic deletion in Telegram is sometimes accidental.
A move-to-archive preserves the data; git history protects it further. We're
a homelab bot, disk space is not the constraint.

### D9. No migration path

**Chosen:** Code targets the new layout from day one. The user's existing
single `memory.md` and `user.md` at `$GOBLIN_HOME/memory/` is their manual
cleanup.

**Why:** The user has accepted this — they're running goblin in development
with disposable state. Auto-migration code would only ever run on one user's
machine. The complexity of "is this an old layout that needs migration"
checks at startup is not worth saving them one `mv` command.

**Constraint:** `user.md` lives at the same path before and after, so the
cleanup is *only* the old top-level `memory.md`. Existing git history at
`$GOBLIN_HOME/memory/.git` is preserved.

### D10. `formatSnapshot` requires explicit `includeAgents` boolean

**Chosen:** The `FormatSnapshotArgs` interface requires `includeAgents: boolean`
in addition to the design's original `store`, `activeScope`, `includePersona?`,
and `getTopicName?` parameters.

**Why:** The `## other scopes` section can include agent persona scopes (when
`includeAgents: true`) or omit them (when `false`). This is a caller decision:
the main agent's snapshot includes agents for cross-scope discovery, while
subagents receive `includeAgents: false` because they cannot spawn other agents
and should not see sibling personas. Making this explicit at the call site
prevents accidental leakage of agent topology into subagent contexts.

**Constraint:** Callers must now pass the flag; there is no default. This is
intentional — it forces a conscious choice about agent visibility at every
snapshot construction site.

## File Changes

### Modified

#### `src/memory/paths.ts`

Replace the current two-path API (`memoryFilePath`, `userFilePath`) with a
scope-aware path resolver:

- **Add type `MemoryScope = "general" | {topic: {chatId: number; topicId: number}} | {agent: {name: string}}`.**
- **Add `scopeMemoryPath(home: string, scope: MemoryScope): string`** that resolves to the canonical disk path for that scope's `memory.md`.
- **Add `userPath(home: string): string`** (one path, global) replacing `userFilePath`.
- **Add `archiveTopicPath(home, chatId, topicId)`** for orphan archival.

Why: Every other module uses path resolution through this layer; centralizing the discriminated-union → string translation here keeps the rest of the code from juggling scope-shape conditionals.

Spec: *Memory scopes by chat surface and named agent*.

#### `src/memory/store.ts`

Substantial refactor.

- **`MemoryStore.add/replace/remove/rewrite/setDescription`** all take a `MemoryScope` argument (or implicit `target = "user"` skips it). Internally, every action funnels into a `mutate(scope, op)` helper that:
    1. Resolves the path via `paths.ts`.
    2. Reads current content, applies op, validates cap.
    3. Atomic write (tmp + rename) — same primitive as today.
    4. Single git commit with subject `memory: <action> in <scope-tag>`.
- **`scope-tag`** is `user`, `general`, `topics/<chat>/<topic>`, or `agents/<name>`.
- **`MemoryStore.read(scope)`** returns the parsed `{description?, body}` of the requested scope file. Note: the store accepts an internal `"memory"` string alias that normalizes to `"general"`; this is a legacy implementation detail distinct from the tool layer's `target: "memory"` concept.
- **`MemoryStore.listIndex({includeAgents: boolean})`** scans `topics/` and (optionally) `agents/` for non-archived scopes and returns `[{id, description}]` arrays.
- **`MemoryStore.archiveOrphan(chatId, topicId)`** moves `topics/<chat>/<topic>/` to `archive/topics/<chat>/<topic>/` via `renameSync`.
- **Frontmatter parsing.** A minimal `--- description: ... ---` parser. Single-line description only; reject multi-line for v1.
- **Cap enforcement.** Body length only; frontmatter is metadata, not entries. Description ≤200 chars.

Spec: *Enforce character caps with overflow errors*, *Atomic writes* (preserved), *Git-backed versioning* (subjects updated), *Memory writes are restricted to the active scope*, *Memory reads support cross-scope retrieval*, *Scope description provides progressive disclosure*, *Orphan topic scopes move to archive on failed resolve*.

#### `src/memory/snapshot.ts`

Rewrite the formatter.

- **New input shape:** `formatSnapshot({store, activeScope, includeAgents: boolean, includePersona?: {name: string}, getTopicName?: (chatId, topicId) => Promise<string | null>})`.
- **Output sections in order:** `[goblin memory snapshot]`, `## scope`, `## user.md`, `## memory.md` (active), optional `## agent persona`, optional `## other scopes`.
- **Empty handling:** sections render `(empty)`; whole payload is `null` when every source is empty/absent and the cross-scope index is empty.
- The function MUST stay synchronous-from-disk where possible. Telegram name lookup (`getTopicName`) is async and best-effort; on miss, falls back to `topics/<chat>/<topic>` literal.

Spec: *Per-turn snapshot includes active scope and cross-scope index*, *Snapshot format for prompt injection*.

#### `src/memory/tool.ts`

Replace `createMemoryTool(store)` with three factories:

- **`createMemoryReadTool({store, activeScope})`** — schema accepts `target: "memory"|"user"|"agent"` and optional discriminated `scope`. Returns parsed body + description. Resolves `target=user` to `userPath`, ignores `scope`. Resolves `target=agent` against the calling agent's name (passed in as part of `activeScope` for named subagents).
- **`createMemoryReadIndexTool({store, activeScope, includeAgents})`** — derives `chatId` from `activeScope` to filter topics to the current chat. Returns `{general, topics: [...], agents: [...]}`. `agents` empty for callers that aren't the main goblin agent.
- **`createMemoryWriteTool({store, activeScope})`** — schema accepts `action`, `target`, plus action-specific fields. Resolver path:
    1. `target=memory` → `activeScope.topicScope ?? generalScope`.
    2. `target=user` → user path.
    3. `target=agent` → `activeScope.namedAgent` (reject if absent).
- **Validation:** missing required field → tool error, no write. Cap overflow → tool error, no write. Substring-match ambiguity (replace/remove) → tool error, no write.

`activeScope` is a small typed bundle: `{chatId: number; topicScope: {topicId: number} | "general"; namedAgent: {name: string} | null}`. The `chatId` is the binding context (which chat this session is in), while `topicScope` distinguishes between the general scope (DM/supergroup-no-topic) and a specific topic. Built once at runner construction.

Spec: *AgentRunner registers the memory write tool*, all the `memory` requirements covering action semantics.

#### `src/agent/mod.ts`

- **Constructor signature gains `locator: ChatLocator`** (the runner's bound chat surface). Either added to `AgentRunnerOptions` or sourced from `state.json` lookup at `init()`. Prefer passing in — `bot.ts` already has it.
- **`init()` builds `activeScope`** from the locator (no `topicId` → `general`; with `topicId` → `{topic: {chatId, topicId}}`). Names the agent as null (main agent has no named identity).
- **Tool registration changes** — `customTools` now includes the three factories above with `activeScope` bound:
    ```typescript
    const tools: ToolDefinition[] = [
      ...this.customTools,
      createMemoryReadTool({store, activeScope}),
      createMemoryReadIndexTool({store, activeScope, includeAgents: true}),
      createMemoryWriteTool({store, activeScope}),
    ];
    ```
- **`prompt()` snapshot building** — replace `formatSnapshot(this.memoryStore)` with the new `formatSnapshot({store, activeScope, getTopicName})`. `getTopicName` calls `bot.api.getForumTopic` lazily, with a small in-memory cache; failures fall back to literal.

Spec: *AgentRunner injects memory snapshot as per-turn aside*, *AgentRunner registers the memory write tool*.

#### `src/subagents/runner.ts` (and `src/subagents/execution.ts`)

- **Spawn paths gain memory wiring.** When `SubagentRunner.spawn` (in `runner.ts`) builds the child's pi `customTools` — the actual `customTools` array is assembled inside `_runInstanceInner` in `execution.ts` via the `buildTools` callback on `ExecutionDeps` — it includes the same three memory tools, with `activeScope` derived from:
    - Anonymous subagent: parent's `activeScope` verbatim. `namedAgent: null`.
    - Named subagent: parent's `activeScope.topicScope`, plus `namedAgent: {name: <sanitized name>}`.
- **Snapshot for named subagents.** Subagent's pi `AgentSession` receives a per-turn snapshot via `sendCustomMessage` analogous to `AgentRunner`'s, but with `includePersona: {name}` so `## agent persona` renders. The snapshot is built from the same `formatSnapshot` factory.
- **Tool schema parity.** The factories produce identical JSON schemas regardless of caller; only the resolver behind them differs.

Spec: *Anonymous subagents inherit parent's active memory scope*, *Named subagents have a three-tier memory model*, *Subagent memory access uses the same tool surface as the main agent*.

#### `src/bot.ts`

Two narrow edits:

1. **Pass `locator` into `new AgentRunner({...})`** at both construction sites (the `/new` branch and the lazy-create at first message). Today: `new AgentRunner({ cfg, sessionId: ..., customTools: [], subagentRunner })`. After: add `locator`.
2. **Wire orphan archival on failed resolve.** When goblin's first attempt to send to a topic returns a Telegram "topic not found" error, call `memoryStore.archiveOrphan(chatId, topicId)` before propagating. Practical site: the `MessageBuffer` flush path or wherever `bot.api.sendMessage` is called against a topic-bound locator. (Implementation detail; specific call site picked during apply after re-reading `tg/`.)

Spec: *Orphan topic scopes move to archive on failed resolve*, plus the agent-layer specs.

#### `src/memory/mod.ts`

Re-exports updated to surface the new factory functions and types
(`MemoryScope`, `ActiveScope`, `MemoryStore`, the three tool factories,
`formatSnapshot`).

### Created

#### `src/memory/scope.ts`

A small focused module containing:

- The `MemoryScope` discriminated union and `ActiveScope` bundle types. `ActiveScope` keeps `chatId` as a sibling field rather than nested in `topicScope` because the chat binding is constant for the session lifetime, while the topic scope can vary (general vs specific topic).
- `resolveActiveScope(locator: ChatLocator, namedAgent?: string): ActiveScope`.
- `scopeTag(scope: MemoryScope): string` — produces the git commit subject's
  scope label (e.g. `topics/-100123/42`).

Why a separate file: scope resolution is its own concern, distinct from path
resolution and from the store's mutation logic. Testable in isolation.

### Tests (modified + created)

- **`src/memory/store.test.ts`** — extended for: scope path creation, per-scope cap independence, frontmatter parsing/preservation, orphan archive, scope-tagged commit subjects.
- **`src/memory/snapshot.test.ts`** — extended for: scope section formatting, cross-scope index, persona section, all-empty → null, partial-empty rendering.
- **`src/memory/tool.test.ts`** — split or expanded to cover three tools' schemas, active-scope resolution per caller type, `target=agent` rejection paths, scope discriminator on read.
- **`src/memory/scope.test.ts`** — new, for `resolveActiveScope` and `scopeTag`.
- **`src/agent/mod.test.ts`** — updated to assert the runner registers three memory tools and that the snapshot it builds carries `activeScope` correctly for DM/topic/supergroup-no-topic.
- **`src/subagents/mod.test.ts`** — new test file or section: anonymous subagent inherits parent active scope; named subagent gets persona tier; `target=agent` rejected for anonymous.

### Deleted

Nothing is deleted outright. The single `createMemoryTool` factory is replaced
by three factories under the same `tool.ts` file (kept under one filename until
it grows beyond ~250 lines — split if needed during apply).
