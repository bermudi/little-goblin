# little-goblin

Telegram-native personal AI agent. Single user (bermudi), single process, homelab.

Goblin lives in Telegram. You message it, it thinks, it responds. It can spawn subagents for focused work, persist conversation history, and evolve its own skills. Deep use of Telegram as UI — reactions, voice, topics, files — not just a chat wrapper.

## Run

```sh
bun install
cp .env.example .env   # BOT_TOKEN, ALLOWED_TG_USER_IDS, MODEL_NAME + API key
bun run src/index.ts    # or: bun run dev
```

## Shape

Single bun process. Three layers:

1. **Telegram layer** — grammy client, message normalization, β-tools (reactions, voice, files). Turns Telegram events into goblin's world.
2. **Session layer** — maps `(chat, topic)` to persistent session. Owns events.jsonl, state, bindings. Topics auto-create; DMs require `/new`.
3. **Agent layer** — wraps pi-coding-agent. Manages LLM context, tool registry, subagent spawning.

Entry at `src/index.ts` → `src/bot.ts` wires layers, mounts middleware, starts polling.

Architecture lives in `specs/` (litespec). This file is just guardrails.

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
