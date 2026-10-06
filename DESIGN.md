# goblin v2 — design

Rewrite of little-goblin. Same product, ruthless scope. The old codebase is at
`~/build/little-goblin`; it keeps running on lithium until cutover. Nothing is imported —
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
  SOUL.md/AGENTS.md stubs, fail-loud config pointer) is the entire setup
  story — no onboarding wizard, ever.
- Telegram is one of two channels: long polling, topics, reactions, files,
  voice — **and Mini Apps, designed in from the start** (the process serves
  them over HTTP; see Telegram intake & delivery). The second channel is
  the app: a React client, PWA while testing and a Capacitor APK when
  stable, speaking the AI SDK UIMessage protocol over the process's own
  HTTP surface (see App channel). The channels are disjoint — a
  conversation is born on the surface where it starts and stays there.
  One sanctioned crossing (ruling 2026-10-03): a delegation launched
  from the Telegram DM spins off a named app conversation, and Telegram
  rings for it (see Spin-off).
- Goblin's machine state lives in SQLite (`bun:sqlite`, WAL); files stay
  where humans edit them — config, auth, workspace. Optional long-term
  memory lives in a separate Hindsight service backed by PostgreSQL (see
  Long-term memory). This does not migrate Goblin's conversation store.
- No third channel — two exist now (Telegram and the app, `App channel`,
  ruling 2026-09-30; another needs a ruling here) — no plugin SDK, no k8s.

## Domain model

Two concepts. Conversation identity **is** its channel address — a Telegram
address (chat + optional topic thread) or an app address (`app/<id>`),
ruling 2026-09-30. The two pools are disjoint; see App channel. One
exception (ruling 2026-10-03): the bot DM is a *rolling* address — it
resolves to its current conversation, and a quiet gap can start the
next one (see Rolling DM).

```text
Telegram update
      │
      ▼
Conversation ─────── (channel address) → durable event history
      │ while a turn is running
      ▼
    Turn ──────────── ephemeral: one agent loop + serialized queue
```

- **Conversation** — keyed by its channel address. A Telegram address is a
  forum topic in the operator's group, or the bare chat itself — for the
  bot DM, a sequence of conversations with one current (Rolling DM; DM
  topics retired 2026-10-03); an app address is a client-minted
  id that exists only in the app channel. Owns `events` (user msgs,
  assistant msgs, tool calls, system events), `meta` (created,
  app model/thinking snapshots; Telegram selection is shared).
- **Turn** — a unit of work enqueued on a conversation. Per-conversation
  serial queue; one active turn. A message submitted while a turn runs
  **steers** (ruled 2026-09-28, replacing queue-behind): the running turn
  folds it into its next model call at the step boundary — the SDK's
  `prepareStep`, which runs before every model call, the first one
  included, so a submit landing during the turn's startup (recall,
  attachments) steers in too. Injection is an appended tail: prefix bytes
  untouched, per-conversation prompt cache stays warm (Cache stability).
  Recall stays admission-time — steered input is not re-recalled. The
  reply's anchor, retention source, and reviewer evidence read the
  exchange as it ended **bounded by an ownership high-water mark**: the
  mark advances only over entries the turn actually injected (claimed by
  message id), so input the turn never read — a mid-conversion arrival
  still sitting in the queue, a steer it couldn't carry — never anchors
  its reply. Input arriving after the final model call has no boundary
  left to steer into — it queues into an immediate successor turn. One
  exception (2026-10-03, Spin-off): a turn led by a sink that doesn't
  stream (the background-turn bell) never absorbs a submit from a
  streaming sink (the app client). That submit waits and leads its
  own turn, or the client would never see the reply. The inverse
  holds and is deliberate (2026-10-04, app.md → Streaming members): a
  streaming turn fans its chunks out to every streaming member, so a
  merged or steered second client watches the whole reply. A
  submit that cannot be prepared for the model errors its own delivery
  and is never re-queued (requeue would fail every successor turn's
  admission conversion identically — a poison pill); its message stays
  in history and degrades to a readable placeholder in later model
  views, the corrupt-row precedent one step later at the conversion
  boundary. `/stop` fences the running turn and
  drops queued ones; messages still in the intake buffer are user input,
  not queued turns, and flush into a fresh turn at the new epoch.

