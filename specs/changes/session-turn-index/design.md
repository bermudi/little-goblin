## Architecture

Two new subsystems that plug into existing infrastructure:

### Turn index writer (agent-events layer)

Currently `handleEvent()` in `src/agent/mod.ts` calls `appendEvent()` and `appendTranscriptEntry()` for every pi event. A third call — `appendTurnSummary()` — is added. This function accumulates turn-level state in an `ActiveTurn` struct, writes a summary line to `turns.jsonl` when the turn completes, and handles auto-retry collapsing.

```
pi events → handleEvent()
              ├── appendEvent()         → events.jsonl (unchanged)
              ├── appendTranscriptEntry() → transcript.jsonl (unchanged)
              └── trackTurn()           → turns.jsonl (new)
                    accumulates state per agent_start/agent_end
                    collapses auto_retry_start/end into same entry
```

### Session search (sessions layer)

`SessionManager.search(query)` does a synchronous linear scan over session directories. For each session it reads `state.json` (for model/date filters), `turns.jsonl` (for error filters), and optionally `transcript.jsonl` (for text search). No external index, no caching — the volume is small enough that scanning tens of sessions is sub-millisecond.

```
/sessions command → SessionManager.search(query)
                      for each session dir:
                        read state.json → filter by model, date
                        read turns.jsonl → filter by errors
                        read transcript.jsonl → filter by text
                      return ranked results
```

## Decisions

### turns.jsonl is append-only JSONL, not a structured file

**Chosen:** One JSON object per line, appended at turn completion.
**Why:** Matches events.jsonl and transcript.jsonl — same `appendJsonl()` primitive, same atomicity, same tools (grep, jq, wc -l). No schema migration risk.
**Alternative:** A single `turns.json` rewritten on every turn. Rejected because it requires read-modify-write and risks corruption on crash.
**Alternative:** SQLite. Rejected because it adds a dependency for a problem that doesn't need it (tens of entries, not millions).

### Auto-retry collapsing is done at write time, not query time

**Chosen:** The `ActiveTurn` struct tracks whether `auto_retry_start` was seen. On `auto_retry_end`, the turn entry is written immediately with retry metadata. No post-hoc grouping needed.
**Why:** Simpler query path — every line in turns.jsonl is one logical turn. The writer already has all the context.
**Tradeoff:** If pi changes its retry event protocol, the writer needs updating. But pi's events are our contract anyway.

### Search is synchronous linear scan

**Chosen:** `SessionManager.search()` reads files on disk per-call.
**Why:** Typical session count is <50. Each `state.json` is ~150 bytes. Even with transcript search, the whole operation is <100ms. No index needed.
**Alternative:** Background indexer. Rejected — adds complexity for a volume that doesn't justify it.

### /sessions parsing is informal

**Chosen:** The command parses arguments like `today`, `errors`, `model:X`, quoted strings, and ISO date prefixes. Not a full query language — just enough to be useful.
**Why:** Over-engineering a query parser for a single-user bot is yak shaving. If it grows, we can formalize later.

## File Changes

### `src/agent/events.ts` — MODIFIED
- Add `TurnSummary` interface and `ActiveTurn` class
- Add `appendTurnSummary(sessionId, home, event)` function
- Called from `handleEvent()` alongside `appendEvent()` and `appendTranscriptEntry()`
- Tracks state across `agent_start`, `message_end`, `tool_execution_start`, `auto_retry_start`, `auto_retry_end`, `agent_end` events
- Writes one line to `turns.jsonl` at turn completion (either `agent_end` without retry, or `auto_retry_end`)

### `src/agent/mod.ts` — MODIFIED
- `handleEvent()` line ~220: add call to `trackTurn()` (the new function from events.ts)
- No other changes to the runner

### `src/sessions/paths.ts` — MODIFIED
- Add `turnsPath(home, id)` → `sessions/<id>/turns.jsonl`

### `src/sessions/manager.ts` — MODIFIED
- Add `readTurns(sessionId): TurnSummary[]` method
- Add `search(query: SessionSearchQuery): SessionSearchResult[]` method
- `search()` reads state.json + turns.jsonl + optionally transcript.jsonl per session

### `src/sessions/types.ts` — MODIFIED
- Add `TurnSummary`, `SessionSearchQuery`, `SessionSearchResult` types

### `src/commands/sessions.ts` — CREATED
- `/sessions` command handler
- Parses query arguments, calls `SessionManager.search()`, formats results
- Registered in bot.ts command routing

### `src/diagnostics.ts` — MODIFIED
- `Diagnostics` interface gains `turnCount: number | null` and `lastTurn: TurnSummary | null`
- `gatherDiagnostics()` calls `SessionManager.readTurns()` to populate
- `formatDiagnostics()` renders turn count and last turn summary

### `src/bot.ts` — MODIFIED
- Add `/sessions` to the command routing switch in the message:text handler
- Wire to `handleSessionsCommand()` from `src/commands/sessions.ts`
