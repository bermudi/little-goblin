# goblin v2 — design

Rewrite of little-goblin — same product, ruthless scope. v1 retired at the
2026-10-09 cutover; no code, no state, no specs carry over — only this
document and the lessons it encodes.

## Why

pi-coding-agent is the ceiling: pi-ai supports only text and images, thinking
levels are half-broken, and the codebase grew a ~10x stabilization apparatus
(test code to product code) to compensate for seams pi forced on it. Vercel AI
SDK gives provider-agnostic model access, native document/audio parts, and
thinking levels that actually work — the agent core is rewritten around it,
and everything else is rebuilt only if it earns its place.

## Product boundary

- One human operator (bermudi), one Bun process, homelab. Prod is g7: this
  tree runs `goblin.service` (systemd user unit, linger) plus the memory
  stack directly. Install is `scripts/install.sh` — fresh-only,
  path-substituting, first-boot scaffolding; there is no onboarding wizard,
  ever. `scripts/deploy.sh` is the update path (gate, rebuild the app client
  when it moved, restart, verify); tests gate merges in CI, not deploys, and
  it never pushes (docs/operations.md → Deploying).
- Two channels. Telegram: long polling, topics, reactions, files, voice —
  **and Mini Apps, designed in from the start** (the process serves them over
  HTTP; see Telegram intake & delivery). The app: a React client, PWA while
  testing, Capacitor APK when stable, speaking the AI SDK UIMessage protocol
  over the process's own HTTP surface (see App channel). The channels are
  disjoint — a conversation is born on the surface where it starts and stays.
  One sanctioned crossing (ruling 2026-10-03): a delegation launched from the
  Telegram DM spins off a named app conversation, and Telegram rings for it
  (see Spin-off).
- Goblin's machine state lives in SQLite (`bun:sqlite`, WAL); files stay
  where humans edit them — config, auth, workspace. Notes are the ruled
  exception (2026-10-10): their editing surface is the app, so they are rows
  (design/projects.md → Notes). Optional long-term memory is a separate
  Hindsight service backed by PostgreSQL (see Long-term memory); it does not
  migrate Goblin's conversation store.
- No third channel — two exist (Telegram and the app, `App channel`, ruling
  2026-09-30; another needs a ruling here) — no plugin SDK, no k8s.

## Setup and diagnosis

Setup (installer + first boot) is ruled in [Setup](design/setup.md): no
wizard ever; fresh setup never quietly updates an existing installation.
Doctor ([Doctor](design/doctor.md)) is one bounded diagnostic pass that
reports — it never repairs, initializes state, or changes services. A
scheduled invocation requires explicit standing authority; no timer or
resident self-waking behavior is introduced by this capability.

## Domain model

Two concepts. Conversation identity **is** its channel address — a Telegram
address (chat + optional topic thread) or an app address (`app/<id>`), ruling
2026-09-30. The two pools are disjoint; see App channel. One exception
(ruling 2026-10-03): the bot DM is a *rolling* address — it resolves to its
current conversation, and a quiet gap can start the next one (see Rolling
DM).

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
  forum topic in the operator's group, or the bare chat itself — for the bot
  DM, a sequence of conversations with one current (Rolling DM; DM topics
  retired 2026-10-03); an app address is a client-minted id that exists only
  in the app channel. Owns `events` (user msgs, assistant msgs, tool calls,
  system events) and `meta` (created, app model/thinking snapshots; Telegram
  selection is shared).
