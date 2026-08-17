# Little Goblin — Feature Guide

Little Goblin is a Telegram-native personal AI agent. It is built for a single operator, runs as one Bun process, and lives wherever you put it — a $5 VPS, a homelab box, or a laptop. There is no web UI, no plugin SDK, and no external database. Telegram is the interface; durable state is filesystem-backed except for the local SQLite memory store.

## Quick start

```sh
bun install
cp .env.example .env
bun run onboard        # creates $GOBLIN_HOME/goblin.json5 + workspace/SOUL.md/AGENTS.md
bun run src/index.ts   # or: bun run dev
```

Then open Telegram and send `/start` to inspect the current Conversation in a DM or forum topic. Send ordinary text (or `/new`) to create a Conversation on an unbound Surface.

## Surfaces and Conversations

A **Surface** is one complete Telegram routing lane: a DM, forum topic, topicless supergroup, or guest lane. A Surface has at most one current **Binding**, and a Binding points to one durable **Conversation**. A Conversation is history plus an immutable execution environment; its live `AgentRunner` and queue are an ephemeral **Conversation runtime**.

- Ordinary content on an unbound Surface creates a Conversation lazily.
- `/new` rotates to fresh history without deleting the prior Conversation.
- `/resume <id>` moves compatible history to this Surface; it never shares a live runtime across Surfaces.
- `/archive` unbinds and archives the active Conversation.
- Model, thinking, schedules, heartbeat, and project assignment belong to the Surface and survive Conversation rotation.

Conversations persist in `$GOBLIN_HOME/state/sessions/<id>/` with atomic JSON state and append-only transcript/event/metric logs. Bindings and Surface settings are separately persisted under `$GOBLIN_HOME/state/`.

## Commands

All slash commands are available in DMs and in topics where the bot is reachable. In groups, only allowed users can invoke commands; everyone else must @mention the bot or reply to it.

| Command | Purpose |
|---------|---------|
| `/start` | Inspect the current Conversation. If none is bound, explains that ordinary text or `/new` will create one. |
| `/new` | Start a fresh Conversation for this Surface; prior history stays resumable. |
| `/archive` | Archive the active Conversation and dispose its runtime. |
| `/resume <id-or-name>` | Move a compatible Conversation to this Surface without losing history. |
| `/name <name>` | Set a human-readable title for the active Conversation. |
| `/project <dir>` | Assign an unassigned Surface to one project directory and start fresh project history. It cannot be cleared or switched; use another Surface for another environment. |
| `/model [index]` | List favorite models or switch one for this Surface. |
| `/think [level]` | Show or set this Surface's thinking level (`off` to `max`; unsupported levels are clamped to the nearest supported one). |
| `/compact [instructions]` | Manually compact the active Conversation runtime's context. Handy before a long task. |
| `/queue <text>` | Enqueue text to run as a fresh turn after the current one finishes. |
| `/debug` | Dump diagnostics: Conversation ID, model, project root, subagent count, bindings, etc. |
| `/subagents` | List tracked subagents. |
| `/cancel_subagent <id>` | Cancel a running subagent. |
| `/revive <id> <prompt>` | Revive a persisted subagent with a follow-up prompt. |
| `/cancel` | Abort the current turn. Cascades to subagents. |
| `/voice` | Convert the last assistant message to a voice note (Edge TTS). Shorthand: `/v`. |
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
| `memory_search` | Hybrid search across permitted curated memory and transcripts. |
| `memory_write` | Curate active-scope memory: `add`, `replace`, `remove`, `rewrite`, `set_description`. |
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

Curated memory is canonical in `$GOBLIN_HOME/state/memory/memory.sqlite`. Markdown files in that directory are export-only views, not editable storage. Active memory scope is derived from the current Surface and captured when its runtime is created, so moving a Conversation does not rewrite history or merge two Surfaces' memory context.

A bounded frozen summary is included at runtime creation; `memory_search` supplies relevant hybrid recall from allowed curated memory and transcripts per turn. `memory_write` is the sole curation path (`add`, `replace`, `remove`, `rewrite`, `set_description`); a global character budget applies. Use `memory status` and `memory export` as the operator inspection/export commands.

## Subagents

Spawn subagents to do focused work in the background:

- **Generic subagents** inherit the parent context and can use goblin’s skills.
- **Named subagents** are recipes in `$GOBLIN_HOME/workspace/agents/<name>/` with their own `AGENTS.md` and isolated `.agents/skills/` catalog.
- Recursive spawning up to **depth 3**.
- Default timeout: **10 minutes**.
- Subagents are headless: they run through the same agent code but do not talk to Telegram directly. Results come back to the parent turn.
- Subagents can be cancelled with `/cancel_subagent` or by cancelling the parent turn. Finished subagents can be revived with `/revive`.

The agent sees `spawn_subagent` and `revive_subagent` tools automatically.

## Project directory

`/project <dir>` makes a one-time project assignment for an unassigned Surface:

- It starts a fresh project Conversation; prior personal history remains resumable and keeps its personal workspace authority.
- Future Conversations on that Surface use the assigned directory as CWD. The assignment cannot be cleared or switched through `/project`.
- Project documents, voice, and audio are saved beneath the project root. Personal-environment uploads are saved under `$GOBLIN_HOME/workspace/attachments/`.
- A project `AGENTS.md` is supplemental runtime guidance; it does not replace Goblin's deployment identity prompt.

Photos are passed to the agent as inline images.

## Files and media

Goblin understands several Telegram message types:

- **Text** — normal chat, including commands.
- **Photos** — downloaded and sent to the model as an image. Caption is included as text.
- **Documents** — saved in the current Conversation environment (project root or personal `workspace/attachments/`) and announced with the actual relative path.
- **Voice messages** — transcribed when ASR is configured and saved in the current Conversation environment.
- **Audio/music files** — saved in the current Conversation environment.
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

All string values support three forms:

- Literal: `"your-token-here"`
- Env var: `"BOT_TOKEN"` reads `process.env.BOT_TOKEN`.
- Shell command: `"!pass show bots/goblin"` runs the command and uses stdout.

## Identity and prompt files

Onboarding creates two agent-owned prompt files in `$GOBLIN_HOME/workspace/`:

- `SOUL.md` — the conversational identity and voice (required). Missing at startup is fatal.
- `AGENTS.md` — agent operating rules (optional). Missing at startup produces a warning.

You can also put `AGENTS.md` in a project directory for project-specific rules.

## Security

- **Allowlist only.** Only Telegram user IDs in `allowedUsers` can talk to the bot in DMs or invoke commands without an @mention.
- **Groups.** In groups, anyone can @mention the bot or reply to its messages; only allowed users can send slash commands or plain text.
- **Small-group exception.** In groups with 2 or fewer members, allowed users can send plain text without @mentioning.
- **No external database, no webhooks.** Long-polling only. No inbound ports; memory uses local SQLite under `$GOBLIN_HOME/state/`.
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
2. **Conversation creation:** send ordinary text or `/new` on an unbound Surface
3. **Conversation:** Send ordinary text; the agent should reply with a status line
4. **Memory:** Ask goblin to "remember that I prefer concise responses"
5. **Subagent:** Ask goblin to "spawn a subagent to list the files in /home"
6. **Big output:** Ask for a large file read; it should arrive as `reply.md`
7. **Revive:** After a subagent finishes, ask to "revive that subagent with a follow-up"
