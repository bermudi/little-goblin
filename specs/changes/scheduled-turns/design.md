# scheduled-turns design

## Architecture

Scheduled turns are a local, single-process orchestration layer. They do not add a database, external queue, or second worker process.

The core architecture has four parts:

1. `ScheduleStore` persists schedule definitions in a single JSON file whose path is resolved via `src/sessions/paths.ts` (`schedulesPath(home) = join(home, "schedules.json")`) with atomic writes. The path helper lives in `paths.ts` to honor the AGENTS.md guardrail that `$GOBLIN_HOME` is only touched from the code tree through `SessionManager`, `MemoryStore`, and `paths.ts`.
2. `/schedule` command handlers mutate `ScheduleStore` for the active session and captured Telegram locator.
3. A scheduler loop polls the store on an interval, claims due schedules, validates that the captured session is still bound to the captured locator, and dispatches due prompts.
4. A shared session turn dispatcher owns runner creation, per-session prompt queues, and `MessageBuffer` creation so scheduled turns, `/queue`, and media prompts all use the same fresh-turn semantics.

The important refactor is to move the runner/queue/prompt-dispatch closure currently embedded in `src/tg/intake.ts` into a reusable module. `createTelegramIntake(...)` will still own Telegram update decisions, but it will call the dispatcher for fresh-turn scheduling. The scheduler will call the same dispatcher with a synthetic scheduled-turn prompt and a Telegram destination from the captured locator.

Scheduled prompt lifecycle:

1. User sends `/schedule at ...` or `/schedule every ...` in an active session.
2. The command parses time/duration and writes a schedule with `{ sessionId, locator, prompt, nextRunAt, kind }`.
3. The scheduler tick (default 60-second interval, see decision below) loads due schedules and atomically claims each due schedule one at a time within the tick.
4. Before dispatch, the scheduler checks the captured locator still resolves to the captured session id using a non-mutating `SessionManager.peekBinding(loc)` (see decision below). The existing `resolve()` MUST NOT be used because it auto-creates sessions for topic and supergroup locators, which would violate the "SHALL NOT recreate" scenario.
5. If the binding is stale/mismatched, the scheduler disables the schedule and records last-run status.
6. If valid, the scheduler asks the shared dispatcher to enqueue a fresh turn.
7. One-shot schedules are already disabled/complete when dispatch starts. Recurring schedules already have their next run advanced before dispatch starts.
8. Prompt failures are logged by the dispatcher; recurring schedules still keep their advanced next run so a broken prompt does not tight-loop.

Heartbeat is represented as a schedule with `kind = "heartbeat"` and a system-owned prompt. It is created only by `/schedule heartbeat on ...` and removed/disabled only by heartbeat subcommands. The default interval is 30 minutes.

## Decisions

### Persist schedules in one JSON file under `GOBLIN_HOME`

Chosen: `<home>/schedules.json`, with the path resolved via `schedulesPath(home)` in `src/sessions/paths.ts`.

Why: this follows the repository's file-native, atomic-write shape and lets startup discover schedules before any individual session is loaded. Putting schedules inside `sessions/<id>/` would make startup discovery require scanning every session and would make schedule lifecycle awkward when sessions are archived. The path helper lives in `paths.ts` to honor the AGENTS.md guardrail that `$GOBLIN_HOME` is only touched from the code tree through `SessionManager`, `MemoryStore`, and `paths.ts`. This ruling is promoted to decision 0006 (`schedule-store-location`) so it applies beyond this change.

Constraints: this is single-process only. No cross-process locks are added.

Spec links: `Persist scheduled turn definitions`.

### Claim due work before prompt dispatch

Chosen: update the schedule record before invoking the agent.

Why: if Goblin crashes during a long scheduled turn, the same due occurrence should not immediately double-dispatch on restart. For one-shot schedules, claiming disables/completes them. For recurring schedules, claiming advances `nextRunAt` by the interval.

Constraints: a crash after claim but before prompt delivery may skip that occurrence. This is acceptable for v1 because exact delivery guarantees are a non-goal.

Spec links: `Scheduler dispatches due turns through the per-session queue`.

### Validate the captured binding at run time

Chosen: a schedule stores both `sessionId` and `ChatLocator`, and the scheduler verifies they still match before dispatch.

Why: `/new`, `/resume`, and `/archive` can rebind a Telegram surface. A schedule created for an older session must not silently run against a new session just because the topic or DM locator is still active.

Constraints: stale schedules are disabled rather than migrated automatically.