- **Turn** — a unit of work enqueued on a conversation: per-conversation
  serial queue, one active turn. A message submitted while a turn runs
  **steers** (2026-09-28, replacing queue-behind): folded into the next model
  call at the SDK's `prepareStep` boundary, which runs before every model
  call including the first, so submits landing during turn startup (recall,
  attachments) steer too. Injection is an appended tail: prefix bytes
  untouched, the conversation's prompt cache stays warm (Cache stability).
  Recall stays admission-time — steered input is not re-recalled. The reply's
  anchor, retention source, and reviewer evidence read the exchange as it
  ended **bounded by an ownership high-water mark** advancing only over
  entries the turn actually injected (claimed by durable event seq, never
  the app-controlled message id): input the turn
  never read — a mid-conversion arrival still queued, an uncarryable steer —
  never anchors its reply. The admission-time model view is bounded the same
  way (2026-10-08, #82): durability is not ownership — a submit still queued
  at turn start (the streaming client a non-streaming head must leave
  behind) stays out of that turn's view and anchor; the turn that claims it
  reads it. The inverse is deliberate (2026-10-04, app.md → Streaming
  members): a streaming turn fans chunks out to every streaming member, so a
  merged or steered second client watches the whole reply. Exceptions:
  - A turn led by a sink that doesn't stream (the background-turn bell)
    never absorbs a submit from a streaming sink (2026-10-03, Spin-off):
    that submit waits and leads its own turn, or the client would never
    see the reply.
  - Input arriving after the final model call has no boundary left to
    steer into — it queues into an immediate successor turn.
  - A submit that cannot be prepared for the model errors its own delivery
    and is never re-queued (requeue would fail every successor turn's
    admission conversion identically — a poison pill); its message stays in
    history and degrades to a readable placeholder in later model views, the
    corrupt-row precedent one step later at the conversion boundary.
  - `/stop` fences the running turn and drops queued ones; messages still in
    the intake buffer are user input, not queued turns, and flush into a
    fresh turn at the new epoch.

**Topics are the UX — in the group.** In the bot DM, quiet gaps draw the
boundaries (Rolling DM), with explicit `/new` and `/back` overrides
(operator ruling, 2026-10-05); neither command applies to group topics.
`/resume` is not DM/topic navigation: it resumes only interrupted turns from
[the turn journal](design/runtime-turn.md#the-turn-journal). Durable work
moves to the app (Spin-off). In the group, a forum topic is a conversation:
create a topic to start one, post in an old topic to resume it; the bot may
also create topics itself (`createForumTopic`); a chat without topics is one
standing conversation; management is Telegram's job in the group, not a
command set's. A topic created without an explicit name (`is_name_implicit`)
carries a placeholder; the first text burst triggers a one-shot rename via
the optional `titleModel` config ref — an explicit operator rename always
wins.

### The authority rule

The one lesson from v1's RuntimeMachine worth keeping, minus the machinery:
**before any side effect (Telegram send, state write, tool call), the turn
re-checks that it still holds authority** — its conversation epoch hasn't
advanced since enqueue.

Each conversation carries a monotonic `epoch`, bumped on conversation-scoped
settings changes (`/voice`, `/memory on|off`) and explicit cancellation.
Model/thinking edits do **not** bump the epoch: Telegram has one shared
selection, app conversations own durable snapshots, and root config holds app
defaults for future conversations (ruling 2026-10-06). A turn captures its
selection at admission; edits apply to its next turn without interrupting
this one, including overflow recovery and automatic compaction. `/model` and
`/think` stay retired. A turn captures `(conversationId, epoch)` at admission
and re-checks authority around every await. Fenced turns abort quietly
and log it. No machines, no drain sets — one counter and one function.
Delivery checks authority when each queued Telegram action executes, not only
when it is queued. The sole post-fence exception is a cancellation edit: an
already-visible partial reply may be stamped `⏹ superseded` using only its
displayed text. Unsent chunks never become new bubbles on cancellation, and
fenced chunks are not retried.

Shutdown rides the same rule. SIGINT/SIGTERM closes the runtime (submits
still land in history but never run), fences every live lane — each sink
stamps "⏹ superseded" on its already-visible partial reply (if any), without
flushing unsent content — and drains the intake buffer into history, all
under a bounded budget. A crash mid-turn leaves the same shape minus the
flush: the user message is in history, the next turn answers it. The turn
journal (design/runtime-turn.md → The turn journal) makes the distinction
durable: a graceful shutdown stamps its runs `fenced`; a row still `running`
at open means the process died, is reclassified `interrupted`, and is
surfaced to the operator as a boot notice — counts and facts, never a
replay. Boot never auto-retries a half-run turn — tool calls aren't
idempotent, and an unanswered tail can't be told apart from `/stop`.
Resuming an interrupted turn is a separate explicit decision riding the
journaled rows, not a boot behavior.

## Cache stability

Provider prompt caching is a pricing and latency feature goblin is designed
around, not an afterthought: z.ai caches repeated prefixes implicitly (no
breakpoints; `cached_tokens` in usage), other providers do the same by prefix
matching. The invariant: **the request for turn N+1 is the request for turn N
with new content appended — bytes already sent are never rewritten.**
Consequences:

- No per-turn re-judgment of history. Attachment representation is the pure
  function above; there is no whole-turn budget and no newest-first eviction
  — an old image never degrades to a path reference because newer ones
  arrived.
- The system prompt carries no automatic per-turn variability — no clock;
  current time comes from `date` via bash when it matters. Operator edits
  (SOUL.md, AGENTS.md, USER.md, skills) load at conversation boundaries, not
  mid-run: the system prompt is frozen per conversation (built at the
  first turn), so a live conversation's prefix cache is never rewritten under
  it. Boundaries are a DM roll, a compaction (which clears
  the snapshot — the history rewrite busts the prefix anyway, so the refresh
  is free), and a spin-off/new conversation. Mid-conversation edits are
  visible to the agent via the read tools immediately; injection waits for
  the boundary.
- Every model call logs usage with the cached split and a request prefix
  hash — cache behavior and drift are observable in goblin.log; window
  utilization warns as input approaches the catalog limit. Compaction is an
  explicit logged boundary starting a fresh stable prefix — never silent
  eviction (see Compaction).
- Pruning old textual tool results is opt-in through the bootstrap-only
  `cachePruning` config block (profiles of route key + settings hash). A
  committed projection is a sanctioned rewrite of the model-facing view
  only — the `events` row is never modified, and the marker replays
  byte-identically on every later read and restart. New batches commit only
  between turns, when the profile is unexpired and the observed receipts
  don't contradict its presumed expiry; a contradiction suspends new batches
  — never committed rows (an unchanged-prefix zero-cache-read call inside
  the window, an expired profile, or a documented expiry the contract
  registry can't support). Prefix relations (`first`/`same`/`append`/
  `rewrite`) are structural facts about consecutive requests, never proof of
  cache warmth, expiry or a provider bug. Cache-call evidence has no
  automatic age-based deletion or prompt-hash stripping; retention changes
  require a separate explicit decision.

Sanctioned one-time rewrites, each visible as a request-hash move in the log:
a model switch — or a catalog refresh that changes a model's listed
modalities — recomputes attachment representations once (and re-renders
stored PDF fetch refs through the same modalities-and-pipe gate); a fenced or
failed turn leaves its user message unanswered, and the successor turn's
burst-merge (Causal view) rewrites that boundary; a corrupt row's placeholder
is a repair, not drift; a deploy that changes the read-time compaction
marker's wording rewrites it once in every compacted conversation; the
owning turn's injected skill body collapses to its `[skill: name]` marker
on the next turn's view (owned-seq ruling); a
committed pruning marker replaces an old textual tool result once, then
replays verbatim forever. Everything else that moves the hash is a bug.

## Design areas

The core above holds what every change must respect. Each area's rulings
live in its own file under `design/`; comments cite sections by name
(`design/telegram.md → Roles and permissions`). A new ruling goes in its
area's file; a change to the domain model, the authority rule, cache
stability, or the non-goals goes here. A superseded ruling is rewritten in
place, not amended: state the surviving rule with its provenance anchor;
narration of retired behavior belongs in git, not the spec.

## State layout

`$GOBLIN_HOME`: config (`goblin.json5`, `auth.jsonl`), `workspace/` (the
agent's home — every tool runs there), `projects/<slug>/`, and `state/`
(SQLite, tool-owned dirs). SQLite durability = WAL + transactions
(`synchronous=NORMAL` minimum), not tmp/fsync/rename — that ritual is for
whole-file state only. Inspectability is an export/query command, not a
format property. Pass-keys state lives outside the tree (OS store,
agent-lane snapshots) — see [Auth](design/auth.md#proton-pass-2026-09-26).

## Config

`goblin.json5`: provider registry + per-capability blocks (absent =
capability off; each block's policy lives in its area doc). No secrets —
`auth.jsonl` holds those.

**One canonical object.** A save parses settings through the schema and
rewrites the file whole (tmp+fsync+rename, existing mode preserved) — text is
never patched in place. Comments and key order are not configuration and are
dropped by a save; unknown keys are rejected at load, not stripped, so a typo
fails loud. Malformed JSON5 or a schema-invalid incumbent also fails loud — a
save never resets it silently. Save freshness rides the mini app's `If-Match`
version, so competing saves cannot silently overwrite each other.

**Settings owns routine configuration.** The app and Telegram mini app share
the supported settings editor; `goblin.json5` is its persisted state, not a
parallel editing interface. Direct file edits are reserved for bootstrap and
recovery, including advanced blocks not yet exposed in Settings. Validate
those edits with Doctor before an approved restart; the next Settings save
canonicalizes the file.

## Module map

Flat modules, one job each, tests colocated; the tree itself is the map,
`scripts/function-size-audit.ts` lists units past the ~300-line smell line.
`index.ts` wires and never rules: a rule with no owning module gets one
before it may live here. Inside a module, state clusters by lifetime live in
their own units — never one scope of closures.

## Non-goals (v1 — return only on demand)

The list below is a record, not a law. The law, applied to any capability:

1. **Core** — what the turn loop's honesty depends on (ordering, authority,
   durability, delivery). Always in; defects here jump the queue.
2. **Chat-native** — a natural property of one operator talking to one agent
   in Telegram: text/voice/media intake, topics, settings commands, the soul.
   The operator is one person (possibly several accounts); anyone else appears
   only as a fenced sandbox lane (`design/telegram.md` → Roles and
   permissions). In scope by default; a missing piece here is a gap *against
   this doc*, not a deferral. (Voice notes are chat-native — the rewrite
   exists because pi couldn't do audio; if transcription is missing, that's a
   bug in the roadmap, not a choice.)
3. **Machinery** — a second system the loop must keep honest: memory stores,
   schedulers, subagent fleets, MCP brokers, skill catalogs, projects, inner
   life. Out until explicitly demanded; when demanded, designed here first.

If a capability can't be classified in one sentence, the classification is
the design conversation — have it before building.

Read-only diagnosis returned on demand as Doctor; it does not return
proactive monitoring or authorize repair.

Still out (previously "returned on demand," each designed in its own area
where it returned): proactive monitoring, self-waking and memory nudges; a
native browser tool; a native MCP client; raw in-process OAuth; ACP;
onboarding wizard; a state-migration framework (additive memory schema
changes are in scope); in-process embeddings; a third channel; backend
registries; generic agents, recursion and timeout-revive; a second harness
for projects; self-grading skill machinery; conversation-lifecycle commands;
full multi-user. The named `allowedUsers` slice stands fenced: sandboxed
turns + standing sandbox DMs, guest persona + `search` only, memory-excluded,
no app doors, no sandbox `fetch` (`design/telegram.md` → Roles and
permissions).

## Test posture — the real change

v1 died of test-to-code ratio. **Tests guard boundaries and invariants, not
implementations:** worth a test — authority fencing, durable write semantics,
intake coalescing, auth command resolution; not worth one — that a function
calls its collaborator with the right arguments. Fakes at the two external
edges (model provider, Telegram API); no mock.module pyramids; the suite
stays smaller than `src/` — bigger is a smell to fix, not a badge.
