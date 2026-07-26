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

There is no optional writer context. Surface-backed writing requires a canonical validated SurfaceId; internal writing deliberately omits it. Main-agent event callbacks and synthetic user-visible reply paths close over the runtime capture instead of looking up the current binding. A runtime invalidated during movement can therefore only stamp its original Surface on any write still accepted by orchestration.

The transcript module remains the only JSONL parser and producer. It validates `sourceSurfaceId` without discarding otherwise readable legacy entries. Valid provenance stays attached through display extraction, logical range reads, cursor alignment, and per-entry chunking. Earlier entries are never rewritten merely because later entries come from another Surface.

### Migrate legacy files conservatively

`TranscriptProvenanceMigrator` runs after canonical Surface migration and before provenance-aware index use or Conversation lifecycle migration. It scans every non-internal transcript and computes all candidate outputs before the first write. Changed files are replaced atomically with line order and all fields preserved.

A backfill is allowed only when persisted historical evidence proves a unique event/file source. Existing valid per-entry provenance is proof. Explicit historical migration records may also be proof. These are not proof by themselves:

- a current binding;
- Conversation creation `chatId`/`topicId` metadata;
- a shared memory scope or project directory;
- an Execution Environment;
- numeric chat similarity.

Legacy `/resume` could move history without event boundaries, so stamping current state would be false precision. Unknown or invalid provenance remains absent and is reported as bounded counts without transcript content.

A file-version marker is written only after all files are processed. Atomic per-file writes make mixed generations restart-safe; rerunning preserves canonical fields and does not duplicate or reorder them.

### Purge guessed index rows before serving search

The memory schema adds nullable `memory_entries.source_surface_id`. It is populated only for validated transcript chunks. Curated memory, user memory, internal transcript material, and unresolved legacy chunks store null.

The rollout has a separate index-version marker. One SQLite transaction deletes every old transcript entry plus dependent FTS, embeddings, tags, and `memory_sources` rows, then records the new version. Startup does not enable scheduler or polling until file migration and index invalidation are current. A crash before commit leaves the old version and repeats the transaction; a crash after commit cannot expose old guessed rows.

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

**Chosen:** Backfill only from explicit historical evidence; never stamp a transcript from its current binding or creation metadata alone.

**Why:** Null provenance reduces default recall but is recoverable through explicit cross-chat search. False attribution silently leaks search results and promotes memory into the wrong scope.

### Decision: Rebuild rather than patch transcript rows

**Chosen:** Purge all old transcript index data transactionally and reuse normal sync.

**Why:** Old chunks lack line-to-Surface provenance, so in-place chat updates cannot represent moved Conversations. Rebuild reuses the canonical reader/chunker/indexer seam.

### Decision: Quarantine mixed proven light-sleep ranges

**Chosen:** A candidate spanning multiple proven MemoryScopes is `ambiguous_source_scope` unless its target is globally defined.

**Why:** First-line, current-binding, and line-count policies are arbitrary authority guesses. A later extraction can emit narrower ranges.

## File Changes

### New files

- **`src/sessions/transcript-provenance-migration.ts`** — Conservative precomputed backfill, atomic rewrites, version marker, and bounded diagnostics.
- **`src/sessions/transcript-provenance-migration.test.ts`** — Proven evidence, invalid/unknown history, no-current-binding guess, field/order preservation, and interruption fixtures.

### Transcript and agent writing

- **`src/sessions/transcript.ts` / `mod.ts`** — Add provenance-aware writer contexts, parsing status, range propagation, and chunk propagation.
- **`src/agent/mod.ts`** — Stamp event writes from the runtime capture; select internal writing explicitly.
- **`src/tg/intake.ts` and synthetic reply paths** — Supply the current runtime writer context rather than querying a binding.
- **Focused transcript/agent/intake tests** — Cover movement, synthetic replies, internal omission, malformed legacy values, and round trips.

### Memory index and search

- **`src/memory/schema.ts` / `migration.ts`** — Add nullable Surface provenance and file/index rollout markers.
- **`src/memory/store.ts`** — Replace transcript scopes with per-chunk Surface/chat values transactionally.
- **`src/memory/transcript-index.ts`** — Remove session-state chat resolution and consume transcript chunks only.
- **`src/memory/search.ts`** — Apply captured chat boundaries to provenance-derived rows while preserving explicit cross-chat/internal behavior.
- **Existing memory tests** — Cover mixed chats, null legacy rows, index purge, bounded rebuild, and deleted transcripts.

### Dreaming and startup

- **`src/memory/dreaming.ts`** — Select light/REM/deep targets from transcript/index provenance and quarantine mixed proven ranges.
- **`src/scheduler/loop.ts`** — Request light sleep by Conversation/session compatibility ID only.
- **`src/index.ts`** — Order Surface migration, transcript-file migration, index invalidation, initial sync, scheduler, and polling.
- **Dreaming/scheduler tests** — Cover moved topic promotion, legacy fallback, mixed-range quarantine, deterministic REM winners, deep preservation, and Surface-free extraction.

### Intentionally unchanged

- Surface projection, frozen summary capture, memory tool authority, and subagent inheritance are supplied by `surface-derived-memory-context`.
- Curated scope keys, public search schemas, ranking, and embedding policy remain unchanged.
- Conversation movement and binding ownership remain in `conversation-lifecycle`.
