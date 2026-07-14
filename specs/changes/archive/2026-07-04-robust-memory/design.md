# Robust Memory Design

## Architecture

Robust memory adds a background reflection pipeline beside the existing scoped `MemoryStore` rather than replacing it.

Current user-facing turns stay on the fast path:

```diagram
╭──────────╮     ╭─────────────╮     ╭────────────────╮
│ Telegram │────▶│ AgentRunner │────▶│ pi AgentSession │
╰──────────╯     ╰──────┬──────╯     ╰────────────────╯
                         │
                         │ per-turn aside
                         ▼
                   ╭────────────╮
                   │ MemoryStore │
                   ╰────────────╯
```

After `agent_end`, the runner schedules reflection without awaiting it from the Telegram response path:

```diagram
╭───────────────╮   transcript tail   ╭─────────────────╮
│ transcript    │────────────────────▶│ MemoryReflector │
│ .jsonl        │                     ╰───────┬─────────╯
╰───────────────╯                             │ candidates
                                              ▼
                                     ╭──────────────────╮
                                     │ SafetyFilter     │
                                     │ + redaction      │
                                     ╰───────┬──────────╯
                                  safe       │ rejected
                                  ▼          ▼
                         ╭────────────────╮ ╭─────────────────╮
                         │ Consolidator   │ │ quarantine.jsonl │
                         ╰───────┬────────╯ ╰─────────────────╯
                                 ▼
                         ╭────────────────╮
                         │ MemoryStore    │
                         │ add/replace    │
                         ╰────────────────╯
```

The reflection pipeline reads from `sessions/<id>/transcript.jsonl`, writes a cursor under `sessions/<id>/memory-reflection.json`, and mutates only the existing trusted memory files through `MemoryStore`. The cursor makes reflection resumable and avoids duplicate writes after restarts.

The trusted memory store remains:

- `memory/user.md`
- `memory/general/memory.md`
- `memory/topics/<chatId>/<topicId>/memory.md`
- `memory/agents/<name>/memory.md`
- `memory/archive/topics/<chatId>/<topicId>/`

This change adds only:

- `memory/quarantine.jsonl` for rejected automatic candidates.
- `sessions/<sessionId>/memory-reflection.json` for reflection progress.

### Reflection flow

1. `AgentRunner.handleEvent()` observes `agent_end` for a main session.
2. The runner queues `MemoryReflector.reflect({ sessionId, activeScope })` in a fire-and-log background promise.
3. The reflector reads the cursor and the transcript tail after the cursor.
4. Candidate extraction produces structured candidates:
   - `target`: `"user" | "memory"`
   - `category`: `profile | preference | project_fact | decision | gotcha | convention`
   - `confidence`: numeric 0–1
   - `summary`: proposed memory text
   - `source`: session id, transcript line range, source role
5. Deterministic filtering rejects secrets, credentials, sensitive identifiers, tiny fragments, procedural noise, small talk, unsupported guesses, and low-confidence candidates.
6. Safe candidates consolidate against the resolved target file. Near-duplicates update existing entries; distinct candidates append.
7. Rejected candidates write redacted previews to `memory/quarantine.jsonl` when they are unsafe, low-confidence, or review-worthy; obvious noise may be skipped.
8. Cursor advances only after the pass finishes successfully enough that every candidate in the range was either persisted, rejected/quarantined, or intentionally skipped.

## Decisions

### D1. Background reflection, not inline reflection

**Chosen:** schedule reflection after `agent_end` and do not await it from Telegram response flushing.

**Why:** Memory should improve future turns, not make the current answer feel slower or fail because reflection failed. This matches the observed problem: Goblin rarely writes memory, but the user-facing turn path already works.

**Rejected:** forcing every turn to run extraction before completing. That would make memory reliability user-visible and couple Telegram responsiveness to model/tool failures in a secondary pipeline.

**Constraint:** a memory write produced by reflection appears on the next turn only if the background pass completed before that turn's snapshot is loaded. Reflection scheduling is serialized per session: a second schedule while a pass is running coalesces into one follow-up pass instead of racing the cursor.

Specs: `AgentRunner schedules background memory reflection after completed turns`, `AgentRunner injects memory snapshot as per-turn aside`.

### D1b. First observation seeds existing sessions to transcript end

