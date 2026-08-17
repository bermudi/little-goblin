---
nospec: true
role: view
---

# Little Goblin

> Telegram-native personal AI agent. Single user, single process, homelab.

Little Goblin is an autonomous agent that lives in Telegram. You message it, it thinks, it responds. It can read and edit files, run shell commands, spawn focused subagents, curate persistent memory, and send media back to you — all from a chat window.

No web UI. No external database. No webhooks. Just a Bun process, Telegram long-polling, filesystem state, and one local SQLite memory store.

---

## What it looks like

```
You: refactor the auth middleware in src/auth.ts
Goblin: 🤔 thinking…
        🔧 read src/auth.ts
        🔧 bash git diff
        ✅ bash git diff
        ✅ read src/auth.ts
        ✅ write src/auth.ts
Goblin: Done. I inlined the helper, added a test, and saved the diff to /tmp/auth-refactor.diff.
```

## Get started

```sh
# 1. Install dependencies
bun install

# 2. Copy the env template (optional — only needed if you want to reference env vars)
cp .env.example .env

# 3. Run the interactive onboarding wizard.
#    It creates $GOBLIN_HOME/goblin.json5 and the SOUL.md/AGENTS.md prompt files
#    and runs the offline state migration for you.
bun run onboard

# 4. Start the bot
bun run src/index.ts
```

Then open Telegram and send `/start` to inspect the current Conversation in a DM or forum topic. Send ordinary text (or `/new`) to create a Conversation on an unbound Surface.

See <ref_file file="/home/daniel/build/little-goblin/goblin.json5.example" /> for a complete annotated config.

## Production install

For a homelab server that survives reboots, run the packaging installer as root on a Linux host:

```sh
sudo bash scripts/install.sh
```

This creates a dedicated `goblin` user, installs `bun` if needed, clones the repo to `/opt/little-goblin`, runs `bun run onboard` if no config exists, validates the config, and installs a systemd service that auto-starts on boot. (The same script is aliased as `bun run install:prod` for discovery, but it must still be run as root.)

Once installed:

```sh
systemctl start goblin     # start now
systemctl stop goblin      # stop
systemctl status goblin    # status
journalctl -u goblin -f    # follow live logs
```

Updates are scripted:

```sh
sudo bash scripts/update.sh   # pull latest code, validate config, migrate state, then restart goblin
```

`scripts/update.sh` validates configuration before stopping Goblin, then runs the offline migration with the service stopped. It restarts only after migration succeeds; on migration failure it deliberately leaves the service stopped so the operator can restore from the migration backup, which the migration writes to `$GOBLIN_HOME/.migration-backup-<timestamp>/` (a `snapshot.json` manifest plus copies of the persisted roots). If the pull changes `update.sh` itself, the updater hands off to the pulled revision before any post-pull deployment step, so it never mixes old control flow with new code. Run CI/typecheck before invoking it—it does not run them.

## Core ideas

- **Telegram is the UI.** Every feature is designed around chat, topics, replies, and file sharing.
- **Surfaces and conversations are separate.** A Surface is a DM, topic, or group routing lane. Its Binding points to one current Conversation; `/resume` moves compatible history rather than sharing a live runtime.
- **Immutable project environments.** `/project <dir>` assigns an unassigned Surface once and starts fresh project history. Existing history remains resumable; switch projects by using another Surface.
- **Curated memory.** The agent decides what to remember. The canonical store is local SQLite and its active scope is derived from the current Surface.
- **Subagents.** Delegate work to headless workers that can recursively spawn up to depth 3, then revive them later.
- **Local durable state.** Bindings and Conversation metadata are atomic JSON/JSONL files; memory is the one local SQLite store.

## Commands

Send any of these in Telegram:

| Command | What it does |
|---------|--------------|
| `/start` | Report the active Conversation on this Surface; if none is bound, explain how to start one. |
| `/new` | Start a fresh Conversation on this Surface; prior history remains resumable. |
| `/resume <id>` | Move a compatible Conversation to this Surface. |
| `/archive` | Archive the active Conversation. |
| `/name <name>` | Name the active Conversation. |
| `/project <dir>` | Assign this unassigned Surface to one project environment and start fresh project history. |
| `/model [index]` | List or switch favorite models. |
| `/think [level]` | Show or set thinking level (`off` to `max`). |
| `/compact` | Manually compact the active Conversation runtime's context. |
| `/queue <text>` | Enqueue a follow-up turn. |
| `/subagents` | List running/persisted subagents. |
| `/cancel_subagent <id>` | Cancel a subagent. |
| `/revive <id> <prompt>` | Revive a subagent with a follow-up. |
| `/cancel` | Abort the current turn (cascades to subagents). |
| `/voice` | Convert the last assistant message to a voice note. |
| `/debug` | Dump Conversation and runtime diagnostics. |
| `/ping` | Smoke test. |
| `/help` | Show the command list. |

For full details see <ref_file file="/home/daniel/build/little-goblin/features.md" />.

## Models

Goblin supports multiple provider namespaces via prefixed model IDs:

- `poe/Claude-Sonnet-4.6`, `poe/GPT-5`, `poe/Gemini-2.5-Pro`
- `or/anthropic/claude-sonnet-4.5`, `or/openai/gpt-5`
- `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/o4`
- `anthropic/claude-opus-4`, `anthropic/claude-sonnet-4.6`
- `zai/glm-5.2`, `zai/glm-5.1`
- `opencode-go/glm-5.2`, `opencode-go/minimax-m3`, `opencode-go/kimi-k2.6`

Pattern-built entries are also available for unknown `poe/<id>`, `or/<slug>`, `openai/<id>`, `anthropic/<id>`, `zai/<id>`, and `opencode-go/<id>` models. Set the matching API key in `goblin.json5`.

## Development

```sh
bun run dev          # watch mode
bun run test         # run all tests
bun run typecheck    # TypeScript check
bun run onboard      # first-time setup wizard
bash scripts/deployment-order.test.sh  # isolated fake-command deployment ordering checks
```

Tests are colocated with source files (`foo.ts` ↔ `foo.test.ts`). `src/subagents/` is the one exception: its suites live under `src/subagents/test/*.suite.ts` and are bootstrapped from `src/subagents/mod.test.ts` because `bun:test` `mock.module()` is process-global.

## Architecture

The core ownership boundary is `Surface → Binding → Conversation → ConversationRuntime`:

1. **Telegram layer** (`src/tg/`) normalizes and delivers complete Surfaces.
2. **Lifecycle/orchestration** (`src/orchestration/`) owns binding transitions, pending-assignment recovery, runtime authority, and queue invalidation.
3. **Persistence** (`src/sessions/`) owns Conversations, bindings, and Surface settings; **agent** (`src/agent/`) owns pi runtime construction.

Read `ARCHITECTURE.md` for current/target boundaries. Code/tests and explicitly designated contract records own current behavior; accepted architectural rulings live in `decisions/`. Internal guardrails are in <ref_file file="/home/daniel/build/little-goblin/AGENTS.md" />.

## Documentation map

| File | What it covers |
|------|----------------|
| <ref_file file="/home/daniel/build/little-goblin/README.md" /> | This file — quick start, overview, command cheat-sheet. |
| <ref_file file="/home/daniel/build/little-goblin/features.md" /> | Full user guide: Surfaces, Conversations, tools, memory, subagents, media, config, security. |
| <ref_file file="/home/daniel/build/little-goblin/goblin.json5.example" /> | Annotated configuration example. |
| <ref_file file="/home/daniel/build/little-goblin/AGENTS.md" /> | Project guardrails and planning discipline. |
| `ARCHITECTURE.md` | Current/target/open system map and delivery order. |
| `BACKLOG.md` | Current priority, next cycle, parked scope, and open questions. |
| `decisions/` | Accepted architectural rulings. |
| `glossary.md` | Canonical domain language. |
| `specs/` | Frozen Litespec-era contracts, plans, decisions, and archives retained as historical input. |

---

Built for homelab. Operated from Telegram. Kept small on purpose.
