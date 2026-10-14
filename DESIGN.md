# goblin v2 — design

Rewrite of little-goblin. Same product, ruthless scope. v1 ran on lithium
until the cutover and is retired (its tree is gone); nothing was imported —
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
  `scripts/install.sh` is fresh-only and path-substituting: it refuses an
  existing installation, validates provisioned config/auth before enabling
  units, builds client assets, and checks the current boot rather than
  accepting an active restart loop. That script plus first-boot scaffolding
  (home layout, SOUL.md/AGENTS.md stubs, fail-loud config pointer) is the
  entire setup story — no onboarding wizard, ever. Deployment reality: prod
  is g7 — this tree runs `goblin.service` plus the memory stack directly
  (lithium ran prod until 2026-10-09, then retired; its state was merged
  here). `scripts/deploy.sh` is the update path: gate (typecheck + tests),
  rebuild the app client when it moved, restart, verify. Git publication is
  separate: local deployment never pushes or updates the remote review
  baseline (docs/operations.md → Deploying).
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
  where humans edit them — config, auth, workspace. Notes are the ruled
  exception (2026-10-10): their editing surface is the app, so they are
  rows (design/projects.md → Notes). Optional long-term
  memory lives in a separate Hindsight service backed by PostgreSQL (see
  Long-term memory). This does not migrate Goblin's conversation store.
- No third channel — two exist now (Telegram and the app, `App channel`,
  ruling 2026-09-30; another needs a ruling here) — no plugin SDK, no k8s.

## Setup and diagnosis

Setup remains two operator-edited inputs plus a non-interactive installer,
not a wizard. Shared read-only checks distinguish start-ready preflight
from an installed system; onboarding owns actions and current-invocation
startup acceptance. Fresh setup must not quietly update an existing
installation. Production updates remain the separately approved deploy
path. See [Setup](design/setup.md).

Doctor is one bounded diagnostic pass, not a watchdog or repair service.
`bun run doctor` reports configured failures, skipped/unknown coverage and
manual next steps without initializing application state, resolving
arbitrary auth commands or changing services. Its consumers are the
operator, installer and Goblin's existing bash tool. JSON stdout is a
single report; diagnostic operational messages use stderr, deliberately
separate from the runtime's JSONL log stream. Only the two safe startup
lifecycle signals bypass normal log filtering so acceptance can observe
them. See [Doctor](design/doctor.md).

