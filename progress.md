# little-goblin

> Telegram-native personal AI agent. One user (bermudi), one goblin, one homelab.
> Anti-thesis: openclaw. If we're about to build a plugin SDK, we've lost.

## North star

A **goblin** that lives on the homelab, reachable over Telegram, with pi-coding-agent as its brain and deep use of Telegram as its UI. Single-user, single-process, filesystem-as-extensibility.

The goblin is **one persistent entity** — one brain, one workspace, one memory — that accumulates knowledge and artifacts over time. It spawns subagents (workers and named specialists) to do focused work without diluting its own context. Every subagent conversation is a persisted pi session, revivable like `pi -c`.

## Frozen decisions

### Surface
- **Channel:** Telegram only. No web UI, no other channels, ever.
- **Lean into Telegram features:** voice, inline keyboards, reactions, chat actions, forum topics, pins, renames, file sends. These are not transport; they are UI.
- **Auth:** bot token + hardcoded Telegram user-id allowlist (just bermudi). No pairing ceremony, no OAuth, no "trust model."

### Sessions (Q4) — Telegram conversation threads
- **Goblin-level concept**, projected onto Telegram two ways:
  - In forum-enabled groups: **one topic = one session**.
  - In DMs: **`/new` creates a session**; current-session state is per-chat.
- Sessions are **conversation contexts**, not isolated workspaces.
- **All sessions share goblin's single workspace** (`~/goblin/workdir/`). Files, memory, and skills accumulate across sessions — goblin is one entity, not a fleet of isolated agents.
- Per-session filesystem state is limited to observability: `state.json` (TG binding), `events.jsonl`, `transcript.jsonl`.
- **Isolation when needed** is solved by git + homelab snapshots, not per-session directories.

### Workspace & memory (Q8)
- **One workspace**: `~/goblin/workdir/` is goblin's cwd for every session.
- **AGENTS.md** at `~/goblin/AGENTS.md`, always in context. Goblin may append; bermudi edits by hand.
- **Skills** at `~/goblin/skills/`, shared across all goblin sessions.
- **v1.5:** `remember()` tool → appends to `~/goblin/memory/YYYY-MM.md`.
- **Rejected:** vector stores. Grep > embeddings at this scale.

### Subagents (Q7) — workers and specialists
Goblin spawns subagents to do focused work without polluting its own context. Two kinds:

- **Generic subagents** — ad-hoc spawns for one-off focused tasks. System prompt set at spawn time. Inherit goblin's skills (optionally filtered via `tools` whitelist). Examples: "research these five URLs," "grep this codebase in parallel."
- **Named subagents** — specialists pre-defined at `~/goblin/agents/<name>/` with their own `AGENTS.md` and `skills/`. Examples: Researcher, Reviewer, HomelabOps. **Strictly isolated** from goblin's skills — a Researcher sees only `agents/researcher/skills/`, never `~/goblin/skills/`. This isolation is the whole point: a specialist has a focused, curated toolkit.

**Every subagent instance is a persisted pi session.** Every spawn creates a full conversation history stored as JSONL. Revival is effortless — pass the subagent id + a new prompt and pi-coding-agent's `SessionManager.open()` restores the full context. This is "pi -c for subagents."

**No Telegram surface.** Subagents are invoked by goblin programmatically via tool calls. Results flow back through goblin's narration ("spawning 3 researchers…"). User never chats directly with a subagent in v1; user-facing named-subagent invocation is a v1.1 feature.

**Scope (cwd) is chosen per spawn:**
- `shared` — cwd = goblin's workdir. For read-mostly or whole-workspace tasks.
- `isolated` — cwd = subagent instance's own workdir. For experiments, parallel work, untrusted operations.

**Lifecycle:** subagent sessions persist forever by default, matching goblin's session philosophy. User runs `/prune_subagents` to reclaim disk.

**Cross-talk between live subagents is deferred to v2.** v1 expresses all coordination as either (a) goblin orchestrating serial spawns, passing A's result into B's prompt, or (b) reviving a subagent with new context. Design reference for v2 cross-talk: `~/build/pi-messenger-swarm`.

