# Tasks: Curated Memory v1

## Phase 1: Memory paths and store

- [x] Create `src/memory/paths.ts` exporting `memoryDir(home)` and `memoryFilePath(home, target)`.
- [x] Create `src/memory/store.ts` with `class MemoryStore`:
  - Constructor takes `goblinHome: string`.
  - `read(target: "memory" | "user"): string` — returns file contents or `""` on `ENOENT`.
  - Private constants: `MEMORY_CAP = 4000`, `USER_CAP = 2000`, `DELIMITER = "\n§\n"`.
  - `add(target, content)`, `replace(target, oldText, content)`, `remove(target, oldText)` — all returning `{ ok: true } | { ok: false, error: string }`.
  - Atomic writes via tmp file + `fs.renameSync` (mirror existing `src/sessions/manager.ts` pattern).
  - Cap enforcement on `add` and `replace` paths.
  - Substring match: count occurrences via `String.prototype.split`; reject zero or >1.
- [x] Create `src/memory/store.test.ts` covering:
  - Empty file → first add → no delimiter; second add → exactly one delimiter.
  - Add at cap → success; add over cap → error message includes current/cap/overflow.
  - Replace unique / ambiguous (returns error) / not-found (returns error).
  - Remove unique / ambiguous / not-found.
  - Atomic write: simulate failure, assert original file untouched and tmp file pattern is consistent.
- [x] Verify `bun run typecheck` and `bun test` pass.

Commit: `phase 1: memory store with caps and atomic writes`

## Phase 2: Git-backed versioning

- [x] Add `private commit(action: "add" | "replace" | "remove", target: "memory" | "user")` to `MemoryStore` shelling out to `git` via `Bun.spawnSync` (or `node:child_process.spawnSync`).
  - Lazy-init: if `<memoryDir>/.git` is absent, run `git init -q`, `git config user.name goblin`, `git config user.email goblin@localhost`.
  - On every successful mutation, run `git add <file>` then `git commit -q -m "memory: <action> in <target>"`. Swallow "nothing to commit".
- [x] Commit message format MUST be exactly `memory: <action> in <target>` (e.g., `memory: add in user`, `memory: replace in memory`). Matches spec scenario `Successful add commits`.
- [x] Wire `commit()` into the success paths of `add`, `replace`, `remove`. Failed writes MUST NOT commit.
- [x] Extend `src/memory/store.test.ts`:
  - First successful write initializes `.git` directory.
  - Each successful write produces exactly one new commit; assert via `git rev-list --count HEAD`.
  - Each commit's subject matches `memory: <action> in <target>` exactly; assert via `git log -1 --format=%s`.
  - Failed writes (overflow, ambiguous match) produce no new commits.
- [x] Verify `bun run typecheck` and `bun test` pass.

Commit: `phase 2: git versioning for memory mutations`

## Phase 3: Memory tool definition

- [ ] Create `src/memory/tool.ts` exporting `createMemoryTool(store: MemoryStore): ToolDefinition`.
  - Zod input schema: `action` enum, `target` enum, optional `content`, optional `old_text`.
  - Action-specific validation: `add` requires `content`; `replace` requires `old_text` + `content`; `remove` requires `old_text`. Validation failure returns error result without calling store.
  - Dispatch to `store.add/replace/remove`. Map `{ ok: false, error }` to a tool error result; map `{ ok: true }` to a success result with a one-line summary the agent can echo to the user.
- [ ] Create `src/memory/snapshot.ts` exporting a free function `formatSnapshot(store: MemoryStore): { customType, content, display, details } | null`:
  - Returns `null` when both files are empty or absent (matches spec scenario `Both files empty`).
  - Otherwise returns a `customType: "goblin.memory.snapshot"` payload whose `content` text is exactly:
    ```
    [goblin memory snapshot]

    ## memory.md
    <memory.md contents or `(empty)`>

    ## user.md
    <user.md contents or `(empty)`>
    ```
  - Both sections always present. Empty individual files render as the literal string `(empty)`. Matches spec scenarios `Only memory.md populated` and `Only user.md populated`.
