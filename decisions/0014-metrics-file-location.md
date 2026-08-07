---
nospec: true
id: 0014
date: 2026-07-15
status: accepted
spine: false
---

# 0014: Metrics File Location

> Amended 2026-08-07 during architectural-review closure: legacy
> `SessionManager` language below is replaced by the current Conversation
> ownership. This does not move the legacy on-disk `state/sessions/` layout or
> alter the metrics reader/writer boundary.

## Context

The system needs a durable, per-session stream of metrics (turns, counters, events) that is independent of `transcript.jsonl` and `events.jsonl`. The metrics must be available to `/debug` even when no `AgentRunner` is in memory, and must move with the session when it is archived. Several places could host the file: inside the `metrics` module as its own directory, alongside `transcript.jsonl` under the session directory, or inside the `state/` root with a flat naming scheme.

## Decision

We SHALL place `metrics.jsonl` at `state/sessions/<id>/metrics.jsonl` and treat it as a Conversation or internal-runtime artifact, not a `metrics`-module-private file.

- `ConversationStore` SHALL eagerly create `metrics.jsonl` alongside `transcript.jsonl` and `events.jsonl` when it creates a Conversation, and `ConversationStore.archive()` SHALL move it with the Conversation directory to `state/sessions/archive/<id>/`.
- `InternalSessionStore` SHALL eagerly create `metrics.jsonl` with the other artifacts of its Surface-free internal runtime record. Internal sessions are not Conversations and never participate in Conversation archive or bindings.
- `metricsPath(home, id)` SHALL live in `src/sessions/paths.ts`, sharing that module's filesystem-safe identifier validation.
- `src/metrics/store.ts` (`MetricsStore` and its read helpers) SHALL be the only module that reads metrics records from or appends metric records to `metrics.jsonl`; diagnostics reads it through `readMetricsSummary`. `MetricsStore` MAY lazily create the parent directory and empty metrics file while appending a first record. That materializes only the metrics artifact for a caller-supplied validated id; it creates no Conversation, InternalSession state, binding, or layout authority.

`ConversationStore` and `InternalSessionStore` own their respective layout lifetimes. `MetricsStore` owns metrics-record I/O and lazy metrics-artifact materialization through `metricsPath`, and is a narrow allowed `$GOBLIN_HOME` persistence adapter; it does not own Conversation creation, archive, binding, or internal-runtime state.

## Consequences

- Archiving, rebinding, and listing Conversations continue to work without `metrics`-specific code because the file moves with the Conversation directory.
- `/debug` can read metrics from disk even when no runner exists, simply by knowing the Conversation id.
- The `metrics` module depends on `sessions/paths.ts` for `metricsPath`, which is consistent with how `transcriptPath` is already shared.
- Future work (per-Conversation dashboards, external export) can read the same file without a new storage layer.
