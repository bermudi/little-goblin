# Long-term memory — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Long-term memory

**Implemented and live-verified** — first traffic 2026-09-24 against the
real Podman stack; the 2026-09-25 reboot closed the boot-path gate. A
z.ai 429 "insufficient balance" during extraction blocks one document
for operator reconciliation, by design, not a crash — provider credit
is a live dependency of retention. One open edge: **Unverified:** an
active extraction interrupted mid-`processing` by a restart (never
observed live). Slice 2 rulings (below) lock turn integration; memory
returns on explicit operator demand. Hindsight is the selected memory
service, not an agent runtime — Goblin owns history, tools, reasoning,
and Telegram delivery — no MCP, replacement turn loop, or generic
multi-backend framework.

### Slice 2 rulings (locked)

1. **Config: an optional `memory` block; absent = exact current
   behavior.** `auth` resolves through the existing `auth.jsonl`
   mechanism (loopback needs none). The recall timeout was raised
   2026-10-02: cold recall measured ~2.3–2.7s, and the old 2s bound
   silently disabled recall on every cold turn rather than bounding the
   wait; the remote embedding leg re-colded within ~8s of idle. That
   leg is gone with local embeddings (2026-10-09); the timeout stays as
   a bound.

2. **Exclusions: per-topic, command-first** (an epoch-bumped settings
   command; the mini-app toggle follows). Excluded topics send nothing
   and recall nothing — enforced in Goblin before any external request,
   for both automatic recall and the memory-search tool. No automatic
   ingestion until this control exists.

3. **Recall persistence: every recall outcome (results, empty,
   unavailable) is persisted verbatim before the model call and
   materialized immediately before its triggering user message** — turn
   N+1's request starts with turn N's request plus appended content;
   future turns reuse the persisted bytes, never regenerate.
   Enable/disable and forgetting are explicit logged cache boundaries
   (the prefix may reset there, nowhere else). Recall-context writes are
   working state, not completed-turn commits: a turn fenced after its
   recall may leave an orphan block, and its same-anchor retry replaces
   it under the logged turn-fenced boundary; a failed request is never
   anyone's prefix.

4. **Document identity: stable per completed exchange, unique across
   retries; retries replay identical content.**

5. **Degraded status: log + `/memory status`, plus exactly two
   notices.** One per outage episode — a retention chain that cannot
   drain for a continuous hour earns exactly one notice, to the stuck
   exchange's conversation (2026-09-24). One per document's first
   `blocked` transition (2026-09-25), naming `/memory retry` and
   `/memory dismiss` — blocked is not an outage: the service answered.
   No other Telegram notification, including per retry. Retry mints a
   fresh operation id — Hindsight holds the old op terminally failed
   server-side, so replaying it reads a dead op; dismiss keeps the row
   for audit. The mini app's Memories tab renders status read-only and
   never mutates the queue.

6. **Bank/mission: operator step, no auto-creation.** Goblin never
   creates banks or sets missions; the mission lives in code
   (`DEFAULT_MISSION` in the installer), applied at bank creation —
   bank state is never its source of truth. Bank-level overrides stay
   out of Goblin.

