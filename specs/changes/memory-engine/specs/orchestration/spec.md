# orchestration

## ADDED Requirements

### Requirement: Scheduler dispatches dreaming phases

The scheduler SHALL dispatch three dreaming phases on independent configurable schedules:

- **Light sleep:** recurring interval, default 240 minutes. Dispatches a light sleep turn that scans recent transcripts, extracts candidates via subagent, and promotes novel snippets.
- **REM sleep:** recurring interval, default 1440 minutes (aligned to 03:00 local time on first run). Dispatches a REM sleep turn that detects recurring themes and promotes cross-session patterns.
- **Deep sleep:** recurring interval, default 1440 minutes (aligned to 04:00 local time on first run). Dispatches a deep sleep turn that promotes short-term entries to durable and runs budget compaction.

Each dreaming phase SHALL be dispatched as a scheduled turn through the existing per-session queue. The dreaming turns SHALL target a dedicated internal session identified by the constant session id `__goblin_dreaming__` (not a Telegram chat). The session SHALL be created lazily on first dispatch, SHALL have no Telegram binding, and SHALL be persisted in the scheduler's session source so that in-process dispatch serialization is reused. The scheduler SHALL use the existing `SchedulerDispatcher` seam — no new dispatch path.

Dreaming schedule intervals SHALL be expressed as a non-negative integer number of minutes or the literal `off` (case-insensitive); `0` is equivalent to `off`. Dreaming schedules SHALL be registered at startup alongside existing schedules. The schedules SHALL be configurable via `GOBLIN_MEMORY_DREAM_LIGHT_INTERVAL`, `GOBLIN_MEMORY_DREAM_REM_INTERVAL`, and `GOBLIN_MEMORY_DREAM_DEEP_INTERVAL`. Setting any interval to `0` or `off` SHALL disable that phase.

For REM and deep sleep, the scheduler SHALL align the first run to the configured local time (03:00 for REM, 04:00 for deep) by computing the next occurrence of that time after startup. Subsequent runs SHALL be spaced by the configured interval. Light sleep SHALL start from the first tick after startup and repeat at the configured interval — no local-time alignment.

The scheduler SHALL NOT dispatch a dreaming phase while a previous dreaming phase for the same session is still running. Overlapping schedules SHALL coalesce into at most one follow-up dispatch.

#### Scenario: Light sleep dispatched on interval

- **GIVEN** light sleep is configured with a 240-minute interval
- **WHEN** the scheduler ticks and the interval has elapsed
- **THEN** a light sleep turn SHALL be dispatched to the dreaming session
- **AND** the turn SHALL be enqueued through the per-session queue
- **AND** the dreaming session id SHALL be `__goblin_dreaming__`
- **AND** the dreaming session SHALL have no Telegram `chatId` or `topicId`

#### Scenario: Dreaming phase disabled

- **GIVEN** `GOBLIN_MEMORY_DREAM_LIGHT_INTERVAL=off`
- **WHEN** the scheduler ticks
- **THEN** no light sleep turn SHALL be dispatched
- **AND** the schedule SHALL not be registered

#### Scenario: Overlapping dreaming phases coalesce

- **GIVEN** a light sleep turn is running for the dreaming session
- **WHEN** the scheduler ticks and REM sleep is due
- **THEN** the REM sleep turn SHALL wait behind the light sleep turn via the per-session queue
- **AND** SHALL run after the light sleep turn completes

#### Scenario: REM sleep first run aligns to 03:00 local

- **GIVEN** goblin starts at 22:00 local time and REM sleep is configured with a 1440-minute interval
- **WHEN** the scheduler registers the REM schedule at startup
- **THEN** the first REM dispatch SHALL be scheduled for 03:00 local time (5 hours after startup)
- **AND** the second REM dispatch SHALL be 1440 minutes after the first (03:00 the next day)

#### Scenario: Dreaming does not block user turns

- **GIVEN** a dreaming turn is running for the dreaming session
- **WHEN** a user sends a message to a different session
- **THEN** the user's turn SHALL be processed immediately
- **AND** the dreaming turn SHALL continue without interruption

### Requirement: Transcript sync runs on scheduler interval

The scheduler SHALL dispatch a transcript sync tick on a configurable interval (default 5 minutes). The sync tick SHALL scan `$GOBLIN_HOME/state/sessions/*/transcript.jsonl` for changes since the last sync, reindex changed files into the memory SQLite database, and remove entries for deleted sessions.

The sync tick SHALL be dispatched as a lightweight scheduled task (not a full agent turn) — it does not require model invocation. The sync SHALL run in the scheduler loop and SHALL NOT block user turns or dreaming phases. The sync task SHALL yield between files and SHALL be bounded to a configurable maximum duration per tick (default 30 seconds); if the bound is exceeded, the remaining work SHALL resume on the next tick.

The sync interval SHALL be configurable via `GOBLIN_MEMORY_TRANSCRIPT_SYNC_INTERVAL` (minutes, default 5). Setting it to `0` SHALL disable transcript indexing.

#### Scenario: Changed transcript reindexed on sync tick

- **WHEN** the sync tick runs and a transcript file's mtime has changed since the last sync
- **THEN** the file SHALL be re-parsed, chunked, and embedded into `memory_entries`
- **AND** the `memory_sources` table SHALL be updated with the new mtime and hash

#### Scenario: Sync tick does not block user turns

- **GIVEN** a sync tick is running
- **WHEN** a user sends a message
- **THEN** the user's turn SHALL be processed without waiting for the sync to complete
- **AND** the sync SHALL continue in the background

#### Scenario: Transcript sync disabled

- **GIVEN** `GOBLIN_MEMORY_TRANSCRIPT_SYNC_INTERVAL=0`
- **WHEN** the scheduler ticks
- **THEN** no transcript sync SHALL run
- **AND** transcript entries SHALL NOT be indexed

#### Scenario: Long sync tick yields and resumes

- **GIVEN** a sync tick begins with 100 transcript files to process and the per-tick duration bound is 30 seconds
- **WHEN** the tick has processed 40 files after 30 seconds
- **THEN** the sync task SHALL yield and the remaining 60 files SHALL resume on the next tick
- **AND** user turns received during the sync SHALL be processed without waiting for sync completion
