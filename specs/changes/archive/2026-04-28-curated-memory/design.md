# Design: Curated Memory v1

## Architecture

Memory is a thin file-backed store sitting beside the existing session machinery. Three pieces:

1. **Store module** — `src/memory/store.ts` owns reads, writes, the `\n§\n` delimiter, cap enforcement, atomic writes, and git commits. Pure, no pi dependencies, no telegram dependencies. The store exposes only mutation and raw-read APIs; snapshot formatting is intentionally a separate concern.
2. **Snapshot formatter** — `src/memory/snapshot.ts` exports a free function `formatSnapshot(store)` that reads both files via the store and produces the pi `sendCustomMessage` payload (or `null` when both are empty). Free function, not a method on `MemoryStore`, because the snapshot is a *view* of store state, not store state itself — keeping it out of the store class avoids confusion about whether the snapshot is cached or live.
3. **Tool factory** — `src/memory/tool.ts` produces the `memory` `ToolDefinition` consumed by pi via `createAgentSession({ customTools })`. The tool is constructed with a closure over the store so the tool's handler is a thin adapter from pi's tool ABI to `store.add/replace/remove`.
4. **AgentRunner integration** — `src/agent/mod.ts` instantiates a `MemoryStore`, appends `createMemoryTool(store)` to `customTools` before calling `createAgentSession`, and on every `prompt()` call invokes `formatSnapshot(store)` and dispatches the result via `sendCustomMessage(..., { deliverAs: "nextTurn" })` when non-null.

Data flow per turn:

```
user msg → bot.ts → runner.prompt(text)
                  ↳ formatSnapshot(store) reads memory.md + user.md
                  ↳ if non-null: session.sendCustomMessage(snapshot, { deliverAs: "nextTurn" })
                  ↳ session.sendUserMessage(text)
                       → pi appends user msg + queued aside → LLM call
                       → if LLM calls `memory.*` → store.* → atomic write → git commit
                  ↳ next turn re-reads from disk
```

The system prompt is **never** mutated for memory. Whatever pi sets `_baseSystemPrompt` to at session creation stays there for the AgentRunner's lifetime so the provider prefix cache holds. (Today that value is pi's default; if AGENTS.md injection lands in a separate change, this invariant still holds — memory just doesn't touch it.)

`$GOBLIN_HOME/memory/` is its own git repo. The runner does not interact with git directly — `store.ts` shells out to `git` after each successful write.

## Decisions

### Per-turn aside, not system prompt mutation

**Chosen**: Inject memory via `AgentSession.sendCustomMessage(..., { deliverAs: "nextTurn" })` (pi-coding-agent ≥ 0.67.68 supports this; verified at `@/home/daniel/build/little-goblin/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts:351-355`).

**Rejected alternatives**:
- *Mutate `agent.state.systemPrompt` per turn* — pi already resets this from `_baseSystemPrompt` before each turn unless overridden via the extension `beforeAgentStart` hook. Writing an extension just for memory is more pi coupling than warranted for v1.
- *Refresh `_baseSystemPrompt` on dirty bit* — same coupling issue, plus invalidates provider prefix cache on every memory write.
- *Freeze snapshot per AgentRunner* — sessions live for weeks. Memory writes in week 1 must be visible in week 4 within the same AgentRunner. Per-AgentRunner freezing is a UX cliff for long-lived topics.

**Trade-off accepted**: The model sees memory as an aside-positioned context block adjacent to the user message rather than pinned in system text. Likely a wash, possibly better — the snapshot is closest to the query when the LLM reads it.

### File-backed, two files, hard caps

**Chosen**: `memory.md` (4000) + `user.md` (2000), `\n§\n` delimited entries, agent self-defrags on overflow.

**Rejected alternatives**:
- *Hierarchical `memory/system/**/*.md` (skill default)* — premature for ~6KB of curated facts. One user, one process; we don't need progressive disclosure.
- *SQLite + FTS* — violates AGENTS.md's "no DB" guardrail. Overkill for a 6KB corpus.
- *Hermes's exact caps (2200 + 1375)* — too tight for goblin's homelab + projects + people coverage. 4000 + 2000 leaves headroom without bloating the prefix cache.

**Constraints introduced**: Eventually the agent will hit a cap. Defrag is the agent's job — the overflow error message tells it so. If this becomes painful in practice, we add a progressive `reference/` tier in v1.x.

### Substring match for replace/remove

**Chosen**: `old_text` is a unique substring; ambiguous matches fail.

**Rejected**: Per-entry IDs with hashes. Cheap on disk but expensive on every read (extra tokens) and confusing for the LLM to reason about.

**Constraint**: The LLM must pick a unique substring. With ~6KB total and `\n§\n`-separated entries, this is usually trivial.

### No `MemoryProvider` ABC for v1

**Chosen**: Two functions and one tool. No interface, no plugin seam.

**Rejected**: Lifting hermes's `MemoryProvider` ABC. We have one backend with no concrete plan to add a second. YAGNI.

**Constraint accepted**: If/when inferred memory (Honcho-style) returns from backlog, we extract the seam then. The current shape is small enough to refactor cleanly.

### Subagents are out of scope for this change

**Chosen**: Curated-memory only modifies the existing `AgentRunner`. The in-flight `subagent-runtime` change introduces a separate `SubagentRunner` class (`@/home/daniel/build/little-goblin/specs/changes/subagent-runtime/specs/subagents/spec.md:103-110`) that runs with `customTools: []`. Subagent memory access is decided in a follow-up change after both architectures are in canon.