**Chosen:** when a session has no `memory-reflection.json`, the runner/reflection layer distinguishes existing history from new work by seeding the cursor to the current transcript end on first observation, before later completed turns are reflected. It does not backfill old transcript entries automatically.

**Why:** The proposal explicitly excludes automatic historical import. Without this rule, deployment would silently process old work the first time an existing topic receives a new message.

**Rejected:** starting absent cursors at line 0. That is an implicit backfill and should be a separate opt-in command if wanted later.

**Constraint:** existing useful history remains untouched until a future explicit backfill feature exists. This is safer than surprise persistence.

Specs: `Reflection cursor prevents duplicate processing`.

### D2. Main-agent-only automatic reflection

**Chosen:** automatic reflection runs only for main `AgentRunner` sessions. Subagents keep explicit memory tools but do not get background transcript reflection.

**Why:** Subagents can be speculative, adversarial, or narrow-purpose. Automatically persisting their intermediate conclusions into shared memory would increase poisoning risk. Named-agent persona memory also has different semantics: it is methodology/persona continuity, not project facts.

**Rejected:** reflecting every subagent transcript into parent memory. Too noisy and hard to attribute.

Specs: `Background reflection excludes subagent transcripts`.

### D3. Shared deterministic safety filter before any write

**Chosen:** put a shared safety/redaction module in `src/memory/safety.ts` and invoke it from both the explicit memory tool and the reflection pipeline before they call `MemoryStore`.

**Why:** Once reflection becomes automatic, storing secrets or PII is the main new risk. The same protection must cover explicit `memory_write`, otherwise the safety model has two paths with different behavior.

**Rejected:** asking the LLM judge not to persist secrets. LLM-only redaction is not reliable enough for credentials and identifiers.

**Constraint:** the deterministic filter will produce false positives. False positives from reflection go to quarantine for audit rather than trusted memory; explicit tool writes return a safety error. No runtime configuration surface is introduced in this change; the filter uses known patterns and heuristics.

Specs: `Memory safety filter rejects secrets and sensitive identifiers`, `memory tool exposes add, replace, remove`, `Quarantine stores rejected memory candidates outside snapshots`.

### D4. Markdown metadata inside entries, no sidecar database

**Chosen:** reflection-written entries embed metadata in the entry text itself, preserving the existing `\n§\n` delimiter model.

Example entry shape:

```md
<!-- memory: category=decision confidence=0.86 created_at=2026-07-03T00:00:00.000Z updated_at=2026-07-03T00:00:00.000Z source_session=s_123 updated_source_session=s_456 source_role=user -->
User prefers terse engineering summaries with command/test evidence.
```

**Why:** This keeps memory human-readable, git-diffable, and compatible with the existing store. Legacy entries need no migration; the snapshot can inject both legacy and metadata-bearing entries as plain Markdown.

**Rejected:** JSONL records or SQLite tables as the source of truth. They would improve structured querying but add a new storage model before Goblin has enough memory volume to justify it.

Specs: `Memory entries carry provenance metadata`.

### D5. Cursor under session directory

**Chosen:** store reflection progress in `sessions/<sessionId>/memory-reflection.json`.

**Why:** Transcript ownership is session-local, and the cursor should archive/delete with the session. The memory repo should contain remembered facts, not processing state for every conversation.

**Rejected:** one global reflection cursor file in `memory/`. It would mix operational state into the trusted memory repo and complicate session archival.

**Constraint:** cursor writes need an in-process per-session guard so two async reflection passes cannot process the same range concurrently.

Specs: `Reflection cursor prevents duplicate processing`.

### D6. Consolidation before append

**Chosen:** the reflector compares candidates against the target file and prefers replace/rewrite for near-duplicates or updates. On update, `created_at` and the original `source_session` stay stable, `updated_at` changes, and the latest observing session is recorded as `updated_source_session`.

**Why:** The current store's cap is intentionally small. A robust system must keep memory dense rather than slowly filling with stale variants.

**Rejected:** append-only automatic memory. It is simpler, but it makes the 4000/2000 char caps a time bomb and worsens context noise.

Specs: `Reflection candidates consolidate with existing entries`.

### D7. Quarantine is audit-only, not retrieval

**Chosen:** `quarantine.jsonl` is never injected and never returned by memory read/index tools.

