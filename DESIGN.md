# goblin v2 — design

Rewrite of little-goblin. Same product, ruthless scope. The old codebase is at
`~/build/little-goblin`; it keeps running until cutover. Nothing is imported —
no code, no state, no specs. This document is the only thing that carries over,
plus the lessons it encodes.

## Why

pi-coding-agent is the ceiling: pi-ai supports only text and images, thinking
levels are half-broken, and the codebase grew an enormous stabilization
apparatus (roughly 10x test code to product code) to compensate for seams pi
forced on it. Vercel AI SDK gives us provider-agnostic model access, native
document/audio parts, and thinking levels that actually work — so the agent
core gets rewritten around it, and everything else gets rebuilt only if it
earns its place.

## Product boundary

Unchanged from v1:

- One human operator (bermudi), one Bun process, homelab.
- Telegram is the UI: long polling, topics, reactions, files, voice.
- Filesystem state; SQLite only for memory.
- No web UI, no multi-channel, no plugin SDK, no k8s.

## Domain model

Three concepts. That's it.

```text
Telegram update
      │
      ▼
    Lane ──────────── one Telegram routing lane (a DM, or a forum topic)
      │ currentConversationId
      ▼
Conversation ──────── durable event history + immutable cwd
      │ while a turn is running
      ▼
    Turn ──────────── ephemeral: one agent loop + serialized queue
```

- **Lane** — `{ chatId, topicId? }` identity. Owns the current-conversation
  pointer, model/thinking preferences, schedules, and an authority epoch.
- **Conversation** — durable `events.jsonl` (user msgs, assistant msgs, tool
  calls, system events) + `meta.json` (id, created, cwd). cwd is fixed at
  creation; it is never mutated.
- **Turn** — a unit of work enqueued against a lane's current conversation.
  Per-conversation serial queue; one active turn.

A Lane with no conversation keeps none. `/new` creates a Conversation and
rebinds. `/resume` rebinds an existing Conversation to the current Lane.

### The authority rule

The one lesson from v1's RuntimeMachine worth keeping, minus the machinery:
**before any side effect (Telegram send, state write, tool call), the turn
re-checks that it still holds authority** — i.e. its conversation is still the
lane's current one and the lane epoch hasn't advanced since enqueue.

Implementation: each lane carries a monotonic `epoch`, bumped on `/new`,
`/resume`, and settings changes. A turn captures `(laneId, conversationId,
epoch)` at admission and calls `checkAuthority()` around every await. Fenced
turns abort quietly and log it. No machines, no drain sets, no ticket types —
one counter and one function.

## Model layer

Vercel AI SDK (`ai` package). `streamText` with tools and `stopWhen` for the
agent loop.

- **Provider registry** in config: name → AI SDK provider factory +
  credentials env var. v1 targets:
  - `zai` — GLM via OpenAI-compatible endpoint (`@ai-sdk/openai-compatible`).
    Daily driver.
  - `openrouter` — `@openrouter/ai-sdk-provider`.
  - `codex` — **needs a spike.** ChatGPT-subscription OAuth isn't a standard
    AI SDK provider; likely a community package or a thin custom provider.
    Verify before committing.
- **Thinking**: per-provider reasoning effort mapping, one `/think` command,
  honest about which providers support which levels.
- **History**: `events.jsonl` stores our normalized event format, not
  provider messages. Prompt is rebuilt each turn; `toModelMessages` conversion
  lives in one function.
- **Content**: this is the payoff — AI SDK takes image, document, and audio
  parts. Telegram photos/files/voice go to the model natively where the
  provider supports them; otherwise saved to `attachments/` and referenced by
  path.

## Tools (v1)

Hand-rolled, zod-validated, ~6 tools:

`read_file` `write_file` `edit_file` `bash` (timeout, cwd = conversation cwd)
`memory_write` `schedule`

Telegram send is delivery, not a tool. Subagent/MCP/external tools do not
exist yet.

## Memory