**Rejected**:
- *Add a `mode: "primary" | "subagent"` flag to `AgentRunner`* — this assumed subagents and primary agents share a runner class. They don't.
- *Modify `SubagentRunner` here* — cross-change scope creep; would couple two in-flight changes.

**Constraint accepted**: Until the follow-up lands, subagents have neither read nor write access to memory. Acceptable; matches "defer subagent cross-talk" decision (`@/home/daniel/build/little-goblin/specs/decisions/0001-defer-subagent-cross-talk.md`).

### Git versioning from day one

**Chosen**: `git init` on first write; commit on every successful mutation. Shell out to `git` from `store.ts`.

**Rationale**: Cheap (~5ms per commit), provides audit log, cheap rollback, future-proofs concurrent writes if subagents ever gain write access. Aligns with skill recommendation.

**Trade-off**: Adds a `git` binary dependency. Acceptable for a homelab tool; AGENTS.md already assumes a unix env.

### Memory module placement

**Chosen**: New top-level module `src/memory/` (peer to `src/agent/`, `src/sessions/`).

**Rejected**: Burying memory inside `src/agent/`. Memory is its own concern with its own filesystem, distinct from agent runtime. A peer module keeps boundaries clean and mirrors hermes's separation of `MemoryStore` from `Agent`.

## File Changes

### New files

- **`src/memory/paths.ts`** — `memoryDir(home)`, `memoryFilePath(home, target)`. Mirrors `src/agent/paths.ts`. Implements *Memory store filesystem layout*.
- **`src/memory/store.ts`** — `class MemoryStore` with `read(target)`, `add(target, content)`, `replace(target, oldText, content)`, `remove(target, oldText)`. Owns delimiter logic, cap enforcement, atomic writes via `tmp + renameSync`, and git commits. Implements *Entry delimiter*, *Enforce character caps*, *Substring match*, *Atomic writes*, *Git-backed versioning*.
- **`src/memory/store.test.ts`** — unit tests covering: empty file → first add → delimiter check; second add; cap enforcement (under, at, over); replace unique / ambiguous / not-found; remove; atomic write (interrupt simulation via temp file inspection); git init on first write; commit message format.
- **`src/memory/snapshot.ts`** — free function `formatSnapshot(store: MemoryStore): { customType, content, display, details } | null`. Reads both files via the store and produces the pi `sendCustomMessage` payload, or `null` when both are empty. Implements *Snapshot format for prompt injection*.
- **`src/memory/snapshot.test.ts`** — tests `formatSnapshot()` for: both empty → `null`; only `memory.md` populated → payload includes `(empty)` for `user.md` section; only `user.md` populated → payload includes `(empty)` for `memory.md` section; both populated → both sections render.
- **`src/memory/tool.ts`** — `createMemoryTool(store): ToolDefinition`. Validates `action`, `target`, and per-action required args (zod schema), dispatches to store, returns success/error text. Implements *memory tool exposes add, replace, remove*.
- **`src/memory/tool.test.ts`** — tool ABI tests: schema validation rejects missing args; `add` happy path; overflow returns error text without writing; ambiguous match returns error.
- **`src/memory/mod.ts`** — barrel export of `MemoryStore`, `createMemoryTool`, `formatSnapshot`, paths.

### Modified files

- **`src/agent/mod.ts`** —
  - In `init()`, instantiate `this.memoryStore = new MemoryStore(this.cfg.goblinHome)` once and append `createMemoryTool(this.memoryStore)` to a local copy of `customTools` before calling `createAgentSession`.
  - Add private field `private memoryStore: MemoryStore` for reuse across turns and so the tool factory closes over it once.
  - In `prompt(text, callbacks)`, before the existing `sendUserMessage` / `followUp` branch, compute `const aside = formatSnapshot(this.memoryStore)` and, when non-null, call `await this.session.sendCustomMessage(aside, { deliverAs: "nextTurn" })`. Implements *AgentRunner injects memory snapshot as per-turn aside*.

- **`src/agent/mod.test.ts`** — extend with: assert `customTools` passed to `createAgentSession` includes a tool definition named `memory`; assert caller-supplied tools are preserved; assert per-turn `sendCustomMessage` is invoked with the snapshot before the user message; assert that when both files are empty `sendCustomMessage` is not called. Reuses the existing `mock.module("@mariozechner/pi-coding-agent", ...)` pattern in the file.

- **`src/bot.ts`** — unchanged. The existing `new AgentRunner(cfg, session.id, [])` construction site continues to work; the runner now adds the memory tool internally.

### Unchanged

- `AGENTS.md` injection into the system prompt is *not* introduced here. The current TODO-shaped placeholder in `runner.init()` remains untouched. AGENTS.md handling is orthogonal and can land separately.

## Spec traceability

| Requirement | Implemented in |
|:---|:---|
| Memory store filesystem layout | `src/memory/paths.ts`, `src/memory/store.ts` |
| Entry delimiter | `src/memory/store.ts` (constant `\n§\n`) |
| Enforce character caps | `src/memory/store.ts::add/replace` |
| memory tool exposes add, replace, remove | `src/memory/tool.ts` |
| Substring match for replace and remove | `src/memory/store.ts::replace/remove` |
| Atomic writes | `src/memory/store.ts` via tmp + `renameSync` |
| Git-backed versioning | `src/memory/store.ts` shells out to `git` |
| Snapshot format for prompt injection | `src/memory/snapshot.ts::formatSnapshot` |
| AgentRunner injects memory snapshot as per-turn aside | `src/agent/mod.ts::prompt` |
| AgentRunner registers the memory write tool | `src/agent/mod.ts::init` |