7. **Forgetting: two commands, suppression survives everything.**
   `/forget <query>` resolves and shows affected sources; `/forget
   delete <documentId>` requires that go-ahead, then runs one protocol:
   suppress, settle every named destination's in-flight operations,
   park the document's outbox rows, delete the remote document through
   every destination the outbox names plus the current one, and redact
   affected recall snapshots (global prefix reset, logged). Suppression
   is bank-agnostic and checked before every enqueue, so restarts and
   future backfills cannot resurrect forgotten sources.

   Every boot records its destination — baseUrl, bank, auth key name,
   never a token; a destination the history cannot reconstruct refuses
   the forget outright, all tracking preserved (2026-10-08, #87).
   Old-bank rows are never silently cancelled on a new-bank delete, and
   rows pending against a previous bank never drain through the current
   worker (Retain's binding rule) — forgetting is their reconciliation
   path.

   The park step (2026-10-08, #113): the outbox rows ARE the
   document→destination mapping, never deleted before the remote delete
   confirms. Rows park invisible to the worker — ingestion and
   blocked-review stop while suppression blocks re-enqueue — and each
   destination's rows release only after its own delete confirms;
   blocked/dismissed rows cancel under the same delete, and a failure
   leaves unconfirmed destinations parked for the retry. Retain's
   durable-operation rule applied to deletion: persist before the
   remote action, drop only after confirmation. Parked rows surface as
   degraded with `/forget delete` retry guidance; they do not drain
   automatically, and `/memory retry` does not retry deletions.

8. **Memories browser: the mini app grows a Memories tab (operator ask,
   2026-09-30).** Reads and forgets go through goblin's own endpoints,
   never Hindsight directly — the service stays invisible to the page.
   Filter-only by ruling: `q` filters documents by bank id-substring,
   but "what do you remember about X" belongs to recall in chat, not a
   second recall box. Forgetting is the one mutation, running `/forget
   delete`'s protocol through one owner both surfaces call, go-ahead
   included; the issuing-conversation fence stays in the command, and
   the browser inherits its tolerated cross-conversation recall-in-
   flight window (suppression persists, so re-running forget is the
   recovery). All routes share the status gate — boot-time destination
   or an operator-facing reason, never a read or delete against a stale
   bank. Conversation filtering must scan, filter, then paginate (the
   bank offers only SQL `ILIKE`); the document-id scheme stays server
   knowledge. It backs the PWA's per-thread sources panel
   (design/app.md → Thread sources); the global tab is unchanged.

### Deployment and configuration

A portable, optional rootless Podman/Quadlet stack, pinned images (no
floating automatic upgrades); PostgreSQL unpublished, Hindsight's API
on loopback; nothing assumes a particular hostname, operator home
directory, or existing database. The stack is boot-enabled like goblin
itself — the installer's cost confirmation gates the first start, not
every reboot (the first nightly shutdown left goblin up, memory down, a
day retrying a dead port) — and a stopped or absent stack is a
deliberate operator choice that stays stopped.

Health probes gate startup but are write-only after it (a watch timer
turns an `unhealthy` container report into a unit restart). Ruling
(2026-10-08): **healthcheck commands carry no shell metacharacters** —
quadlet `HealthCmd` passes through systemd's unit lexer and podman's
CMD-SHELL re-quoting; podman 5.4 (Debian trixie, lithium) drops a
one-liner's trailing escaped quote — every probe died with `sh:
Unterminated quoted string`, and the watch restart-looped a healthy
API, while g7's podman 6.1.3 re-quoted it correctly. Mounted scripts
survive; `python -c` one-liners do not.

Provider/model/key choices are explicit installer prompts (secrets
hidden); the launch guard validates before anything is written, and the
generated database password is never printed.

Goblin accepts a configured Hindsight base URL and bank identity — the
supplied local stack or an existing service. Remote services require an
explicit operator choice and appropriate transport/authentication.
Credentials stay out of config examples, logs, model context, and
Goblin's inherited tool environment: Goblin auth rides the existing
mechanism, and service credentials stay scoped to the containers, never
exported into Goblin.

**Model selection belongs to the operator, not an SDK's implicit
defaults.** The requested initial setup: `glm-5.3-flash` for
extraction/consolidation, `voyageai/voyage-4-lite` for embeddings.
Ruling (2026-10-09): embeddings moved to local `embeddinggemma` (host
Ollama through the embed relay) for latency; extraction unchanged.
These are requested identifiers, not verified wire configuration —
verify provider support, endpoint, and exact model IDs before live
calls. Reranking is **unresolved**: require an explicit choice or a
verified supported no-reranker mode; never silently download or invoke
a default model. Switching an existing bank's embedding model requires
an explicit compatibility/re-indexing procedure, not a hot config
edit. Self-hosted storage does not imply local processing: with local
embeddings, embedding inputs (fact text, recall queries) stay on the
box, but the extraction LLM provider still receives conversation text —
document which text each external model service receives.

The TypeScript SDK is an HTTP client, not a requirement to run Node;
use direct typed HTTP if necessary, never a Node sidecar. SDK 0.10.0
passed basic retain/recall against a fake HTTP server under Bun 1.4.2
during planning; real-server compatibility, cancellation, timeouts,
error handling, and document management remain release gates.

### Retain: a durable projection of completed exchanges

One bank per Goblin installation/operator, shared across topics, with
full provenance preserved. An assistant suggestion is not an operator
decision. Banks are not public knowledge: an allowed Telegram sender is
not proof that everyone who can read a group may see recalled memories;
memory-enabled delivery destinations must be operator-approved.

Start with new completed text exchanges only — no historical backfill,
attachment ingestion, raw tool output, hidden reasoning, or
re-ingestion of recall results. Bounded prior context may resolve
references but must be labelled context, not fresh independent
evidence. Scheduled housekeeping is not automatically a source of new
personal memories; extraction prompts guide quality, not privacy
enforcement.

**Fact language is pinned to English (ruled 2026-10-08): every fact
extracts in English regardless of conversation language; proper nouns,
product names, and quoted terms stay verbatim.** The raw document layer
keeps source language (fidelity and provenance live there); facts are
derived. One fact language keeps cross-language dedup, consolidation,
and correction-invalidation reliable (the operator mixes languages
freely); multilingual embeddings absorb the query-side cost.

**Retention text is operator speech; a stored transcript is speech, not
attachment ingestion (#111, ruled 2026-10-08).** The media exclusion
governs bytes and bare file references — content a text exchange never
had — not the operator's words. A voice or video note whose transcript
is stored in history is the completed text exchange itself — the
retention-side twin of compaction's #84 fix. Memory's text projection
(`memory/mod.ts`) therefore embeds stored transcripts with a path
reference, compaction's format; transcript-less attachments stay
dropped — no text, no speech — so an untranscribed voice note retains
nothing, not a filename.

Completed-turn memory commits under the turn's existing authority
check: a failed or fenced turn cannot commit it, and a committed
exchange is independent background indexing work — a later epoch
change does not retroactively cancel it. The durable queue drains with
replacement semantics — an HTTP acknowledgement is not proof of
completion, and an acknowledged operation that disappears is blocked
for operator reconciliation, never blindly resubmitted. Queued records
are bound to the original endpoint and bank so a configuration change
cannot redirect pending personal content; pending work survives
restarts, permanent failures stay inspectable and reported — never
silently dropped or tight-loop retried; never mutate the same document
concurrently, and preserve source chronology where it matters.

Indexing is eventually consistent: a turn immediately afterward in
another topic may run before the prior exchange becomes searchable. Do
not delay Telegram delivery for extraction or promise immediate
cross-topic recall.

### Recall: evidence, not instructions

Recall queries are bounded, built from the admitted message snapshot
and recent context — no query-generation model initially — with
explicit time/search/output bounds and source references; a validated
memory-search tool exposes deeper searches.

**On-demand reflection is approved:** cross-session investigation by
the configured service — a bounded specialist, not a replacement turn
loop (Goblin owns the final answer; automatic injection continues to
use recall). Reflection requests supporting facts (the observed 0.10.0
contract), returns synthesis separately from dated evidence, and
reports the mental models and directives that shaped it; missing
evidence envelopes are protocol failures, not successful text-only
answers. Bank disposition and directives are
service-side interpretation, never new Goblin instructions. Oversized
responses are a resource-limit failure with a narrower-question
suggestion, not a wire protocol violation; the model-facing result
stays much smaller than the evidence — if the synthesis exceeds its
share, omit it (flagged) rather than clipping a qualification or
dropping a completed investigation. Reflection outcomes are logged
separately and never change the shared recall-health latch. No new
provider/model, bank creation, automatic reflection, or instruction-
file generation; the existing service's configured LLM does the work.

**Memory quality and safety.** Completed exchanges retain full text,
not a silent prefix; Hindsight owns extraction chunking, and an
oversized retention is rejected loudly without dropping the completed
response. Context is a bounded, labelled aid, not fresh evidence.
Recognizable credentials are redacted before the durable outbox and
before recall, search, reflection, and legacy queued submissions leave
the process; pattern screening is not a secrecy guarantee, does not
rewrite history, and is not retroactive cleanup of old outbox rows or
remote storage.

Deliberate search does not inherit the automatic-recall deadline.
Score floors are an initial tunable policy, not an empirically
calibrated quality claim; recall rendering fits whole facts into a
bounded envelope with explicit omission counts rather than clipping
qualifications — a sizing estimate, not a model-specific tokenizer.

Borrowed mechanisms: the catalog-pinned Hindsight Hermes plugin 1.2.2
(`f843f173bb41f001e322cc83c917371639e47fbf`) supplies observation
preference, score-floor enforcement, and optional memory investigation;
current Hermes supplies pre-provider credential screening.

**Consolidation is live, and it is Hindsight's, not Goblin's (recorded
2026-10-06; never previously ruled on).** The deployed bank runs
auto-consolidation with observations (both observed `true` live):
deduplicated beliefs are refined — not overwritten — as evidence
arrives; contradictions capture the evolution ("previously X, now Y"),
near-duplicates reconcile at the default 0.97 cosine threshold, and
delete/update/retain trigger consolidation server-side. Recall returns
observations by default —
Goblin sends no `types` filter, the wire default is all fact types
including `observation` — so observations are recall evidence under
existing rules: dated, sourced, outranked by current operator
statements. Goblin's projection stays append-only; the converging
layer belongs to the service. Unresolved: (1) `prefer_observations`
(service default false, Goblin default true) drops raw facts
superseded by a returned observation and backfills the freed token
budget under the memory-quality ruling above; (2) `/forget delete`
removes source documents, but whether delete-triggered consolidation
reconciles their derived observations is unverified — Goblin has no
observation handling anywhere, so forgotten facts may survive as
derived beliefs until a synthetic retain → consolidate → delete →
observation-recall drill verifies the cascade; observations are also a
redaction surface the forget protocol does not yet account for.

Retrieved text is dated, potentially stale evidence, not system
instructions. Current operator statements outrank retrieved
preferences; inferred observations are not explicit requests. Keep
source attribution available for important claims rather than treating
extraction as truth.

Preserve the cache invariant: store the exact bounded recall context
used by a turn at a stable causal position — never shift old blocks
when new messages arrive, inject changing results into the system
prompt, or feed them back to retain; successful turns preserve the
request prefix across later turns and process restarts, and
cancelled/failed-turn recovery follows the existing logged
cache-boundary rule.

An unavailable memory service must not stop ordinary conversation. Log
the failure, distinguish unavailable recall from an empty result in
model context and operator-facing status, leave durable writes queued,
and report recovery without a notification per retry.

### Control, correction, and forgetting

Exclusion controls ship before automatic ingestion, are enforced
mechanically before any external request — never through model
instructions — and enabling memory does not silently backfill excluded
or historical messages.

**Exclusion is per-event and stamped at append time (amendment
2026-10-08, issue #85).** The live topic flag is a hard gate while set;
eligibility for the future is decided once, at admission — every event
row carries whether its conversation was excluded then, and
memory-bound builders read that stamp through a separate projection of
history, never the live flag, so lifting the gate cannot retroactively
ship what was written under it. Ordinary history, the model view, and
chat search are untouched: exclusion governs what leaves for the memory
service, not what the conversation holds. Edges: steered-in messages
carry their own append-time stamps (a steer after a mid-turn `/memory
off` is stamped excluded, and the epoch bump fences the running turn);
fenced and failed turns commit no memory regardless of stamps; a
compaction summary inherits its folded span's eligibility — eligible
only when every event below the boundary was eligible, recomputed per
pointer so repeated compactions stay consistent; spin-off forks copy
stamps verbatim. Events predating the stamp are ineligible; eligibility
accrues only from new exchanges.

New dated corrections are retained beside historical facts (verify
recall distinguishes past from current); suppression survives restarts
and future backfills, so forgotten sources cannot be resurrected by
retries.

Forgetting indexed knowledge is distinct from erasing original Telegram
messages or Goblin history. Explain that distinction. Stored recall
snapshots and tool results can also contain forgotten information;
remove or redact those projections and intentionally reset the affected
request prefix. Never claim complete erasure while originals, backups,
or provider retention still exist. Document that restoring an older
backup can restore forgotten data and requires suppression
reconciliation before serving it.

### Operations and verification

Basic database maintenance only: leave PostgreSQL autovacuum enabled,
surface health/storage errors, and document upgrades and recovery.
Backups, retention schedules, encryption, off-machine storage, and
restore drills belong to the operator — ship guidance, not a backup
scheduler. No automatic volume pruning or destructive cleanup. Image
rollback alone is not database rollback after a schema migration.

Every service boundary and queue mutation emits structured signals
with classified failures — never credentials or raw memory contents.
Tests fake external services, never invoke an unspecified model; live
model verification uses only explicitly configured models and
credentials.

Borrowed mechanisms, not scope: OpenClaw supplies source-aware user
directives and supersede-in-place correction — keep USER.md for small
deliberate always-needed preferences, not a parallel automatic memory
database; Hermes establishes frozen past context for prompt caching —
apply that to persisted per-turn recall rather than importing its
session lifecycle.
