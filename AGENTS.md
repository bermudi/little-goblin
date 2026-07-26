# little-goblin

Telegram-native personal AI agent. Single user (bermudi), single process, homelab.

Goblin lives in Telegram. You message it, it thinks, it responds. It can spawn subagents for focused work, persist conversation history, and evolve its own skills. Deep use of Telegram as UI — reactions, voice, topics, files — not just a chat wrapper.

## Architecture stabilization gate

> **This project is being architecturally stabilized. Do not add new product features on top of known-bad seams.** Repair ownership, lifetime, authority, storage, and module interfaces first; otherwise each feature makes the eventual migration harder.

Before proposing or implementing feature work:

- Read the relevant canon, active litespec changes, and accepted decisions. Canon describes implemented behavior; active changes may deliberately replace it.
- Name the owner and lifetime of every new piece of state: Surface, Conversation, conversation runtime, Execution Environment, delegated run, or deployment.
- Name its authority source and persistence location. Do not infer authority from convenience fields or duplicate it across callers.
- Put cross-cutting behavior behind a deep module with one interface; do not add orchestration choreography to commands, Telegram intake, or other callers.
- Do not extend legacy `Session`/`ChatLocator`, mutable-project, `scratch/`, or ad-hoc skill-loading patterns. Migrate or replace the seam.
- A bug fix may land during stabilization, but it must move toward the target architecture or explicitly document why it is a containment patch.

New feature work resumes when its architectural dependencies are explicit and the relevant stabilization changes are accepted. “It fits the current code” is not sufficient.

### Planning discipline

- **WIP limit: one change in progress, one fully specced next.** Follow the implementation train in [`ARCHITECTURE.md`](ARCHITECTURE.md). Everything further out stays a paragraph in `specs/backlog.md`. Writing specs feels like progress and costs nothing to start; that is exactly why the pile grows.
- **`dependsOn` holds hard edges only** — the change's own tasks consume a type, persisted format, or module interface the dependency introduces. Vocabulary sharing, Non-Goals deferral, and correctness sequencing are soft edges and belong in `ARCHITECTURE.md`, not in the DAG.
- **The litespec ≤3-capability guardrail is spec hygiene, not a delivery plan.** Splitting a change to satisfy it does not mean the pieces ship separately.
- **Do not `litespec archive` an unimplemented change.** Archive merges deltas into canon and asserts the behavior exists. Delete it and record the reasoning in `specs/backlog.md`; git keeps the artifacts.

## Run

```sh
bun install
cp .env.example .env   # BOT_TOKEN, ALLOWED_TG_USER_IDS, MODEL_NAME + API key
bun run migrate        # write state-version.json and run offline migrations
bun run src/index.ts   # or: bun run dev
```

## Shape

Entry is `src/index.ts`; `src/bot.ts` is the Telegram composition root. The implemented system is currently migrating from an overloaded Telegram/session/agent shape to explicit Surface, Binding, Conversation, ConversationRuntime, and Execution Environment lifetimes.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before structural work. It distinguishes implemented **CURRENT** behavior, accepted **TARGET** architecture, and unresolved **OPEN** questions. Litespec remains authoritative for detailed behavioral contracts; this file remains guardrails.

## Guardrails

- **TypeScript strict.** No `any`. Use `unknown` and narrow. Validate at boundaries.
- **Atomic writes.** tmp + `renameSync`. JSON for state, JSONL for logs. No database except the memory store at `$GOBLIN_HOME/state/memory/memory.sqlite`.
- **Fail loud.** `ENOENT` is expected — return null. Everything else propagates.
- **No `console.log`.** Use `log` from `src/log.ts`.
- **One module, one job.** Flat modules with `mod.ts` barrels. Colocate tests.

## Temporary Notes

## Memory

Persistent memory lives in a SQLite database at `$GOBLIN_HOME/state/memory/memory.sqlite`. Markdown files in `$GOBLIN_HOME/state/memory/` are an export-only view:

- `memory.md` — notes about the environment, projects, conventions, decisions.
- `user.md` — user preferences, communication style, recurring people/places.
- `agents/<name>/memory.md` — named subagent persona memory.
- Entries are stored as rows; `\n§\n` delimiters are used only during markdown export.
- Goblin curates memory via the `memory_write` tool (`add` / `replace` / `remove` / `rewrite` / `set_description`). A global character budget (default **50,000 chars**) applies to curated memory; only auto-promoted "dreaming" entries are eligible for compaction, user entries are preserved.
- The store is canonical; direct edits to markdown files are overwritten on the next `memory export`.
- A frozen memory summary is injected into the system prompt at session creation. A per-turn `## relevant memory` aside is computed via hybrid search on the prompt text.
- Inspect: `memory status` for counts, `memory export` to regenerate markdown, `cat $GOBLIN_HOME/state/memory/memory.md` after export.

This file (`AGENTS.md`) is **not** auto-injected into the system prompt today; that's a separate concern.

## Test conventions

- **Colocated.** `foo.ts` ↔ `foo.test.ts` in the same directory. `bun test` discovers them automatically.
- **One exception: `src/subagents/`.** Its tests live in `src/subagents/test/*.suite.ts`, bootstrapped from `mod.test.ts`. The reason: `bun:test` `mock.module()` is process-global, so the suites must run under a single mock install. The `.suite.ts` extension prevents bun from auto-discovering them (which would race the mock). If bun ever gets per-file mock scoping, collapse this back to colocated `.test.ts` files.
- Add `"test": "bun test"` to package.json if it's still missing.
- Run `bun run typecheck` (`tsc --noEmit`) before committing.

## Things not to do

- No web UI, no multi-channel, no plugin SDK, no Docker, no k8s
- No security audit system
- No multi-agent gateway
- Don't touch `$GOBLIN_HOME` from the code tree except through `SessionManager`, `MemoryStore`, `paths.ts`, and `config.ts`'s `ensureGoblinHome()` (startup directory creation only — see decision `config-startup-filesystem-mutation` 0007). One read-only exception: user-authored `workspace/` prompt files (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, future prompt files) may be read directly at request time via the path helpers in `src/workspace/paths.ts` / `src/scheduler/loop.ts` (see decision `workspace-prompt-file-reads` 0009). This covers only read access, only `workspace/` prompt files — never `state/` or `scratch/` — and non-ENOENT read errors propagate per the fail-loud rule.
