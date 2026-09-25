# v1 ↔ v2 feature map

v1 = `~/build/little-goblin` (pi-coding-agent core; retired at cutover —
v2 is the running bot). v2 = this repo (Vercel AI SDK core). Same product,
ruthless scope: v2 rebuilds what earned its place and drops the machinery
that didn't. Nothing migrated — no code, no state, no specs. Rows below
describe what each repo actually does (v2 at current HEAD).

Legend: ✅ both, roughly same shape · 🔀 both, new mechanism in v2 ·
❌ v1 only · ➕ v2 only

## Core

| | v1 | v2 |
|---|---|---|
| 🔀 Agent loop | pi-coding-agent (pi-ai): text + images only, thinking levels half-broken | Vercel AI SDK `streamText`: native image/document/audio parts, thinking that works per family |
| 🔀 Authority & cancel | `RuntimeMachine`, queue tickets, drain sets — heavy machinery | one epoch counter per conversation + `checkAuthority()` before every side effect |
| 🔀 Test posture | ~10x test code to product code | suite ≈ size of `src/`; tests guard boundaries and invariants only |

## Conversations & Telegram UX

| | v1 | v2 |
|---|---|---|
| 🔀 Identity model | Surface → Binding → Conversation; three concepts, lifecycle commands to manage them | a topic **is** the conversation (chatId + threadId); create a topic = new, post in an old one = resume |
| 🔀 Conversation management | `/new` `/resume <id>` `/archive` `/name` | none — Telegram owns it. Unnamed topics get a one-shot rename from the first text burst (`titleModel`); the bot can create topics itself |
| 🔀 Queuing | `/queue <text>` enqueues a follow-up turn | implicit per-conversation serial queue; submits while a turn runs coalesce into one successor turn; `/stop` fences |
| 🔀 State | per-conversation dirs under `state/sessions/<id>/` (atomic JSON + JSONL logs) | one SQLite db (`goblin.sqlite`, WAL); history as AI SDK `UIMessage` JSON rows |
| 🔀 Message coalescing | text-fragment coalescer (>4096 splits, command-entity edge cases) | ~1.5s quiet-window buffer; consecutive user messages merge at conversion |
| 🔀 History ordering | append order | arrival-order storage, causal view: replies interleave at their triggering message's seq (`anchor_seq`) |
| ❌ Group machinery | @mention gating, small-group exception, guest lane | `allowedUsers` gates first thing; multi-user is a non-goal |
| 🔀 Compaction | `/compact` manual context compaction | out (history unbounded by design; compaction returns with the feature that needs it) |

## Commands

| | v1 | v2 |
|---|---|---|
| 🔀 Full set | 21: `/start /new /archive /resume /name /project /model /think /compact /queue /debug /subagents /cancel_subagent /revive /cancel /voice /ping /help /skills /mcp /schedule` | 7, settings only: `/start /stop /model /think /voice /memory /forget` |
| 🔀 Cancel | `/cancel` | `/stop` |

## Models & settings