**Recursion:** subagents may spawn their own subagents, capped at depth 3 to prevent runaway.

### Deployment (Q5)
- **Homelab box.** Full user-level filesystem access (media, NAS, services reachable on LAN).
- **Long-polling only.** No inbound ports, no tunnel, no public exposure.
- **`systemd --user` service.** `goblin.service`. Auto-restart. `journalctl --user -u goblin`.
- No Docker, no k8s, no monorepo.

### Capabilities (Q6)
- **α Core (pi defaults):** shell, read/edit/apply_patch, web fetch/search, code exec. In.
- **β Telegram-native tools:** send voice, photos, files, inline keyboards, reactions, pin, rename topics, set chat actions. In. **Not available to subagents** (no TG surface).
- **γ Homelab control:** NOT a tool suite. Delivered as `skills/` + generic HTTP + `ssh`. Goblin learns services from markdown skills.
- **δ Subagent orchestration:** `spawn_subagent`, `spawn_named`, `revive_subagent`, `list_subagents` — available to goblin and (recursively, up to depth 3) to subagents.
- **ε Personal assistant (calendar/reminders):** deferred.

### Memory (Q8)
- Covered under "Workspace & memory" above. Single source of truth: `~/goblin/AGENTS.md`, `~/goblin/skills/`, `~/goblin/workdir/`.
- Named subagents have their own `AGENTS.md` and `skills/` (strict isolation).

### Model (Q9)
- **Poe primary, OpenRouter secondary.** Both supported in v1 via an explicit model table in `src/agent/models.ts`.
- Env: `POE_API_KEY` and/or `OPENROUTER_API_KEY` (at least one required) + `MODEL_NAME` (a key in the table). No `MODEL_BASE_URL` — baseUrl is a property of each model entry.
- **Per-family API routing** (Poe exposes all three endpoints; pick the richest that fits):
  - Claude models        → `anthropic` / Messages API (`https://api.poe.com`) — prompt caching, thinking blocks
  - GPT + o-series       → `openai-responses` (`https://api.poe.com/v1`) — reasoning summaries
  - Everything else (Gemini/Llama/…) → `openai-completions` (`https://api.poe.com/v1`)
  - All OpenRouter models → `openai-completions` (OR only speaks chat completions)
- Poe's Responses API has documented gaps (`instructions` ignored, `previous_response_id` 500s) but pi-ai's `openai-responses` provider is stateless and doesn't use either, so we're unaffected.
- `selectModel(task)` router stays a v1.x one-file change; v1 uses a single model per session. Subagents may override model per spawn in v1.x.

### Safety posture (Q10)
- **YOLO.** No approval prompts. Goblin acts.
- Mitigation: `trash` aliased for `rm` in goblin's shell; git in `~/goblin/workdir/`; homelab snapshots.
- v1.1 escape hatch: allowlist-with-Telegram-approval is mechanically addable later.

### β tool binding (design)
Every β tool (send_voice, react, rename_topic, etc.) is instantiated with its `chatId` (and `messageId`/`topicId` where relevant) **baked into the closure at creation time**. The LLM never sees or passes `chatId` as a parameter.

**Why:** Prevents the LLM from hallucinating wrong targets and sending messages/reactions to random chats. The tool schema stays clean (just business args like `voiceFile`, `emoji`). Each `AgentRunner` instance gets its own β tool instances bound to that specific Telegram session.

**Where:** Tool factories live in `src/tg/` (Telegram layer). `bot.ts` creates instances per-session and passes them to `AgentRunner` as `customTools`. Subagents receive no β tools — they have no Telegram surface.

### Session lifecycle (Q11)
- Telegram sessions **persist forever** by default. `/archive` moves the session dir to `sessions/archive/` and renames the Telegram topic to its final title.
- Subagent sessions also persist forever. `/prune_subagents` reclaims disk.
- No auto-archive / auto-prune daemons in v1.

### Output / streaming (Q12)
- **Hybrid (d):**
  - **Tool calls:** coalesced status lines in one edited message (🧠 thinking / 🔧 tool / ✍️ composing / ✅ ❌). ~1 edit/sec throttle.
  - **Model response:** streamed via edits on its own message, rolling to a new message at 4096 chars.
  - **Big output (>~20KB):** send as `reply.md` file attachment with a short summary.
