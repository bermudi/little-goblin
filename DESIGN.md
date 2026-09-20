# goblin v2 — design

Rewrite of little-goblin. Same product, ruthless scope. The old codebase is at
`~/build/little-goblin`; it keeps running until cutover. Nothing is imported —
no code, no state, no specs. This document is the only thing that carries over,
plus the lessons it encodes.

## Why

pi-coding-agent is the ceiling: pi-ai supports only text and images, thinking
levels are half-broken, and the codebase grew an enormous stabilization
apparatus (roughly 10x test code to product code) to compensate for seams pi
forced on it. Vercel AI SDK gives provider-agnostic model access, native
document/audio parts, and thinking levels that actually work — so the agent
core gets rewritten around it, and everything else gets rebuilt only if it
earns its place.

## Product boundary

- One human operator (bermudi), one Bun process, homelab. It runs as a
  systemd user unit (`deploy/goblin.service`, linger enabled): restart on
  failure, starts on boot, SIGTERM rides the graceful shutdown path.
  `scripts/install.sh` installs it — idempotent, path-substituting, and it
  refuses to enable a half-configured service (config/auth missing) rather
  than crash-loop it. That script plus first-boot scaffolding (home layout,
  SOUL.md template, fail-loud config pointer) is the entire setup story —
  no onboarding wizard, ever.
- Telegram is the UI: long polling, topics, reactions, files, voice — **and
  Mini Apps, designed in from the start** (the process serves them over HTTP;
  see Intake & delivery).
- Machine state lives in SQLite (`bun:sqlite`, WAL); files stay where humans
  edit them — config, auth, workspace.
- No standalone web UI beyond Telegram Mini Apps, no multi-channel, no plugin
  SDK, no k8s.

## Domain model

Two concepts. Conversation identity **is** the Telegram address.

```text
Telegram update
      │
      ▼
Conversation ─────── (chatId, threadId?) → durable event history
      │ while a turn is running
      ▼
    Turn ──────────── ephemeral: one agent loop + serialized queue
```

- **Conversation** — keyed by its Telegram address: a forum topic — in the
  operator's group or in the bot's DM, which supports topics too — or the
  bare chat itself. Owns `events` (user msgs, assistant msgs, tool calls,
  system events), `meta` (created, model/thinking overrides).
- **Turn** — a unit of work enqueued on a conversation. Per-conversation
  serial queue; one active turn. A turn's history snapshot is taken at
  admission: messages submitted while it runs join the queue and its
  successor's context, never its own. `/stop` fences the running turn and
  drops queued ones; messages still in the intake buffer are user input,
  not queued turns, and flush into a fresh turn at the new epoch.

**Topics are the UX.** There are no `/new` or `/resume` commands. A forum
topic is a conversation: create a topic to start one, post in an old topic to
resume it. The bot may also create topics itself (`createForumTopic`). A chat
without topics is one standing conversation. Conversation management is
Telegram's job, not a command set's. A topic created without an explicit name
(`is_name_implicit`) carries a placeholder; the first text burst triggers a
one-shot rename via the optional `titleModel` config ref — an explicit
operator rename always wins.

### The authority rule

The one lesson from v1's RuntimeMachine worth keeping, minus the machinery:
**before any side effect (Telegram send, state write, tool call), the turn
re-checks that it still holds authority** — its conversation epoch hasn't
advanced since enqueue.

Implementation: each conversation carries a monotonic `epoch`, bumped on
settings changes (`/model`, `/think`, `/voice`) and explicit cancellation. A turn
captures `(conversationId, epoch)` at admission and calls `checkAuthority()`
around every await. Fenced turns abort quietly and log it. No machines, no
drain sets — one counter and one function.

