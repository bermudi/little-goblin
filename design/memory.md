# Long-term memory — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Long-term memory

**Implemented; live-verified 2026-09-24** on the homelab box against the
real Podman stack (0.10.0-slim). Verified by live traffic that day:
retention end-to-end (queued exchanges drained through submit → async
operation → completed), recall answering with real extracted facts,
installer start, and the watch timer firing on schedule. The 2026-09-25
reboot closed the boot-path gate in production: db and api units
auto-started within a minute of boot — the wants-symlink → generator
path survived contact with a real restart (`systemctl --user is-enabled
goblin-memory-api` reads `generated`; the symlink is the evidence, not
that command). On 2026-09-27, four synthetic exchanges across three named
private Telegram topics exercised cross-topic recall and a dated correction
with the operator-selected `glm-5.3-flash`: the fresh topics' persisted
recall blocks cited the source topic, the recall reply gave the prior
value, and the correction reply distinguished current from prior and
included the date. All four replies were visible in Telegram and all four
retention operations completed. With the queue idle, a
controlled API restart returned healthy with unchanged queue state; a
watch tick against a healthy API left its service invocation unchanged.
In a later drill that day, pausing only the API process made its running
container genuinely `unhealthy` after four failed probes. The scheduled
watch restarted that unit, not the database; the new container became
healthy and readiness returned HTTP 200. A separate synthetic retention
operation was acknowledged as `pending` remotely when the API restarted:
Goblin submitted it once, kept the same operation ID, and later marked it
completed with a stored document. Two attempts to catch an operation in
`processing` finished before the probe could observe that state; active
extraction interrupted by a restart is therefore **not verified**.
First live finding: z.ai 429
"insufficient balance" during extraction blocks a single document for
operator reconciliation (the designed path, not a crash) — provider
credit is a live dependency of retention.
Slice 2 rulings (below) lock the turn-integration mechanisms.
Memory returns on explicit
operator demand. Hindsight is the selected memory service, not an agent
runtime: Goblin still owns history, tools, reasoning, and Telegram delivery.
No MCP, replacement turn loop, or generic multi-backend framework.

### Slice 2 rulings (locked)

1. **Config key: `memory`.** Optional `goblin.json5` block `{baseUrl,
   bankId, auth?, recallTimeoutMs?, maxTokens?, budget?}`; absent =
   exact current behavior. `auth` names an `auth.jsonl` secret for the
   Bearer token (loopback needs none). Recall defaults: 5000ms timeout,
   1024 max tokens, `low` budget — turns must not wait on memory.
   (Timeout raised 2026-10-02: measured cold recall is ~2.3–2.7s — the
   remote embedding leg re-colds within ~8s of idle, so every chat turn
   pays it; 2s silently disabled recall on every cold turn rather than
   bounding the wait.)
2. **Exclusions: per-topic setting, command-first.** `memoryExcluded`
   boolean on the conversation (settings-command pattern: `/memory
   on|off|status`, epoch-bumped like `/voice`; mini-app toggle follows).
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
   no Telegram notification per retry. Amendment (2026-09-24): the ruling
   covers per-retry spam, not silence — a retention chain that cannot
   drain for a continuous hour earns exactly ONE notice per episode,
   sent to the conversation whose exchange is stuck (episode state in
   SQLite, `memory_outage`; a failed send retries on the next worker
   failure; any successful advance clears the episode silently). The
   amendment exists because the stack's boot-enablement gap (below) left
   goblin retrying a dead port for a full day with no one the wiser.
   Amendment (2026-09-25): blocked retention is not an outage — the
   service answered — and it surfaced nowhere in chat while a 429 storm
   left a document stuck for hours. A document's first transition into
   `blocked` earns ONE notice per document (latch in SQLite,
   `memory_blocked_notices`), naming `/memory retry` and `/memory
   dismiss`; everything after the first notice is `/memory status`
   territory. The mini app's Memories tab renders the same status as a
   read-only card (`GET /api/memory-status`, same auth as every other
   endpoint, polled only while the tab is open) — the status panel
   never mutates the queue. Forgetting later grew a UI surface
   (ruling 8); retry and dismiss stay Telegram verbs. Retry mints a FRESH operation id — Hindsight holds the old
   op terminally failed server-side, so replaying it just re-reads the
   dead op's status (the live hand-requeue that failed); dismiss keeps
   the row as `dismissed` for audit, and `/forget delete` cancels
   blocked and dismissed rows too.
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
   Amendment (2026-10-08, #87): forgetting is destination-aware. The
   outbox binds rows to the endpoint+bank target hash, and that hash is
   one-way — after a destination change, the bank that owns a row could
   not be addressed again, so `/forget delete` polled old-bank UUIDs
   against the new bank (a bank-scoped 404 reads as settled), cancelled
   the old rows, deleted only in the new bank, and reported forgotten
   while the old bank kept the document and its live retention. Every
   boot now records its destination (baseUrl, bank, auth key name —
   never a token) in `memory_destinations` keyed by the target hash;
   the protocol settles each destination's in-flight operations and
   deletes the document through every destination the outbox names,
   plus the current one. A destination the history cannot reconstruct
   (rows predating the table) refuses the forget outright with all
   tracking preserved — old-bank rows are never silently cancelled on
   a new-bank delete. Suppression stays bank-agnostic. Pending rows
   against a previous bank still never drain through the current worker
   (the binding rule above); forgetting is their reconciliation path.
8. **Memories browser: the mini app grows a Memories tab (operator ask,
   2026-09-30).** The settings page restructures to two tabs — Settings
   (the six config sections one level deep behind an index; settings
   stays the default view) and Memories (status card + browser). The
   browser reads and forgets through goblin's own endpoints
   (`GET /api/memory/documents[/<id>]`, `DELETE …/<id>`), never through
   Hindsight directly — the service stays invisible to the page. Reads
   are paginated documents (one per retained exchange, filterable by
   the bank's id-substring `q` — filter-only by ruling: "what do you
   remember about X" belongs to recall in chat, not a second recall
   box) plus a document's facts and original text; invalidated facts
   render dimmed so corrections are visible. Forgetting is the one
   mutation: the route runs the same protocol as `/forget delete` —
   quiesce, settle in-flight retention, suppress, cancel, delete,
   redact — extracted into one owner (`src/memory-forget.ts`) that
   both surfaces call, with a confirm dialog as the go-ahead. The
   command's issuing-conversation fence stays in the command; the
   cross-conversation recall-in-flight window it already tolerates is
   the browser's window too (suppression persists, so re-running
   forget is the recovery). All three routes share the status gate:
   boot-time destination or degrade to an operator-facing reason
   ("restart to apply"), never a read or delete against a stale bank.