SQLite via `bun:sqlite` at `state/memory.sqlite`. One table of curated entries
plus an FTS5 index. `memory_write` tool (add/replace/remove). System prompt
gets a frozen memory summary at turn start; a per-turn `## relevant memory`
aside comes from FTS on the user's text. No embeddings, no scopes, no export
pipeline — add them when they hurt.

## Scheduler

`state/schedules.json`: `{ id, laneId, kind: "cron"|"at", spec, prompt,
enabled }`. A tick loop finds due items and enqueues a turn on the lane's
current conversation; a lane with no conversation logs and skips. Heartbeat is
just a schedule whose prompt comes from `workspace/HEARTBEAT.md`.

## Telegram intake & delivery

- grammy long polling; `ALLOWED_TG_USER_IDS` gate first thing.
- **Coalescing buffer**: rapid-fire messages from one lane merge into one turn
  (~1.5s quiet window). This was real product value in v1; keep it.
- **Delivery**: `streamText` deltas → throttled message edits (~1/s), final
  flush on completion. Typing indicator while a turn runs. Errors post a short
  message and log structured detail.
- Commands: `/new` `/resume` `/model` `/think` `/cd` `/schedules`. Parse in
  the tg layer, call into lane/conversation modules — no choreography in
  commands.

## Filesystem layout

```text
$GOBLIN_HOME/
├── goblin.json5            # providers, models, lane defaults
├── workspace/              # the agent's home; cwd default for conversations
│   ├── SOUL.md             # required, template-created on first boot
│   ├── AGENTS.md           # optional, agent-owned
│   ├── HEARTBEAT.md        # optional heartbeat prompt
│   └── attachments/
└── state/
    ├── lanes.json          # lane records incl. epoch + current conversation
    ├── schedules.json
    ├── memory.sqlite
    └── conversations/<id>/
        ├── meta.json
        └── events.jsonl
```

Whole-file writes: tmp + fsync + rename, preserving mode. JSONL: append, one
record per write, failures propagate. `ENOENT` → null; everything else throws.

## Config

Secrets in env (`BOT_TOKEN`, provider keys). Everything else in
`goblin.json5`: provider registry, per-lane default model/thinking, schedule
tick interval.

## Module map

```text
src/
  index.ts          composition root: config → memory → lanes → scheduler → bot
  config.ts         goblin.json5 + env, zod-validated
  log.ts            structured log; no console.log anywhere else
  tg/               grammy: intake, buffer, delivery, commands (only grammy-aware dir)
  lane.ts           lane records, epoch, current-conversation pointer
  conversation.ts   store: create/load/append events, meta
  runtime.ts        per-conversation queue, turn loop, checkAuthority
  agent/
    providers.ts    registry: name → AI SDK provider
    prompt.ts       system prompt assembly (shell + SOUL.md + memory)
    history.ts      events.jsonl → ModelMessage[]
    tools/          the six tools
  memory/           sqlite store + FTS
  scheduler/        tick loop, due-item dispatch
```

Flat modules, one job each, tests colocated.

## Non-goals (v1 — return only on demand)

subagents · delegated work · external agents · ACP · MCP · skill catalogs ·
project environments beyond cwd · inner life / dreaming · mini apps ·
onboarding wizard · state migrations · embeddings · multi-user

## Test posture — the real change

v1 died of test-to-code ratio. New rule: **tests guard boundaries and
invariants, not implementations.** Worth a test: authority fencing, durable
write semantics, intake coalescing, schedule dispatch, history rebuild.
Not worth a test: that a function calls its collaborator with the right
arguments. Fakes at the two external edges (model provider, Telegram API);
no mock.module pyramids. The suite should stay smaller than `src/` — if it
isn't, that's a smell to fix, not a badge.

## Open questions / spikes

1. **Codex provider** — does a usable AI SDK provider exist for
   ChatGPT-subscription Codex auth? If not, thin custom provider wrapping the
   OAuth token + responses endpoint.
2. **Voice notes** — which providers take audio parts directly vs needing a
   transcription step?
3. **z.ai thinking** — GLM reasoning params via openai-compatible; verify the
   effort mapping actually reaches the wire.
