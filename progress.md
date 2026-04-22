# little-goblin

> Telegram-native personal AI agent. One user (bermudi), one goblin, one homelab.
> Anti-thesis: openclaw. If we're about to build a plugin SDK, we've lost.

## North star

A **goblin** that lives on the homelab, reachable over Telegram, with pi-coding-agent as its brain and deep use of Telegram as its UI. Single-user, single-process, filesystem-as-extensibility.

## Frozen decisions

### Surface
- **Channel:** Telegram only. No web UI, no other channels, ever.
- **Lean into Telegram features:** voice, inline keyboards, reactions, chat actions, forum topics, pins, renames, file sends. These are not transport; they are UI.
- **Auth:** bot token + hardcoded Telegram user-id allowlist (just bermudi). No pairing ceremony, no OAuth, no "trust model."

### Sessions (Q4)
- **Goblin-level concept**, projected onto Telegram two ways:
  - In forum-enabled groups: **one topic = one session**.
  - In DMs: **`/new` creates a session**; current-session state is per-chat.
- Each session has its own pi workdir, context, transcript.
- **Subagents (Q7):** semi-visible. Goblin narrates ("spawning 3 workers…") via status updates; subagents do not get their own Telegram surface.

### Deployment (Q5)
- **Homelab box.** Full user-level filesystem access (media, NAS, services reachable on LAN).
- **Long-polling only.** No inbound ports, no tunnel, no public exposure.
- **`systemd --user` service.** `goblin.service`. Auto-restart. `journalctl --user -u goblin`.
- No Docker, no k8s, no monorepo.

### Capabilities (Q6)
- **α Core (pi defaults):** shell, read/edit/apply_patch, web fetch/search, code exec. In.
- **β Telegram-native tools:** goblin can send voice, photos, files, inline keyboards, reactions, pin, rename topics, set chat actions. In.
- **γ Homelab control:** **NOT** built as a tool suite. Delivered as `skills/` + generic HTTP + `ssh`. Goblin learns Jellyfin/HA/etc. from markdown skills.
- **δ Personal assistant (calendar/reminders):** **deferred**.

### Memory (Q8)
- `AGENTS.md` at goblin-state root, always injected into context.
- Goblin may append; bermudi edits by hand.
- **v1.5:** add `remember()` tool → appends to `memory/YYYY-MM.md` as spillover.
- **Rejected:** vector stores. Grep > embeddings at this scale.

### Model (Q9)
- **Poe primary, OpenRouter secondary.** Both supported in v1 via an explicit model table in `src/agent/models.ts`.
- Env: `POE_API_KEY` and/or `OPENROUTER_API_KEY` (at least one required) + `MODEL_NAME` (a key in the table). No `MODEL_BASE_URL` — baseUrl is a property of each model entry.
- **Per-family API routing** (Poe exposes all three endpoints; pick the richest that fits):
  - Claude models        → `anthropic` / Messages API (`https://api.poe.com`) — prompt caching, thinking blocks
  - GPT + o-series       → `openai-responses` (`https://api.poe.com/v1`) — reasoning summaries
  - Everything else (Gemini/Llama/…) → `openai-completions` (`https://api.poe.com/v1`)
  - All OpenRouter models → `openai-completions` (OR only speaks chat completions)
- Poe's Responses API has documented gaps (`instructions` ignored, `previous_response_id` 500s) but pi-ai's `openai-responses` provider is stateless and doesn't use either, so we're unaffected.
- `selectModel(task)` router stays a v1.x one-file change; v1 uses a single model per session.

### Safety posture (Q10)
- **YOLO.** No approval prompts. Goblin acts.
- Mitigation: `trash` aliased for `rm` in goblin's shell; whatever homelab snapshots bermudi already has.
- v1.1 escape hatch: allowlist-with-Telegram-approval (design in Q10 options b/c) is mechanically addable later, not architecturally.

### Session lifecycle (Q11)
- Sessions **persist forever** by default. `/archive` moves the session dir to `sessions/archive/` and renames the Telegram topic to its final title.
- No auto-archive daemon in v1.

### Output / streaming (Q12)
- **Hybrid (d):**
  - **Tool calls:** coalesced status lines in one edited message (🧠 thinking / 🔧 tool / ✍️ composing / ✅ ❌). ~1 edit/sec throttle.
  - **Model response:** streamed via edits on its own message, rolling to a new message at 4096 chars.
  - **Big output (>~20KB):** send as `reply.md` file attachment with a short summary.
