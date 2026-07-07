# Tasks

## Phase 1: Create the transcript module

- [ ] Add `src/sessions/transcript.ts` exporting the `TranscriptEntry` type (moved from `events.ts:30-46`), the `TranscriptContent`/`TranscriptUsage` types if events.ts still needs them, the `TranscriptLine` type (moved from `reflector.ts`), `appendTranscriptEntry` (moved from `events.ts:261`), `readTranscriptAfter(home, sessionId, processedLines)` (consolidated from `reflector.ts:378-412`), and `extractEntryText(content)` (moved from `reflector.ts:364-376`). Behavior unchanged. Covers: `Transcript module owns the transcript seam`, `Reader supports range reads for reflection cursoring`, `Reader extracts displayable text uniformly`.
- [ ] Add `src/sessions/transcript.test.ts` with round-trip tests: assistant entry with all optional fields (api/provider/model/stopReason/errorMessage) survives write+read; tool-result entry preserves toolCallId/toolName/isError; content blocks (text, tool-call, image mimeType-only) extract correctly via `extractEntryText`; malformed line is skipped but counted toward processedLines; range read excludes entries at or before processedLines and returns the rest in order. Covers: `Round-trip preserves all fields the writer can produce`, `Reader and writer share one type`.
- [ ] Run `bun test src/sessions/transcript.test.ts` and `bun run typecheck`.

Commit: `phase 1: add transcript module`

## Phase 2: Route the writer through the module

- [ ] Update `src/agent/events.ts`: delete the local `TranscriptEntry` interface (and `TranscriptContent`/`TranscriptUsage` if relocated), import `TranscriptEntry` and `appendTranscriptEntry` from `sessions/transcript.ts`. Keep `transcriptEntryFromEvent` in events.ts returning the imported type. The `message_end` write path calls the module's writer. Covers modified: `Write transcript entries on message completion`.
- [ ] Run `bun test src/agent/events.test.ts` (if present) and `bun run typecheck`.

Commit: `phase 2: route transcript writer through the module`

## Phase 3: Route the reader through the module

- [ ] Update `src/memory/reflector.ts`: delete `RawTranscriptEntry` (`:358-362`), `extractText` (`:364-376`), and `readTranscript` (`:378-412`). Replace the call site with `readTranscriptAfter(home, sessionId, cursor.processedLines)` imported from `sessions/transcript.ts`. Import `TranscriptLine` from the module. Cursor logic stays in the reflector. Covers modified: `Write transcript entries on message completion`, `Reader and writer share one type`.
- [ ] Update `src/memory/reflector.test.ts` to remove any direct references to `RawTranscriptEntry`/`extractText`; cursor and reflection-behavior tests remain unchanged because `TranscriptLine` shape is preserved.
- [ ] Run `bun test src/memory/reflector.test.ts` and `bun run typecheck`.

Commit: `phase 3: route transcript reader through the module`

## Phase 4: Boundary check and validation

- [ ] Grep the tree for any remaining direct `JSON.parse` of `transcript.jsonl` lines or private `TranscriptEntry`/`RawTranscriptEntry` redeclarations outside `src/sessions/transcript.ts`; fix any stragglers. Covers: `Writer is the sole producer`, `Reader is the sole consumer`.
- [ ] Run full validation: `litespec validate memory-transcript-module`, `bun test`, `bun run typecheck`.

Commit: `phase 4: finalize transcript module boundary`
