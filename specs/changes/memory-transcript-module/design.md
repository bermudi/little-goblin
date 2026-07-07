# Memory Transcript Module Design

## Architecture

Today the transcript seam is implicit: `events.ts` writes, `reflector.ts` reads, and the two agree by coincidence because neither references the other's type.

```
╭──────────────╮   appendTranscriptEntry()   ╭─────────────────────╮
│ events.ts    │────────────────────────────▶│ transcript.jsonl    │
│ (writer,     │   private TranscriptEntry    │ (state/sessions/<id>)│
│  non-exported│                              ╰──────────┬──────────╯
│  type)       │                                         │ readFileSync +
╰──────────────╯                                         │ JSON.parse line-by-line
                                                         ▼
                                               ╭─────────────────────╮
                                               │ reflector.ts        │
                                               │ RawTranscriptEntry  │
                                               │ + extractText()     │
                                               ╰─────────────────────╯
```

After this change one module owns the type, the writer, and the reader:

```
╭──────────────╮                          ╭──────────────────────╮
│ events.ts    │── appendTranscript ─────▶│ transcript module    │
│ (writer only)│   (writer)               │  • TranscriptEntry   │
╰──────────────╯                          │  • appendTranscript  │
                                          │  • readTranscript    │
╭──────────────╮                          │  • extractEntryText  │
│ reflector.ts │── readTranscriptAfter ──▶│                      │
│ (reader only)│   (reader, by cursor)    ╰──────────┬───────────╯
╰──────────────╯                                     │ owns the file
                                                     ▼
                                          ╭──────────────────────╮
                                          │ transcript.jsonl     │
                                          ╰──────────────────────╯
```

The new module is the seam. Format changes touch one file; the round-trip is the test surface.

### Reader shape preserved

The reflector does not consume raw `TranscriptEntry` values — it consumes `TranscriptLine` records (`{ index, role, text, ts }`) where `text` is already extracted. The new module preserves this consumer-facing shape: `readTranscriptAfter(home, sessionId, cursor)` returns `TranscriptLine[]`, and the `extractText` logic moves into the module as `extractEntryText(content)`. The reflector keeps its cursor logic; only the parse + extract step is relocated.

## Decisions

### D1. New module at `src/sessions/transcript.ts`

**Chosen:** a dedicated transcript module under `src/sessions/` (where transcript persistence already lives per canon — `Write transcript entries on message completion` is a sessions requirement).

**Why:** the writer is invoked from `src/agent/events.ts` and the reader from `src/memory/reflector.ts`; the module must be importable by both without creating a cycle. `sessions/` already owns the on-disk layout (`transcriptPath`, `sessionDir`) and is imported by both layers today, so it is the natural neutral ground. A new top-level `src/transcript/` would over-promote a single-file concern.

**Rejected:** putting the module in `src/memory/` (it would bias the reader) or `src/agent/` (it would bias the writer and re-introduce the cycle the events.ts header comment warns about).

**Constraint:** the module exports only the type, the writer, the reader, and the text-extraction helper. It does not export path helpers (those stay in `sessions/paths.ts`) or cursor logic (that stays in the reflector).

Specs: `Transcript module owns the transcript seam`, `Write transcript entries on message completion`.

### D2. `TranscriptEntry` type moves to the new module; both consumers re-import

**Chosen:** the `TranscriptEntry` interface (currently at `events.ts:30`, non-exported) moves to the transcript module and is exported. `events.ts` imports it; `reflector.ts` deletes `RawTranscriptEntry` and uses `TranscriptEntry` for parsing.

**Why:** the whole point is one type. Keeping a private copy in either consumer would reproduce the bug.

**Constraint:** parsing still validates defensively (transcript lines may be malformed or hand-edited), so the reader uses `as TranscriptEntry` on parsed JSON but extracts fields through the typed accessor. This is not a validation boundary — it is a typing boundary — so no zod/schema parsing is introduced; existing fail-loud semantics for non-malformed lines are preserved.

Specs: `Transcript module owns the transcript seam`, `Reader and writer share one type`.

### D3. Reader exposes cursor-aware range reads; `extractText` relocates

