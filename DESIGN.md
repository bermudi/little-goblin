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

- One human operator (bermudi), one Bun process, homelab.
- Telegram is the UI: long polling, topics, reactions, files, voice — **and
  Mini Apps, designed in from the start** (the process serves them over HTTP;
  see Intake & delivery).
- Persistence backend is open (files vs SQLite) — see Open questions.
- No standalone web UI beyond Telegram Mini Apps, no multi-channel, no plugin
  SDK, no k8s.

## Domain model

Two concepts. Conversation identity **is** the Telegram address.

```text
Telegram update
      │
      ▼
Conversation ─────── (chatId, threadId?) → durable event history + cwd
      │ while a turn is running
      ▼
    Turn ──────────── ephemeral: one agent loop + serialized queue
```

- **Conversation** — keyed by its Telegram address: a forum topic in the
  operator's group, or the DM itself. Owns `events` (user msgs, assistant
  msgs, tool calls, system events), `meta` (created, cwd, model/thinking
  overrides). cwd is fixed once set.
- **Turn** — a unit of work enqueued on a conversation. Per-conversation
  serial queue; one active turn.

**Topics are the UX.** There are no `/new` or `/resume` commands. A forum
topic is a conversation: create a topic to start one, post in an old topic to
resume it. The bot may also create topics itself (`createForumTopic`). The DM
lane is one standing conversation. Conversation management is Telegram's job,
not a command set's.

### The authority rule

The one lesson from v1's RuntimeMachine worth keeping, minus the machinery:
**before any side effect (Telegram send, state write, tool call), the turn
re-checks that it still holds authority** — its conversation epoch hasn't
advanced since enqueue.

Implementation: each conversation carries a monotonic `epoch`, bumped on
settings changes (`/model`, `/think`, `/cd`) and explicit cancellation. A turn
captures `(conversationId, epoch)` at admission and calls `checkAuthority()`
around every await. Fenced turns abort quietly and log it. No machines, no
drain sets — one counter and one function.

## Model layer

Vercel AI SDK (`ai` package). `streamText` with tools and `stopWhen` for the
agent loop.

- **Provider registry** in config: name → AI SDK provider factory + auth
  reference. v1 targets:
  - `zai` — GLM via OpenAI-compatible endpoint (`@ai-sdk/openai-compatible`).
    Daily driver.
  - `openrouter` — `@openrouter/ai-sdk-provider`.
  - `codex` — **needs a spike.** ChatGPT-subscription OAuth isn't a standard
    AI SDK provider; likely a community package or a thin custom provider.
    Verify before committing.
- **Thinking**: per-provider reasoning effort mapping, one `/think` command,
  honest about which providers support which levels.
- **History**: stored as AI SDK `UIMessage`-format JSON (the v5 parts array —
  text, reasoning, tool, file parts). The SDK doesn't prescribe storage; this
  is the format it round-trips best.
- **Capabilities**: don't hand-maintain a matrix. Use what the SDK exposes on
  model objects (`supportedUrls`, unsupported-feature warnings) plus the
  `models.dev` catalog for per-model input modalities (image/audio/document),
  which is what other agent tools already do.
- **Content**: the payoff — AI SDK takes image, document, and audio parts.
  Telegram media goes to the model natively when the model's capability data
  says it can; otherwise saved to `attachments/` and referenced by path.

## Tools (v1)

Hand-rolled, zod-validated, exactly four:

`read_file` `write_file` `edit_file` `bash` (timeout, cwd = conversation cwd)

Telegram send is delivery, not a tool. Memory, scheduling, subagent, MCP, and
external-agent tools do not exist — each arrives with the feature that needs
it, designed then, not spec'd now.

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
- **Mini Apps**: the process serves an HTTP endpoint for mini-app pages; the
  bot links them via `web_app` buttons. Telegram requires HTTPS — how the
  endpoint is exposed (tailscale funnel, reverse proxy, direct) is deployment
  config, see Open questions.
- **Commands** are settings-only: `/model` `/think` `/cd` `/stop`. No
  conversation-lifecycle commands — topics own that.
- **Large files**: Telegram's hosted Bot API caps downloads at 20MB; 2GB files
  need a self-hosted `telegram-bot-api` server (grammy supports a custom API
  root). Pinned — see Open questions.

## State layout (if filesystem wins the open question)

```text
$GOBLIN_HOME/
├── goblin.json5            # providers, models, defaults
├── auth.jsonl              # secrets, mode 0600
├── workspace/              # the agent's home; default conversation cwd
│   ├── SOUL.md             # required, template-created on first boot
│   ├── AGENTS.md           # optional, agent-owned
│   └── attachments/
└── state/
    └── conversations/<chatId>/<threadId|dm>/
        ├── meta.json
        └── events.jsonl    # UIMessage-format records, one per line
```

If SQLite wins: same layout minus `state/` — one `state.db` instead. Workspace
stays plain files either way.

## Config

`goblin.json5`: provider registry, per-conversation default model/thinking.
No secrets — those live in `auth.jsonl`.

## Module map

```text
src/
  index.ts          composition root: config → auth → conversations → bot → http
  config.ts         goblin.json5, zod-validated
  auth.ts           auth.jsonl reader + "!" command resolution
  log.ts            structured log; no console.log anywhere else
  tg/               grammy: intake, buffer, delivery, commands (only grammy-aware dir)
  conversation.ts   store: resolve-by-address/load/append events, meta, epoch
  runtime.ts        per-conversation queue, turn loop, checkAuthority
  agent/
    providers.ts    registry: name → AI SDK provider
    prompt.ts       system prompt assembly (shell + SOUL.md)
    tools/          the four tools
  http/             mini-app serving
```

Flat modules, one job each, tests colocated.

## Non-goals (v1 — return only on demand)

memory store · scheduler/heartbeat · conversation-lifecycle commands ·
subagents · delegated work · external agents · ACP · MCP · skill catalogs ·
project environments beyond cwd · inner life · onboarding wizard · state
migrations · embeddings · multi-user

## Test posture — the real change

v1 died of test-to-code ratio. New rule: **tests guard boundaries and
invariants, not implementations.** Worth a test: authority fencing, durable
write semantics, intake coalescing, auth command resolution. Not worth a test:
that a function calls its collaborator with the right arguments. Fakes at the
two external edges (model provider, Telegram API); no mock.module pyramids.
The suite should stay smaller than `src/` — if it isn't, that's a smell to
fix, not a badge.

## Open questions

1. **Persistence backend** — files vs SQLite for all state. AI SDK is
   unopinionated (store `UIMessage` JSON yourself). Recommendation: SQLite via
   `bun:sqlite` in WAL for all machine state — one file, transactional
   appends, and memory will need it whenever it lands. Workspace stays files.
   Decide before the store is written.
2. **2GB file support** — self-hosted `telegram-bot-api` server on the
   homelab, grammy pointed at the local API root. **Pinned — bermudi is
   reading up on this.** Questions to settle: where it runs, how uploads vs
   downloads differ, whether it changes intake code paths.
3. **Codex provider** — does a usable AI SDK provider exist for
   ChatGPT-subscription Codex auth? If not, thin custom provider wrapping the
   OAuth token + responses endpoint.
4. **Mini-app exposure** — Telegram requires HTTPS for web_app URLs. Homelab
   answer is probably tailscale funnel or an existing reverse proxy; pick at
   deploy time, keep `http/` behind a port that doesn't care.
