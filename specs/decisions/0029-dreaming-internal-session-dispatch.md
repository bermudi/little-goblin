# Dreaming Internal Session Dispatch

## Status

accepted

## Context

The memory-engine spec requires a dedicated internal session with id `__goblin_dreaming__` for dreaming turns. The spec says: "The session SHALL be created lazily on first dispatch, SHALL have no Telegram binding, and SHALL be persisted in the scheduler's session source so that in-process dispatch serialization is reused. The scheduler SHALL use the existing `SchedulerDispatcher` seam — no new dispatch path."

The existing session and dispatch infrastructure is Telegram-coupled:

1. **`SessionManager.createForChat(loc)`** requires a `ChatLocator` with `chatId: number` (required, non-nullable) and writes a binding (`bindings.dm`/`topics`/`supergroups`/`guest`). There is no path for a session with no Telegram chat. `SessionState.chatId` is `number` (required).

2. **`TurnDispatcher.enqueueScheduledTurn(session, locator, content, onError)`** is Telegram-coupled at three points:
   - `createBetaToolsFn(chatId, threadId)` builds Telegram beta tools (voice/photo/document). Dreaming needs none.
   - `createMessageBuffer(locator, session)` creates a Telegram message sink. Dreaming turns must NOT produce Telegram messages — the model's output is JSON candidates for the dreaming pipeline, not a chat response.
   - `manager.getProjectDir(locator)` / `consumeProjectNotice(locator)` are chat-scoped. Dreaming has no project dir or project notice.

3. **`enqueueScheduledTurn` is fire-and-forget.** It does not return the model's response. The dreaming pipeline needs the assistant's text to parse JSON candidates (`text`, `category`, `confidence`, `target`, `rationale`). Without a return path, the pipeline would have to read the response from `transcript.jsonl` after completion — fragile (timing, parsing, race with the next turn).

4. **`ScheduleStore`** is designed for user-authored schedules: it has binding validation (`peekBinding`), an agent-source cap (`MAX_AGENT_SCHEDULES = 8`), and `claimDue`/`recordRun` semantics. Dreaming phases are system-internal timers that need none of this.

The subagent runner (`SubagentRunner.spawn`) is a run-to-completion model invocation that returns the assistant text and has no Telegram coupling. But it creates its own session (a subagent instance, not a goblin session), doesn't use the per-session queue in `schedulePrompt`, and injects goblin's tool set (memory tools, spawn_subagent) which the dreaming subagent should not have.

## Decision

### Session creation: `SessionManager.ensureInternal(id)`

The `SessionManager` SHALL gain a method `ensureInternal(id: string): SessionState`:

- If `sessions/<id>/state.json` exists, load and return it.
- Otherwise, create the session directory + files (`ensureSessionFiles`), write `state.json` with `{ id, createdAt, chatId: 0 }`, and return the state. No binding entry is written.
- `chatId: 0` is a sentinel. Telegram chat IDs are never 0 (user IDs are positive, group/channel IDs are negative). The sentinel is safe.
- The method is idempotent. The session id is fixed (`__goblin_dreaming__`), not generated.
- The session is excluded from `manager.list()` (which scans `sessions/` but skips `archive/` — it will also skip `__goblin_dreaming__`).
- The session is never archived. `archive()` is never called on it.

The `SchedulerSessionSource` seam SHALL gain `ensureInternal(id: string): SessionState`.

### Dispatch: `TurnDispatcher.enqueueInternalTurn(session, content, onComplete, onError)`

The `TurnDispatcher` SHALL gain a method `enqueueInternalTurn(session, content, onComplete, onError)`:

- Creates a runner via `getOrCreateRunner` with a sentinel locator `{ chatId: 0 }` and no beta tools (empty array override). The runner is reused across dreaming turns (same session id → same runner, same per-session queue).
- Uses a **capture message buffer** that accumulates the assistant's text events without sending to Telegram. The buffer is a simple accumulator: it collects text deltas and exposes `getText()` returning the full assistant text.
- Calls `schedulePrompt(session, runner, run, onError)` for per-session serialization. The `run` function:
  1. Checks `isCurrent()`.
  2. Calls `runner.prompt(content, captureBuffer)`.
  3. After `prompt` resolves, checks `isCurrent()` again (runner may have been swapped).
  4. Calls `onComplete(captureBuffer.getText())` with the accumulated assistant text.