Spec links: `Scheduled turns stay bound to their captured session surface`.

### Share the per-session queue with Telegram intake

Chosen: extract runner creation and fresh-turn queueing from `src/tg/intake.ts` into a reusable dispatcher module.

Why: duplicating prompt queues would break ordering: a due scheduled turn and a Telegram message could run concurrently in the same session. A single dispatcher keeps `/queue`, media, and scheduled prompts serialized.

Constraints: the dispatcher remains Telegram-aware because it creates `MessageBuffer` instances and beta Telegram tools.

Spec links: `Scheduler dispatches due turns through the per-session queue`, `Agent turns do not block unrelated updates`.

### Keep `/schedule` instant-timing

Chosen: schedule commands mutate only the schedule store and do not wait for the in-flight runner.

Why: creating or listing a schedule is independent of current model streaming. It should not abort or defer a turn.

Constraints: if a schedule becomes due while the current runner is streaming, the scheduler-dispatched prompt still waits behind the current turn via the shared queue.

Spec links: `Schedule command manages explicit scheduled turns`.

### Use bounded explicit time grammar

Chosen: support ISO timestamps for `at`, `in <duration>`, and integer durations with `m`, `h`, `d` for `every` and heartbeat intervals.

Why: natural-language time parsing is surprisingly ambiguous and out of scope. A tiny grammar is testable and enough for v1.

Constraints: users must write explicit durations/timestamps.

Spec links: `Schedule command parses bounded time expressions`.

### Heartbeat is just an explicit schedule kind

Chosen: heartbeat is persisted and dispatched through the same scheduler, not a second timer system.

Why: this keeps lifecycle, binding checks, and queueing consistent. It also makes heartbeat visible via `/schedule heartbeat status`.

Constraints: heartbeat is opt-in and session-scoped; there is no global ambient heartbeat.

Spec links: `Heartbeat schedule is explicit and session-scoped`, `Schedule command manages heartbeat`.

### Scheduler ticks every 60 seconds

Chosen: 60-second default tick interval, hardcoded as a constant in `src/scheduler/loop.ts`.

Why: this bounds the worst-case delivery latency for `at`/`every`/heartbeat schedules to ~60 s, which is well inside the granularity users care about for a personal assistant. Shorter intervals increase idle filesystem I/O on `schedules.json` for no perceptible latency win; longer intervals make `at <soon>` feel broken. The non-goal "no guaranteed exact-time execution" already covers the trade-off.

Constraints: not configurable in v1. A future config key can surface this if needed.

Spec links: `Scheduler dispatches due turns through the per-session queue`.

### Validate binding with a non-mutating peek

Chosen: add `SessionManager.peekBinding(loc): { sessionId: string; state: SessionState } | null` that reads `loadBindings` + `loadState` without auto-creating. The scheduler uses `peekBinding`, never `resolve()`.

Why: `resolve()` auto-creates sessions for topic and supergroup locators when the binding is stale or absent. If the scheduler called `resolve()` on an archived topic schedule's locator, it would silently create a brand-new session as a side effect — directly violating the "Archived session skipped" scenario's "SHALL NOT recreate." `peekBinding` reads the binding and state non-mutatingly so the scheduler can detect mismatches without side effects.

Constraints: `peekBinding` is read-only and does not heal stale bindings. Stale schedules are disabled, not migrated.

Spec links: `Scheduled turns stay bound to their captured session surface`.

### Schedule ids are 10-char hex from randomUUID

Chosen: `makeScheduleId()` reuses the same scheme as `makeSessionId()` — `randomUUID().replace(/-/g, "").slice(0, 10)`, yielding 10 hex chars (16^10 ≈ 1.1 trillion combos, fs-safe, URL-safe, user-typable).

Why: matches the existing session id convention so users see a consistent id style across `/schedule list` and session references. No new dependency (nanoid) needed.

Constraints: ids are unique within the schedule store; collisions are astronomically unlikely and handled by a retry on write.

Spec links: `Schedule command manages explicit scheduled turns`, `Persist scheduled turn definitions`.

### Heartbeat prompt is a fixed system-owned string

Chosen: the heartbeat prompt is a constant defined in `src/scheduler/loop.ts`:

```
[heartbeat] This is a scheduled self-check-in. No user message prompted this turn. Review the current session context and decide whether there is anything useful, timely, or important to say. If there is nothing worth saying, reply briefly that you have nothing to add and stop.
```

