# Turn Dispatcher Relocation

## Motivation

`TurnDispatcher` lives at `src/tg/turn-dispatcher.ts:68` even though its job is turn serialization — runner lifecycle, per-session prompt queues, scheduling (`schedulePrompt:155-181`, `getOrCreateRunner:119-127`). It constructs `MessageBuffer` internally (`new MessageBuffer` at line 135), which couples turn serialization to Telegram rendering. That coupling forces `src/scheduler/loop.ts:5` to import from `src/tg/` even though the scheduler never sends a Telegram message — the file's own header comment (`turn-dispatcher.ts:64-66`) defends the cross-layer import as "intentional."

Two related leaks exist:

- The dispatcher exposes a public `runners: Map<string, AgentRunner>` (`turn-dispatcher.ts:69`, assigned at `:86`) that intake reads directly (`src/tg/intake.ts:274, 381`) to do stale-runner checks and runner lookup. The arrival-timing, stale-runner, runner-lookup, command-execution, side-effect, and reply logic is split across `tg/intake.ts` and `tg/turn-dispatcher.ts` with no single home.
- A `createMessageBuffer` injection hook exists on both `TurnDispatcherOptions` (`turn-dispatcher.ts:49`) and `TelegramIntakeOptions` (`intake.ts:74`), and intake does call `dispatcher.createMessageBuffer(locator)` (`intake.ts:210, 369`). The factory is threaded in *tests* (`intake.test.ts` passes a real callback) and forwarded by `createTelegramIntake` (`intake.ts:185`), but the **production** composition root (`bot.ts`) does not pass one, so the dispatcher's internal `new MessageBuffer(...)` fallback (`turn-dispatcher.ts:135`) fires in prod. The seam is half-wired: structurally present but not relied on by the only caller that matters.

This change merges two architecture-review candidates: "Move TurnDispatcher out of the Telegram module" (R1#3) and "Deepen command runtime and hide runner maps" (R2#1). Both target the same coupling; addressing them together avoids doing the move twice.

## Scope

Affected capabilities: `orchestration` and `telegram`. (`commands` is touched at the boundary but the command registry/dispatch shape is unchanged.)

This change introduces:

- Relocation of `TurnDispatcher` from `src/tg/` to an orchestration-layer module (`src/orchestration/`). Turn serialization stops knowing about `MessageBuffer`.
- A buffer-factory seam: callers (Telegram intake for live turns, the scheduler for scheduled turns) inject a `createMessageBuffer` factory at the call site. The existing-but-half-wired injection hook becomes the only path; the internal `new MessageBuffer` fallback is removed. (Today the hook is used in tests and forwarded by `createTelegramIntake`, but prod `bot.ts` does not pass it and so the fallback fires. This change makes the factory mandatory.)
- Behavior-oriented dispatcher methods that replace the public `runners` map reads. Intake's stale-runner check and runner lookup go through dispatcher methods (`getRunner(sessionId)`, `hasRunner(sessionId)`, etc.) instead of `dispatcher.runners.get(...)`. The `runners` map becomes private.
- Concentration of arrival-timing and stale-runner behavior: the dispatcher owns runner-replacement semantics; intake owns Telegram-side arrival and reply routing.

## Non-Goals

- No change to the per-session turn serialization model, the steer-vs-queue policy, or how `/queue` works.
- No change to the command registry, command handlers, or command timing classification.
- No change to `MessageBuffer`'s rendering behavior, status phases, or rollover logic.
- No change to the scheduler's due-turn semantics — only to which module the scheduler imports the dispatcher from.
- Not addressing the broader command-runtime deepening (a separate deferred candidate) beyond what's needed to hide the runners map.
- Not adding new transports; this change cleans up the existing two (live + scheduled) without introducing a third.