**Topics are the UX — in the group.** In the bot DM, quiet gaps draw the
boundaries (Rolling DM), with explicit `/new` and `/back` overrides
(operator ruling, 2026-10-05). Neither command applies to group topics;
there is no `/resume` command. Durable work moves to the app (Spin-off). In the group, a forum
topic is a conversation: create a topic to start one, post in an old topic to
resume it. The bot may also create topics itself (`createForumTopic`). A chat
without topics is one standing conversation. Conversation management is
Telegram's job in the group, not a command set's. A topic created without an explicit name
(`is_name_implicit`) carries a placeholder; the first text burst triggers a
one-shot rename via the optional `titleModel` config ref — an explicit
operator rename always wins.

### The authority rule

The one lesson from v1's RuntimeMachine worth keeping, minus the machinery:
**before any side effect (Telegram send, state write, tool call), the turn
re-checks that it still holds authority** — its conversation epoch hasn't
advanced since enqueue.

Implementation: each conversation carries a monotonic `epoch`, bumped on
conversation-scoped settings changes (`/voice`, `/memory on|off`) and
explicit cancellation. Model/thinking edits do **not** bump the epoch:
Telegram has one shared selection, app conversations own durable snapshots,
and root config holds app defaults for future conversations (ruling
2026-10-06). A turn captures its selection at admission; edits apply to
its next turn without interrupting this one, including overflow recovery
and automatic compaction. `/model` and `/think` stay retired. A turn
captures `(conversationId, epoch)` at admission and calls `checkAuthority()`
around every await. Fenced turns abort quietly and log it. No machines, no
drain sets — one counter and one function. Delivery checks authority when each
queued Telegram action executes, not only when it is queued. The sole
post-fence exception is a cancellation edit: an already-visible partial reply
may be stamped `⏹ superseded` using only its displayed text. Unsent chunks
never become new bubbles on cancellation, and fenced chunks are not retried.

Shutdown rides the same rule. SIGINT/SIGTERM closes the runtime (submits
still land in history but never run), fences every live lane — each sink
stamps "⏹ superseded" on its already-visible partial reply (if any),
without flushing unsent content — and drains the intake
buffer into history, all under a bounded budget. A crash mid-turn leaves
the same shape minus the flush: the user message is in history, the next
turn answers it. Boot never auto-retries a half-run turn — tool calls
aren't idempotent, and an unanswered tail can't be told apart from
`/stop`. If recovery is ever wanted it is notify-don't-retry: surface
the orphaned turn to the operator, don't replay it.

## Cache stability