Shutdown rides the same rule. SIGINT/SIGTERM closes the runtime (submits
still land in history but never run), fences every live lane — each sink
stamps "⏹ superseded" and runs its final flush — and drains the intake
buffer into history, all under a bounded budget. A crash mid-turn leaves
the same shape minus the flush: the user message is in history, the next
turn answers it. Boot never auto-retries a half-run turn — tool calls
aren't idempotent, and an unanswered tail can't be told apart from
`/stop`. If recovery is ever wanted it is notify-don't-retry: surface
the orphaned turn to the operator, don't replay it.

## Model layer

Vercel AI SDK (`ai` package). `streamText` with tools and `stopWhen` for the
agent loop.

- **Provider registry** in config: name → AI SDK provider factory + auth
  reference. v1 targets:
  - `zai` — GLM via OpenAI-compatible endpoint (`@ai-sdk/openai-compatible`).
    Daily driver.
  - `openrouter` — `@openrouter/ai-sdk-provider`.
  - `codex` — `ai-sdk-provider-codex-cli` exists (ChatGPT Plus/Pro auth via
    `codex` CLI login) but wraps the CLI's own agent loop — no caller tools,
    so it can't drive goblin's turn loop. Ours is a thin `LanguageModelV2`
    over `chatgpt.com/backend-api/codex/responses` (`src/agent/codex.ts`):
    reads `~/.codex/auth.json` per call, refreshes expired access tokens
    against the OAuth endpoint, and writes rotated refresh tokens back —
    not writing back would invalidate the CLI's own login.