- `chat_action("typing…")` refreshed every ~4s while active.
- Tool stdout/stderr is **hidden by default** — goblin summarizes. User asks to see raw if wanted.
- `MessageBuffer` class owns rate-limit coalescing; drops intermediate edits if it can't keep up; never crashes goblin.
- Subagent tool activity appears in goblin's status line ("🧠 Researcher thinking…"), not as raw events.
- **Tool visibility config:** User-configurable levels (`none`, `minimal`, `standard`, `verbose`, `debug`). `AgentRunner` fires `onToolStart/End` for **every tool**; `MessageBuffer` filters based on user config. Complete audit trail in `events.jsonl`, filtered view in Telegram.

### Stack (Q13)
- **Runtime:** `bun`.
- **Language:** TypeScript, strict.
- **Agent brain:** `pi-coding-agent` embedded as a library. No subprocess.
- **Telegram:** `grammy`.
- **Layout:** single package. `package.json`, `src/`, no workspaces.

### Observability (Q13)
- Per-Telegram-session JSONL at `sessions/<id>/events.jsonl`.
- Per-subagent-instance JSONL at `subagents/<id>/events.jsonl` or `agents/<name>/instances/<id>/events.jsonl`.
- Goblin's session `events.jsonl` records spawn/revive markers with the subagent id for cross-reference.
- `/debug` DMs the tail of the current session's events. `/debug <subagent-id>` dumps a subagent's tail.
- `journalctl` for process-level. No OTel, no Prom, no dashboards.

## Filesystem layout

```
~/goblin/                          # GOBLIN_HOME (configurable)
├── AGENTS.md                      # goblin's long-term memory
├── skills/                        # goblin's shared skills
│   └── <name>/SKILL.md
├── memory/                        # v1.5 remember() appends here
│   └── YYYY-MM.md
├── workdir/                       # goblin's single shared cwd (all sessions)
│   └── (files accumulate over time)
├── agents/                        # named subagent definitions + instances
│   └── <name>/                    # e.g., "researcher", "reviewer"
│       ├── AGENTS.md              # role system prompt
│       ├── skills/                # role-specific skills (strict isolation)
│       └── instances/             # each past/current spawn
│           └── <id>/
│               ├── session.jsonl  # pi session (revivable)
│               ├── meta.json      # status, spawnedBy, timestamps
│               ├── events.jsonl
│               └── workdir/       # if scope=isolated
├── subagents/                     # generic subagent instances
│   └── <id>/
│       ├── session.jsonl          # pi session (full conversation)
│       ├── meta.json              # role?, status, spawnedBy, timestamps
│       ├── events.jsonl
│       └── workdir/               # if scope=isolated
├── sessions/                      # goblin's Telegram sessions
│   ├── <id>/
│   │   ├── state.json             # chatId, topicId, title
│   │   ├── events.jsonl
│   │   └── transcript.jsonl
│   └── archive/<id>/              # /archive destination
├── pi-agent/                      # pi's internal state (shared across all agents)
│   ├── auth.json
│   └── settings.json
└── config.json                    # chat-id <-> session-id bindings, misc

~/.config/goblin/.env              # MODEL_*, BOT_TOKEN, ALLOWED_TG_USER_IDS
```

Running code lives at `/home/daniel/build/little-goblin`. Goblin state is `~/goblin/`. Code and state are separate trees.

## High-level architecture

Single process, four concerns:

1. **Telegram I/O** (`src/tg/`) — grammy client, long-polling, message normalization, `MessageBuffer` for outbound coalescing, β-tool implementations.
2. **Goblin sessions** (`src/sessions/`) — maps `(chat_id, topic_id | "dm")` → session-id, state.json lifecycle, `/new` / `/archive` / `/debug` commands.
3. **Agent runner** (`src/agent/`) — wraps pi-coding-agent for goblin's main agent. Owns shared services (AuthStorage, ModelRegistry, SettingsManager) pointing at `~/goblin/pi-agent/`. Loads goblin's AGENTS.md + skills. Pipes events into TG layer via `MessageBuffer`, writes `events.jsonl`.
4. **Subagent runner** (`src/subagents/`) — spawn (generic + named), revive, list, prune. Reuses the Agent runner's shared services. Loads named agent definitions from `~/goblin/agents/<name>/`. Persists sessions to `subagents/<id>/` or `agents/<name>/instances/<id>/`.

