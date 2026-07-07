# Little Goblin

> Telegram-native personal AI agent. Single user, single process, homelab.

Little Goblin is an autonomous agent that lives in Telegram. You message it, it thinks, it responds. It can read and edit files, run shell commands, spawn focused subagents, curate persistent memory, and send media back to you — all from a chat window.

No web UI. No database. No webhooks. Just a Bun process, Telegram long-polling, and the filesystem.

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
#    It creates $GOBLIN_HOME/goblin.json5 and the SOUL.md/AGENTS.md prompt files.
bun run onboard

# 4. Start the bot
bun run src/index.ts
```

Then open Telegram and send `/start` in a DM, or start typing in a forum topic where the bot is a member.

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

Backups and updates are also scripted:

```sh
sudo bash scripts/backup.sh   # archive $GOBLIN_HOME to $GOBLIN_HOME/backups/
sudo bash scripts/update.sh   # pull latest code, run checks, then restart goblin
```

`scripts/update.sh` only restarts the service if the typecheck and `bun run validate-config` pass, so a bad deploy cannot leave the bot down.

`scripts/backup.sh` is safe to run while the service is running: most state files are written atomically (tmp + rename). The exception is `state/transcript.jsonl`, which is appended line-by-line; a live backup may capture a partial trailing line.

## Core ideas

- **Telegram is the UI.** Every feature is designed around chat, topics, replies, and file sharing.
- **One session per topic.** DMs and forum topics are isolated contexts. A supergroup without topics shares one session.
- **Project directory binding.** Point a session at a directory on disk; the agent works there, and uploaded files land there.
- **Curated memory.** The agent decides what to remember. Memory is scoped by chat/topic, global user identity, and named subagent persona.
- **Subagents.** Delegate work to headless workers that can recursively spawn up to depth 3, then revive them later.
- **No database.** State is JSON files and JSONL logs. Writes are atomic (tmp + rename).

## Commands

Send any of these in Telegram:

| Command | What it does |
|---------|--------------|
| `/start` | Start or resume a session in a DM. In a topic, confirms it is already active. |
| `/new` | Archive the current session and start fresh. |
| `/resume <id>` | Switch this chat/topic to another existing session. |
| `/archive` | Archive the active session. |
| `/name <name>` | Name the active session. |
| `/project <dir>` | Bind the session to a project directory. |
| `/model [index]` | List or switch favorite models. |
| `/think [level]` | Show or set thinking level (`off` to `xhigh`). |
| `/compact` | Manually compact the session context. |
| `/queue <text>` | Enqueue a follow-up turn. |
| `/subagents` | List running/persisted subagents. |
| `/cancel_subagent <id>` | Cancel a subagent. |
| `/revive <id> <prompt>` | Revive a subagent with a follow-up. |
| `/cancel` | Abort the current turn (cascades to subagents). |
| `/voice` | Convert the last assistant message to a voice note. |
| `/debug` | Dump session diagnostics. |
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
```

Tests are colocated with source files (`foo.ts` ↔ `foo.test.ts`). `src/subagents/` is the one exception: its suites live under `src/subagents/test/*.suite.ts` and are bootstrapped from `src/subagents/mod.test.ts` because `bun:test` `mock.module()` is process-global.

## Architecture

The code is organized in three layers:

1. **Telegram layer** (`src/tg/`) — grammy client, message normalization, allowlist middleware, β-tools, and the message buffer.
2. **Session layer** (`src/sessions/`) — maps `(chat, topic)` to persistent session state, bindings, and project directories.
3. **Agent layer** (`src/agent/`) — wraps `pi-coding-agent`, manages model resolution, context, and tool registration.

Detailed specs live in `specs/canon/`. Historical design decisions and phased changes are archived under `specs/changes/archive/`. Internal guardrails are in <ref_file file="/home/daniel/build/little-goblin/AGENTS.md" />.

## Documentation map

| File | What it covers |
|------|----------------|
| <ref_file file="/home/daniel/build/little-goblin/README.md" /> | This file — quick start, overview, command cheat-sheet. |
| <ref_file file="/home/daniel/build/little-goblin/features.md" /> | Full user guide: sessions, tools, memory, subagents, media, config, security. |
| <ref_file file="/home/daniel/build/little-goblin/goblin.json5.example" /> | Annotated configuration example. |
| <ref_file file="/home/daniel/build/little-goblin/AGENTS.md" /> | Project guardrails for contributors. |
| `specs/canon/` | Architecture and behavior specs. |
| `specs/changes/archive/` | Past litespec changes and design docs. |

---

Built for homelab. Operated from Telegram. Kept small on purpose.
