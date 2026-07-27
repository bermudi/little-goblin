# transcript-surface-provenance — Design

## Architecture

### Bind provenance to the transcript writer

`surface-derived-memory-context` gives each user-visible runtime an immutable `sourceSurfaceId`. The transcript seam turns that fact into event-time provenance:

```ts
type TranscriptWriterContext =
  | { kind: "surface"; sourceSurfaceId: SurfaceId }
  | { kind: "internal" };

interface TranscriptEntry {
  // existing fields
  sourceSurfaceId?: SurfaceId;
}
```

There is no optional writer context. Surface-backed writing requires a canonical validated SurfaceId; internal writing deliberately omits it. `AgentRunner` derives and freezes this context from `CapturedMemoryContext.authority.sourceSurfaceId` before registration; an `InternalMemoryContext` selects the separate internal context. Main-agent event callbacks pass that frozen context directly to the transcript module. Intake and command synthetic-reply paths receive the current runner (or its writer context) rather than a Conversation ID or binding reader. If user-visible delivery has no current runner context, it is delivered but not appended to transcript JSONL; it emits a bounded `no-transcript-writer-context` signal. Callers never manufacture provenance by creating a runtime or reading a later binding. A runtime invalidated during movement can therefore only stamp its original Surface on any write still accepted by orchestration.

The transcript module remains the only JSONL parser and producer. It exposes normalized typed entries to ordinary readers and a named migration-only lossless-record operation to `TranscriptProvenanceMigrator`; ordinary readers, indexers, dreaming, commands, and intake cannot import that operation. A static boundary test enforces that restriction. A normalized entry exposes `sourceSurfaceId` only when the raw field is a canonical valid SurfaceId; absent, non-string, malformed, unknown-version, or non-canonical values leave typed provenance unavailable without discarding otherwise readable text or fields. An unchanged raw record is re-emitted byte-for-byte. A rewrite preserves every raw field, including an invalid `sourceSurfaceId`; migration may add proven provenance only when the field was absent, never replace invalid input with a guess. Valid typed provenance stays attached through display extraction, logical range reads, cursor alignment, and per-entry chunking. Earlier entries are never rewritten merely because later entries come from another Surface.

### Migrate legacy files conservatively offline

`TranscriptProvenanceMigrator` implements filesystem migration step 3 in the canonical append-only list owned by `src/migrate.ts`, advancing `CURRENT_STATE_VERSION` from 2 to 3 only after success. It runs only through explicit `bun run migrate` while the service is stopped, after canonical Surface and execution-environment migration and before the Conversation lifecycle migration step. It scans every non-internal transcript and computes and validates all candidate outputs before the first write. Changed files are replaced atomically with line order and all fields preserved.

A backfill is allowed only when persisted historical evidence proves a unique event/file source. In this deployment the only such evidence is an entry's own existing valid per-entry `sourceSurfaceId`; no named historical-evidence store exists, and legacy `SessionState` carries only creation-time `chatId`/`topicId`, which is explicitly insufficient. These are not proof by themselves:

- a current binding;
- Conversation creation `chatId`/`topicId` metadata;
- a shared memory scope or project directory;
- an Execution Environment;
- numeric chat similarity.

Legacy `/resume` could move history without event boundaries, so stamping current state would be false precision. Unknown or invalid provenance remains absent and is reported as bounded counts without transcript content. Introducing a named historical-evidence store is out of scope and would be a separate change; until then the step preserves valid provenance and leaves everything else null.

The canonical migration command owns the pre-mutation backup and advances `stateVersion` only after the complete step succeeds. The step has no independent completion marker and is not required to accept mixed-generation files, restart after partial writes, or converge idempotently. Failure recovery restores the command's backup under decision 0038.

### Purge guessed index rows before serving search

The memory schema adds nullable `memory_entries.source_surface_id`. It is populated only for validated transcript chunks. Curated memory, user memory, internal transcript material, and unresolved legacy chunks store null.

The rollout has a separate SQLite index-version marker. After startup's filesystem `stateVersion` gate proves the offline transcript step completed, one memory-schema transaction deletes every old transcript entry plus dependent FTS, embeddings, tags, and `memory_sources` rows, then records the new index version. Startup does not enable scheduler or polling until that transaction and bounded initial sync complete. A crash before commit leaves the old database version and repeats the transaction; a crash after commit cannot expose old guessed rows. This transactional database migration remains governed by the decision-0038 SQLite exception, not by filesystem migration rules.

Normal bounded sync rebuilds the index. For each transcript entry:

```text
sourceSurfaceId ── parseSurfaceId ──► Surface.chatId ──► memory_entries.chat_id
       │
       └──────────────────────────────────────────────► source_surface_id
```

Replacement is still atomic per `transcript/<conversationId>` scope, but its chunks may carry different SurfaceIds and chat IDs. Provenance-null chunks get `chat_id = null`. FTS keeps only the existing chat filter; full Surface provenance remains in `memory_entries` and is read through joined IDs.

Captured Surface callers retain default same-chat search. Null/other-chat chunks are excluded unless `all_chats = true`; explicit Surface-free internal transcript search also retains accepted all-chat access.

### Derive dreaming targets from candidate sources

Light sleep receives only a Conversation/session compatibility ID. It reads provenance-aware `TranscriptLine` ranges and projects valid source Surfaces through the shared memory scope conversion:

- exactly one proven MemoryScope in the candidate range → promote there;
- no proven scope → decision 0025 fallback to `general`;
- several conflicting proven scopes → quarantine as `ambiguous_source_scope` rather than selecting a current binding;
- `target = "user"` → remains global;
- internal extraction proposing `target = "agent"` → reject/quarantine because it has no named caller authority.

REM reads stored `source_surface_id`. For each concept, a Conversation contributes at most once to each projected source scope; chunk volume must not manufacture additional origins. The accepted winner is highest distinct-origin count, then latest update, then scope name. Provenance-null origins do not invent a topic and fall back to `general` when no proven winner exists. Deep sleep preserves the already selected scope of short-term rows.

The model invocation remains only an extraction vehicle. It uses the dependency's explicit internal context, receives no Surface authority, and never turns the `chatId: 0` compatibility sentinel into provenance or a promotion target.

## Decisions

### Decision: Store full SurfaceId beside derived chat ID

**Chosen:** Add nullable `source_surface_id` to `memory_entries`; retain `chat_id` as the existing search filter derived from it.

**Why:** Chat ID alone loses topic/container provenance needed by dreaming. Duplicating SurfaceId in FTS adds synchronization cost without a query need.

### Decision: Unknown history remains unknown

**Chosen:** Preserve existing valid per-entry provenance; never stamp a transcript from its current binding or creation metadata alone. In this deployment no other historical-evidence source exists, so legacy entries without proven provenance stay null with bounded unknown counts.

**Why:** Null provenance reduces default recall but is recoverable through explicit cross-chat search. False attribution silently leaks search results and promotes memory into the wrong scope. A named evidence store could be introduced later, but inventing one now would be speculative.

### Decision: Rebuild rather than patch transcript rows

**Chosen:** Purge all old transcript index data transactionally and reuse normal sync.

**Why:** Old chunks lack line-to-Surface provenance, so in-place chat updates cannot represent moved Conversations. Rebuild reuses the canonical reader/chunker/indexer seam.

### Decision: Quarantine mixed proven light-sleep ranges

**Chosen:** A candidate spanning multiple proven MemoryScopes is `ambiguous_source_scope` unless its target is globally defined.

**Why:** First-line, current-binding, and line-count policies are arbitrary authority guesses. A later extraction can emit narrower ranges.

## File Changes

### New files

- **`src/sessions/transcript-provenance-migration.ts`** — Conservative precomputed offline backfill step, atomic rewrites, and bounded diagnostics, registered by the canonical migration runner.
- **`src/sessions/transcript-provenance-migration.test.ts`** — Existing valid provenance preserved, invalid/unknown history left null with bounded counts, no-current-binding guess rejected, complete output, conflicts, and field/order preservation.

### Transcript and agent writing

- **`src/sessions/transcript.ts` / `mod.ts`** — Add provenance-aware writer contexts, normalized typed parsing, migration-only lossless raw records, range propagation, and chunk propagation.
- **`src/agent/mod.ts`** — Freeze writer context from runtime capture, stamp event writes from it, and select internal writing explicitly.
- **`src/tg/intake.ts` and synthetic reply paths** — Supply the current runtime writer context rather than querying a binding; deliver but do not append when no context exists.
- **`src/commands/voice.ts`** — Replace direct transcript JSONL parsing with the transcript module's display-text reader.
- **Focused transcript/agent/intake tests** — Cover movement, synthetic replies, no-runner non-append signals, internal omission, malformed legacy values, lossless raw round trips, and chunk propagation.

### Memory index and search

- **`src/memory/schema.ts` / `migration.ts`** — Add nullable Surface provenance and one transactional SQLite provenance-index version marker; filesystem completion is represented only by canonical `stateVersion`.
- **`src/memory/store.ts`** — Replace transcript scopes with per-chunk Surface/chat values transactionally.
- **`src/memory/transcript-index.ts`** — Remove session-state chat resolution and consume transcript chunks only.
- **`src/memory/search.ts`** — Apply captured chat boundaries to provenance-derived rows while preserving explicit cross-chat/internal behavior.
- **Existing memory tests** — Cover mixed chats, null legacy rows, index purge, bounded rebuild, and deleted transcripts.

### Dreaming, migration, and startup

- **`src/memory/dreaming.ts`** — Select light/REM/deep targets from transcript/index provenance and quarantine mixed proven ranges.
- **`src/scheduler/loop.ts`** — Request light sleep by Conversation/session compatibility ID only.
- **`src/migrate.ts` / `src/state-version.ts`** — Register transcript-file step 3 after execution-environment migration, set `CURRENT_STATE_VERSION = 3`, and test migration from version 2; `src/index.ts` retains the state-version gate and orders SQLite index invalidation, initial sync, scheduler, and polling.
- **Dreaming/scheduler tests** — Cover moved topic promotion, legacy fallback, mixed-range quarantine, deterministic REM winners, deep preservation, and Surface-free extraction.

### Intentionally unchanged

- Surface projection, frozen summary capture, memory tool authority, and subagent inheritance are supplied by `surface-derived-memory-context`.
- Curated scope keys, public search schemas, ranking, and embedding policy remain unchanged.
- Conversation movement and binding ownership remain in `conversation-lifecycle`.
