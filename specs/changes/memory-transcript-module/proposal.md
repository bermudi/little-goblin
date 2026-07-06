# Memory Transcript Module

## Motivation

The transcript JSONL is the seam between the agent layer and the memory reflector — but the shape is defined nowhere. `src/agent/events.ts` owns an internal `TranscriptEntry` type (non-exported, `events.ts:30`) and writes via `appendTranscriptEntry` (`events.ts:261`). The reflector reads the same file with an unrelated `RawTranscriptEntry` subset (`src/memory/reflector.ts:358`) and hand-rolled `extractText` + line-by-line `JSON.parse` (`reflector.ts:378-412`). The two modules agree by coincidence, not by contract.

This is the only seam in the codebase with no interface at all. Change how a `toolCall` block serializes in `events.ts` and the reflector silently stops extracting its text — a live class of silent data-loss bug. Every other duplication candidate in the architecture reviews has *some* home; this one has none.

Reviews identified this as the top recommendation on locality grounds (highest payoff, lowest risk) and the only candidate preventing a real failure mode rather than just tidying duplication.

## Scope

Affected capabilities: `memory` and `sessions` (transcript persistence is currently specced under sessions — `Write transcript entries on message completion` — and consumed under memory by the reflection pipeline).

This change introduces:

- A single transcript module that owns the `TranscriptEntry` type, the writer (`appendTranscriptEntry`), and the reader (replaces the reflector's hand-rolled `RawTranscriptEntry` + `extractText`).
- Round-trip tests at the seam: every entry shape the writer can produce must be readable by the reader without silent text loss.
- Both consumers (`events.ts`, `reflector.ts`) cross the new interface; neither touches the on-disk JSONL shape directly.

## Non-Goals

- No change to the on-disk JSONL format. The module owns the shape; this change does not migrate it. Existing transcripts remain valid.
- No change to reflection behavior, candidate extraction, or what the reflector chooses to harvest. Only the read path is consolidated.
- No change to where transcripts live on disk (`state/sessions/<id>/transcript.jsonl`).
- No new transcript producers. The events writer remains the only producer; the reflector remains the only consumer in this change.
- Not addressing the duplicated `activeMemoryScopeFor` copies (separate candidate, parked as backlog) or the broader memory-context-assembly refactor.
