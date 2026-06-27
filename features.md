# Little Goblin — Feature Guide

Little Goblin is a Telegram-native personal AI agent. It is built for a single operator, runs as one Bun process, and lives wherever you put it — a $5 VPS, a homelab box, or a laptop. There is no web UI, no plugin SDK, and no database. Telegram is the interface; the filesystem is the state.

## Quick start

```sh
bun install
cp .env.example .env
bun run onboard        # creates $GOBLIN_HOME/goblin.json5 + SOUL.md/AGENTS.md
bun run src/index.ts   # or: bun run dev
```

Then open Telegram and send `/start` to your bot in a DM, or start typing in a forum topic where the bot is a member.

## Sessions

Everything happens inside a **session**. A session is identified by `(chat, topic)`:

- **DM** — one session per private chat. Created with `/start` or automatically on first message.
- **Forum topic** — every topic is its own isolated session. Auto-created on the first message.
- **Supergroup without topics** — one shared session for the whole group.
- **Plain group** — not supported. Use a supergroup with forum topics for group work.

Sessions persist in `$GOBLIN_HOME/sessions/<id>/`. Each session has:

- `state.json` — session metadata, model override, thinking level, title, archived flag.
- `events.jsonl` — append-only log of the conversation and tool events.
- Atomic file writes (tmp + rename) everywhere.

Commands that affect the session dispose the live `AgentRunner` and start fresh when needed.

## Commands

All slash commands are available in DMs and in topics where the bot is reachable. In groups, only allowed users can invoke commands; everyone else must @mention the bot or reply to it.

| Command | Purpose |
|---------|---------|
| `/start` | DM: create a session if none exists, or welcome back to the existing one. Topic: tells you the topic is already its own session. |
| `/new` | Archive the current session and start a fresh one for this chat/topic. |
| `/archive` | Mark the active session as archived. It stops appearing in `/resume` and the runner is disposed. |
| `/resume <id-or-name>` | Bind this chat/topic to an existing session. Useful for switching contexts without losing history. |
| `/name <name>` | Set a human-readable title for the active session. |
| `/project <dir>` | Bind the session to a project directory. Uploaded documents, voice, and audio are saved there; the agent uses it as cwd. Pass no argument to clear. |
| `/model [index]` | List favorite models or switch to one. The override is stored per session. |
| `/think [level]` | Show or set the thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). Clamped to what the current model supports. |
| `/compact [instructions]` | Manually compact the session context. Handy before a long task. |
| `/queue <text>` | Enqueue text to run as a fresh turn after the current one finishes. |
| `/debug` | Dump diagnostics: session id, model, project dir, subagent count, bindings, etc. |
| `/subagents` | List tracked subagents. |
| `/cancel_subagent <id>` | Cancel a running subagent. |
| `/revive <id> <prompt>` | Revive a persisted subagent with a follow-up prompt. |
| `/cancel` | Abort the current turn. Cascades to subagents. |
| `/ping` | Smoke test. Replies with pong and chat info. |
| `/help` | Show the command list. |

## Models

Model IDs are prefixed by provider. Set the matching API key in `goblin.json5`.

| Provider | Prefix | Examples |
|----------|--------|----------|
| **Poe** | `poe/` | `poe/Claude-Sonnet-4.6`, `poe/GPT-5`, `poe/Gemini-2.5-Pro` |
| **OpenRouter** | `or/` | `or/anthropic/claude-sonnet-4.5`, `or/openai/gpt-5` |
| **OpenAI** | `openai/` | `openai/gpt-5.4`, `openai/gpt-5.4-mini`, `openai/o4` |
| **Anthropic** | `anthropic/` | `anthropic/claude-opus-4`, `anthropic/claude-sonnet-4.6` |
| **Z.AI Coding Plan** | `zai/` | `zai/glm-5.2`, `zai/glm-5.1` |
| **OpenCode Go** | `opencode-go/` | `opencode-go/glm-5.2`, `opencode-go/minimax-m3`, `opencode-go/kimi-k2.6` |

