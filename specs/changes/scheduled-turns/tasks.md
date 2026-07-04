# scheduled-turns tasks

## Phase 1: Add schedule store

- [ ] Add `schedulesPath(home)` to `src/sessions/paths.ts` returning `join(home, "schedules.json")` for `Persist scheduled turn definitions`.
- [ ] Add `peekBinding(loc)` to `src/sessions/manager.ts` — non-mutating binding read for `Scheduled turns stay bound to their captured session surface`.
- [ ] Add `src/sessions/manager.test.ts` coverage for `peekBinding` returning bound state, returning null on missing binding, and not auto-creating for topic/supergroup locators.
- [ ] Create `src/scheduler/types.ts` with schedule, heartbeat, and last-run status types (including `LastRunStatus = { at: string; outcome: "ok" | "binding-mismatch" | "archived" | "error"; message?: string }`) for `Persist scheduled turn definitions`.
- [ ] Create `src/scheduler/store.ts` backed by `schedulesPath(home)` with atomic load/save and missing/malformed-file handling.
- [ ] Implement create/list/remove/pause/resume, heartbeat enable/disable/status, and due-claim operations in `ScheduleStore`.
- [ ] Implement `makeScheduleId()` reusing the `randomUUID().slice(0,10)` scheme from `makeSessionId`.
- [ ] Add `src/scheduler/store.test.ts` coverage for persistence, missing/malformed files, ownership checks, heartbeat defaults, due claiming, and id generation.
- [ ] Export store and types from `src/scheduler/mod.ts`.
- [ ] Run `bun test src/scheduler/store.test.ts src/sessions/manager.test.ts`.
- [ ] Run `bun run typecheck`.

## Phase 2: Add schedule time parsing

- [ ] Create `src/scheduler/time.ts` for duration parsing, relative `in <duration>`, ISO `at`, past-time rejection, and reply formatting for `Schedule command parses bounded time expressions`.
- [ ] Add `src/scheduler/time.test.ts` coverage for valid durations, invalid durations, relative one-shot times, absolute ISO timestamps, and past timestamps.
- [ ] Run `bun test src/scheduler/time.test.ts`.
- [ ] Run `bun run typecheck`.

## Phase 3: Extract shared turn dispatcher

- [ ] Create `src/tg/turn-dispatcher.ts` to own AgentRunner creation, MessageBuffer creation, runner disposal, and per-session fresh-turn queues for `Scheduler dispatches due turns through the per-session queue`.
- [ ] Refactor `src/tg/intake.ts` to use the shared dispatcher while preserving text, media, command, and `/queue` behavior.
- [ ] Update `src/tg/intake.test.ts` for the dispatcher extraction and shared ordering proof.
- [ ] Run `bun test src/tg/intake.test.ts`.
- [ ] Run `bun run typecheck`.

## Phase 4: Add schedule command

- [ ] Create `src/commands/schedule.ts` with pure helpers for `list`, `at`, `in`, `every`, `remove`, `pause`, `resume`, and `heartbeat` subcommands.
- [ ] Extend `DispatchDeps` and `COMMAND_REGISTRY` in `src/commands/registry.ts` with instant-timing `/schedule <subcommand>`.
- [ ] Pass `ScheduleStore` into command dispatch from `src/tg/intake.ts`.
- [ ] Add `src/commands/schedule.test.ts` for all subcommands, active-session requirement, invalid time expressions, ownership checks, and heartbeat behavior.
- [ ] Update registry/help tests to include `/schedule <subcommand>`.
- [ ] Run `bun test src/commands/schedule.test.ts src/commands/registry.test.ts src/commands/help.test.ts`.
- [ ] Run `bun run typecheck`.

## Phase 5: Add scheduler loop

- [ ] Create `src/scheduler/loop.ts` with start/stop lifecycle, 60-second tick interval constant, due claiming one at a time, binding validation via `SessionManager.peekBinding` (never `resolve()`), stale schedule disablement with `LastRunStatus`, dispatch through the shared turn dispatcher, and logged tick errors.
- [ ] Define the heartbeat prompt constant (prefixed with `[heartbeat]`) in `src/scheduler/loop.ts`.
- [ ] Add `src/scheduler/loop.test.ts` for due dispatch, busy-session queueing, overlapping ticks, one-shot completion, recurring advancement, stale bindings, archived-session skip without recreation, tick errors, heartbeat prompt content, and stop behavior.
- [ ] Run `bun test src/scheduler/loop.test.ts src/scheduler/store.test.ts`.
- [ ] Run `bun run typecheck`.

## Phase 6: Wire scheduler lifecycle

- [ ] Update `src/bot.ts` to construct and share `ScheduleStore` and the turn dispatcher with Telegram intake and scheduler setup.
- [ ] Update `src/index.ts` to start the scheduler after `manager.init()` and stop it during graceful shutdown.
- [ ] Verify wiring by checking that `src/index.ts` constructs exactly one `ScheduleStore`, passes it to both intake and the scheduler loop, and calls `scheduler.stop()` in the SIGTERM/SIGINT handler before `bot.stop()`.
- [ ] Update `specs/backlog.md`: if the scheduled-turn substrate is deemed to satisfy the auto-archive/auto-prune daemon prerequisite, annotate that item; otherwise leave it unchanged.
- [ ] Run `litespec validate scheduled-turns`.
- [ ] Run `bun test`.
- [ ] Run `bun run typecheck`.
