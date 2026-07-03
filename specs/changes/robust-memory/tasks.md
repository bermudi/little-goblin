# Tasks

## Phase 1: Add memory safety filtering

- [x] Add `src/memory/safety.ts` with deterministic checks for secret-like tokens, private keys, password/cookie assignments, Telegram bot tokens, high-risk identifiers, tiny fragments, and description-line safety. Covers: `Memory safety filter rejects secrets and sensitive identifiers`.
- [x] Add `redactPreview()` so rejected content can be logged/quarantined without copying the sensitive value. Covers: `Quarantine stores rejected memory candidates outside snapshots`.
- [x] Wire `checkMemorySafety()` into `src/memory/tool.ts` for `add`, `replace`, `rewrite`, and `set_description`; failed checks must throw through the existing tool error path before any store mutation. Covers modified: `memory tool exposes add, replace, remove`.
- [x] Add `src/memory/safety.test.ts` and extend `src/memory/tool.test.ts` for accepted safe content and rejected unsafe explicit writes with unchanged files and no git commits.
- [x] Run `bun test src/memory` and `bun run typecheck`.

Commit: `phase 1: add memory safety filtering`

## Phase 2: Add metadata entries and quarantine

- [x] Add `src/memory/entry.ts` to format and parse metadata-bearing Markdown entries while preserving legacy plain entries. Covers: `Memory entries carry provenance metadata`.
- [x] Add `src/memory/quarantine.ts` to append redacted JSONL records at `$GOBLIN_HOME/memory/quarantine.jsonl` with timestamp, source session, target scope, category, reason, and preview. Covers: `Quarantine stores rejected memory candidates outside snapshots`.
- [x] Ensure `formatSnapshot`, `memory_read`, and `memory_read_index` continue to ignore quarantine by construction; add regression tests proving quarantine alone does not produce a snapshot or index entry.
- [x] Add tests for metadata formatting/parsing, legacy entry passthrough, quarantine append, and redacted preview storage.
- [x] Run `bun test src/memory` and `bun run typecheck`.

Commit: `phase 2: add memory metadata and quarantine`

## Phase 3: Add reflection cursor and candidate pipeline

- [x] Add `src/memory/reflector.ts` with a `MemoryReflector` class that reads `sessions/<id>/transcript.jsonl`, reads/writes `sessions/<id>/memory-reflection.json`, and processes only transcript entries after the cursor. Covers: `Reflection cursor prevents duplicate processing`.
- [x] Implement first-observation cursor seeding before later completed turns are reflected: existing sessions with no cursor start at the current transcript end, not line 0; newly completed work after the seeded cursor remains eligible. Covers: `Reflection cursor prevents duplicate processing`.
- [x] Add an in-process per-session reflection scheduler/lock that coalesces overlapping schedules into at most one follow-up pass. Covers: `Reflection cursor prevents duplicate processing`.
- [x] Implement deterministic candidate extraction for explicit user preferences, corrections, decisions, project facts, gotchas, and conventions from recent transcript entries. Covers: `Reflection uses scoped memory context`.
- [x] Run every candidate through procedural-noise filtering and `checkMemorySafety()`; safe candidates continue, low-confidence/unsafe/review-worthy candidates append to quarantine with redacted previews, and obvious noise may be skipped. Covers: `Memory safety filter rejects secrets and sensitive identifiers`, `Reflection filters procedural noise before persistence`, and `Quarantine stores rejected memory candidates outside snapshots`.
- [x] Implement consolidation that compares candidates against the target file and uses `replace`/`rewrite` for near-duplicates or updates, preserving original `source_session` and recording `updated_source_session`; otherwise `add`. Covers: `Reflection candidates consolidate with existing entries`.
- [x] Add `src/memory/reflector.test.ts` for first-observation cursor seeding, cursor skip after restart, retry when cursor is not advanced, overlapping schedule coalescing, unsafe candidate quarantine, low-confidence quarantine, procedural-noise skip, safe candidate write, and duplicate consolidation.
- [x] Run `bun test src/memory` and `bun run typecheck`.

Commit: `phase 3: add memory reflection pipeline`

## Phase 4: Schedule reflection from AgentRunner

- [x] Instantiate or inject `MemoryReflector` in `src/agent/mod.ts` and schedule a fire-and-log reflection pass when main-agent `agent_end` is observed. Covers: `AgentRunner schedules background memory reflection after completed turns`.
- [x] Pass the runner's `sessionId`, `cfg.goblinHome`, and `activeScope` into the reflection pass so automatic writes target only `user.md` or the active main-agent scope. Covers: `Reflection uses scoped memory context`.
- [x] Ensure `followUp()` does not schedule an independent reflection pass and that reflection errors do not reject `prompt()` or crash the event handler.
- [x] Extend `src/agent/mod.test.ts` for scheduling after completed prompt turns, no independent scheduling for steer events, reflection errors logged/swallowed, and reflected writes visible to a subsequent snapshot. Covers modified: `AgentRunner injects memory snapshot as per-turn aside`.
- [x] Run `bun test src/agent/mod.test.ts src/memory` and `bun run typecheck`.

Commit: `phase 4: schedule main-agent memory reflection`

## Phase 5: Preserve subagent boundaries

- [ ] Verify `src/subagents/execution.ts` does not instantiate or schedule `MemoryReflector`; avoid implementation changes unless needed for test injection. Covers: `Background reflection excludes subagent transcripts`.
- [ ] Extend `src/subagents/test/memory.suite.ts` to assert subagent `agent_end` does not schedule reflection and named-agent persona memory changes only via explicit `memory_write`.
- [ ] Run `bun test src/subagents/mod.test.ts src/subagents/test/memory.suite.ts src/memory` and `bun run typecheck`.

Commit: `phase 5: preserve subagent reflection boundary`

## Phase 6: Mark snapshots as stale-prone

- [ ] Update `src/memory/snapshot.ts` so every non-null snapshot includes guardrail text after `[goblin memory snapshot]` stating memory may be stale/incomplete and current context overrides memory. Covers: `Snapshot marks memory as auxiliary and possibly stale`.
- [ ] Update snapshot and AgentRunner tests that assert exact snapshot content/order.
- [ ] Run `bun test src/memory/snapshot.test.ts src/agent/mod.test.ts src/subagents/test/memory.suite.ts` and `bun run typecheck`.

Commit: `phase 6: mark memory snapshots as auxiliary`

## Phase 7: Graduate backlog and run full validation

- [ ] Remove the `v1.x: PII redaction in memory writes` line from `specs/backlog.md`; this change now owns that work.
- [ ] Run full validation: `litespec validate robust-memory`, `bun test`, and `bun run typecheck`.
- [ ] Manually inspect `git diff` for accidental memory content leakage, over-broad filters, and any changes outside the planned files.

Commit: `phase 7: finalize robust memory proposal`
