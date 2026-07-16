# commands

## MODIFIED Requirements

### Requirement: Debug command dumps diagnostics

The `/debug` command is instant-timing: it runs immediately regardless of streaming state and does not abort or defer the current turn. It SHALL include the session name in its diagnostics output. `gatherDiagnostics` SHALL extract `deps.session.title ?? null` into a new `sessionName` field on the `Diagnostics` type. `formatDiagnostics` SHALL render `Session Name: <name>` immediately after `Session: <id>` when the name is present, and `Session Name: unavailable` when absent.

`/debug` SHALL also read the session's `metrics.jsonl` and include the following in the output:
- Last turn: tokens, cost, cacheRead/cacheWrite, stopReason.
- Session totals: total turns, total tokens, total cost, cache read/write totals, average turn duration.
- Memory counters: total writes, overflows, safety rejections, searches, average search result count, reflection candidates, quarantined candidates.
- A cache summary line such as `Cache: <cacheRead> read / <cacheWrite> write tokens in this session`.

`gatherDiagnostics` SHALL read `metrics.jsonl` via the `metrics` module's `readMetricsSummary` helper and add `metrics: MetricsSummary | null` to the `Diagnostics` type. `formatDiagnostics` SHALL render the fields above when `metrics` is non-null, and `Metrics: unavailable` when the file is missing or unreadable.

#### Scenario: Named session with metrics

- **WHEN** `/debug` is invoked on a session with `title: "ttt-v2"` and a `metrics.jsonl` containing one turn and two counters
- **THEN** the output SHALL contain `Session: <id>` followed by `Session Name: ttt-v2`
- **AND** it SHALL contain `Turns: 1`, `Tokens: <n>`, `Cost: $ <n>`, and `Cache: <r> read / <w> write tokens`
- **AND** it SHALL contain `Memory writes: <n>` and `Memory searches: <n>`

#### Scenario: Session with no metrics file

- **WHEN** `/debug` is invoked on a session whose `metrics.jsonl` is missing or empty
- **THEN** the output SHALL contain `Metrics: unavailable`

#### Scenario: Named session without title

- **WHEN** `/debug` is invoked on a session without a title
- **THEN** the output SHALL contain `Session Name: unavailable`
- **AND** the metrics section SHALL still render if the metrics file is present