Why: pinning the exact text prevents drift that could quietly violate the "MUST NOT claim a user asked a new question" rule. The `[heartbeat]` prefix makes the prompt distinguishable from user-authored text at the agent layer and in transcripts.

Constraints: the prompt is system-owned; `/schedule` cannot override it. The `kind = "heartbeat"` schedule record stores no user prompt text.

Spec links: `Heartbeat schedule is explicit and session-scoped`.

### `LastRunStatus` shape

Chosen: `LastRunStatus = { at: string; outcome: "ok" | "binding-mismatch" | "archived" | "error"; message?: string }` where `at` is an ISO-8601 timestamp.

Why: a concrete shape ensures the store, loop, and command surfaces agree on status values. The `outcome` enum covers the three terminal cases the scheduler produces (successful dispatch, binding mismatch, archived session) plus a generic error catch-all.

Constraints: `LastRunStatus` is optional on each schedule record; absent until the first run.

Spec links: `Persist scheduled turn definitions`, `Scheduled turns stay bound to their captured session surface`.

## File Changes

### `src/scheduler/types.ts`

Create schedule types:

- `ScheduleKind = "once" | "recurring" | "heartbeat"`
- `ScheduleState = "enabled" | "disabled" | "completed"`
- `ScheduledTurn`
- `ScheduleStoreFile`
- `LastRunStatus = { at: string; outcome: "ok" | "binding-mismatch" | "archived" | "error"; message?: string }`

Relates to `Persist scheduled turn definitions` and `Heartbeat schedule is explicit and session-scoped`.

### `src/scheduler/store.ts`

Create `ScheduleStore` backed by the path returned by `schedulesPath(home)` from `src/sessions/paths.ts`.

Responsibilities:

- load missing file as empty;
- warn and load empty on malformed JSON;
- atomic writes via the existing `atomicWrite` helper;
- create one-shot and recurring schedules;
- create/update/disable heartbeat schedule;
- list schedules by session id;
- remove/pause/resume schedules only when owned by the active session;
- claim due schedules by updating state/next-run before dispatch.

Relates to `Persist scheduled turn definitions`, `Scheduled turns stay bound to their captured session surface`, and `Heartbeat schedule is explicit and session-scoped`.

### `src/scheduler/store.test.ts`

Add tests for missing/malformed store loading, atomic-ish persistence behavior, one-shot records, recurring records, heartbeat defaults, owner checks, and due claiming.

Relates to all sessions capability scenarios.

### `src/sessions/paths.ts`

Add `schedulesPath(home): string` returning `join(home, "schedules.json")`. This is the single point where the schedule store path is defined, honoring the AGENTS.md guardrail that `$GOBLIN_HOME` is only touched from the code tree through `SessionManager`, `MemoryStore`, and `paths.ts`.

Relates to `Persist scheduled turn definitions`.

### `src/sessions/manager.ts`

Add `peekBinding(loc: ChatLocator): { sessionId: string; state: SessionState } | null` — a non-mutating read of `loadBindings` + `loadState` that returns the currently bound session id and state for a locator without auto-creating. This is the method the scheduler uses for binding validation; `resolve()` MUST NOT be used because it auto-creates sessions for topic and supergroup locators.

Relates to `Scheduled turns stay bound to their captured session surface`.

### `src/scheduler/time.ts`

Create pure parsers/formatters for schedule command time expressions:

- parse duration strings like `30m`, `2h`, `1d`;
- parse `/schedule in <duration>`;
- parse ISO timestamps for `/schedule at`;
- reject invalid or past times;
- format durations and run times for replies.

Relates to `Schedule command parses bounded time expressions`.

### `src/scheduler/time.test.ts`

Add parser tests for valid durations, invalid duration strings, relative one-shots, absolute ISO timestamps, and past timestamp rejection.

Relates to `Schedule command parses bounded time expressions`.

### `src/tg/turn-dispatcher.ts`

Create a shared dispatcher that owns:

- `agentRunners` map access;
- per-session prompt queue map;
- `AgentRunner` creation using the same options currently built in `src/tg/intake.ts`;
- `MessageBuffer` creation;
- fresh-turn scheduling with stale-runner guards;
- runner disposal side effects.

`createTelegramIntake(...)` will receive or construct this dispatcher and delegate fresh-turn scheduling, runner creation, and runner disposal to it. The scheduler will use the same dispatcher to enqueue scheduled prompts.

