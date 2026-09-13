---
role: contract
owns: private-reflection
---

# Private Reflection

Status: target contract for Litespec issue #67 (`litespec/private-reflection`). This is the
first bounded implementation of decision 0035, not the frozen v1 inner-life plan.
It replaces light-sleep model extraction only. REM, deep sleep, transcript sync,
heartbeat, and user-facing turns retain their existing behavior.

## Requirements

### Requirement: Durable, bounded wake ownership

Before model execution, the deployment-owned inner-life host SHALL persist a
schema-validated version-1 wake under
`$GOBLIN_HOME/state/inner-life/wakes/<wakeId>.json`. The record includes stable
identity, source Conversation and cursor window, immutable bounded transcript
input with event-time provenance, code-selected profile ID/version, creation
time, lifecycle state, attempt count, accepted intents, and effect outcomes.
Records use mode-preserving tmp/fsync/rename replacement and exclusive initial
reservation. Only the wake store writes these records; path helpers own paths.
Unknown versions, invalid records, and non-ENOENT errors fail loudly.

One wake owns one light-sleep batch; it is not a Conversation, Surface, delegated
run, or Execution Environment. Input is capped at 256 KiB of UTF-8 serialized
transcript data; existing configured line batching and lookback still apply.
Oversize input is a recorded failure, never silent truncation. Terminal records
and effect receipts are retained in this first slice; no automatic deletion or
operator reset is introduced.

#### Scenario: Reservation precedes reflection

- WHEN overlapping light-sleep triggers select the same unread window
- THEN one durable wake is reserved before any model call and only one reflection runs.
- AND a failed reservation prevents model execution.

### Requirement: Extractive facts with no ambient authority

The version-1 private-facts profile SHALL permit only fact proposals or an empty
result, using the operator's existing deployment model selection without a
fallback model. Each invocation is isolated from conversation history, workspace
prompts, skills, MCP, and all tools, including built-in shell/file tools. It has
no Telegram destination or contact authority. The host bounds each invocation
to 120 seconds, output to 64 KiB, accepted facts to 32, and fact text to 2,000
characters. A strict, versioned schema rejects unknown fields and other effect
kinds. No provider call is needed in automated verification.

Each fact SHALL cite one user-role line in the captured input and preserve a
nonempty contiguous verbatim excerpt of that line as its stored text. The model
may select facts but cannot paraphrase them in this slice. Classification as a
fact remains a model judgment; quotation proves source support, not truth.
Invented wording, non-user sources, and out-of-window citations are rejected.
Existing safety, confidence, procedural-noise, and provenance checks still apply.
Only existing memory/user targets are eligible; named-agent writes are denied.

#### Scenario: Supported text, not inferred text

- WHEN the input says "I live in Madrid" and the model proposes that exact excerpt
- THEN it is eligible for code validation and memory policy checks.
- WHEN the model instead proposes "I speak Spanish" or cites assistant/tool text
- THEN no memory effect is accepted for that proposal.

### Requirement: Transactional memory effects

MemoryStore SHALL own application of validated fact effects. A stable wake/effect
key and payload identity identify each attempt. The memory mutation and its
canonical outcome receipt commit in one SQLite transaction, including updates
to an existing near-duplicate; replay returns the prior outcome without repeating
the mutation. Reusing a key with different input fails. Accepted intents are
persisted in the wake before entering MemoryStore. Scope derives from captured
event-time provenance under decisions 0025 and 0037, never the current binding.
Budget, safety, confidence, and duplicate policy remain enforced; only the
extractive fact category is newly admitted by this profile.

Receipt persistence does not make filesystem artifacts or embedding requests
part of the SQLite transaction. Their failures SHALL be observable without
rolling back or repeating committed memory. A retried diary/quarantine append
may duplicate an artifact line and must carry the effect identity; canonical
memory and receipts do not duplicate. Current artifact retention remains intact.

#### Scenario: Crash after memory commit

- WHEN memory and its receipt commit but the process stops before the wake records success
- THEN recovery reads the receipt and completes the effect without adding a second row or reapplying an update.
- AND an unavailable embedding service cannot turn that committed effect into a new mutation.

### Requirement: Bounded recovery before admission

Startup SHALL validate and reconcile current-version wake records before new
wakes or Telegram polling are admitted. Interrupted reflection retries the same
captured input with at most three persisted attempts in total. Accepted intents
are replayed through their stable receipts rather than regenerated. Exhausted
reflection or infrastructure failure remains explicitly failed, does not advance
the source cursor, and is not silently replaced by another wake for the same
window. Explicit policy rejections are completed outcomes, not infrastructure
success disguises. Cursor advancement follows all terminal policy outcomes and
can be replayed without moving backward or consuming later transcript entries.
No distributed exactly-once claim is made for model calls or audit artifacts.

#### Scenario: Repeat restart

- WHEN the process stops at reflection, effect commit, wake update, or cursor update boundaries
- THEN repeated restart converges on recorded outcomes with no duplicate memory or skipped accepted facts.
- AND a corrupt wake or unreadable receipt prevents admission rather than being treated as absent.

### Requirement: Existing scheduling, separate execution

Existing light-sleep triggers SHALL enter one deployment-owned inner-life host,
not dispatch an internal conversation turn. The host owns in-flight work and
shutdown fencing; each reflection has a wake/attempt lifetime. Stop closes
admission, cancels model work, and disposes its resources within a bounded period;
late output cannot write memory. New transcript lines wait for a later finite
snapshot. Existing fresh-cursor seeding, lookback warnings, batch draining,
per-Conversation serialization, and coordination with REM/deep sleep remain.
Persisted layout changes SHALL use the offline versioned migration mechanism,
preserve existing cursors and memory, and never replay historical internal model
sessions. Runtime startup does reconciliation, not migration.

#### Scenario: Background-only replacement

- WHEN scheduled light sleep processes a supported fact and shutdown races a later reflection
- THEN the completed fact is stored, late output has no effect, and no Conversation runtime or Telegram send is created.
- AND heartbeat, REM, deep sleep, and transcript sync keep their existing scheduling and behavior.
