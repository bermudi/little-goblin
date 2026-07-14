# External Agent Scratch Lifecycle

## Status

proposed

## Context

External-agent runs can outlive a single Telegram turn and may even survive a process restart if the OS child is orphaned. A crash or restart leaves persisted metadata whose status is non-terminal, but the new process cannot prove it owns the old child process. Attempting to adopt processes by PID or PTY session name is unsafe and could accidentally cancel or observe unrelated work. At the same time, users and audit consumers need bounded, read-only status artifacts while the run is in progress and after it finishes.

## Decision

External-agent run records SHALL persist under `$GOBLIN_HOME/scratch/external-agents/<runId>/`. `meta.json` and `result.txt` SHALL be written atomically; `events.jsonl` SHALL be appended as complete JSON lines. Each run is non-resumable: at startup, the runner SHALL load all persisted metadata and atomically mark every non-terminal record `interrupted`, because no live handle can be proven owned after restart.

Output SHALL be bounded: 32,000 characters per normalized output event, 2 MiB per `events.jsonl` measured on UTF-8 bytes, 128,000 characters per final result, 16,000 characters per `status` response, and the 20 newest owned runs per `list` response. Truncation SHALL be explicit in metadata and tool results. The 2 MiB `events.jsonl` cap is measured on UTF-8 bytes; if the next serialized event would exceed the cap, the runner SHALL truncate the payload before serialization or reject the event, and SHALL never write a partial JSONL line or silently exceed the cap.

`start` SHALL return a run id immediately after scheduling the run, not block until the task completes. The final result is retrieved later through `status` or `list`.

## Consequences

- Easier: the runner is honest about runs that were orphaned by a crash; it does not pretend to control a process it did not start.
- Easier: scratch storage keeps large event logs out of backups and out of durable state directories.
- Harder: users must poll `status` or schedule a later turn to see completion; the runner does not push Telegram messages when a background run finishes.
- Must change: `ExternalAgentRunner.init()` reconciles persisted metadata before any new starts are accepted.
