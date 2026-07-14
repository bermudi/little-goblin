# scheduled-turns

## Motivation

Goblin currently only thinks when Telegram input arrives. That makes it reactive: it can answer messages, process media, and run queued prompts, but it cannot wake itself to perform an explicit future check-in or periodic nudge. The backlog already calls out auto-archive / daemon-like behavior, and the upcoming memory retrieval work creates a path for better recall, but the first scheduling step should be small and explicit.

This change adds a local scheduler for user-authored scheduled turns plus an opt-in heartbeat. The scheduler lets the user say "run this prompt later" or "run this prompt every N minutes/hours/days" and have Goblin enqueue that prompt into the same session turn machinery as `/queue`. Heartbeat is deliberately separate and opt-in: when enabled for a session, Goblin periodically asks itself whether there is anything useful to say, with a conservative 30-minute default interval.

## Scope

This change adds explicit scheduled turns and opt-in session heartbeat.

Affected capabilities:

- `orchestration`: start, tick, and stop a single-process scheduler that dispatches due work through the existing per-session prompt queue.
- `commands`: add `/schedule` command forms for creating, listing, disabling, and removing schedules and heartbeat.
- `sessions`: persist scheduled-turn definitions under `GOBLIN_HOME` with atomic JSON writes.

Behavior changes:

- Users can create one-shot or recurring scheduled prompts for the active Telegram session.
- Due scheduled prompts run as fresh turns through the same runner and MessageBuffer path used by queued prompts.
- Schedules are bound to a session id plus the Telegram locator captured at creation time.
- If a session is archived or no longer bound to the captured locator, its schedules are disabled rather than silently running in the wrong place.
- Heartbeat does nothing unless explicitly enabled for a session. When enabled without an interval, it runs every 30 minutes.

New functionality:

- A JSON schedule store records schedule ids, session ids, locators, prompt text, next run time, recurrence, enabled/disabled state, and last run metadata.
- A scheduler loop polls for due work and claims one due item at a time so overlapping ticks do not double-run the same schedule.
- `/schedule list` shows active schedules for the current session.
- `/schedule at <time> <prompt>` creates a one-shot schedule with an absolute ISO-8601 timestamp.
- `/schedule in <duration> <prompt>` creates a one-shot schedule relative to now.
- `/schedule every <duration> <prompt>` creates a recurring schedule.
- `/schedule remove <id>` removes a schedule.
- `/schedule pause <id>` and `/schedule resume <id>` disable and re-enable a schedule.
- `/schedule heartbeat on [duration]`, `/schedule heartbeat off`, and `/schedule heartbeat status` manage the explicit heartbeat schedule for the current session.

## Non-Goals

- No inferred commitments or automatic schedule creation from ordinary conversation.
- No calendar integration, cron syntax, timezone database UI, or natural-language date parsing beyond a small documented set of accepted forms.
- No distributed scheduler, multi-process locking, or persistence guarantees across multiple Goblin processes sharing a home directory.
- No guaranteed exact-time execution; due work runs on the scheduler's polling cadence.
- No background auto-archive or auto-prune daemon in this change.
- No memory-search-driven commitment scanner in this change.