- **Thinking**: `off|low|medium|high|xhigh|max` is an operator vocabulary,
  not a provider contract — `thinkingOptions` maps each family to the
  nearest honest knob and writes the collapse down; `thinkingLevelsFor`
  is the same table read the other way, and `/think` + the mini app offer
  only what the active model can express. Family ladders follow the bare
  model id under every kind — a `glm-5.3` is forced-thinking whether z.ai
  serves it directly or via a relay. Stored values outside a model's set
  aren't errors — defaults span models, so the mapping clamps them to the
  nearest rung at-or-above (GLM's own collapse direction). GLM
  (docs.z.ai): 5.3+ is forced thinking with effort `low|high|max`
  (unlisted values silently become `max`; `off`/`medium` clamp to `low`/
  `high`), 5.2 toggles plus `high|max`, ≤4.6 toggles only. Endpoint
  caveat: z.ai's coding plan (`api.z.ai/api/coding/…`) serves only
  5.3-gen models and aliases older glm-* ids to them, so on that base
  URL every glm gets the 5.3 ladder and wire map. GPT/codex
  takes `reasoning_effort` verbatim on a `low|medium|high|xhigh` ladder
  (gpt-6 adds `max`); `off` isn't a rung and clamps to the floor.
  OpenRouter's public `/models` catalog is fetched + cached like
  models.dev: `supported_parameters` discriminates `reasoning_effort`
  (native ladder → verbatim), `reasoning` only (toggle → `off|low`), or
  neither (non-reasoner → `off`); a cold catalog passes the level
  through — fail loud, never fake knowledge. `off` = `enabled:false`.
  One `/think` command.
- **History**: stored as AI SDK `UIMessage`-format JSON (the v5 parts array —
  text, reasoning, tool, file parts). The SDK doesn't prescribe storage; this
  is the format it round-trips best.
- **Causal view, arrival-order storage.** `events` appends in arrival seq —
  that stays the truth. What the model sees interleaves replies by
  `anchor_seq`: each assistant response is stamped with the seq of the user
  message that triggered its turn and sorts immediately after it, so a reply
  never reads as having seen input that arrived while it ran. Submits queued
  behind a running turn coalesce into one successor turn — a single model
  call answers them all — and consecutive user messages merge into one at
  conversion.
- **Capabilities**: don't hand-maintain a matrix. Use what the SDK exposes on
  model objects (`supportedUrls`, unsupported-feature warnings) plus the
  `models.dev` catalog for per-model input modalities (image/audio/document),
  which is what other agent tools already do.
- **Content**: the payoff — AI SDK takes image, document, and audio parts.
  Telegram media is saved to `attachments/` and stored in history as a
  `data-attachment` part (path + metadata, no payload). At turn time each
  part materializes against the *current* model's capability data: a file
  part when the model can consume the media type and the payload fits the
  inline cap, otherwise a text reference to the saved path. Capability is
  judged per turn — a `/model` switch or a wrong catalog guess degrades to
  the path reference instead of poisoning history with a part the provider
  rejects on every turn.
- **Transcription**: voice notes, audio files, and video notes are speech —
  a model that can't consume audio shouldn't lose them to a bare path.
  When `transcription` is configured (`kind: groq`, whisper `model`, `auth`
  ref — other kinds slot in as the SDK grows transcription providers),
  intake transcribes the saved file once and stores the text inside the
  `data-attachment` part. Eager, not per-turn: the transcript is durable
  history, and materialization prefers it over the path reference whenever
  the file can't go inline — wrong modality or spent budget — while
  audio-capable models still get the file part. The call rides the
  per-conversation intake chain (off the update hot path), bounded at 60s
  per call. Files over the provider's 25 MiB upload cap are segmented, not
  skipped: ffmpeg extracts the audio track to mono opus — a video note's
  payload is mostly pixels — and splits it into 15-minute chunks,
  transcribed sequentially and joined; a partial result is kept and
  warn-logged rather than discarded. ffmpeg presence is probed at boot
  when transcription is configured, and install.sh warns when the config
  names it but PATH lacks it. A failed transcription — whisper down,
  ffmpeg missing, corrupt media — leaves the attachment path-referenced
  and warn-logged: it must never eat a voice message.

## Tools (v1)

Hand-rolled, zod-validated, five:

`read_file` `write_file` `edit_file` `bash` (timeout) `speak`

All tools run in the deployment workspace — conversations have no cwd and
there is no `/cd`. Working elsewhere is the agent's own business (`cd x &&
…` inside `bash`), not conversation state.

`speak` is the voice-out twin of intake transcription: it *synthesizes*,
it does not send. The tool hands audio bytes to the turn's delivery sink
(`sink.onVoiceNote`), which owns the Telegram call — so "Telegram send is
delivery, not a tool" stays true and voice notes ride the same serialized
chain and authority fencing as text: a `/stop`'d turn can't emit one.
Input is `text` or a file `path` (plain text/markdown; richer formats are
extracted with the agent's own tools first) — a path is synthesized
straight from disk, so "read me this document" never re-types the content
as model output. Long input is split at sentence boundaries inside the
tts module, never by the caller. Configure `tts` or the tool isn't in the
set at all.

Memory, scheduling, subagent, MCP, and external-agent tools do not exist —
each arrives with the feature that needs it, designed then, not spec'd now.

## Skills

Agent Skills (agentskills.io format): one directory per skill holding
`SKILL.md` — YAML frontmatter plus a Markdown body — alongside whatever
scripts/references/assets the body points at. The frontmatter is validated
per the spec: `name` + `description` required; `license`, `compatibility`,
`metadata`, `allowed-tools` checked for shape when present and then
ignored for behavior — except `compatibility`, which joins the catalog
line so a skill needing tools the box lacks isn't a dead-end invitation.
`allowed-tools` is spec-experimental and nothing here enforces per-skill
tool scope. `disable-model-invocation` is a non-spec extension the
operator's catalog already carries; it is honored (below). Unknown keys
pass through — real skills in the wild carry extra fields.

One catalog, fixed: `workspace/skills/`. It sits inside the agent's cwd so
goblin can author its own — writing `skills/<name>/SKILL.md` is the entire
publishing flow, live next turn. Sharing in a host skill is a symlink —
made by goblin on request, or by hand; there is no second root, no source
policy, no selection UI.

The lifecycle is the filesystem, and the agent is the operator's hands:
**install** = "install the mq skill" in chat → goblin links or copies it
into `skills/`, fetches a repo via `bash`, or files a SKILL.md that
arrived as a Telegram attachment; **update** = edit the files; **remove**
= delete the entry. Each is live on the next turn — no command,
registry, cache, or tombstone for any of it, and no ssh: the operator
asks in Telegram and goblin already has a shell on the box. Where to
fetch *from* (the operator's skills repo, the host catalog) is
deployment fact, not code — it lives in the workspace `AGENTS.md` so the
agent knows its sources. Hand-editing `skills/` over ssh always works;
it is the fallback, not the flow. `skills-ref validate` is installed for
authoring-time checks — goblin runs it via `bash` after writing a skill,
and a skipped entry plus the warn log is the failure signal when it
doesn't.

Discovery is per turn, in `buildSystemPrompt`: scan `skills/*/SKILL.md`
(symlinks resolved), parse a bounded head of each file for frontmatter —
the body is never injected — and render a `## skills` section listing
name + description (+ compatibility when set) + path. The section
renders even when the catalog is empty: it's also the notice that the
capability exists.

- `name` must equal its directory name and follow the spec rule —
  1–64 chars, `a-z0-9` and hyphens, no leading/trailing hyphen, no
  consecutive hyphens; `description` is required, ≤1024 chars.
- `disable-model-invocation: true` excludes the skill from the list —
  manual-only. The operator can still name it and the agent can `ls
  skills/` and read it; it just isn't advertised every turn.
- A malformed entry never kills a turn: `log.warn` with path + reason,
  skip it, and the section notes the skip count so the agent can surface
  it in chat — and fix the file, when it's one it authored.
- Sorted by name; deterministic. Same-name conflicts can't exist —
  name == dirname means they'd be the same directory.

Scan contract: each entry in `skills/` is stat'ed (symlinks followed).
A directory without `SKILL.md` warns and skips; a non-directory is
ignored silently; a broken symlink warns and skips. Frontmatter is read
from a bounded head (16 KiB — a `---` that doesn't close inside it is
malformed). The catalog caps at 128 entries: over that, the
sorted-first-128 list plus a warn — a self-authored catalog that big is
already a bug worth surfacing.

The section, approximately:

```text
## skills

Skills are directories under `skills/` — each a SKILL.md (frontmatter:
name, description) with instructions plus any scripts/files it needs.
When a request matches one, read_file its SKILL.md and follow it. This
catalog is yours: write skills/<name>/SKILL.md when you learn a
repeatable task, then `skills-ref validate ./skills/<name>` via bash.
Edits are live next turn.

- mq — jq for Markdown … [Requires the mq CLI] (skills/mq/SKILL.md)
- pdf — Extract PDF text … (skills/pdf/SKILL.md)
(1 entry skipped as malformed — see goblin.log)
```

An empty catalog renders the header plus "(none yet)" — the notice that
the capability exists is the point.

Invocation is `read_file`. The model sees the catalog line, reads the
SKILL.md when one matches the request, runs its scripts via `bash`.
Activation is already observable in the tool-call log — no skill tool, no
per-skill tool scoping (`allowed-tools` is parsed and ignored), no
snapshots, no fingerprints.

Still out — machinery that returns only on demand: additional catalog
roots (host, project), per-conversation selection, a `/skills` command or
mini-app surface, immutable skill snapshots.

## Auth

No secrets in env — the agent's `bash` tool inherits the process environment,
and env vars leak. Instead: `$GOBLIN_HOME/auth.jsonl`, mode `0600`, one record
per line:

```json
{"name": "openrouter", "value": "!pass show api/openrouter"}
```

A value is either a literal credential or `!<command>` — resolved by executing
the command and reading stdout, lazily at the point of use, in-process.
Resolved values never enter the tool environment, the model context, or logs.

## Telegram intake & delivery

- grammy long polling; `ALLOWED_TG_USER_IDS` gate first thing.
- **Coalescing buffer**: rapid-fire messages in one conversation merge into
  one turn (~1.5s quiet window). Real product value in v1; keep it.
- **Delivery**: `streamText` deltas → throttled message edits (~1/s), final
  flush on completion. Typing indicator while a turn runs. Errors post a short
  message and log structured detail.
- **TTS**: `tts: {kind: "edge", voice, rate?}` — the Edge read-aloud
  websocket service (no auth, unofficial, it can break; failures surface
  as a warn + a callback toast, never a turn failure). Three doors into
  the same `synthesizeSpeech`: the `speak` tool (text or file path, sent
  in-stream via the sink), a 🔊 button stamped on a completed reply's
  last bubble, and `/voice` mode (below). Input over ~10k chars is
  chunked at sentence boundaries inside the module — the cap is a sanity
  guard, never a control-flow path the model must recover from. Button
  text is stripped of the tool-status tail and markdown before synthesis
  (`speakable`); tool input is already authored for speech. Edge's supported
  WebM/Opus stream is remuxed losslessly through ffmpeg to ogg/opus — a real
  voice-note bubble, not an audio-file card. ffmpeg is probed at boot when TTS
  is configured, and install.sh warns when it is absent.
  `record_voice` chat action runs while synthesis is in flight. The
  button voices the *whole* reply, not the tapped bubble: delivery keeps
  a bounded in-memory map of its own recent sends (chat, message id →
  full reply text — one process, one operator, no schema change), and a
  miss (restart, old message) degrades to the tapped bubble's text,
  warn-logged. No button in voice mode — the reply is already audio.
- **Voice mode**: `/voice` toggles voice-note replies per conversation —
  a settings command like `/model`/`/think`, epoch bump and all, so a
  turn never switches medium mid-flight. When on, delivery skips
  streamed text entirely: typing indicator while the turn runs,
  `record_voice` while it synthesizes, then the final reply as voice
  notes. The mode changes delivery, not the record — history still
  stores the reply text, so toggling off loses nothing and "what did you
  say verbatim" stays answerable. Code blocks and long URLs aren't
  spoken; a reply carrying them sends them as a plain text message
  alongside the audio. Composes with topics: a voice-mode topic plus
  voice-note intake transcription is a fully ears-in-ears-out
  conversation.
- **Mini Apps**: the process serves an HTTP endpoint on localhost; the bot
  links pages via `web_app` buttons. Telegram requires HTTPS, and the page is
  fetched by the *client device* — so the door is a config knob (`publicUrl`)
  and nothing in the process assumes a public IP. Reference doors, all
  zero-open-port: `tailscale serve` (tailnet HTTPS, auto cert — works when
  operator devices are on the tailnet, the v1-on-lithium pattern), `tailscale
  funnel` (public HTTPS relayed through Tailscale's edge, for off-tailnet
  clients), or any reverse proxy with a cert. NAT-first by construction.
- **Commands** are settings-only: `/model` `/think` `/voice` `/stop`. No
  conversation-lifecycle commands — topics own that.
- **Large files**: self-hosted `telegram-bot-api` on lithium, `--local` mode,
  grammy `apiRoot` → `http://127.0.0.1:8081`. Needs `api_id`/`api_hash` from a
  my.telegram.org app registration (operator's account, stored as secrets —
  "Little Goblin" app, api_id 955258, already minted for the v1 e2e harness,
  lives in `little-goblin/e2e/.env`). App-platform cred, not per-environment:
  all instances share it; dev/prod splits on bot token + server instance.
  No inbound ports — long-poll only, the server dials out to Telegram; its
  only client is goblin on the same box. `getFile` returns an absolute local
  path — intake reads the file off disk, no HTTP fetch. Uploads ≤2GB,
  `file://` URIs for sends. The server's working dir is a staging cache, not
  storage — Telegram still owns the files; periodic clean is safe (worst
  case = re-fetch via `file_id`). Deploy: static binary + systemd unit (no
  docker); build off-box, TDLib compile would crush lithium.

## State layout

```text
$GOBLIN_HOME/
├── goblin.json5            # providers, models, defaults
├── auth.jsonl              # secrets, mode 0600
├── workspace/              # the agent's home; every tool runs here
│   ├── SOUL.md             # required, template-created on first boot
│   ├── AGENTS.md           # optional, agent-owned
│   ├── skills/             # the skill catalog — agent-authored, in cwd
│   └── attachments/
└── state/
    └── goblin.sqlite       # all machine state: conversation meta, event
                            # history (UIMessage JSON rows), bindings
```

SQLite durability = WAL + transactions (`synchronous=NORMAL` minimum), not
tmp/fsync/rename — that ritual is for whole-file state only. Inspectability
is an export/query command, not a format property.

## Config

`goblin.json5`: provider registry, per-conversation default model/thinking,
optional `transcription` block. No secrets — those live in `auth.jsonl`.

**Settings are operator-facing UI, not SSH.** The mini app is the
configuration surface: the process reads and writes `goblin.json5` itself, and
the operator changes settings from Telegram. Editing the file by hand always
works; it is never required.

## Module map

```text
src/
  index.ts          composition root: config → auth → conversations → bot → http
  config.ts         goblin.json5, zod-validated
  auth.ts           auth.jsonl reader + "!" command resolution
  log.ts            structured log; no console.log anywhere else
  tg/               grammy: intake, buffer, delivery, commands (only grammy-aware dir)
  conversation.ts   store: SQLite-backed resolve/load/append events, meta, epoch
  runtime.ts        per-conversation queue, turn loop, checkAuthority
  agent/
    providers.ts    registry: name → AI SDK provider
    models-dev.ts   input-modality catalog (fetch, cache, backoff)
    attachments.ts  data-attachment parts + per-turn materialization
    transcribe.ts   speech → text at intake (groq whisper, more kinds later)
    tts.ts          text or file → speech (edge read-aloud ws, opus out)
    prompt.ts       system prompt assembly (shell + SOUL.md + agent-owned
                    AGENTS.md; re-read every turn, edits live next message)
    skills.ts       catalog scan + frontmatter validation → ## skills section
    tools/          the five tools
  http/             mini-app serving
```

Flat modules, one job each, tests colocated.

## Non-goals (v1 — return only on demand)

The list below is a record, not a law. The law, applied to any capability:

1. **Core** — what the turn loop's honesty depends on (ordering, authority,
   durability, delivery). Always in; defects here jump the queue.
2. **Chat-native** — a natural property of one operator talking to one agent
   in Telegram: text/voice/media intake, topics, settings commands, the
   soul. In scope by default; a missing piece here is a gap *against this
   doc*, not a deferral. (Voice notes are chat-native — the rewrite exists
   because pi couldn't do audio; if transcription is missing, that's a bug
   in the roadmap, not a choice.)
3. **Machinery** — a second system the loop must keep honest: memory stores,
   schedulers, subagent fleets, MCP brokers, skill catalogs, projects, inner
   life. Out until explicitly demanded; when demanded, designed here first.

If a capability can't be classified in one sentence, the classification is
   the design conversation — have it before building.

memory store · scheduler/heartbeat · conversation-lifecycle commands ·
subagents · delegated work · external agents · ACP · MCP · project
environments · inner life · onboarding wizard · state
migrations · embeddings · multi-user · history compaction (history is
unbounded in v1 — a designed truncation/compaction story arrives with the
feature that needs it)

## Test posture — the real change

v1 died of test-to-code ratio. New rule: **tests guard boundaries and
invariants, not implementations.** Worth a test: authority fencing, durable
write semantics, intake coalescing, auth command resolution. Not worth a test:
that a function calls its collaborator with the right arguments. Fakes at the
two external edges (model provider, Telegram API); no mock.module pyramids.
The suite should stay smaller than `src/` — if it isn't, that's a smell to
fix, not a badge.