Plus `src/commands/` for `/`-commands and `src/config.ts` for env loading.

## v1 milestone (ship this)

- [x] `bun init`, scaffold `src/`, install `grammy` + `pi-coding-agent`.
- [x] Env loader (`MODEL_*`, `BOT_TOKEN`, `ALLOWED_TG_USER_IDS`, `GOBLIN_HOME`).
- [x] Long-polling bot with user-id allowlist middleware.
- [x] Session manager: `/new`, resolve chat→session, create state.json.
- [ ] `~/goblin/workdir/` as shared cwd. Remove per-session workdir from `paths.ts`, update `ensureGoblinHome()` to create it.
- [ ] Agent runner: embed pi, point shared services at `~/goblin/pi-agent/`, cwd = shared workdir, load AGENTS.md + skills from `~/goblin/`.
- [ ] `MessageBuffer` (src/tg/) with 1 edit/sec throttle, 4096-char rollover, file-attachment escape.
- [ ] Hybrid streaming wired: status-line message (tools) + response message (model stream).
- [ ] `chat_action("typing…")` heartbeat.
- [ ] β tools: send_voice, send_photo, send_file, inline_keyboard, react, pin, rename_topic, set_chat_action.
- [ ] Subagent runner: spawn generic, spawn named (loads `agents/<name>/`), persist `session.jsonl` via pi's `SessionManager.create(...).setSessionFile(...)`, revive via `SessionManager.open(path)`, list, prune.
- [ ] Subagent tools exposed to goblin: `spawn_subagent`, `spawn_named`, `revive_subagent`, `list_subagents`. Recursion depth cap = 3.
- [ ] `/archive`, `/debug`, `/prune_subagents` commands.
- [ ] `events.jsonl` writers for goblin sessions + subagent instances. Spawn/revive markers in parent events.
- [ ] `systemd --user` unit file in repo.
- [ ] README with setup.

## Deferred (explicitly not v1)

- v1.1: approval-required tool mode (allowlist + inline-keyboard approvals).
- v1.1: **user-facing named subagent invocation** — slash command (`/researcher`) or topic-to-agent binding so user can chat a named subagent directly via Telegram.
- v1.5: `remember()` tool → `memory/YYYY-MM.md`.
- v1.x: mixed-provider routing (`selectModel(task)`), per-subagent model override.
- v1.x: auto-archive / auto-prune daemons.
- v2: voice-note-first workflow (STT + TTS).
- v2: skills for common homelab services shipped in repo.
- v2: **live subagent cross-talk / swarms** — `message_sibling`, `ask_sibling`, spawn_swarm with DAG topology. Design reference: `~/build/pi-messenger-swarm`. v1 coordination is serial orchestration + revival only.
- Forever-rejected: plugin SDK, multi-agent gateway, web UI, vector stores, security audit system.

## Open questions (non-blocking)

- Which pi-coding-agent release to pin? (Check latest stable before `bun add`.)
- STT provider when v2 voice lands — Whisper local vs. Poe/OpenRouter audio endpoint.
- Named subagent user-facing invocation (v1.1 design): slash command per agent (`/researcher`), one generic dispatcher (`/agent researcher …`), or Telegram topic binding (a topic routes to a named agent instead of goblin)?
- `spawn_named` when there's no existing instance: always create new, or prompt goblin to pick between create / continue latest / continue specific?

## Progress log

- 2026-04-19: design frozen (Q1-Q13). Ready to scaffold v1.
- 2026-04-22: architecture deep-review. Locked **single goblin workspace** (Model A — all sessions share `~/goblin/workdir/`, no per-session workdir). Expanded subagent model: generic + named, **all persisted as revivable pi sessions**, strict skill isolation for named agents. Live cross-talk deferred to v2 (inspiration: pi-messenger-swarm). Persistence + revival committed to v1.