- `onComplete(text: string)` is the return path. The dreaming pipeline parses JSON candidates from `text`.
- `onError(err: unknown)` is called if the turn fails (model error, abort, etc.).
- The turn is serialized through the same per-session queue as scheduled turns. Overlapping dreaming phases for `__goblin_dreaming__` coalesce automatically: the second call waits behind the first in `schedulePrompt`.

The `SchedulerDispatcher` seam SHALL gain `enqueueInternalTurn(session, content, onComplete, onError)`.

### Scheduling: scheduler-managed timers, not `ScheduleStore`

Dreaming phases SHALL NOT be registered in `ScheduleStore`. The `ScheduleStore` is for user-authored schedules with binding validation, agent-source caps, and claim/recordRun semantics. Dreaming phases are system-internal timers.

The `SchedulerLoop` SHALL manage dreaming timers separately:

- On startup, register three timers (light/REM/deep) using `clock.setInterval`. Each timer fires at the configured interval (`GOBLIN_MEMORY_DREAM_LIGHT_INTERVAL`, `GOBLIN_MEMORY_DREAM_REM_INTERVAL`, `GOBLIN_MEMORY_DREAM_DEEP_INTERVAL`; defaults 240/1440/1440 minutes; `0` or `off` disables).
- For REM and deep sleep, align the first dispatch to the configured local time (03:00 / 04:00) by computing the next occurrence after startup. Subsequent dispatches are spaced by the interval. Light sleep starts from the first tick after startup.
- On each timer fire, call `dreamingPipeline.runLightSleep()` / `runRemSleep()` / `runDeepSleep()`. The dreaming pipeline handles dispatch + candidate processing.
- `stop()` clears all dreaming timers alongside the tick timer.

The `DreamingPipeline` methods (`runLightSleep` / `runRemSleep` / `runDeepSleep`) SHALL:

1. Build the phase-specific prompt (transcript snippets for light sleep, concept-tag aggregates for REM, short-term entries for deep sleep).
2. Call `sessionManager.ensureInternal("__goblin_dreaming__")` to get the session state.
3. Call `dispatcher.enqueueInternalTurn(state, prompt, onComplete, onError)` to dispatch.
4. In `onComplete(text)`: parse JSON candidates, quarantine malformed/low-confidence/skip, dedupe, consolidate, promote, compact, advance cursor, write dream diary.
5. In `onError(err)`: log the error, advance cursor if applicable, do not promote.

### Transcript sync: direct scheduler tick, not a scheduled turn

Transcript sync is already specified as a lightweight scheduled task (not a full agent turn). It runs directly in the scheduler tick, not through `enqueueInternalTurn` or `enqueueScheduledTurn`. No change to the existing spec.

## Consequences

**Easier:** Dreaming turns reuse the per-session queue for serialization (overlapping coalescing is automatic). The model's response is returned via `onComplete` — no transcript-parsing hack. No `ScheduleStore` pollution (dreaming phases don't need binding validation or claim/recordRun). No new `ScheduleKind` values.

**Harder:** `TurnDispatcher` gains a new method (`enqueueInternalTurn`). `SessionManager` gains a new method (`ensureInternal`). `SchedulerLoop` gains timer management for three dreaming phases. The `SchedulerSessionSource` and `SchedulerDispatcher` seams each gain a method. Test fakes for these seams need to implement the new methods.

**Telegram coupling resolved:** `enqueueInternalTurn` bypasses `createBetaToolsFn` (no beta tools) and `createMessageBuffer` (uses a capture buffer instead). The sentinel locator `{ chatId: 0 }` is used for runner construction only — it does not trigger Telegram routing.

**Session model impact:** `SessionState.chatId: 0` is a new sentinel value. Existing code that assumes `chatId` is a valid Telegram chat ID will not encounter the dreaming session (it's excluded from `manager.list()` and has no binding). The `resolveActiveScope({ chatId: 0 })` returns `{ chatId: 0, topicScope: "general", namedAgent: null }` — this scope is never written to (dreaming promotes to origin scopes, not the dreaming session's scope).

**Spec amendment:** The orchestration spec's "The scheduler SHALL use the existing `SchedulerDispatcher` seam — no new dispatch path" is amended to: "The scheduler SHALL reuse the per-session queue serialization via `TurnDispatcher.schedulePrompt`. Dreaming turns SHALL use `enqueueInternalTurn` (no beta tools, no Telegram message buffer, `onComplete` return path). No new dispatch infrastructure — the per-session queue is shared."
