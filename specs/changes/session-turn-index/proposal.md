## Motivation

Debugging failed sessions requires grepping through 1000+ lines of streaming deltas in `events.jsonl` to find the one line that says a turn timed out. There's no index, no summary, no way to scan "what happened in this session" without reading the raw event stream. Session search doesn't exist at all — finding the right session is `ls -lt` and hope.

This came up directly: a model (kimi-k2.6) hung for 14 minutes with zero output, timed out, auto-retried, and succeeded. Finding that story in the session data took 10 minutes of manual spelunking across `events.jsonl` (981 lines) and `transcript.jsonl` (50 entries).

## Scope

Two deliverables:

1. **Turn index** (`turns.jsonl`) — a compact per-turn summary file written alongside `events.jsonl` in each session directory. One line per turn: model, duration, token counts, stop reason, error, retry status. Enough to answer "what went wrong?" without opening events.jsonl.

2. **Session search** — a `/sessions` command in Telegram that lets the user query sessions by time range, content substring, model, or error status. Returns ranked results with context snippets. Not a full search engine — just a structured grep over the data we already have on disk.

### Capabilities affected

- **sessions** — new file (`turns.jsonl`) in session directory, new read/query methods on SessionManager
- **agent/events** — write a turn summary entry at `agent_end` (and `auto_retry_start`/`auto_retry_end`)
- **commands** — new `/sessions` command
- **diagnostics** — `/debug` gains turn count and last-turn summary from the index

## Non-Goals

- Full-text search engine or external index (sqlite, elasticsearch, etc.)
- Searching across all sessions in parallel — linear scan is fine for the volume we have
- Real-time indexing or watch-based systems
- Indexing subagent sessions (scope to main sessions for now)
- Web UI for session browsing
- Changing the events.jsonl or transcript.jsonl format