**Dependency note:** the dispatcher lives in `src/tg/` because it creates `MessageBuffer` instances (a Telegram-layer type) and beta Telegram tools. This creates a `src/scheduler/ → src/tg/` import dependency. This is acceptable because the dispatcher is inherently Telegram-aware — scheduled turns deliver to Telegram surfaces. Moving it to `src/agent/` would create a worse `src/agent/ → src/tg/` dependency for `MessageBuffer`. The dependency is documented here so future refactors know it is intentional.

Relates to `Scheduler dispatches due turns through the per-session queue` and `Agent turns do not block unrelated updates`.

### `src/tg/intake.ts`

Refactor existing internal helper logic to call `turn-dispatcher.ts`. Preserve public intake methods and current behavior for text, media, commands, stale-runner guards, and `/queue` side effects.

Relates to the modified `Agent turns do not block unrelated updates` requirement.

### `src/tg/intake.test.ts`

Update existing tests as needed after the dispatcher extraction. Add proof that Telegram `/queue` and scheduled-dispatch calls share the same per-session ordering when using the same dispatcher.

Relates to `Scheduler dispatches due turns through the per-session queue`.

### `src/scheduler/loop.ts`

Create a scheduler loop class with `start()` and `stop()` methods plus an injectable clock/timer for tests. The loop ticks at a 60-second default interval (constant in this file). Each tick:

1. claims due schedules from `ScheduleStore` one at a time;
2. validates session binding through `SessionManager.peekBinding(loc)` (never `resolve()`);
3. disables stale/mismatched/archived schedules with `LastRunStatus` (`outcome: "binding-mismatch"` or `"archived"`);
4. dispatches valid prompts through `turn-dispatcher.ts`;
5. logs unexpected errors and keeps future ticks alive.

The heartbeat prompt constant (see decision above) lives in this file.

Relates to `Scheduler dispatches due turns through the per-session queue`, `Scheduler lifecycle follows bot lifecycle`, and `Scheduled turns stay bound to their captured session surface`.

### `src/scheduler/loop.test.ts`

Add tests for due dispatch, busy-session queueing via fake dispatcher, overlapping tick claims, one-shot completion, recurring advancement, stale binding disablement, tick error logging, and stop behavior.

Relates to orchestration capability scenarios.

### `src/scheduler/mod.ts`

Export scheduler store, loop, and types.

Relates to module organization.

### `src/commands/schedule.ts`

Create pure command execution helpers for `/schedule`:

- parse subcommands;
- build replies;
- call injected schedule store operations;
- require active session;
- enforce active-session ownership for remove/pause/resume;
- manage heartbeat status/on/off.

Relates to `Schedule command manages explicit scheduled turns`, `Schedule command parses bounded time expressions`, and `Schedule command manages heartbeat`.

### `src/commands/schedule.test.ts`

Add command tests for all schedule subcommands and error cases.

Relates to all commands capability scenarios.

### `src/commands/registry.ts`

Import `executeSchedule`, extend `DispatchDeps` with a `scheduleStore`, add the `schedule` command to `COMMAND_REGISTRY` with `argsHint: "<list|at|in|every|remove|pause|resume|heartbeat ...>"` and `timing: "instant"`, and route to the schedule handler.

Relates to `Schedule command manages explicit scheduled turns` and `Help command lists available commands`.

### `src/commands/registry.test.ts` / `src/commands/help.test.ts`

Update command registry and help tests to include `/schedule <subcommand>`.

Relates to `Help command lists available commands`.

### `src/tg/intake.ts` dispatch deps construction

Pass the shared `ScheduleStore` into command dispatch dependencies so `/schedule` can mutate schedules from the message:text command path.

Relates to `Schedule command manages explicit scheduled turns`.

### `src/bot.ts`

Construct one shared `ScheduleStore` and one shared turn dispatcher. Pass both into `createTelegramIntake(...)`. Return the schedule store/dispatcher if tests need to assert wiring.

Relates to `Build bot with middleware and command handlers` indirectly and to scheduler wiring.

### `src/index.ts`

After `manager.init()`, construct/start the scheduler loop using the shared store and dispatcher. On graceful shutdown, call `scheduler.stop()` before disposing runners and stopping the bot.

Relates to `Scheduler lifecycle follows bot lifecycle`.

### `specs/backlog.md`

After implementation lands, update the `auto-archive / auto-prune daemons` backlog item only if this change is considered to satisfy the explicit scheduled-turn substrate. Do not remove auto-archive/auto-prune if it remains a separate daemon feature.

Relates to backlog hygiene.