- **Cache stability.** Provider prompt caching is a pricing and latency
  feature goblin is designed around, not an afterthought: z.ai caches
  repeated prefixes implicitly (no breakpoints; `cached_tokens` in
  usage), other providers do the same by prefix matching. The invariant:
  **the request for turn N+1 is the request for turn N with new content
  appended — bytes already sent are never rewritten.** Consequences:
  - No per-turn re-judgment of history. Attachment representation is the
    pure function above; there is no whole-turn budget and no newest-first
    eviction — an old image never degrades to a path
    reference because newer ones arrived.
  - The system prompt carries no automatic per-turn variability — no
    clock. Current time comes from `date` via bash when it matters.
    Operator edits (SOUL.md, AGENTS.md, USER.md, skills) load at
    conversation boundaries, not mid-run: the system prompt is frozen
    per conversation (`prompt_snapshots`, built at the first turn), so
    a live conversation's prefix cache is never rewritten under it.
    Boundaries are a DM roll, a compaction (which clears the snapshot —
    the history rewrite busts the prefix anyway, so the refresh is
    free), and a spin-off/new conversation. Mid-conversation edits are
    visible to the agent via the read tools immediately; injection
    waits for the boundary, logged by `noteSource` diffs and the
    `prompt snapshot built` line.
  - Every model call logs usage with the cached split
    (`cacheReadTokens`/`cacheWriteTokens` in the per-step line — spec v4
    splits reads from writes — null when the provider doesn't report)
    and the
    request prefix hash — cache behavior and any drift are observable in
    goblin.log. Window utilization warns as input approaches the
    catalog context limit. History compaction is an explicit logged
    boundary that starts a fresh stable prefix — never silent eviction
    (see Compaction).

  Sanctioned one-time rewrites, each visible as a requestHash move in the
  log: a model switch — or a catalog refresh that changes a model's
  listed modalities — recomputes attachment representations once (and
  re-renders stored PDF fetch refs through the same modalities-and-pipe
  gate); a fenced
  or failed turn leaves its user message unanswered, and the successor
  turn's burst-merge (Causal view) rewrites that boundary; a corrupt row's
  placeholder is a repair, not drift. Everything else that moves the hash
  is a bug.

## Design areas

The core above holds what every change must respect. Each area's rulings
live in its own file under `design/`. Code comments and docs cite design
sections by name (`DESIGN.md, "Web access"`, `DESIGN.md → Proton Pass`);
this index resolves a name to its file. A new ruling goes in its area's
file; a change to the domain model, the authority rule, cache stability,
or the non-goals goes here.

- this file — Why, Product boundary, Domain model, Conversation, Turn, The authority rule, Cache stability, Design areas, State layout, Config, Module map, Non-goals (v1 — return only on demand), Test posture — the real change
- [`design/model.md`](design/model.md) — Model layer, Provider registry, Thinking, History, Causal view, arrival-order storage, Compaction, Capabilities, Content, Transcription
- [`design/tools.md`](design/tools.md) — Tools (v1), Vision (image Q&A), Chat search, SQLite FTS5, Scope: every conversation except memory-excluded ones
- [`design/web.md`](design/web.md) — Web access (search, fetch, browser), `search` is one tool with a provider behind it, Config, Fallback chains are explicit config, never implicit, Wire formats, Input, Output is deterministic text, Search results and fetched page text ride fenced, `fetch` is always in the set, PDFs ride as documents, not text, Overflow goes to disk, recovery named, No SSRF policy — recorded as a ruling, Auth never enters tool env, Logging, The browser is a skill, not a tool, MCP returns as a skill over goblin's own mcporter, Goblin owns its mcporter; it never rides the host's, Imports stay off by gate, not by convention, No daemon, by mechanism, The `goblin-mcp-dev` profile starts empty and stays warm, Known limits, accepted
- [`design/skills.md`](design/skills.md) — Skills, Skill reviewer, Gate: Jev on every completed turn, Evidence: a bounded tool digest, captured per turn, Reviewer: staging, validation, then atomic publish, /stop cancels the conversation's reviews, Off the record means no distillation, It publishes, then tells, Instrumentation
- [`design/programs.md`](design/programs.md) — Programs (standing orders), State is rows, not files, Firing is one path for every trigger, Post-submit accounting is trigger-owned, Authority is granted, never self-issued, Webhooks: one secret address per program, Recurrence is cron, evaluated in the server's local timezone, A program belongs to the conversation where it was created, Management is the `program` tool, The scheduler is an in-process ticker
- [`design/delegation.md`](design/delegation.md) — Delegation (other harnesses, via herdr), The herdr session is its own systemd user unit, Targets: the own local session plus configured machines, One protocol, target-agnostic, Only `src/herdr.ts` knows herdr, One lifecycle owner, Harnesses are config, never guessed, Agents run full-auto; goblin never answers approvals, State is rows, Watcher writes are compare-and-set; the notice lands first, Start, The watcher is an in-process ticker, Management is the `delegate` tool, Goblin may delegate on its own judgment
- [`design/mail.md`](design/mail.md) — Email (Gmail) + Workspace via gws, Reads ride gws; goblin holds no read credential, Scopes: readonly is the wall, The `mail` tool is send-only, Google OAuth with split authority, Mail is a program trigger, System One (`system1` block + Jev gate) feeds the shared gates, Logging
- [`design/memory.md`](design/memory.md) — Long-term memory, Slice 2 rulings (locked), Deployment and configuration, Retain: a durable projection of completed exchanges, Recall: evidence, not instructions, Control, correction, and forgetting, Operations and verification
- [`design/auth.md`](design/auth.md) — Auth, Proton Pass (2026-09-26), Goblin's own agent token, Never the owner session, by mechanism, Goblin's own keys resolve through pass-keys, Warmer, Secrets during tasks: the `pass-cli` skill, Honest boundary
- [`design/telegram.md`](design/telegram.md) — Telegram intake & delivery, Coalescing buffer, Delivery, TTS, Files, Voice mode, Mini Apps, Commands, Large files, Rolling DM (ruling 2026-10-03)
- [`design/app.md`](design/app.md) — App channel (PWA → APK), Spin-off (ruling 2026-10-03)

## State layout

```text
$GOBLIN_HOME/
├── goblin.json5            # providers, models, defaults
├── auth.jsonl              # secrets, mode 0600
├── pass-cli.env            # goblin's agent-token PAT, mode 0600
│                           # (owner-written; never read into context)
├── mcporter.json           # goblin's own MCP servers, seeded empty
│                           # (placeholders only; imports [] — gated)
├── mcp                     # symlink → repo scripts/mcp (refreshed boot)
├── workspace/              # the agent's home; every tool runs here
│   ├── SOUL.md             # required, template-created on first boot
│   ├── AGENTS.md           # stub-created on first boot, then agent-owned
│   ├── USER.md             # operator model — directive entries (observed
│   │                       # date, active/superseded), agent-grown
│   │                       #
│   │                       # Keep small deliberate preferences here;
│   │                       # automatic cross-topic memory belongs to the
│   │                       # approved Long-term memory design. Update the
│   │                       # prompt-shell "only memory" claim when wired.
│   ├── skills/             # the skill catalog — agent-authored, in cwd
│   └── attachments/
└── state/
    ├── goblin.sqlite       # Goblin state: conversation meta, event
    │                       # history (UIMessage JSON rows), bindings,
    │                       # memory outbox/contexts/suppressions,
    │                       # programs, delegations
    ├── pass-cli/           # pass-cli session dir for the pass-keys
    │                       # lane (auth.jsonl `!pass-keys` resolves)
    ├── pass-cli-task/      # pass-cli session dir for the skill —
    │                       # separate, never concurrent with the lane
    ├── mcporter/            # mcporter data/cache/daemon dirs (0700) —
    │                       # OAuth tokens + schema caches, off ~/.mcporter
    └── delegations/<id>/report.md   # a harness's final report
```

SQLite durability = WAL + transactions (`synchronous=NORMAL` minimum), not
tmp/fsync/rename — that ritual is for whole-file state only. Inspectability
is an export/query command, not a format property.

## Config

`goblin.json5`: provider registry, root `model`/`thinking` app defaults for
future conversations, independent shared `telegram.model`/`telegram.thinking`,
optional `transcription` block, optional `vision` block (absent =
vision tool absent; `model` + `maxTokens`), optional `search` block (absent =
search tool absent), optional `memory` block (absent = memory
disabled), optional `delegation` block (`maxRunning`, default 3;
`harnesses`: name → `{ kind, args? }` — absent = delegate tool
absent; the herdr session name is not config, it belongs to
`deploy/goblin-herdr.service`), optional `mail` block (`clientId`,
`clientSecretAuth`, `sendAuth` — the send credential only; reads ride
`gws auth login`, absent = no mail tool, no mail watcher), optional
`reviewer` + `system1` blocks (the skill-review gate and the shared
System One gate behind it — Email + Skill reviewer). No secrets —
those live in `auth.jsonl`.

**Settings are operator-facing UI, not SSH.** The mini app is the
configuration surface: the process reads and writes `goblin.json5` itself, and
the operator changes settings from Telegram. Editing the file by hand always
works; it is never required.

## Module map

```text
src/
  index.ts          composition root: config → auth → conversations → bot → http
  config.ts         goblin.json5, zod-validated
  auth.ts           auth.jsonl reader + "!" command resolution +
                    pass-cli-direct poisoning (resolve rejects, never spawns)
  log.ts            structured log; no console.log anywhere else
  tg/               grammy: intake, buffer, delivery, commands (only grammy-aware dir)
  conversation.ts   store: SQLite-backed resolve/load/append events, meta, epoch
  memory.ts         recall contexts, retention builders, status, worker timer
                    (wire client in hindsight.ts, outbox in memory-queue.ts,
                    outage episodes in memory-outage.ts)
  programs.ts       standing programs — rows in goblin.sqlite, cron
                    validated at the boundary, webhook token hashes
  scheduler.ts      ticker: due programs → turns in their pinned
                    conversation; fire() is shared with the webhook route
  herdr.ts          herdr CLI adapter (the only herdr-aware module)
  delegations.ts    delegation rows (SQLite store)
  delegation-lifecycle.ts   the delegation protocol: launch, send,
                    stop, read + the watcher's verdicts and boot
                    recovery — herdr state → turns in the pinned
                    conversation; the ticker is a thin timer over
                    the owner's scan
  mail-gws.ts       the watcher's poll surface over the gws CLI (raw
                    Discovery calls, JSON out) — the only gws-aware
                    module; runner injectable, gws owns its auth
  mail-watcher.ts   the mail trigger's ticker: gws poll → the firing
                    owner's mail entry point (never writes program state)
  mail.ts           the send client (operator-gated) + shared mail shapes
                    (MailHit, ThreadContext, HistoryExpiredError, MailPoller)
  injection.ts      System One injection checker: shared Jev gate →
                    clean/suspicious/malicious/unavailable verdicts, fail-open
  jev.ts            the Jev/OpenRouter Decisions boundary (the reviewer's
                    gate and the checker's shared client)
  runtime.ts        per-conversation queue, turn loop, checkAuthority
  agent/
    providers.ts    registry: name → AI SDK provider
    catalog-fetch.ts  the cached-catalog skeleton: single-flight fetch,
                    failure backoff, TTL, validated disk cache — a spec
                    supplies wire/disk shapes and path
    models-dev.ts   the two model catalogs (models.dev modalities +
                    context limits; openrouter per-route params) as
                    specs over catalog-fetch.ts
    codex/          the codex provider: auth.ts (OAuth file lifecycle —
                    expiry, single-flight refresh, durable write-back)
                    and model.ts (LanguageModelV4 — prompt→responses
                    conversion, SSE→stream parts)
    attachments.ts  data-attachment parts + per-turn materialization
    transcribe.ts   speech → text (groq whisper, more kinds later) —
                    intake + transcribe tool share it
    tts.ts          text or file → speech (edge read-aloud ws, opus out)
    prompt.ts       system prompt assembly (shell + SOUL.md + agent-owned
                    AGENTS.md/USER.md — capped at 20k chars each, USER.md
                    at 4k; overage keeps head 70%/tail 20%, drops the
                    middle — newest notes live at the end). Frozen per
                    conversation (prompt_snapshots): edits load at
                    boundaries (roll/compaction), never mid-run
    skills.ts       catalog scan + frontmatter validation → ## skills section
    tools/          the fifteen tools (read, write, edit, bash, speak,
                    transcribe, vision, program, delegate, mail
                    (send-only; reads ride the goblin-mail wrapper via
                    bash), send_file, memory_search, search, fetch,
                    history_search)
  http/             mini-app serving + POST /hook/<token> +
                    loopback POST /api/check-injection (the wrapper's gate;
                    value imports live in check.ts, never mod.ts — the
                    client tsconfig would drag the server graph into DOM-land)
    app.ts          page markup+css (served as-is, no build step)
    app.js          page client — plain JS, tsc-checked (checkJs via
                    tsconfig.client.json); wire types imported from
                    mod.ts/config.ts so schema drift fails typecheck
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

memory store (returned on demand — approved in `Long-term memory`) ·
scheduler (returned on demand — generalized into `Programs`;
heartbeat/proactive monitoring stays out) · web access (returned on
demand — designed in `Web access`; a native browser tool stays
out) · delegated work / external agents (returned on demand —
designed in `Delegation`) · MCP (returned on demand as a skill over
goblin's own mcporter — `Web access`; a native client stays out) ·
email (returned on demand — `Email`; reads migrated to gws 2026-09-29 —
Workspace access is now in scope exactly at gmail.readonly +
drive.readonly + calendar rw + sheets rw, reached through the gws CLI
and the goblin-mail wrapper, never raw in-process OAuth) · inner life (partly returned on
demand — `Chat search`, `Skill reviewer`; self-waking, memory nudges,
and self-grading skill machinery stay out) · conversation-lifecycle
commands · subagents · ACP ·
project environments · onboarding wizard · state
migrations (general framework; additive memory schema changes are in scope) ·
in-process embeddings (delegated to Hindsight for memory) · app client
(returned on demand 2026-09-30 — `App channel`; a third channel stays
out) · multi-user

## Test posture — the real change

v1 died of test-to-code ratio. New rule: **tests guard boundaries and
invariants, not implementations.** Worth a test: authority fencing, durable
write semantics, intake coalescing, auth command resolution. Not worth a test:
that a function calls its collaborator with the right arguments. Fakes at the
two external edges (model provider, Telegram API); no mock.module pyramids.
The suite should stay smaller than `src/` — if it isn't, that's a smell to
fix, not a badge.