A scheduled invocation requires explicit standing authority; no timer or
resident self-waking behavior is introduced by this capability.

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
  its reply. The admission-time model view is bounded the same way
  (2026-10-08, #82): durability is not ownership — a submit still queued
  when the turn starts (the streaming client a non-streaming head must
  leave behind) stays out of that turn's view and anchor; the turn that
  claims it reads it. The inverse is deliberate too (2026-10-04, app.md →
  Streaming members): a streaming turn fans its chunks out to every
  streaming member, so a merged or steered second client watches the
  whole reply. Exceptions:
  - A turn led by a sink that doesn't stream (the background-turn bell)
    never absorbs a submit from a streaming sink (2026-10-03, Spin-off):
    that submit waits and leads its own turn, or the client would never
    see the reply.
  - Input arriving after the final model call has no boundary left to
    steer into — it queues into an immediate successor turn.
  - A submit that cannot be prepared for the model errors its own
    delivery and is never re-queued (requeue would fail every successor
    turn's admission conversion identically — a poison pill); its
    message stays in history and degrades to a readable placeholder in
    later model views, the corrupt-row precedent one step later at the
    conversion boundary.
  - `/stop` fences the running turn and drops queued ones; messages
    still in the intake buffer are user input, not queued turns, and
    flush into a fresh turn at the new epoch.

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
or the non-goals goes here. And a superseded ruling is rewritten in
place, not amended in place: state the surviving rule with its
provenance anchor; narration of retired behavior belongs in git, not
the spec.

- this file — Why, Product boundary, Domain model, Conversation, Turn, The authority rule, Cache stability, Design areas, State layout, Config, Module map, Non-goals (v1 — return only on demand), Test posture — the real change
- [`design/model.md`](design/model.md) — Model layer, Provider registry, Thinking, History, Causal view, arrival-order storage, Compaction, Capabilities, Content, Transcription
- [`design/asr.md`](design/asr.md) — Speech recognition engines: whistle (local) default, eight kinds behind one interface, artifact auto-fetch, verbatim provider contracts
- [`design/runtime-turn.md`](design/runtime-turn.md) — The turn (architecture ruling): the phase list, state ownership by lifetime, the attempt loop, what must not change, module map, the two text projections (#84/#111)
- [`design/tools.md`](design/tools.md) — Tools (v1), Scripting (in-process tool composition, not a subagent), Vision (image Q&A), Chat search, SQLite FTS5, Scope: every conversation except memory-excluded ones
- [`design/web.md`](design/web.md) — Web access (search, fetch, browser), `search` is one tool with a provider behind it, Config, Fallback chains are explicit config, never implicit, Wire formats, Input, Output is deterministic text, Search results and fetched page text ride fenced, `fetch` is always in the set, PDFs ride as documents, not text, Overflow goes to disk, recovery named, No SSRF policy — recorded as a ruling, Auth never enters tool env, Logging, The browser is a skill, not a tool, MCP returns as a skill over goblin's own mcporter, Goblin owns its mcporter; it never rides the host's, Imports stay off by gate, not by convention, No daemon, by mechanism, The `goblin-mcp-dev` profile starts empty with its own snapshot, Known limits, accepted
- [`design/skills.md`](design/skills.md) — Skills, Skill reviewer, Gate: System One on every completed turn, Evidence: a bounded tool digest, captured per turn, Reviewer: staging, validation, then an atomic proposal, /stop cancels the conversation's reviews, Off the record means no distillation, It proposes, then tells, Instrumentation
- [`design/system1.md`](design/system1.md) — System One (typed-decision models): the shared client, retry policy, wire protocol, the four-consumer table, the loopback injection-check endpoint, config surface
- [`design/programs.md`](design/programs.md) — Programs (standing orders), State is rows, not files, Firing is one path for every trigger, Post-submit accounting is trigger-owned, Authority is granted, never self-issued, Webhooks: one secret address per program, Recurrence is cron, evaluated in the server's local timezone, A program belongs to the conversation where it was created, Management is the `program` tool, The scheduler is an in-process ticker
- [`design/delegation.md`](design/delegation.md) — Delegation (other harnesses, via herdr), The herdr session is its own systemd user unit, Targets: the own local session plus configured machines, One protocol, target-agnostic, Only `src/herdr.ts` knows herdr, One lifecycle owner, Harnesses are config, never guessed, Agents run full-auto; goblin never answers approvals, State is rows, Watcher writes are compare-and-set; the notice lands first, Start, The watcher is an in-process ticker, Management is the `delegate` tool, Goblin may delegate on its own judgment
- [`design/mail.md`](design/mail.md) — Email (Gmail) + Workspace via gws, Reads ride gws; goblin holds no read credential, Scopes: readonly is the wall, Every read injection-checked and fenced, The `mail` tool is send-only, Google OAuth with split authority, Mail is a program trigger, Reads ride the shared System One gate (design/system1.md), Logging
- [`design/memory.md`](design/memory.md) — Long-term memory, Slice 2 rulings (locked), Deployment and configuration, Retain: a durable projection of completed exchanges, Recall: evidence, not instructions, Control, correction, and forgetting, Operations and verification
- [`design/auth.md`](design/auth.md) — Auth, Proton Pass (2026-09-26), Goblin's own agent token, Never the owner session, by mechanism, Goblin's own keys resolve through pass-keys, Warmer, Secrets during tasks: the `pass-cli` skill, Honest boundary
- [`design/telegram.md`](design/telegram.md) — Telegram intake & delivery, Coalescing buffer, Delivery, TTS, Files, Voice mode, Mini Apps, Commands, Large files, Rolling DM (ruling 2026-10-03)
- [`design/app.md`](design/app.md) — App channel (PWA → APK), Spin-off (ruling 2026-10-03)
- [`design/sandbox.md`](design/sandbox.md) — Sandbox (ruling 2026-10-10): a disposable rootless-podman container per conversation behind the `sandbox` tool — the wall, the lifetime, network off by default, images pulled only with operator permission
- [`design/projects.md`](design/projects.md) — Projects & Notes (ruling 2026-10-10): projects scope app conversations (cwd, instructions, memory choice, fixed binding); notes are server-mediated SQLite rows (markdown only, versions, the `note` tool, attach, fenced append, AI rewrite); Pi Durable rejected as a second harness

- [`design/doctor.md`](design/doctor.md) — Shared read-only checks, output/exit contract, phases and diagnostic coverage
- [`design/setup.md`](design/setup.md) — Product shape, Install order, Phases, Phase-dependent expectations, Startup acceptance, Installer rules, Opt-in dependencies, Verification boundary

## State layout

```text
$GOBLIN_HOME/
├── goblin.json5            # providers, models, defaults
├── auth.jsonl              # secrets, mode 0600
├── mcporter.json           # goblin's own MCP servers, seeded empty
│                           # (placeholders only; imports [] — gated)
├── mcp                     # symlink → repo scripts/mcp (refreshed boot)
├── doctor                  # symlink → repo scripts/doctor (refreshed boot)
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
├── projects/<slug>/        # a project's home; its default cwd (notes are
│                           # rows, not files — design/projects.md)
└── state/
    ├── goblin.sqlite       # Goblin state: conversation meta, event
    │                       # history (UIMessage JSON rows), bindings,
    │                       # memory outbox/contexts/suppressions,
    │                       # programs, delegations, projects, notes
    │                       # (+ versions, FTS)
    ├── pass-cli/           # pass-cli session dir for background sync;
    │                       # shared agent lane, not foreground resolution
    ├── pass-cli-task/      # separate pass-cli session dir for the skill;
    │                       # never interleave calls within one session
    ├── mcporter/            # mcporter data/cache/daemon dirs (0700) —
    │                       # OAuth tokens + schema caches, off ~/.mcporter
    └── delegations/<id>/report.md   # a harness's final report
```

Pass-keys state is outside this tree: encrypted per-profile snapshots in
Secret Service/KWallet, plus the dedicated agent's bootstrap PAT in the OS
store under `goblin-dev` (shared by `goblin-dev` and `goblin-mcp-dev`). No
PAT env file is part of the target layout. `auth.jsonl` uses
`!pass-keys get goblin-dev NAME`; MCP uses local snapshot env injection via
`pass-keys run goblin-mcp-dev -- …`. Only explicit background `warm` syncs
reach Pass. Failed syncs preserve last-good snapshots; persistent wallets
survive reboot if unlocked. Neither auto-unlock nor same-user isolation is
assumed. See [Auth](design/auth.md#proton-pass-2026-09-26).

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
`guest` block (absent = no service for non-operators;
`outputChars` default 3500 — sandboxed turns and standing sandbox
DMs for `allowedUsers`, `design/telegram.md` → Roles and
permissions), optional
`sandbox` block (absent or `""` = no sandbox tool; `image`,
`idleHours`, `memory`, `cpus`, `pids` — `design/sandbox.md`), optional
`reviewer` + `system1` blocks (the skill-review gate and the shared
System One client's own switch — `design/system1.md`). No secrets —
those live in `auth.jsonl`.

**Settings are operator-facing UI, not SSH.** The mini app is the
configuration surface: the process reads and writes `goblin.json5` itself, and
the operator changes settings from Telegram. Editing the file by hand always
works; it is never required.

## Module map

```text
src/
  index.ts          composition root: config → auth → conversations → bot →
                    http — it wires, it never rules; a rule with no owning
                    module gets one before it may live here
  config.ts         goblin.json5, zod-validated
  auth.ts           auth.jsonl reader + "!" command resolution +
                    pass-cli-direct poisoning (resolve rejects, never spawns)
  log.ts            structured log; no console.log anywhere else
  health.ts         shared read-only diagnostic checks; no bootstrap
  doctor.ts         bounded text/JSON CLI; preflight or installed policy
  tg/               grammy: intake, buffer, delivery, commands, guest
                    mode (only grammy-aware dir)
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
                    the owner's scan; delegationWake owns the notice
                    routing (never roll the DM; app-pinned rows wake
                    their conversation)
  wake.ts           the shared wake path: system messages submit into
                    pinned conversations through the ordinary turn
                    path — makeWakeDeps owns the routing rules (the
                    rolling gap, the bell for app conversations)
  spinoff.ts        the spin-off fork and where a delegation launch
                    pins its notices (launchPin — the Spin-off trigger
                    map, design/app.md → Spin-off)
  podman.ts         the podman CLI adapter (the only podman-aware
                    module); argv seams for tests, every call logged —
                    create/inspect/lifecycle/exec/cp/network ops only,
                    no prune (design/sandbox.md)
  sandboxes.ts      the sandboxes table + lifecycle owner: one
                    container per conversation, row-vs-engine
                    reconcile, fail-closed network, call-time idle
                    reap — never boot/shutdown
  mail-gws.ts       the watcher's poll surface over the gws CLI (raw
                    Discovery calls, JSON out) — the only gws-aware
                    module; runner injectable, gws owns its auth
  mail-watcher.ts   the mail trigger's ticker: gws poll → the firing
                    owner's mail entry point (never writes program state)
  mail.ts           the send client (operator-gated) + shared mail shapes
                    (MailHit, ThreadContext, HistoryExpiredError, MailPoller)
  injection.ts      System One injection checker: shared System One gate →
                    clean/suspicious/malicious/unavailable verdicts, fail-open
  system1.ts        the System One boundary — the OpenRouter Decisions
                    client shared by all four consumers
                    (design/system1.md)
  runtime.ts        per-conversation queue, lane drain, checkAuthority,
                    stop/shutdown, the attempt loop — the turn's phases
                    live in turn/ (design/runtime-turn.md)
  turn/             the turn's phases (design/runtime-turn.md)
    state.ts        TurnState: attempt-scoped state, the loop machinery
                    (detector, watchdog cadence, warn/cut landings — no
                    step budget), and the TurnRecovery whitelist
                    projection
    admission.ts    the admission snapshot: epoch, ownership filter
                    (#82), anchor, steer-mark seed
    view.ts         pure model-view assembly — byte-stable
                    (cache stability)
    stream.ts       the stream driver: SDK callbacks, steering fold,
                    chunk fan-out, wire log, join replay
    overflow.ts     overflow classify + compact-and-resume packaging
    finish.ts       persist, retention hand-off, reviewer snapshot,
                    forced-landing stamps
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
    tools/          the tools (read, write, edit, bash, speak,
                    transcribe, vision, program, delegate, mail
                    (send-only; reads ride the goblin-mail wrapper via
                    bash), send_file, memory_search, memory_reflect, search, fetch,
                    history_search, sandbox, script, ui)
  http/             the HTTP doors: /t/ and /app/ serve the built
                    client (app/dist) — the Telegram mini app and the
                    PWA are one client with two entries — plus the
                    initData operator tails (/api/*), POST /hook/<token>,
                    and loopback POST /api/check-injection (the wrapper's
                    gate; value imports live in check.ts, never mod.ts)
```

Flat modules, one job each, tests colocated.

## Non-goals (v1 — return only on demand)

The list below is a record, not a law. The law, applied to any capability:

1. **Core** — what the turn loop's honesty depends on (ordering, authority,
   durability, delivery). Always in; defects here jump the queue.
2. **Chat-native** — a natural property of one operator talking to one agent
   in Telegram: text/voice/media intake, topics, settings commands, the
   soul. The operator is one person (possibly several accounts); anyone
   else appears only as a fenced sandbox lane (`design/telegram.md` →
   Roles and permissions). In scope by default; a missing piece here is a gap *against this
   doc*, not a deferral. (Voice notes are chat-native — the rewrite exists
   because pi couldn't do audio; if transcription is missing, that's a bug
   in the roadmap, not a choice.)
3. **Machinery** — a second system the loop must keep honest: memory stores,
   schedulers, subagent fleets, MCP brokers, skill catalogs, projects, inner
   life. Out until explicitly demanded; when demanded, designed here first.

If a capability can't be classified in one sentence, the classification is
   the design conversation — have it before building.

Read-only diagnosis returned on demand as Doctor; it does not return
proactive monitoring or authorize repair.

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
project environments (returned on demand 2026-10-10 — `Projects &
Notes`; app-channel projects with a cwd + instructions, notes as
server-mediated rows; a second harness stays out) · onboarding wizard · state
migrations (general framework; additive memory schema changes are in scope) ·
in-process embeddings (delegated to Hindsight for memory) · app client
(returned on demand 2026-09-30 — `App channel`; a third channel stays
out) · sandboxed execution (returned on demand 2026-10-10 — `Sandbox`;
one podman backend, no backend registry) · multi-user (bounded slice
returned on demand 2026-10-06, widened 2026-10-11 —
named `allowedUsers` get sandboxed turns and standing sandbox DMs:
guest persona + `search` only, memory-excluded, no app doors
(`design/telegram.md` → Roles and permissions; no sandbox `fetch` —
Guest mode there); strangers get one refusal line and nothing else;
full multi-user stays out)

## Test posture — the real change

v1 died of test-to-code ratio. New rule: **tests guard boundaries and
invariants, not implementations.** Worth a test: authority fencing, durable
write semantics, intake coalescing, auth command resolution. Not worth a test:
that a function calls its collaborator with the right arguments. Fakes at the
two external edges (model provider, Telegram API); no mock.module pyramids.
The suite should stay smaller than `src/` — if it isn't, that's a smell to
fix, not a badge.