**Chosen:** the new module exports `readTranscriptAfter(home, sessionId, processedLines)` returning `TranscriptLine[]` (the shape reflector already uses), and `extractEntryText(content)` for the text-extraction logic currently at `reflector.ts:364-376`.

**Why:** the reflector's cursor tracks line indices, not byte offsets, and skips malformed lines while still counting them. That logic is transcript-shape logic, not reflection logic — it belongs with the type.

**Constraint:** the reflector's cursor file (`memory-reflection.json`) and its read/write stay in the reflector. The reader is given the cursor as input; it does not own cursor persistence.

Specs: `Reader supports range reads for reflection cursoring`, `Reader extracts displayable text uniformly`.

### D4. No on-disk format change

**Chosen:** the JSONL shape on disk is unchanged. The module owns the shape; this change does not migrate it.

**Why:** existing transcripts must remain readable, and there is no format problem to fix — the problem is the missing interface, not the format.

Specs: `Write transcript entries on message completion` (preserves all existing fields and the dropping of noisy/sensitive payloads).

## File Changes

### `src/sessions/transcript.ts` (new)

Owns the transcript seam. Exports:
- `TranscriptEntry` type (moved from `events.ts:30-46`).
- `appendTranscriptEntry(sessionId, home, event)` — moved from `events.ts:261`; unchanged behavior.
- `readTranscriptAfter(home, sessionId, processedLines)` — consolidated from `reflector.ts:378-412`; returns `TranscriptLine[]`.
- `extractEntryText(content)` — moved from `reflector.ts:364-376`.
- `TranscriptLine` type (moved from `reflector.ts`; the `{ index, role, text, ts }` shape).

Covers `Transcript module owns the transcript seam`, `Reader supports range reads for reflection cursoring`, `Reader extracts displayable text uniformly`.

### `src/sessions/transcript.test.ts` (new)

Round-trip tests at the seam:
- write an assistant entry with all optional fields, read it back, assert no field loss.
- write a tool-result entry, read it back, assert `toolCallId`/`toolName`/`isError` survive.
- write content blocks (text, tool-call, image with mimeType only), read back, assert `extractEntryText` yields the text block.
- malformed line handling: a hand-corrupted line is skipped but counted toward `processedLines`.
- range read: entries before `processedLines` are excluded; entries after are returned in order.

Covers `Round-trip preserves all fields the writer can produce`.

### `src/agent/events.ts` (modified)

- Delete the local `TranscriptEntry` interface (`events.ts:30-46`) and the `TranscriptContent`/`TranscriptUsage` types if they are not used elsewhere in `events.ts`; if used, move them to `transcript.ts` alongside `TranscriptEntry`.
- `appendTranscriptEntry` at `events.ts:261` becomes a re-export from `sessions/transcript.ts`, or is deleted with the call site updated to import directly. Preferred: keep the call site in `events.ts` importing the writer from the new module.
- `transcriptEntryFromEvent` (`events.ts:214`) stays in `events.ts` (it is the event→entry translation, which is writer-side concern) but returns the imported `TranscriptEntry` type.

Covers modified `Write transcript entries on message completion` (writer goes through the module).

### `src/memory/reflector.ts` (modified)

- Delete `RawTranscriptEntry` (`reflector.ts:358-362`) and `extractText` (`reflector.ts:364-376`) and `readTranscript` (`reflector.ts:378-412`).
- Replace the `readTranscript(...)` call site with `readTranscriptAfter(home, sessionId, cursor.processedLines)` from the new module.
- The `TranscriptLine` type is now imported from the transcript module.

Covers modified `Write transcript entries on message completion` (reader goes through the module) and `Reader and writer share one type`.

**Cross-change note:** `memory-context-assembly` also edits `reflector.ts`, but at `reflector.ts:450` (`activeMemoryScopeFor`) — a different region of the file. The two changes don't share symbols or types (no shared new types are introduced by either), so neither needs the other to compile. Land `memory-transcript-module` first (it touches the read path; line numbers in this spec are anchored to current line numbers and will drift if the other change lands first). Not a `dependsOn` relationship — see portfolio coordination.

### `src/memory/reflector.test.ts` (modified)

Update any test that asserts on `RawTranscriptEntry` or `extractText` directly to use the new module's exports. Cursor and reflection-behavior tests are unchanged (they consume `TranscriptLine`, whose shape is preserved).
