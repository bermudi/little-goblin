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
- **Atomic writes.** tmp + `renameSync`. JSON for state, JSONL for logs. No database.
- **Fail loud.** `ENOENT` is expected — return null. Everything else propagates.
- **No `console.log`.** Use `log` from `src/log.ts`.
- **One module, one job.** Flat modules with `mod.ts` barrels. Colocate tests.

## Temporary Notes

[src/bot.ts] is approaching its limit at 291 lines. The single message:text handler is now ~225 lines with a big switch and a lot of nested closures. Each command's body is doing wiring (lookup runner, archive, dispose, delete from map, format reply) that smells dispatchable. I'd extract a handleCommand(command, ctx, deps): Promise<boolean> so bot.ts becomes "wire middleware, route to handler, error-handle." Don't refactor for its own sake, but next time you add a command you'll feel the friction.

## Memory

Curated, agent-controlled persistent memory lives at `$GOBLIN_HOME/memory/`:

- `memory.md` — notes about the environment, projects, conventions, decisions. Cap: **4000 chars**.
- `user.md` — user preferences, communication style, recurring people/places. Cap: **2000 chars**.
- Entries are separated by `\n§\n`. Single-entry files contain no delimiter.
- Goblin curates this via the `memory` tool (`add` / `replace` / `remove`). Overflow returns an error to the agent telling it to consolidate; defrag is the agent's job, not the user's.
- Every successful write commits to a git repo at `$GOBLIN_HOME/memory/.git` with subject `memory: <action> in <target>`.
- Inspect: `cat $GOBLIN_HOME/memory/memory.md`, `git -C $GOBLIN_HOME/memory log --oneline`.
- The whole snapshot is injected into every turn as a per-turn aside via pi's `sendCustomMessage(..., { deliverAs: "nextTurn" })`. The system prompt stays frozen so the provider prefix cache holds.

This file (`AGENTS.md`) is **not** auto-injected into the system prompt today; that's a separate concern.

## Test conventions

- **Colocated.** `foo.ts` ↔ `foo.test.ts` in the same directory. `bun test` discovers them automatically.
- **One exception: `src/subagents/`.** Its tests live in `src/subagents/test/*.suite.ts`, bootstrapped from `mod.test.ts`. The reason: `bun:test` `mock.module()` is process-global, so the suites must run under a single mock install. The `.suite.ts` extension prevents bun from auto-discovering them (which would race the mock). If bun ever gets per-file mock scoping, collapse this back to colocated `.test.ts` files.
- Add `"test": "bun test"` to package.json if it's still missing.

## Things not to do

- No web UI, no multi-channel, no plugin SDK, no Docker, no k8s
- No security audit system
- No multi-agent gateway
- Don't touch `$GOBLIN_HOME` from the code tree except through `SessionManager`, `MemoryStore`, and `paths.ts`