Poe, OpenRouter, direct OpenAI, and direct Anthropic accept arbitrary model IDs via pattern matching (`poe/<bot-id>`, `or/<slug>`, `openai/<id>`, `anthropic/<id>`). Z.AI and OpenCode Go also fall back to pattern-built entries for unknown IDs.

Use `favorites` in `goblin.json5` to populate `/model` quick-switch list.

## Tools

The agent has access to filesystem, shell, memory, subagent, and Telegram tools.

### Core (α) tools

| Tool | What it does |
|------|--------------|
| `read` | Read file contents. |
| `bash` | Execute shell commands. |
| `edit` | Modify files. |
| `write` | Create or overwrite files. |
| `grep` | Search file contents. |
| `memory_read` | Read scoped memory (`memory`, `user`, `agent`). |
| `memory_read_index` | List available memory scopes and descriptions. |
| `memory_write` | Curate memory: `add`, `replace`, `remove`, `rewrite`, `set_description`. |
| `spawn_subagent` | Delegate work to a subagent. |
| `revive_subagent` | Resume a persisted subagent with a follow-up. |
| `text_to_speech` | Convert text to speech (Edge TTS). Returns an MP3 path. |

### Telegram (β) tools

These are injected per chat surface and can be used by the agent when it wants to send media or rename the topic:

| Tool | What it does |
|------|--------------|
| `send_voice` | Send a voice message to the chat. |
| `send_photo` | Send an image to the chat. |
| `send_document` | Send a file to the chat. |
| `rename_topic` | Rename the active forum topic. |

## Memory

Goblin keeps curated, agent-controlled persistent memory in `$GOBLIN_HOME/memory/`:

| Target | Cap | Purpose |
|--------|-----|---------|
| `memory` (active scope) | 4000 chars | Notes about the current chat/topic, projects, conventions, decisions. |
| `user` | 2000 chars | Global user preferences, communication style, recurring people/places. |
| `agent` | 2000 chars | Named subagent persona memory. |
| `general` | 4000 chars | Fallback memory for surfaces without a topic scope. |

Memory is injected as a per-turn aside, so the frozen system prompt stays cacheable. Every successful memory write is committed to a git repo at `$GOBLIN_HOME/memory/.git` with subject `memory: <action> in <target>`.

The agent can read memory from other scopes (`general`, another topic, a named agent) via `memory_read` with an explicit scope, and discover them via `memory_read_index`.

## Subagents

Spawn subagents to do focused work in the background:

- **Generic subagents** inherit the parent context and can use goblin’s skills.
- **Named subagents** are recipes in `$GOBLIN_HOME/agents/<name>/` with their own `AGENTS.md` and isolated `skills/` directory.
- Recursive spawning up to **depth 3**.
- Default timeout: **10 minutes**.
- Subagents are headless: they run through the same agent code but do not talk to Telegram directly. Results come back to the parent turn.
- Subagents can be cancelled with `/cancel_subagent` or by cancelling the parent turn. Finished subagents can be revived with `/revive`.

The agent sees `spawn_subagent` and `revive_subagent` tools automatically.

## Project directory

`/project <dir>` binds a session to a directory on the host:

- Uploaded **documents**, **voice**, and **audio** are saved there.
- The agent uses it as the working directory for `bash`, `read`, `edit`, `write`.
- You can put an `AGENTS.md` in that directory for project-specific instructions; it is injected into the system prompt.

Without a project directory, documents/voice/audio are rejected with a prompt to set one. Photos are always sent to the agent as inline images (no directory needed).

## Files and media

Goblin understands several Telegram message types:

- **Text** — normal chat, including commands.
- **Photos** — downloaded and sent to the model as an image. Caption is included as text.
- **Documents** — if a project directory is set, saved there and announced to the agent. If no project dir, the caption is used as a text prompt instead.
- **Voice messages** — saved to the project directory if set; otherwise rejected with instructions.
- **Audio/music files** — same as documents/voice.
- **Forum topic creation/edits** — topic names are persisted as memory scope descriptions.

