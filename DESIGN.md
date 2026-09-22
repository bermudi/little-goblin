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
  SOUL.md/AGENTS.md stubs, fail-loud config pointer) is the entire setup
  story — no onboarding wizard, ever.
- Telegram is the UI: long polling, topics, reactions, files, voice — **and
  Mini Apps, designed in from the start** (the process serves them over HTTP;
  see Intake & delivery).
- Goblin's machine state lives in SQLite (`bun:sqlite`, WAL); files stay
  where humans edit them — config, auth, workspace. Optional long-term
  memory lives in a separate Hindsight service backed by PostgreSQL (see
  Long-term memory). This does not migrate Goblin's conversation store.
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
  `data-attachment` part (path + metadata, no payload). Each part's
  representation — file part vs text reference (transcript first for
  speech) — is a pure function of the stored ref and the conversation's
  model: file part when the model consumes the media type and the payload
  fits the per-item inline cap, reference otherwise. Pure means stable:
  the same history under the same model materializes to the same request
  bytes every turn (see Cache stability). A `/model` switch recomputes
  representations once — legitimate, because a model switch is already a
  cold cache. Only disk failure (file gone) degrades an item that would
  have inlined, with a warn.
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
    Operator edits (SOUL.md, AGENTS.md, USER.md, skills) stay live next turn;
    they are explicit cache boundaries and log the cost they incur.
  - Every model call logs usage with the cached split
    (`cachedInputTokens`, null when the provider doesn't report) and the
    request prefix hash — cache behavior and any drift are observable in
    goblin.log. Window utilization warns as input approaches the
    catalog context limit. History compaction, when it arrives, is an
    explicit logged boundary that starts a fresh stable prefix — never
    silent eviction. (Until then history is unbounded; see non-goals.)

  Sanctioned one-time rewrites, each visible as a requestHash move in the
  log: a `/model` switch — or a catalog refresh that changes a model's
  listed modalities — recomputes attachment representations once; a fenced
  or failed turn leaves its user message unanswered, and the successor
  turn's burst-merge (Causal view) rewrites that boundary; a corrupt row's
  placeholder is a repair, not drift. Everything else that moves the hash
  is a bug.
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

Hand-rolled, zod-validated, seven:

`read_file` `write_file` `edit_file` `bash` (timeout) `speak` `schedule`
`send_file`

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

`schedule` manages standing jobs (list/create/update/delete/toggle) —
see `Scheduled work`. It is bound per-turn to the running conversation
so new jobs are pinned to the chat/topic they were born in; the model
never handles chat ids.

**Tool results are text.** Every provider goblin speaks (OpenAI-compatible
chat completions, the codex Responses shim) serializes tool results as a
string — the SDK's `toModelOutput` media-parts hook exists, but the wire
formats can't carry it, and an image sent as stringified JSON is garbage,
not vision. So tools never put image bytes in results: `read_file` sniffs
magic bytes and returns a structured note (type, dimensions when the
header carries them, size) naming the two working channels — the operator
sending the image via Telegram (intake materializes it natively for vision
models) or `bash`/`ffmpeg` for metadata work. If a provider whose tool
results carry media ever arrives, revisit this ruling — the hook is the
door.

**Bounded, self-describing output.** Read tool: line window + byte ceiling
+ per-line clamp — three ceilings because each catches a shape the others
miss (long files, wide files, minified one-liners); output stops at
complete numbered lines only, and every stop names its own recovery
(`Use offset=N`, sed fallback for a giant line, did-you-mean on a miss,
tail reads via negative offset). Bash: tail-truncation at complete lines,
UTF-8 boundary-safe, with the dropped-byte count stated — the single
exception being a final line that alone exceeds the whole budget, whose
last bytes are kept with an ellipsis prefix so a mid-line start is never
mistaken for a whole line. Special files (devices, FIFOs, sockets) are
refused before any I/O — `read_file` on `/dev/zero` is a hang, not a
read; `bash` (timeouts + output caps) is the sanctioned channel for
those.

Memory, subagent, MCP, and external-agent tools do not exist —
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

## Scheduled work (jobs)

Standing orders, on demand (2026-09-20): a job is a natural-language
prompt the operator asked for once ("every weekday at 08:30, brief me
on X") that keeps firing as an ordinary conversation turn. The design
takes openclaw's hardest lesson wholesale: **a scheduled job's
instructions are the job's state, never a workspace file** — its
HEARTBEAT.md spent years leaking into wrong scopes before being retired
into per-job state. Rulings:

- **State is rows, not files.** A `jobs` table in `goblin.sqlite`
  (own connection in `src/jobs.ts`, same WAL file): name, 5-field cron,
  prompt, the pinned Telegram address, enabled, last_run, next_run.
  Creating a job changes nothing in the workspace and nothing in any
  prompt — cache stable by construction.
- **Recurrence is cron, evaluated in the server's local timezone**
  (operator = admin; `date` via bash agrees). The model translates
  natural language → cron inside the tool call; `cron-parser`
  validates it at the boundary — an invalid expression is rejected
  before a row exists. No interval-plus-prose hybrids; prose recurrence
  is where heartbeat bugs came from.
- **A job belongs to the conversation where it was created** (chat/
  topic address pinned by the tool from the live conversation — the
  model never handles chat ids). Firing = `runtime.submit` of a user
  message `[scheduled: <name>] <prompt>` into that conversation, sink
  built like any other (voice per conversation setting). Replies land
  in that chat/topic. The lane queue orders it behind any live turn —
  no interleaving, no special execution path, epoch fencing applies.
- **Management is the `schedule` tool** (list/create/update/delete/
  toggle), zod-validated, one tool not a CLI — state mutation belongs
  behind validation and logging. Scheduled turns may use it too (a
  job deleting itself on completion is fine); every mutation logs.
  Creating or editing a job is reversible (delete restores), so it
  needs no go-ahead; what a job *does* when it fires is a normal turn
  under the same ask-first rule as any operator message.
- **The scheduler is an in-process ticker** (30s) in the runtime
  process; systemd covers crashes. A fire time missed while the
  process was down fires **once** at the next tick (boot catch-up),
  then advances to the next future occurrence — never a replay of
  every missed instance. Submit first, then markRan: a message that
  landed is history even if the turn never ran.

Still out (machinery): proactive monitoring/heartbeat (jobs are
explicit standing orders the operator asked for, not an agent that
decides to check things), cross-host schedulers, job history/audit
tables beyond last_run.

## Long-term memory

**Implementation in progress.** The optional Podman assets, validated HTTP
client, durable retention queue, and turn-loop integration (bounded recall
with persisted cache-stable blocks, retention enqueue, worker timer,
memory-search tool, `/memory` + `/forget` controls) are implemented and
tested offline. Live verification against a real Hindsight server remains
required before enabling memory.
Slice 2 rulings (below) lock the turn-integration mechanisms.
Memory returns on explicit
operator demand. Hindsight is the selected memory service, not an agent
runtime: Goblin still owns history, tools, reasoning, and Telegram delivery.
No MCP, replacement turn loop, or generic multi-backend framework.

### Slice 2 rulings (locked)

1. **Config key: `memory`.** Optional `goblin.json5` block `{baseUrl,
   bankId, auth?, recallTimeoutMs?, maxTokens?, budget?}`; absent =
   exact current behavior. `auth` names an `auth.jsonl` secret for the
   Bearer token (loopback needs none). Recall defaults: 2000ms timeout,
   1024 max tokens, `low` budget — turns must not wait on memory.
2. **Exclusions: per-topic setting, command-first.** `memoryExcluded`
   boolean on the conversation (settings-command pattern: `/memory
   on|off|status`, epoch-bumped like `/model`; mini-app toggle follows).
   Excluded topics send nothing and recall nothing — enforced in Goblin
   before any external request, for both automatic recall and the
   memory-search tool. No automatic ingestion until this control exists.
3. **Recall persistence: `memory_contexts` table, interleaved before
   the anchored user message.** Every recall outcome (results, empty,
   unavailable) is persisted verbatim keyed by `(conversation_id,
   anchor_seq)` before the model call; future turns reuse the persisted
   bytes, never regenerate. Materialize each block immediately before
   its triggering user message in the causal view, so turn N+1's request
   starts with turn N's request plus appended content. Enable/disable
   and forgetting are explicit logged cache boundaries (the prefix may reset
   there, nowhere else). Recall-context writes are working state, not
   completed-turn commits: a turn fenced after its recall may leave an
   orphan block, and its same-anchor retry replaces it under the logged
   turn-fenced boundary. Successful-turn prefixes are unaffected (a failed
   request is never anyone's prefix).
4. **Document ID: `exchange/{conversationId}/{anchorSeq}/{assistantId}`.**
   Stable per completed exchange, unique across retries; retries replay
   identical content (queue rejects same ID with different content).
5. **Degraded status: log + `/memory status`, not chat spam.** Every
   recall/worker outcome emits a structured line; `/memory status`
   reports disabled/healthy/degraded/pending with outbox counts. Model
   context distinguishes unavailable from empty via the persisted block;
   no Telegram notification per retry.
6. **Bank/mission: operator step, no auto-creation.** Goblin never
   creates banks or sets missions; `docs/memory.md` documents the manual
   `curl` with an example mission (preferences, decisions, commitments,
   people, ongoing work). Bank-level overrides stay out of Goblin.
7. **Forgetting: two commands, suppression survives everything.**
   `/forget <query>` resolves and shows affected sources;
   `/forget delete <documentId>` requires that go-ahead, then suppresses,
   cancels pending outbox rows, deletes the remote document, and redacts
   affected recall snapshots (global prefix reset, logged). Suppression
   lives in SQLite and is checked before every enqueue, so restarts and
   future backfills cannot resurrect forgotten sources.

### Deployment and configuration

Ship a portable, optional rootless Podman stack managed by Quadlet/systemd:
Hindsight plus PostgreSQL with the vector extension required by the pinned
Hindsight release. Use persistent storage, readiness checks, restart on
failure, and a private container network. PostgreSQL publishes no host port;
Hindsight's API binds to loopback. Use pinned images, not floating automatic
upgrades. Nothing assumes a particular hostname, operator home directory,
or existing database installation.

Goblin accepts a configured Hindsight base URL and bank identity; it can
use the supplied local stack or an existing service. Remote services require
an explicit operator choice and appropriate transport/authentication.
Omitting memory configuration preserves current behavior. Configuration is
validated at the boundary; credentials stay out of config examples, logs,
model context, and Goblin's inherited tool environment. Resolve Goblin-side
auth through the existing auth mechanism; keep service credentials scoped
to the containers rather than exporting them into Goblin.

Model selection belongs to the operator, not to an SDK's implicit defaults.
The requested initial setup is `glm-5.3-flash` for extraction/consolidation
and `voyageai/voyage-4-lite` for embeddings. These are requested identifiers,
not claims about Hindsight's accepted wire configuration: verify provider
support, endpoint, and exact model IDs before implementation or live calls.
Other installations select their own providers/models and credentials.
Reranking is **unresolved**: require an explicit choice or a verified
supported no-reranker mode; do not silently download or invoke a default
model. Choosing a different embedding model for an existing bank requires
an explicit compatibility/re-indexing procedure, not a hot config edit.
Self-hosted storage does not imply local processing: document which text
each configured external model service receives.

The TypeScript SDK is an HTTP client, not a requirement to run Node.
Basic retain/recall against a fake HTTP server passed with SDK 0.10.0 under
Bun 1.4.2 during planning. Real-server compatibility, cancellation,
timeouts, error handling, and document management remain release gates.
Use direct typed HTTP if necessary; do not add a Node sidecar.

### Retain: a durable projection of completed exchanges

One bank per Goblin installation/operator, shared across topics. Preserve
conversation identity, source event/message identifiers, timestamps, and
speaker attribution. An assistant suggestion is not an operator decision.
Banks are not public knowledge: an allowed Telegram sender is not proof
that everyone who can read a group is authorized to see recalled memories.
Memory-enabled delivery destinations must be operator-approved.

Start with new completed text exchanges only. No historical backfill,
attachment ingestion, raw tool output, hidden reasoning, or re-ingestion of
recall results. Bounded prior context may resolve references but must be
labelled as context rather than fresh independent evidence. Scheduled
housekeeping is not automatically a source of new personal memories.
Extraction instructions emphasize preferences, decisions, commitments,
people, and ongoing work; they guide quality, not privacy enforcement.

Commit the completed assistant event and a pending-retention record in one
SQLite transaction, under the turn's existing authority check. This is an
additive schema change and must preserve existing installations. A failed
or fenced turn cannot commit completed-turn memory. A committed exchange
is then independent background indexing work; a later epoch change does
not retroactively cancel it.

A bounded worker drains the durable queue, using a stable document ID per
exchange and replacement semantics for retries. Persist a client-generated
operation UUID before submitting asynchronous retention and reuse it after
a lost acknowledgement. Poll the operation to completion; an acknowledged
operation that disappears is blocked for operator reconciliation rather
than blindly resubmitted. Bind queued records to the original endpoint and
bank so a configuration change cannot redirect pending personal content.
Keep pending work through
restarts and retry transient failures with backoff. An HTTP acknowledgement
of asynchronous processing is not proof that retention completed: either
wait for completed retention or track the operation to its terminal state.
Permanent failures remain inspectable and reported, not silently dropped or
retried in a tight loop. Ordering must preserve source chronology where it
matters; never mutate the same document concurrently.

Indexing is eventually consistent. A turn immediately afterward in another
topic may run before the prior exchange becomes searchable. Do not delay
Telegram delivery for extraction or promise immediate cross-topic recall.

### Recall: evidence, not instructions

Before a model turn, build a bounded query from its admitted message
snapshot and recent conversational context. No additional query-generation
model initially. Recall has explicit time/search/output bounds and source
references. Also expose a validated memory-search tool for deeper searches.
Do not use Hindsight `reflect` initially: Goblin already reasons over the
evidence with its selected model.

Retrieved text is dated, potentially stale evidence, not system
instructions. Current operator statements outrank retrieved preferences;
inferred observations are not explicit requests. Keep source attribution
available for important claims rather than treating extraction as truth.

Preserve the cache invariant: store the exact bounded recall context used
by a turn and materialize it at a stable causal position near that turn's
input. Do not regenerate old recall blocks, shift them when new messages
arrive, inject changing results into the system prompt, or feed them back
to retain. Successful turns must preserve the request prefix across later
turns and process restarts; cancelled/failed-turn recovery follows the
existing logged cache-boundary rule. Memory enable/disable and intentional
forgetting are explicit logged boundaries, not accidental prefix drift.

An unavailable memory service must not stop ordinary conversation.
Distinguish unavailable recall from an empty result in model context and
operator-facing status. Log the failure, leave durable writes queued, and
report recovery without emitting a notification for every retry.

### Control, correction, and forgetting

Provide operator-facing exclusion controls before automatic ingestion is
enabled; enforce them before any external request, not through model
instructions. Topic exclusion governs both sending that topic's content
and whether shared memories may be recalled there. Enabling memory does
not silently backfill excluded or historical messages.

New dated corrections can be retained while preserving historical facts;
verify that recall distinguishes past from current state. Explicit
forgetting must first resolve and show the affected sources, then require
the operator's go-ahead before deletion. Persist source suppression, cancel
pending ingestion, and serialize against in-flight writes before deleting
remote documents and accounting for derived observations. Suppression must
survive restarts and any future backfill so forgotten sources cannot be
resurrected by retries.

Forgetting indexed knowledge is distinct from erasing original Telegram
messages or Goblin history. Explain that distinction. Stored recall
snapshots and tool results can also contain forgotten information; remove
or redact those projections and intentionally reset the affected request
prefix. Never claim complete erasure while originals, backups, or provider
retention still exist. Document that restoring an older backup can restore
forgotten data and requires suppression reconciliation before serving it.

### Operations and verification

Basic database maintenance only: leave PostgreSQL autovacuum enabled,
surface health/storage errors, and document upgrades and recovery. Backups,
retention schedules, encryption, off-machine storage, and restore drills
belong to the operator. Ship guidance on what to back up and how to restore,
not a backup scheduler. No automatic volume pruning or destructive cleanup.
Image rollback alone is not database rollback after a schema migration.

Every service boundary and queue mutation emits structured signals:
conversation/document IDs, operation, duration, result count, retry state,
and classified failures without credentials or raw memory contents.
Status must distinguish disabled, healthy, degraded, and pending work.

Tests fake external services, never invoke an unspecified model. Release
gates: cross-topic recall; dated correction; no duplicate documents on
retry; durable restart recovery; authority fencing; exclusions; forgetting
through in-flight writes and derived data; stable cached prefixes; outage
degradation; validation of a real Hindsight server under Bun. Live model
verification uses only explicitly configured models and credentials.

Borrowed mechanisms, not scope: OpenClaw's
`docs/reference/templates/AGENTS.md` supplies source-aware user directives
and supersede-in-place correction; keep USER.md for small deliberate
always-needed preferences, not a parallel automatic memory database.
Hermes' `AGENTS.md` and
`website/docs/user-guide/which-file-does-what.md` establish frozen past
context for prompt caching; apply that to persisted per-turn recall rather
than importing its session lifecycle. See also Hindsight's
[SDK](https://hindsight.vectorize.io/sdks/nodejs),
[installation](https://hindsight.vectorize.io/developer/installation),
[retain](https://hindsight.vectorize.io/developer/retain), and
[recall](https://hindsight.vectorize.io/developer/retrieval) documentation.

Implementation order: configuration/provider compatibility contract →
portable container assets and operations guidance → memory client, durable
queue, controls, and turn integration → boundary tests → explicitly
configured live verification. Reranker selection and exact provider
configuration must be resolved before the live-verification step.

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

- grammy long polling; the `allowedUsers` config key gates access first thing.
- **Coalescing buffer**: rapid-fire messages in one conversation merge into
  one turn (~1.5s quiet window). Real product value in v1; keep it.
- **Delivery**: `streamText` deltas → throttled message edits (~1/s), final
  flush on completion. Typing indicator while a turn runs. Errors post a short
  message and log structured detail.
- **TTS**: `tts: {kind: "edge", voice, rate?}` — the Edge read-aloud
  websocket service (no auth, unofficial, it can break; failures surface
  as a warn + a short chat message, never a turn failure — the 🔊 tap is
  answered immediately because Telegram expires callback queries in
  seconds and synthesis outruns them, so an outcome can't ride the
  toast). Three doors into
  the same `synthesizeSpeech`: the `speak` tool (text or file path, sent
  in-stream via the sink), a 🔊 button stamped on a completed reply's
  last bubble, and `/voice` mode (below). Input over ~10k chars is
  chunked at sentence boundaries inside the module — the cap is a sanity
  guard, never a control-flow path the model must recover from. Button
  text is stripped of the tool-status tail, code blocks, long URLs, and
  markdown before synthesis (`speakable`); tool input is already authored
  for speech. Edge's supported
  WebM/Opus stream is remuxed losslessly through ffmpeg to ogg/opus — a real
  voice-note bubble, not an audio-file card. ffmpeg is probed at boot when TTS
  is configured, and install.sh warns when it is absent.
  `record_voice` chat action runs while synthesis is in flight. The
  button voices the *whole* reply, not the tapped bubble: delivery keeps
  a bounded in-memory map of its own recent sends (chat, message id →
  full reply text — one process, one operator, no schema change), and a
  miss (restart, old message) degrades to the tapped bubble's text,
  warn-logged. No button in voice mode — the reply is already audio.
- **Files**: `send_file` is the file-out twin of intake media: it
  *names*, it does not send. The tool hands a workspace path (+ optional
  caption) to the turn's delivery sink (`sink.onFile`), which owns the
  Telegram call — so "Telegram send is delivery, not a tool" stays true
  and file sends ride the same serialized chain and authority fencing
  as text: a `/stop`'d turn can't emit one. Delivery sniffs magic bytes
  (never the extension): images go as photo previews, everything else
  as documents — except that `as_file` forces the document path
  (sendPhoto re-encodes; a document is byte-exact) and GIFs always
  ride it (sendPhoto strips animation). The file travels from disk
  (no whole-file buffering), capped at the local bot-api's 2GB upload
  ceiling.
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
  conversation-lifecycle commands — topics own that. The one exception is
  `/start`: clients fire it automatically on first open, so it gets a canned
  greeting (consumed before intake, never a model turn) and stays hidden
  from the advertised command menu.
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
    └── goblin.sqlite       # Goblin state: conversation meta, event
                            # history (UIMessage JSON rows), bindings,
                            # memory outbox/contexts/suppressions
```

SQLite durability = WAL + transactions (`synchronous=NORMAL` minimum), not
tmp/fsync/rename — that ritual is for whole-file state only. Inspectability
is an export/query command, not a format property.

## Config

`goblin.json5`: provider registry, per-conversation default model/thinking,
optional `transcription` block, optional `memory` block (absent =
memory disabled). No secrets — those live in `auth.jsonl`.

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
  memory.ts         recall contexts, retention builders, status, worker timer
                    (wire client in hindsight.ts, outbox in memory-queue.ts)
  jobs.ts           scheduled jobs — rows in goblin.sqlite, cron validated
                    at the boundary
  scheduler.ts      ticker: due jobs → turns in their pinned conversation
  runtime.ts        per-conversation queue, turn loop, checkAuthority
  agent/
    providers.ts    registry: name → AI SDK provider
    models-dev.ts   input-modality catalog (fetch, cache, backoff) — two
                    catalog fetchers live here (models.dev, openrouter);
                    the next change to either extracts one
                    fetchCachedCatalog helper and migrates both. No third
                    copy.
    codex.ts        codex OAuth provider — credentials lifecycle, wire
                    conversion, LanguageModelV2; splits into
                    codex/auth.ts + codex/model.ts when next touched
                    (external-change pressure lands on one 770-line file)
    attachments.ts  data-attachment parts + per-turn materialization
    transcribe.ts   speech → text at intake (groq whisper, more kinds later)
    tts.ts          text or file → speech (edge read-aloud ws, opus out)
    prompt.ts       system prompt assembly (shell + SOUL.md + agent-owned
                    AGENTS.md/USER.md, each capped at 8k chars; re-read
                    every turn, edits live next message)
    skills.ts       catalog scan + frontmatter validation → ## skills section
    tools/          the eight tools (read, write, edit, bash, speak,
                    schedule, send_file, memory_search)
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

memory store (returned on demand — approved in `Long-term memory`) ·
scheduler (returned on demand — designed in `Scheduled
work`; heartbeat/proactive monitoring stays out) · conversation-lifecycle
commands · subagents · delegated work · external agents · ACP · MCP ·
project environments · inner life · onboarding wizard · state
migrations (general framework; additive memory schema changes are in scope) ·
in-process embeddings (delegated to Hindsight for memory) · multi-user · history compaction (history is
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