| | v1 | v2 |
|---|---|---|
| 🔀 Providers | static registry, prefixed ids: `or/` `openai/` `anthropic/` `zai/` `opencode-go/` (+ Poe remnants), pattern fallback for unknown ids | config registry: `zai` (daily driver), `openrouter`, `codex` (custom shim over chatgpt.com backend, OAuth token rotation via `~/.codex/auth.json`) |
| 🔀 Thinking | pi levels (`off…max`), half-broken | honest per-family ladders (GLM effort, GPT `reasoning_effort`, OpenRouter catalog-driven); `/think` offers only what the model can express; clamping is defined |
| 🔀 Capabilities | hand-maintained | fetched catalogs: models.dev + OpenRouter `/models` (cached, with backoff) |
| 🔀 Switching | `/model` + `favorites` quick-switch list | `/model` + the mini app |
| 🔀 Mini App settings | yes (issue #59): deployment-wide non-secret settings, searchable Devin models | **the** configuration surface — reads and writes `goblin.json5` itself; served over localhost HTTP, doors are `tailscale serve`/`funnel`, zero open ports |

## Media & files

| | v1 | v2 |
|---|---|---|
| 🔀 Intake media | photos inline as images; documents/voice/audio saved to disk and announced | images, documents, audio all reach the model natively (per-model modality from the catalogs); each attachment's representation is a pure function of the stored ref + conversation model |
| 🔀 Voice in | Groq Whisper transcription when configured | same, plus: transcript stored inside the history part (durable), video notes are speech too, files >25 MiB get ffmpeg audio-track extraction + 15-min segmentation |
| 🔀 File size cap | 20 MB cloud Bot API — larger dropped with a warning | 2 GB via self-hosted `telegram-bot-api` on lithium (`--local`, long-poll only, no inbound ports) |
| ➕ PDFs / rich docs | impossible through pi-ai (content union closed); `pdftotext` workaround | native document parts |
| 🔀 Sends | `send_photo` / `send_document` tools | `send_file` tool hands a path to the delivery sink — "Telegram send is delivery, not a tool"; magic-byte sniffing (photo preview vs byte-exact document, `as_file`, GIFs always documents) |

## Tools

| | v1 | v2 |
|---|---|---|
| 🔀 Toolset | 10 α (`read bash edit write grep memory_search memory_write spawn_subagent revive_subagent text_to_speech`) + 4 per-surface β (`send_voice send_photo send_document rename_topic`) | 8: `read_file write_file edit_file bash speak schedule send_file memory_search` |
| ❌ `grep` tool | yes | no — `bash` covers it |
| 🔀 Tool results | — | text-only by ruling (wire formats can't carry media); `read_file` on an image returns a structured note instead of bytes |
| 🔀 Output bounds | — | bounded, self-describing output: line window + byte ceiling + per-line clamp, every truncation names its own recovery |
| 🔀 TTS | `text_to_speech` → MP3 path, then `send_voice` | `speak` → real ogg/opus voice note via the delivery sink; text **or** file path input ("read me this document" never re-types it) |
| 🔀 Voice mode | `/voice` converts the *last reply* to audio | `/voice` toggles a sticky per-conversation mode: full audio replies, text still stored in history; 🔊 button on completed replies (voices the whole reply, in-memory cache with tap-fallback); code blocks/URLs sent as text alongside |

## Memory

| | v1 | v2 |
|---|---|---|
| 🔀 Storage | local `memory.sqlite`, hybrid FTS + OpenAI embeddings, in-process | external **Hindsight** service (rootless Podman: Postgres + pgvector), one bank per operator |
| 🔀 What's remembered | curated by the model via `memory_write` (add/replace/remove/rewrite, char budget) + private-reflection extraction pipeline ("inner life") | automatic retention of completed text exchanges (extract → enqueue → durable outbox → background worker) |
| 🔀 Recall | frozen summary at runtime creation + `memory_search` hybrid recall per turn | bounded recall before each turn, persisted verbatim and replayed cache-stably; `memory_search` tool for deep search |
| 🔀 Controls | `memory status` / `memory export` inspection | `/memory on\|off\|status` per topic (exclusion enforced before any request), `/forget` resolves → go-ahead → deletes + suppresses permanently |
| ✅ Status | live since forever | live since 2026-09-24 — end-to-end verified against the real server; survived the 2026-09-25 reboot |

## Scheduled work

| | v1 | v2 |
|---|---|---|
| 🔀 Recurrence | one-shot `at`/`in <duration>`, recurring `every <duration>` — intervals only, no cron | 5-field cron, validated by `cron-parser` at the boundary; the model translates natural language → cron |
| 🔀 State | JSON schedule store, Surface-owned, 8-job cap per session | `jobs` table in `goblin.sqlite`; job pinned to the chat/topic it was born in |
| 🔀 Missed runs | — | boot catch-up fires once, then advances; disabled gaps aren't owed; one attempt per occurrence (a failing job can't refire forever) |
| ❌ Heartbeat | `heartbeat_action on/off`, HEARTBEAT.md (global + surface-scoped), agent-initiated proactive turns | explicitly out — jobs are standing orders the operator asked for, not an agent that decides to check things |
| 🔀 Manage | `/schedule` + scheduler tools | `schedule` tool (list/create/update/delete/toggle) |

## Skills

| | v1 | v2 |
|---|---|---|
| 🔀 Layout | pi-native `.agents/skills/` roots (goblin + personal environment), host root (off), per-surface `SkillPolicy`, `/skills` command | one catalog: `workspace/skills/`, agentskills.io format, frontmatter-validated per turn |
| 🔀 Lifecycle | policy + `/skills` inspection/mutation/reload | the filesystem is the lifecycle — the agent authors/edits/removes skills in chat, live next turn; `skills-ref validate` for authoring checks |
| ❌ Per-surface selection | yes | no (out until demanded) |

## Machinery dropped in v2 (v1-only)

| Feature | v1 state |
|---|---|
| ❌ Subagents | generic + named (`workspace/agents/<name>/`), recursion depth 3, 10-min timeout, revive, delegated-run store, Pi execution host |
| ❌ External agents (ACP: Claude, Devin) | implemented and tested but **never production-wired, even in v1** |
| ❌ MCP bridge | `mcporter`-based `mcp_call`, selection store |
| ❌ Inner life | private reflection, light-sleep extraction, wake store, dreaming pipeline |
| ❌ Projects | `/project <dir>` one-time per-surface CWD binding, project `AGENTS.md`, project-scoped attachments |
| ❌ Diagnostics | `/debug`, `/ping`, `/help`, doctor CLI, `MetricsStore` |
| ❌ Onboarding wizard | interactive `bun run onboard` |
| ❌ State migrations | state-version framework (reached v5) |
| ❌ Manual compaction | `/compact` |

All of these sit on v2's non-goals list: each returns only on explicit demand,
designed into `DESIGN.md` first.

## New in v2 (no v1 counterpart)

| | What |
|---|---|
| ➕ Cache discipline | the request for turn N+1 is turn N's request + appended content, ever; usage logs carry cached-token split + request prefix hash, so cache behavior is observable in `goblin.log` |
| ➕ Causal view / burst-merge | replies interleave at `anchor_seq`; queued submits coalesce into one successor turn |
| ➕ Secret discipline | `auth.jsonl` (mode 0600, `!<command>` resolution, lazily at use) — nothing in the process env, because `bash` inherits it |
| ➕ Self-hosted Bot API | static binary + systemd on lithium; 2 GB both ways |
| ➕ Mini app config surface | settings from Telegram, no SSH ever required |
| ➕ Codex provider | ChatGPT Plus/Pro auth reusing the `codex` CLI login, with token rotation written back |
| ➕ Voice mode + speak button | full ears-in/ears-out conversations |
| ➕ Memory controls | `/memory`, `/forget` with explicit go-ahead and permanent suppression |

## Operator habit changes at cutover

Cutover is complete — v2 is the bot; the list below describes current
habits, not a plan.

- **New conversation** — `/new` is gone. Create a topic.
- **Resume** — `/resume` is gone. Post in the old topic.
- **Queue follow-up** — `/queue` is gone. Just send messages while it works; they queue and coalesce. `/stop` to fence.
- **Cancel** — `/cancel` is now `/stop`.
- **Audio of a reply** — `/voice` is no longer per-message; it's a sticky per-topic mode, or tap 🔊.
- **Model favorites** — configured in the mini app / `goblin.json5`, switched with `/model`.
- **Huge replies** — no more `reply.md` document; long replies arrive as chunked bubbles.
- **"Remember X"** — don't ask; retention is automatic once memory goes live. `/forget` removes.
- **Schedules** — natural language still works, but recurrence is cron under the hood (no more `every 30m`; it becomes `*/30 * * * *`).

## Sources

v1: `features.md`, `PARKED.md`, `src/commands/`, `src/scheduler/`, `src/mcp/`,
`src/inner-life/`, `src/external-agents/` in `~/build/little-goblin`.
v2: `DESIGN.md`, `src/` tree, git history to HEAD.