Telegram Bot API limits file downloads to **20 MB**. Anything larger is dropped with a warning.

## Status line and UI

While the agent is working, Goblin posts a live status line in the chat:

- Header: `🤔 thinking…` or the current high-level state.
- One slot per visible tool, updated as tools start and finish.
- Slots transition from 🔧 to ✅ or ❌.

Tool visibility is controlled by `toolVisibility` in `goblin.json5`:

| Level | What is shown |
|-------|---------------|
| `none` | No status line. |
| `minimal` | State-changing tools only: `bash`, `write`, `edit`, `spawn_subagent`. |
| `standard` | All α tools (default). |
| `verbose` | α tools plus `revive_subagent` and `list_subagents`. |
| `debug` | Every tool call. |

Responses are streamed with throttled edits (~1/sec). If a response exceeds **20 000 characters**, Goblin sends it as a `reply.md` document with a short prefix summary instead of splitting it into many messages.

## Configuration

Configuration lives in `$GOBLIN_HOME/goblin.json5`. See <ref_file file="/home/daniel/build/little-goblin/goblin.json5.example" /> for a full example.

Key options:

| Key | Meaning |
|-----|---------|
| `botToken` | Telegram BotFather token. |
| `allowedUsers` | Array of Telegram user IDs allowed to use the bot. |
| `model` | Default model ID (e.g. `poe/Claude-Sonnet-4.6`). |
| `poeApiKey` / `openrouterApiKey` / `openaiApiKey` / `anthropicApiKey` / `zaiApiKey` / `opencodeApiKey` | Provider API keys. |
| `favorites` | Model IDs available to `/model`. |
| `logLevel` | `debug`, `info`, `warn`, `error`. |
| `toolVisibility` | Status-line detail level. |
| `skillSources` | `goblin-only` (use only repo skills) or `user` (also discover `$GOBLIN_HOME/skills/`). |

All string values support three forms:

- Literal: `"your-token-here"`
- Env var: `"BOT_TOKEN"` reads `process.env.BOT_TOKEN`.
- Shell command: `"!pass show bots/goblin"` runs the command and uses stdout.

## Identity and prompt files

Onboarding creates two deployment-owned prompt files in `$GOBLIN_HOME`:

- `SOUL.md` — the conversational identity and voice (required). Missing at startup is fatal.
- `AGENTS.md` — deployment operating rules (optional). Missing at startup produces a warning.

You can also put `AGENTS.md` in a project directory for project-specific rules.

## Security

- **Allowlist only.** Only Telegram user IDs in `allowedUsers` can talk to the bot in DMs or invoke commands without an @mention.
- **Groups.** In groups, anyone can @mention the bot or reply to its messages; only allowed users can send slash commands or plain text.
- **Small-group exception.** In groups with 2 or fewer members, allowed users can send plain text without @mentioning.
- **No database, no webhooks.** Long-polling only. No inbound ports.
- **No secrets in source.** API keys and the bot token live in `goblin.json5` (or the env/command it resolves).

## Commands and concepts at a glance

- **Start fresh:** `/new`
- **Switch context:** `/resume <id>`
- **Name a topic:** `/name "refactor planning"`
- **Bind a project:** `/project /home/daniel/build/my-project`
- **Switch model:** `/model` then `/model 3`
- **Think harder:** `/think high`
- **Spawn work:** tell the agent `spawn a subagent to research this`
- **Check state:** `/debug`
- **Stop everything:** `/cancel`

## Quick test checklist

1. **Basic connectivity:** `/ping`
2. **Session creation:** `/start` in a DM, or type in a forum topic
3. **Conversation:** Send ordinary text; the agent should reply with a status line
4. **Memory:** Ask goblin to "remember that I prefer concise responses"
5. **Subagent:** Ask goblin to "spawn a subagent to list the files in /home"
6. **Big output:** Ask for a large file read; it should arrive as `reply.md`
7. **Revive:** After a subagent finishes, ask to "revive that subagent with a follow-up"