### Deployment and configuration

Ship a portable, optional rootless Podman stack managed by Quadlet/systemd:
Hindsight plus PostgreSQL with the vector extension required by the pinned
Hindsight release. Use persistent storage, readiness checks, restart on
failure, and a private container network. PostgreSQL publishes no host port;
Hindsight's API binds to loopback. Use pinned images, not floating automatic
upgrades. Nothing assumes a particular hostname, operator home directory,
or existing database installation. The stack is boot-enabled
(`[Install]` + `WantedBy=default.target` on the API unit; the database
rides along via `Requires`/`After`) like goblin itself — the installer's
cost confirmation gates the first start, not every reboot. The original
"operator starts it explicitly" ruling died the first nightly shutdown:
the box went down, goblin came back with memory on, the stack did not,
and the bot quietly retried a dead port for a day. Health probes gate
startup (`Notify=healthy`) but are write-only after it —
`Restart=on-failure` only sees process death — so a systemd user timer
(`goblin-memory-watch`, 5 min) turns an `unhealthy` container report
into a unit restart; a stopped or absent stack is a deliberate operator
choice and stays stopped.

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

Setup is installer-driven (`deploy/memory/install.py`), overruling the
earlier "operator setup, not automatic" stance. An installer that *asks*
preserves the deliberation the manual flow was protecting: every provider,
model, and key choice is an explicit prompt (hidden input for secrets), the
launch guard validates the assembled configuration before anything is
written, the database password is generated locally and never printed, and
stack start carries its own cost warning. Deliberation lives in the
questions, not in copy-paste friction.

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

**Reflect stays declined (reaffirmed 2026-10-06, after revisit).** The
original one-line rationale undersold the decision. Hindsight `reflect` is
not consolidation — it is an agentic reasoning loop inside the service:
a question in, a disposition-shaped prose answer out, up to ten tool
iterations under the bank's mission, disposition traits, and directives.
Goblin declines it for the same reason it declines a replacement turn
loop: Goblin owns reasoning, and recalled text must stay dated evidence,
not a second engine's conclusions. The feature that makes reflect
attractive elsewhere — curated precomputed answers ("mental models") —
is already Goblin's workspace-file territory (SOUL.md/AGENTS.md), by
design.

**Consolidation is live, and it is Hindsight's, not Goblin's (recorded
2026-10-06; it had never been ruled on).** The deployed bank runs
auto-consolidation with observations (both observed `true` on the live
bank config) and holds synthesized, deduplicated beliefs that are
refined — not overwritten — when new evidence arrives: contradictions
capture the evolution ("previously X, now Y"), near-duplicates reconcile
at the default 0.97 cosine threshold, and delete/update/retain trigger
consolidation server-side. Recall returns observations by default —
Goblin sends no `types` filter and the wire default is all fact types
including `observation` — so observations are already recall evidence
under the existing rules: dated, sourced, outranked by current operator
statements. Goblin's own projection stays append-only; the converging
layer belongs to the service. Unresolved follow-ups from the revisit:
(1) `prefer_observations` (recall flag, default false) would drop raw
facts superseded by a returned observation and backfill the freed token
budget — recommended, but it changes what the model sees, so it waits
for an explicit operator decision; (2) `/forget delete` removes source
documents, but whether delete-triggered consolidation reconciles the
observations derived from those facts is unverified — Goblin's code has
no observation handling anywhere (the word appears in no src file), so
forgotten facts may survive as derived beliefs until a synthetic
retain → consolidate → delete → observation-recall drill verifies the
cascade. Observations are also a redaction surface the forget protocol
does not yet account for.

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

**Exclusion is per-event and stamped at append time (amendment 2026-10-08,
issue #85).** The live topic flag is a hard gate while set; eligibility for
the future is decided once, at the moment an event is admitted — every
event row carries whether its conversation was excluded then. Memory-bound
builders (the recall query, the retention document's burst and prior
context, its source ids) read that stamp through a separate projection of
history, never the live flag, so lifting the gate cannot retroactively ship
what was written under it. Ordinary history, the model view, and chat
search are untouched: exclusion governs what leaves for the memory
service, not what the conversation itself holds. Rulings on the edges:
steered-in messages carry their own append-time stamps (a steer submitted
after a mid-turn `/memory off` is stamped excluded, and the epoch bump
fences the running turn before it could retain anything); fenced and
failed turns commit no memory regardless of stamps; a compaction summary
is derived text and inherits its folded span's eligibility — eligible only
when every event below the boundary (causal position, the same key the
model view cuts on) was eligible, a property recomputed per pointer so
repeated compactions stay consistent; spin-off forks copy stamps verbatim.
Events that predate the stamp are historical by the main rule: they are
ineligible, and new eligibility accrues only from new exchanges.

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

