## Motivation

`src/bot.ts` had become the place where concepts accumulate. `buildBot()` carried every turn concept at once: command routing, `ChatLocator` resolution, session lookup, `AgentRunner` creation, prompt queueing, the steer-vs-queue policy, media download, project-file saving, stale-work checks, and memory-scope topic descriptions. Understanding a single incoming turn meant bouncing across many small modules and then back to the large module that composed them. The small helpers had clean interfaces, but the real bugs lived in *how they were called together* — so locality was poor, and the test surface was the full grammy update path, not the orchestration seam.

The deepening fix: a dedicated Telegram intake module owns "Telegram update → session turn" in plain domain terms (`text`, `media`, `command`, `ChatLocator`, `session`, `AgentRunner`, `MessageBuffer`), with grammy-specific wiring reduced to a thin adapter. This change adopts the already-implemented refactor into the spec canon.

## Scope

### Thin grammy adapter

`src/bot.ts` shrinks from ~713 lines to ~163. `buildBot()` keeps only what is irreducibly grammy: constructing the `Bot`, wiring allowlist middleware, registering grammy-side commands, mounting one-line `bot.on(...)` handlers, and installing `bot.catch`. Each handler builds a `TelegramIntakeMessage` from the grammy `Context` and delegates to the intake module. No orchestration logic (runner creation, scheduling, steer-vs-queue, media download) remains in `bot.ts`.

### Telegram intake module

A new `src/tg/intake.ts` owns turn orchestration. `createTelegramIntake(options)` returns `handleText`, `handlePhoto`, `handleDocument`, `handleVoice`, `handleAudio`, and `handleTopicDescription`. It centralizes:

- `resolveActiveTurn(message, kind)` — the single seam for "locator → session → `ActiveTurn` with a scheduling closure," shared by all media handlers. Replies for no-session DMs; silently drops no-session topic messages.
- `schedulePrompt(session, runner, run, onError)` — the per-session promise queue with the `isCurrent` stale-runner guard. One implementation enforces ordering and stale-work cancellation for photo, document, voice, and audio alike, instead of four near-duplicate copies.
- `scheduleFreshTurn` and `steerOrFallbackToFreshTurn` — the steer-vs-queue policy for text. Idle runner → fresh turn; streaming runner → `followUp` (steer); steer-race (`"not streaming"` error) → fallback to a fresh turn so the message is never dropped.
- `createRunner` / `getOrCreateRunner` — `AgentRunner` construction with β-tools scoped to `(chatId, threadId)`, and the per-session runner cache.
- `downloadFileBytes` / `downloadFile` / `downloadPhoto` — media download with the 20 MiB cap and Telegram file-API URL construction.
- Document / voice / audio saving into the bound `projectDir`, with safe-name normalization and the no-`projectDir` fallback paths.

`bot.ts` exposes only the grammy-`Context`-shaped `replyNoActiveSession(ctx, ...)` shim, which builds a `TelegramIntakeMessage` and forwards to `intake.ts`'s exported `replyNoActiveSession(message, ...)`.

### Intake seam as the test surface

`src/tg/intake.test.ts` exercises whole intake decisions with a `MockAgentRunner`, a fake `Bot["api"]`, a fake message (`TelegramIntakeMessage`), and injectable `createAgentRunner` / `createMessageBuffer` — no grammy update path, no `buildBot`. It covers command creation + idle prompt + streaming steer, runner-disposing side effects, `/queue` serialization, no-session DM-vs-topic behavior, stale-runner photo drop, topic-tool scoping, and document fallback without a `projectDir`.

The pre-existing `src/bot.test.ts` integration suite (29 tests driving `built.bot.handleUpdate(...)`) is retained as a thinner end-to-end safety net through the adapter.

## Non-Goals

- **No behavior change.** This is a structural refactor. Turn semantics (steer-while-streaming, queue serialization, stale-runner cancellation, media fallback paths) are identical to before; only their *location* changes.
- **No new public API beyond the intake seam.** `createTelegramIntake` and the `TelegramIntakeMessage` / `Telegram*Input` types are the only new exports. `replyNoActiveSession` gains a message-shaped overload but the grammy-`ctx` shim stays.
- **No change to `AgentRunner`, `SessionManager`, command dispatch, or memory.** Intake calls them; it does not alter them.
- **No split of `bot.ts` into a package.** One adapter file, one intake module — both inside `src/tg/` and `src/`.