- `chat_action("typing…")` refreshed every ~4s while active.
- Tool stdout/stderr is **hidden by default** — goblin summarizes. User asks to see raw if wanted.
- `MessageBuffer` class owns rate-limit coalescing; drops intermediate edits if it can't keep up; never crashes goblin.

### Stack (Q13)
- **Runtime:** `bun`.
- **Language:** TypeScript, strict.
- **Agent brain:** `pi-coding-agent` embedded as a library (like openclaw's `runEmbeddedPiAgent`). No subprocess.
- **Telegram:** `grammy`.
- **Layout:** single package. `package.json`, `src/`, no workspaces.

### Observability (Q13)
- Per-session JSONL event log at `sessions/<id>/events.jsonl`.
- `/debug` DMs the tail of the current session's events.
- `journalctl` for process-level. No OTel, no Prom, no dashboards.

## Filesystem layout

```
~/goblin/                          # GOBLIN_HOME (configurable)
├── AGENTS.md                      # always-in-context long-term memory
├── skills/                        # user-authored SKILL.md files
│   └── <name>/SKILL.md
├── sessions/
│   ├── <session-id>/
│   │   ├── workdir/               # pi workdir
│   │   ├── events.jsonl           # observability
│   │   ├── transcript.jsonl       # tg<->goblin messages
│   │   └── state.json             # pi session state + tg binding (chat_id, topic_id)
│   └── archive/<session-id>/      # /archive destination
└── config.json                    # chat-id <-> session-id bindings, misc

~/.config/goblin/.env              # MODEL_*, BOT_TOKEN, ALLOWED_TG_USER_IDS
```

Running code lives at `/home/daniel/build/little-goblin`. Goblin state is `~/goblin/`. Code and state are separate trees.

## High-level architecture

Single process, three concerns:

1. **Telegram I/O layer** (`src/tg/`) — grammy client, long-polling, message normalization, `MessageBuffer` for outbound coalescing, β-tool implementations (send voice, keyboards, etc.).
2. **Session manager** (`src/sessions/`) — maps `(chat_id, topic_id | "dm")` → session-id, loads/persists state, owns lifecycle commands (`/new`, `/archive`, `/debug`).
3. **Agent runner** (`src/agent/`) — wraps `pi-coding-agent`, registers α + β tools, pipes events into Telegram layer via `MessageBuffer`, writes `events.jsonl`.

Plus `src/commands/` for `/`-commands and `src/config/` for env + `AGENTS.md` loading.

## v1 milestone (ship this)

- [x] `bun init`, scaffold `src/`, install `grammy` + `pi-coding-agent`.
- [x] Env loader (`MODEL_*`, `BOT_TOKEN`, `ALLOWED_TG_USER_IDS`, `GOBLIN_HOME`).
- [x] Long-polling bot with user-id allowlist middleware. Non-allowed users → silent drop.
- [x] Session manager: `/new`, resolve chat→session, create workdir + state.json.
- [ ] Agent runner: embed pi, load AGENTS.md, run turn, stream events.
- [ ] `MessageBuffer` with 1 edit/sec throttle, 4096-char rollover, file-attachment escape.
- [ ] Hybrid streaming wired: status-line message (tools) + response message (model stream).
- [ ] `chat_action("typing…")` heartbeat.
- [ ] β tools: send_voice, send_photo, send_file, inline_keyboard, react, pin, rename_topic, set_chat_action.
- [ ] `/archive`, `/debug` commands.
- [ ] `events.jsonl` writer.
- [ ] `systemd --user` unit file in repo.
- [ ] README with setup: get bot token, set env, `systemctl --user enable --now goblin`.

## Deferred (explicitly not v1)

- v1.1: approval-required tool mode (allowlist + inline-keyboard approvals).
- v1.5: `remember()` tool → `memory/YYYY-MM.md`.
- v1.x: mixed-provider routing (`selectModel(task)`).
- v1.x: auto-archive after N days idle.
- v2: voice-note-first workflow (STT + TTS). Input transcription is cheap; full voice-first UX is not.
- v2: skills for common homelab services (HA, Jellyfin, NAS) shipped in repo.
- Forever-rejected: plugin SDK, multi-agent gateway, web UI, vector stores, security audit system.

## Open questions (non-blocking)

- Which pi-coding-agent release to pin? (Check latest stable before `bun add`.)
- STT provider when v2 voice lands — Whisper local vs. Poe/OpenRouter audio endpoint. Decide then.
- Does pi have a clean hook for "tool-call started / progress / finished" events, or do we need to wrap its tool layer? → check in implementation.

## Progress log

- 2026-04-19: design frozen (Q1-Q13). Ready to scaffold v1.
