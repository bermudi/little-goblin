## Phase 1: Turn index types and writer

Core data types and the event handler that writes `turns.jsonl`.

- [ ] Add `TurnSummary` interface to `src/sessions/types.ts` (fields: `turn`, `startTs`, `endTs`, `durationMs`, `model`, `stopReason`, `tokensIn`, `tokensOut`, `error`, `retried`, `retryAttempts`, `toolCalls`)
- [ ] Add `turnsPath(home, id)` to `src/sessions/paths.ts`
- [ ] Create `src/agent/turn-tracker.ts` with `TurnTracker` class:
  - `reset()` — called at `agent_start`, clears accumulated state
  - `accumulate(event)` — called for every event, tracks model/tokens/tools/errors
  - `shouldWrite(event)` — returns true at `agent_end` (no retry) or `auto_retry_end` (retry)
  - `buildEntry(event)` — produces a `TurnSummary` from accumulated state
- [ ] Add `appendTurnSummary(sessionId, home, entry)` to `src/agent/events.ts` using existing `appendJsonl()`
- [ ] Wire `TurnTracker` into `handleEvent()` in `src/agent/mod.ts`:
  - Instantiate `TurnTracker` on `AgentRunner` (lives alongside `accumulatedText`)
  - Call `tracker.accumulate(event)` for every event
  - On `shouldWrite(event)`, call `appendTurnSummary()`
- [ ] Test: unit test for `TurnTracker` — normal turn, errored turn, retried turn, multi-retry turn
- [ ] Test: integration test that events.jsonl events produce correct turns.jsonl entries
- [ ] Verify: `bun run check` passes

## Phase 2: Session search

Read-side of the turn index plus the search method.

- [ ] Add `readTurns(sessionId): TurnSummary[]` to `SessionManager` in `src/sessions/manager.ts` — reads `turns.jsonl`, skips malformed lines, returns empty array on ENOENT
- [ ] Add `SessionSearchQuery` and `SessionSearchResult` types to `src/sessions/types.ts`
- [ ] Implement `SessionManager.search(query)` — linear scan over session dirs, filter by date/model/errors/text, sort by createdAt desc, limit to 10
- [ ] Test: unit tests for `readTurns()` — with turns, without turns, corrupted entry
- [ ] Test: unit tests for `search()` — by model, by errors, by text, combined, empty result
- [ ] Verify: `bun run check` passes

## Phase 3: /sessions command and /debug enrichment

User-facing surface.

- [ ] Create `src/commands/sessions.ts` with `handleSessionsCommand()` — parses query args (`today`, `errors`, `model:X`, quoted text, date prefixes), calls `search()`, formats Telegram reply
- [ ] Register `/sessions` in `src/bot.ts` command routing (add to the switch in message:text handler)
- [ ] Update `src/diagnostics.ts`: add `turnCount` and `lastTurn` to `Diagnostics`, populate from `readTurns()`, render in `formatDiagnostics()`
- [ ] Test: unit test for session command formatter
- [ ] Test: unit test for diagnostics with/without turns
- [ ] Verify: `bun run check` passes
- [ ] Manual test: send `/sessions`, `/sessions errors`, `/sessions today` in a topic with history
