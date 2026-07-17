# Metrics File Location

## Status

accepted

## Context

The system needs a durable, per-session stream of metrics (turns, counters, events) that is independent of `transcript.jsonl` and `events.jsonl`. The metrics must be available to `/debug` even when no `AgentRunner` is in memory, and must move with the session when it is archived. Several places could host the file: inside the `metrics` module as its own directory, alongside `transcript.jsonl` under the session directory, or inside the `state/` root with a flat naming scheme.

## Decision

We SHALL place `metrics.jsonl` at `state/sessions/<id>/metrics.jsonl` and treat it as a session file, not a `metrics`-module-private file.

- `SessionManager.createForChat()` SHALL create `metrics.jsonl` alongside `transcript.jsonl` and `events.jsonl` (per `sessions` spec requirement `Create session filesystem layout`).
- `SessionManager.archive()` SHALL move `metrics.jsonl` with the rest of the session directory to `state/sessions/archive/<id>/`.
- `metricsPath(home, sessionId)` SHALL live in `src/sessions/paths.ts` and use the same `SESSION_ID_HEX_RE` validation as `transcriptPath`.
- `src/metrics/store.ts` SHALL be the only module that writes to `metrics.jsonl`; `src/diagnostics.ts` SHALL read the file via the `metrics` module's `readMetricsSummary` helper.

The `metrics` module is the writer and reader, but the file location is owned by the `sessions` filesystem layout.

## Consequences

- Archiving, rebinding, and listing sessions continue to work without `metrics`-specific code because the file moves with the session directory.
- `/debug` can read metrics from disk even when no runner exists, simply by knowing the session id.
- The `metrics` module depends on `sessions/paths.ts` for `metricsPath`, which is consistent with how `transcriptPath` is already shared.
- Future work (per-session dashboards, external export) can read the same file without a new storage layer.
