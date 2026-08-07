---
nospec: true
role: record
owns: operational-context
---

# little-goblin

Telegram-native personal AI agent. Single user (bermudi), single process, homelab.

Goblin lives in Telegram. You message it, it thinks, it responds. It can spawn subagents for focused work, persist conversation history, and evolve its own skills. Deep use of Telegram as UI — reactions, voice, topics, files — not just a chat wrapper.

## Architecture stabilization gate

> **This project is being architecturally stabilized. Do not add new product features on top of known-bad seams.** Repair ownership, lifetime, authority, storage, and module interfaces first; otherwise each feature makes the eventual migration harder.

Before proposing or implementing feature work:

- Read the current code and tests, [`ARCHITECTURE.md`](ARCHITECTURE.md), relevant accepted decisions and designated contract records, and the current priorities in [`BACKLOG.md`](BACKLOG.md). Frozen legacy material may supply historical context, but it does not override those authorities.
- Name the owner and lifetime of every new piece of state: Surface, Conversation, conversation runtime, Execution Environment, delegated run, or deployment.
- Name its authority source and persistence location. Do not infer authority from convenience fields or duplicate it across callers.
- Put cross-cutting behavior behind a deep module with one interface; do not add orchestration choreography to commands, Telegram intake, or other callers.
- Do not extend legacy `Session`/`ChatLocator`, mutable-project, `scratch/`, or ad-hoc skill-loading patterns. Migrate or replace the seam.
- A bug fix may land during stabilization, but it must move toward the target architecture or explicitly document why it is a containment patch.
- Source-code and internal API compatibility is not maintained during stabilization; callers migrate atomically with interface changes. Persisted state, offline migration inputs, Telegram behavior, and other external contracts remain governed by their schemas, decisions, and migration policy.

New feature work resumes when its architectural dependencies are explicit and the relevant stabilization changes are accepted. “It fits the current code” is not sufficient.

### Planning discipline

- **WIP limit: one implementation cycle in progress, one plainly described next.** Follow the delivery order in [`ARCHITECTURE.md`](ARCHITECTURE.md); keep everything further out in [`BACKLOG.md`](BACKLOG.md).
- **Nospec is the active work process.** Project-local workflow skills are tracked by `skills-lock.json`.
- Work interactively by default. A clear bounded change needs no queue. Use `.loop/<cycle>/` only when cross-session coordination or AFK execution adds value; `QUEUE.md`, `HANDOFF.md`, `REVIEW.md`, and scratch work specs are disposable, while runner-produced `EVIDENCE.md` is the retained ledger.
- Authority is role-based: code and tests own current implemented behavior; explicitly designated contract records own their promises; root `decisions/` owns accepted architectural rulings; `ARCHITECTURE.md` owns the system map; `glossary.md` owns domain language; this file owns repository practice; `BACKLOG.md` owns work priority.
- `specs/` is a frozen Litespec-era reference tree. Do not create, update, archive, or mechanically translate its canon, changes, parked plans, or status-ambiguous decisions. Before retiring historical material, extract still-valid behavior into code/tests or an explicitly designated contract record. Git is the archive.
- A bug fix may land during stabilization, but it must move toward the target architecture or explicitly document why it is a containment patch.

## Run

```sh
bun install
cp .env.example .env   # BOT_TOKEN, ALLOWED_TG_USER_IDS, MODEL_NAME + API key
bun run migrate        # write state-version.json and run offline migrations
bun run src/index.ts   # or: bun run dev
```

## Shape

Entry is `src/index.ts`; `src/bot.ts` is the Telegram composition root. The implemented system is currently migrating from an overloaded Telegram/session/agent shape to explicit Surface, Binding, Conversation, ConversationRuntime, and Execution Environment lifetimes.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before structural work. It distinguishes implemented **CURRENT** behavior, accepted **TARGET** architecture, and unresolved **OPEN** questions. Code/tests and explicitly designated contract records own current behavior; accepted decisions own architectural rulings; this file remains the operational guardrail.

## Guardrails

- **TypeScript strict.** No `any`. Use `unknown` and narrow. Validate at boundaries.
- **Durable filesystem writes.** Replace-whole-file state uses tmp + `fsync` + `renameSync`. Create-only files use exclusive creation (`"wx"`); that is an atomic no-overwrite reservation, not replacement. Append-only JSONL uses append mode with one serialized record per write; it must propagate failures and must not be described as tmp/rename atomic replacement. JSON for state, JSONL for logs. No database except the memory store at `$GOBLIN_HOME/state/memory/memory.sqlite`.
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
- Don't touch `$GOBLIN_HOME` from the code tree except through `ConversationStore` (canonical conversation persistence), `ConversationLifecycle` (bindings, lifecycle transitions, and project assignment), `InternalSessionStore` (Surface-free internal runtime persistence), `MemoryStore`, `MetricsStore` (sole metric-record reader/appender and lazy metrics-artifact materializer through `metricsPath`; decision 0014), `paths.ts`, and `config.ts`'s `ensureGoblinHome()` (startup directory creation only — see decision `config-startup-filesystem-mutation` 0007). One read-only exception: agent-owned `workspace/` prompt files (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, future prompt files) may be read directly at request time via the path helpers in `src/workspace/paths.ts` / `src/scheduler/loop.ts` (see decision `workspace-prompt-file-reads` 0009). This covers only read access by source code; the agent runtime may rewrite these files during a user-facing turn per decision `prompt-files-are-agent-owned` 0039. Recovery from agent rewrites is the operator's responsibility: keep `$GOBLIN_HOME/workspace` in a git repo and revert as needed. Non-ENOENT read errors propagate per the fail-loud rule.
