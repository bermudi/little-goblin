# metrics

## ADDED Requirements

### Requirement: MetricsStore persists per-session metrics to metrics.jsonl

The system SHALL provide a `MetricsStore` module at `src/metrics/store.ts` that appends structured events to `$GOBLIN_HOME/state/sessions/<id>/metrics.jsonl`. The store SHALL be constructed with `goblinHome` and a `sessionId`, and SHALL expose `record(event: MetricsEvent)` (or equivalent) that writes one JSON line per call.

#### Scenario: Record a turn event

- **WHEN** `MetricsStore` is constructed for session `abc123` and `record({ type: "turn", ... })` is called
- **THEN** a single JSON line SHALL be appended to `state/sessions/abc123/metrics.jsonl`
- **AND** the file SHALL contain valid JSONL with one event per line

#### Scenario: Record multiple counters

- **WHEN** `record({ type: "counter", name: "memory_write_add_total", value: 1 })` is called twice
- **THEN** the file SHALL contain two JSON lines
- **AND** each line SHALL be parseable as a `MetricsEvent`

### Requirement: MetricsEvent types cover turns, counters, and events

The `MetricsEvent` union SHALL contain at least:

- `turn` — with `turnStart` (ISO timestamp), `turnEnd` (ISO timestamp), `durationMs` (number), `model` (string), `provider` (string), `api` (string), `usage` (`{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`), `cacheRead` (number), `cacheWrite` (number), `cost` (number), `toolCount` (number), `toolErrorCount` (number), `stopReason` (string | null), and `errorMessage` (string | null).
- `counter` — with `name` (string), `scope` (string | null), and `value` (number). `value` is the absolute count after the increment, not the delta.
- `event` — with `name` (string), `scope` (string | null), and `extra` (record of primitives).

#### Scenario: Turn event captures cache and cost

- **WHEN** a `turn` event is recorded with `cacheRead: 12000`, `cacheWrite: 4000`, and `cost.total: 0.0123`
- **THEN** the persisted JSON line SHALL contain those exact values
- **AND** `usage.cacheRead` and `usage.cacheWrite` SHALL be equal to `cacheRead` and `cacheWrite`

#### Scenario: Counter event stores cumulative value

- **WHEN** `counter` events `memory_write_total: 1`, `memory_write_total: 2`, and `memory_write_total: 3` are recorded sequentially
- **THEN** each persisted line SHALL contain the cumulative value `1`, `2`, and `3` respectively

### Requirement: metrics.jsonl path is exported by sessions/paths.ts

The system SHALL provide `metricsPath(home, sessionId)` in `src/sessions/paths.ts` that returns `state/sessions/<id>/metrics.jsonl` and validates the session ID with the same `SESSION_ID_HEX_RE` guard used by `transcriptPath`.

#### Scenario: Valid session id

- **WHEN** `metricsPath("/home/goblin", "abc123def0")` is called
- **THEN** it SHALL return `"/home/goblin/state/sessions/abc123def0/metrics.jsonl"`

#### Scenario: Invalid session id is rejected

- **WHEN** `metricsPath("/home/goblin", "../etc/passwd")` is called
- **THEN** it SHALL throw an error indicating the session id must be 10 lowercase hex characters

### Requirement: metrics.jsonl is created on session creation and archived with the session

`SessionManager.createForChat()` SHALL create an empty `metrics.jsonl` in the new session directory. `SessionManager.archive()` SHALL move the file to `state/sessions/archive/<id>/metrics.jsonl` as part of the directory rename.

#### Scenario: New session has metrics file

- **WHEN** `SessionManager.createForChat()` creates a new session
- **THEN** `state/sessions/<id>/metrics.jsonl` SHALL exist and be empty

#### Scenario: Archived session retains metrics file

- **WHEN** `SessionManager.archive(sessionId)` is called
- **THEN** `state/sessions/archive/<id>/metrics.jsonl` SHALL exist
- **AND** `state/sessions/<id>/metrics.jsonl` SHALL NOT exist

### Requirement: MetricsStore writes are atomic and safe

The `MetricsStore` SHALL create the parent directory with `mkdirSync` if needed, and write each line using `openSync(path, "a")`, `writeSync`, and `closeSync`. If `metrics.jsonl` does not exist, the first `record()` call SHALL create it with an empty body before appending. The store SHALL not throw on `ENOENT` of the session directory (it SHALL create the directory).

#### Scenario: First write to a new file

- **WHEN** `record()` is called and `metrics.jsonl` does not exist
- **THEN** the file SHALL be created and contain one JSON line

#### Scenario: Append to existing file

- **WHEN** `record()` is called and `metrics.jsonl` already contains one line
- **THEN** the second line SHALL be appended after the existing line
- **AND** the file SHALL contain two complete JSON lines

### Requirement: MetricsStore exposes readMetricsSummary helper

The `metrics` module SHALL expose a `readMetricsSummary(goblinHome, sessionId)` function (or `MetricsStore` method) that parses all `metrics.jsonl` lines for the session and returns a `MetricsSummary` object. The summary SHALL include the last `turn` event, the count of turns, the sum of `usage.totalTokens`, the sum of `cacheRead` and `cacheWrite`, the total `cost`, the average `durationMs`, the last recorded `counter` values for memory counters (`memory_write_total`, `memory_write_overflow_total`, `memory_write_safety_reject_total`, `memory_archive_orphan_total`), the last `memory_search` event's `resultCount`, and the last `memory_reflection_*` counter values. The function SHALL return `null` (or throw `ENOENT` as `null`) when the file is missing or unreadable, and SHALL not throw on malformed lines (malformed lines are skipped).

#### Scenario: Summary of a populated metrics file

- **WHEN** `readMetricsSummary(home, "abc123")` is called and `metrics.jsonl` contains one turn, two counters, and one search event
- **THEN** the result SHALL contain `turns: 1`, `totalTokens` equal to the turn's `usage.totalTokens`, `cacheRead`/`cacheWrite` equal to the turn's values, and `lastSearchResultCount` equal to the search event's `resultCount`

#### Scenario: Missing metrics file

- **WHEN** `readMetricsSummary(home, "abc123")` is called and `metrics.jsonl` does not exist
- **THEN** it SHALL return `null` (or throw `ENOENT` mapped to `null`)

### Requirement: MetricsStore counter helper increments named counters

The `MetricsStore` SHALL expose `incrementCounter(name, scope, delta?)` that reads the last recorded `counter` value for that name and scope from the file (or defaults to 0), adds `delta` (default 1), and records a new `counter` event with the cumulative value.

#### Scenario: Increment from zero

- **WHEN** `incrementCounter("memory_write_total", "general")` is called for the first time
- **THEN** a `counter` event with `value: 1` SHALL be appended

#### Scenario: Increment after prior writes

- **WHEN** `incrementCounter("memory_write_total", "general")` is called after the same counter has been recorded twice
- **THEN** the new `counter` event SHALL have `value: 3`
