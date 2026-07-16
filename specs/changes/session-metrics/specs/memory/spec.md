# memory

## ADDED Requirements

### Requirement: Memory store records write metrics

The `MemoryStore` SHALL accept an optional `MetricsStore` (or session-scoped `metrics` accessor) and record a `counter` event for every successful `add`, `replace`, `remove`, `rewrite`, and `set_description` operation. The store SHALL also record a `counter` event for cap-overflow errors (`memory_write_overflow_total`) and safety-filter rejections (`memory_write_safety_reject_total`). The store SHALL record a `counter` event (`memory_archive_orphan_total`) when an existing file is archived because the scope path was moved.

#### Scenario: Successful add

- **WHEN** `MemoryStore.add(scope, content)` succeeds
- **THEN** `metrics.incrementCounter("memory_write_add_total", scopeTag)` SHALL be called
- **AND** `metrics.incrementCounter("memory_write_total", "all")` SHALL be called

#### Scenario: Overflow error

- **WHEN** `MemoryStore.add(scope, content)` fails because the resulting scope would exceed the character cap
- **THEN** the error SHALL be returned to the caller
- **AND** `metrics.incrementCounter("memory_write_overflow_total", scopeTag)` SHALL be called

#### Scenario: Safety rejection

- **WHEN** `memory_write` tool execution rejects content because the safety filter matched
- **THEN** `metrics.incrementCounter("memory_write_safety_reject_total", scopeTag)` SHALL be called

### Requirement: Memory search records query metrics

`searchMemoryEntries` SHALL accept an optional `MetricsStore` and record an `event` named `memory_search` with `query`, `scopes` (count of scopes searched), `resultCount`, and `limit` when a query is performed.

#### Scenario: Search with results

- **WHEN** `memory_search` is invoked with `query: "deployment"` and returns 3 results
- **THEN** a `memory_search` event SHALL be written with `resultCount: 3` and `scopes` equal to the number of scopes enumerated

#### Scenario: Search with no results

- **WHEN** `memory_search` is invoked and returns 0 results
- **THEN** a `memory_search` event SHALL be written with `resultCount: 0`

### Requirement: MemoryReflector records reflection metrics

The `MemoryReflector` SHALL accept an optional `MetricsStore` and record counters for each of the following outcomes during a reflection pass:
- `memory_reflection_candidate_total` — number of candidates extracted.
- `memory_reflection_persisted_total` — number of candidates that were persisted.
- `memory_reflection_quarantine_total` — number of candidates sent to quarantine, with `reason` in the `scope` field.

It SHALL record the `reason` in the `scope` field for each quarantine counter (e.g., `unsafe`, `low_confidence`, `procedural_noise`, `review`).

#### Scenario: Candidates extracted and persisted

- **WHEN** `MemoryReflector.reflect()` extracts 4 candidates and persists 2
- **THEN** `memory_reflection_candidate_total` SHALL be incremented by 4
- **AND** `memory_reflection_persisted_total` SHALL be incremented by 2
- **AND** `memory_reflection_quarantine_total` SHALL be incremented by 2 with the appropriate reason scope

#### Scenario: No candidates

- **WHEN** `MemoryReflector.reflect()` extracts no candidates
- **THEN** `memory_reflection_candidate_total` SHALL be incremented by 0
- **AND** `memory_reflection_persisted_total` and `memory_reflection_quarantine_total` SHALL NOT be incremented

### Requirement: Snapshot build records snapshot metrics

`formatSnapshot` (or the snapshot builder used by `AgentRunner`) SHALL record an `event` named `snapshot_built` with `empty` (boolean), `entryCount` (number), and `charLength` (number) when a non-empty snapshot is produced for injection. If the snapshot is empty, it SHALL NOT record the event.

#### Scenario: Non-empty snapshot built

- **WHEN** a snapshot containing 3 entries and 1200 characters is built
- **THEN** a `snapshot_built` event SHALL be written with `empty: false`, `entryCount: 3`, `charLength: 1200`

#### Scenario: Empty snapshot

- **WHEN** an empty snapshot is built
- **THEN** no `snapshot_built` event SHALL be written