**Why:** Quarantine may contain redacted traces of secrets or low-confidence material. It is useful for debugging and future review, not for model context.

Specs: `Quarantine stores rejected memory candidates outside snapshots`.

## File Changes

### `src/memory/safety.ts` (new)

Defines the deterministic memory safety filter:

- `checkMemorySafety(content, opts): SafetyResult`
- `redactPreview(content): string`
- secret/PII regexes and heuristic checks

Used by explicit tools and reflection. Covers `Memory safety filter rejects secrets and sensitive identifiers` and the modified `memory tool exposes add, replace, remove` requirement.

### `src/memory/safety.test.ts` (new)

Covers token/private-key/password/cookie rejection, safe preference acceptance, redacted previews, and description safety checks.

### `src/memory/quarantine.ts` (new)

Appends JSONL records to `$GOBLIN_HOME/memory/quarantine.jsonl` using atomic-ish append semantics consistent with existing JSONL helpers. Records contain timestamp, target scope tag, source session, category, reason, and redacted preview.

Covers `Quarantine stores rejected memory candidates outside snapshots`.

### `src/memory/quarantine.test.ts` (new)

Asserts quarantine writes redacted records and that snapshot/index helpers ignore quarantine.

### `src/memory/entry.ts` (new)

Small parser/formatter for metadata-bearing entries without changing the store delimiter logic:

- `formatReflectedEntry(metadata, text)`
- `parseEntryMetadata(entry)`
- `stripEntryMetadata(entry)`

Covers `Memory entries carry provenance metadata` and supports consolidation tests.

### `src/memory/reflector.ts` (new)

Owns the reflection pipeline:

- read cursor + transcript tail,
- extract deterministic candidates,
- run safety filter,
- consolidate and write through `MemoryStore`,
- quarantine rejects,
- advance cursor.

Covers `AgentRunner schedules background memory reflection after completed turns`, `Reflection cursor prevents duplicate processing`, `Reflection uses scoped memory context`, and `Reflection candidates consolidate with existing entries`.

### `src/memory/reflector.test.ts` (new)

Uses temp homes and mocked candidate/judge functions to verify cursoring, safe writes, rejected quarantine, duplicate consolidation, and retry-on-failure behavior. Avoids live model calls.

### `src/memory/store.ts` (modified)

No filesystem rewrite. Add a narrow exported helper if needed for entry splitting or target scope tags, but keep existing public mutations. The safety filter should be enforced by tool/reflection callers; if implementation finds a lower central point in `MemoryStore.mutate()` that can preserve `remove` semantics, prefer central enforcement there.

Covers explicit write safety and keeps `Atomic writes` / `Git-backed versioning` unchanged.

### `src/memory/tool.ts` (modified)

Run `checkMemorySafety` before `add`, `replace`, `rewrite`, and `set_description`. Return the safety error through the existing tool error path without writing.

Covers modified `memory tool exposes add, replace, remove`.

### `src/memory/snapshot.ts` (modified)

Add guardrail text immediately after `[goblin memory snapshot]`, e.g. memory may be stale/incomplete and current context overrides it. Do not include quarantine data.

Covers `Snapshot marks memory as auxiliary and possibly stale`.

### `src/agent/mod.ts` (modified)

Instantiate or receive a `MemoryReflector`. On `agent_end`, schedule reflection for main sessions with current `sessionId`, `activeScope`, and home. Use fire-and-log error handling so reflection failures do not crash the turn.

Covers `AgentRunner schedules background memory reflection after completed turns`.

### `src/agent/mod.test.ts` (modified)

Add tests that main-agent `agent_end` schedules one reflection pass, `followUp()` does not schedule an independent pass, reflection writes are visible in the next snapshot, and reflection errors are logged without rejecting the prompt path.

### `src/subagents/execution.ts` (unchanged or test-only confirmation)

No implementation change expected. Subagent execution should not import or instantiate `MemoryReflector`.

Covers `Background reflection excludes subagent transcripts`.

### `src/subagents/test/memory.suite.ts` (modified)

Add an assertion that subagent `agent_end` does not schedule reflection and named-agent persona memory changes only via explicit `memory_write`.

### `specs/backlog.md` (modified)

Remove the graduated backlog item for PII redaction in memory writes once this change lands.