- [ ] Create `src/memory/mod.ts` barrel exporting `MemoryStore`, `createMemoryTool`, `formatSnapshot`, `memoryDir`.
- [ ] Create `src/memory/tool.test.ts`:
  - Schema validation rejects missing required args without writing.
  - `add` happy path produces success result and updates store.
  - Overflow returns error result; store unchanged.
  - Ambiguous `replace` returns error result; store unchanged.
- [ ] Create `src/memory/snapshot.test.ts`:
  - Both empty → `null`.
  - One file populated → snapshot includes both sections, empty one as `(empty)`.
- [ ] Verify `bun run typecheck` and `bun test` pass.

Commit: `phase 3: memory tool and snapshot formatter`

## Phase 4: AgentRunner memory tool registration

- [ ] In `src/agent/mod.ts`:
  - Add private field `private memoryStore: MemoryStore`.
  - In `init()`, instantiate `this.memoryStore = new MemoryStore(this.cfg.goblinHome)` once (cheap; constructor does no I/O).
  - Build a local copy of customTools as `[...this.customTools, createMemoryTool(this.memoryStore)]` and pass it to `createAgentSession`. Caller-supplied tools come first; the memory tool is appended.
- [ ] `src/bot.ts` requires no changes; the existing `new AgentRunner(cfg, session.id, [])` site continues to work and the runner adds the memory tool internally.
- [ ] Extend `src/agent/mod.test.ts` using the existing `mock.module("@mariozechner/pi-coding-agent", ...)` pattern at lines 66–86 and the `capturedCreateArgs` capture at line 60:
  - Assert `customTools` passed to `createAgentSession` includes a tool definition named `memory` (read it off the captured args).
  - Assert that when the runner is constructed with `customTools = [t1, t2]`, the captured `customTools` includes `t1`, `t2`, and `memory`.
- [ ] Verify `bun run typecheck` and `bun test` pass.

Commit: `phase 4: AgentRunner registers memory tool`

## Phase 5: Per-turn aside injection

- [ ] In `src/agent/mod.ts::prompt(text, callbacks)`, before the existing `isStreaming` branch:
  - Compute `const aside = formatSnapshot(this.memoryStore)`.
  - If `aside !== null`, call `await this.session.sendCustomMessage(aside, { deliverAs: "nextTurn" })`.
  - On every turn, regardless of streaming state. Pi will queue the aside and flush it alongside the user message on the next prompt.
- [ ] Extend `sessionHolder` in `src/agent/mod.test.ts` with a `sendCustomMessage` mock alongside `sendUserMessage` / `followUp` (mirror the existing pattern at lines 17–32). Then assert:
  - When at least one memory file is non-empty, `sendCustomMessage` is invoked with `{ deliverAs: "nextTurn" }` and the captured payload's `content` text starts with `[goblin memory snapshot]`.
  - When both memory files are empty, `sendCustomMessage` is NOT called.
  - The `sendCustomMessage` call happens before `sendUserMessage` / `followUp`.
  - When `memory.md` has content but `user.md` is empty, the captured payload includes `## user.md` followed by `(empty)`.
- [ ] Manual verification (write up the steps in the commit body, do not block on running):
  - Start bot, send a message asking goblin to remember a fact, then in a new turn ask about that fact.
  - Inspect `$GOBLIN_HOME/memory/memory.md` to confirm the entry persisted.
  - Inspect `git log` in `$GOBLIN_HOME/memory/` to confirm the commit landed.
- [ ] Verify `bun run typecheck` and `bun test` pass.

Commit: `phase 5: per-turn memory aside injection`

## Phase 6: Documentation and backlog cleanup

- [ ] Add a short "Memory" section to `AGENTS.md` describing where memory lives (`$GOBLIN_HOME/memory/`), how to read it (`cat`, `git log`), and the cap-driven defrag contract. _Documentation only — this change does not inject `AGENTS.md` into the system prompt; that's a separate concern owned by a future change._
- [ ] Remove the `v1.5: remember() tool writing to memory/YYYY-MM.md` line from `specs/backlog.md` (this change supersedes it; the per-month layout was rejected in favor of two capped files).
- [ ] Add a single-line note to `specs/backlog.md` under "Deferred": `v1.x: subagent memory access — wire memory read (and decide on write) into SubagentRunner once curated-memory and subagent-runtime are both in canon.`
- [ ] Verify `bun run typecheck` and `bun test` pass.

Commit: `phase 6: document memory and graduate from backlog`
