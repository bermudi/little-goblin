# Turn Dispatcher Relocation Design

## Architecture

Today `TurnDispatcher` lives at `src/tg/turn-dispatcher.ts` and constructs `MessageBuffer` internally (`turn-dispatcher.ts:135`). This forces `src/scheduler/loop.ts:5` to import from `src/tg/` and lets `src/tg/intake.ts` read the public `dispatcher.runners` map directly (`intake.ts:274, 381`).

```
╭──────────────╮  imports TurnDispatcher from tg/   ╭─────────────────────╮
│ scheduler    │───────────────────────────────────▶│ tg/turn-dispatcher  │
│ /loop.ts     │                                    │  • new MessageBuffer│ ← Telegram rendering
╰──────────────╯                                    │  • public runners   │ ← read by intake
                                                    ╰──────────┬──────────╯
╭──────────────╮  reads dispatcher.runners.get(...)            │
│ tg/intake.ts │───────────────────────────────────────────────┘
╰──────────────╯
```

After this change the dispatcher moves to `src/orchestration/`, stops constructing `MessageBuffer`, and encapsulates its runner map:

```
╭──────────────╮  imports from orchestration/      ╭──────────────────────╮
│ scheduler    │──────────────────────────────────▶│ orchestration/       │
│ /loop.ts     │                                   │  dispatcher          │
╰──────────────╯                                   │  • private runners   │
                                                   │  • getRunner()       │
╭──────────────╮  injects createMessageBuffer ────▶│  • createBufferFn    │
│ tg/intake.ts │  calls getRunner() (not .runners) │                      │
╰──────────────╮                                   ╰──────────┬───────────╯
             ▼                                              ▼
╭──────────────────╮  constructs MessageBuffer   ╭─────────────╮
│ tg/intake only   │────────────────────────────▶│ MessageBuffer│
╰──────────────────╯                             ╰─────────────╯
```

### Why the scheduler import is the load-bearing fix

`scheduler/loop.ts:5` imports `TurnDispatcher` from `../tg/turn-dispatcher.ts` only to express the union type `SchedulerDispatcher | TurnDispatcher` at `loop.ts:93`. But `TurnDispatcher` already satisfies `SchedulerDispatcher` structurally (it has `enqueueScheduledTurn`), so the union is redundant. After relocation the scheduler imports from `orchestration/`; the union can collapse to just `SchedulerDispatcher`, removing the cross-layer type dependency entirely.

## Decisions

### D1. Move the dispatcher to `src/orchestration/dispatcher.ts`

**Chosen:** relocate `TurnDispatcher` from `src/tg/turn-dispatcher.ts` to `src/orchestration/dispatcher.ts`. Update all imports.

**Why:** the dispatcher's job is turn serialization (runner lifecycle, per-session queues, stale-runner guard). That is orchestration, not Telegram. `src/orchestration/` already exists as the wiring layer (it contains the bot startup sequence). The dispatcher is a peer of `SchedulerLoop`, which is also a lifecycle/serialization concern.

**Rejected:** keeping the dispatcher in `tg/` and just removing the `MessageBuffer` coupling. The relocation is the point — without it, the scheduler still imports a Telegram module by path even if the dispatcher no longer references `MessageBuffer`.

Specs: `Turn serialization lives in the orchestration layer`.

### D2. The dispatcher references an opaque sink, not `MessageBuffer`; the factory is injected once

**Chosen:** the dispatcher's `createMessageBuffer` method (`turn-dispatcher.ts:132-144`) keeps calling `this.createMessageBufferFn(locator)`, but: (a) the `new MessageBuffer(...)` fallback (`turn-dispatcher.ts:135`) is removed, making the injected factory mandatory; (b) the factory's return type and the `createMessageBufferFn` field are typed against an opaque `TurnSink` interface (the subset of `MessageBuffer` that `runner.prompt(content, buffer)` consumes), not against the concrete `MessageBuffer` type; (c) the dispatcher module drops its `import { MessageBuffer } from "../tg/mod.ts"`.

The factory is injected once at dispatcher construction by the composition root (`src/index.ts`, via `buildBot`). The scheduler never passes a buffer; it dispatches through `enqueueScheduledTurn`, and the dispatcher obtains the buffer through its factory when needed.

**Why:** the scheduler calls `enqueueScheduledTurn(session, locator, content, onError)` with no buffer argument, so the buffer *must* be produced inside the dispatcher somehow. Removing the `new MessageBuffer` fallback and typing the factory against an opaque sink is the real decoupling achievable: the dispatcher module no longer imports `MessageBuffer`, and Telegram rendering knowledge (the `onTopicNotFound` orphan-archive hook at `turn-dispatcher.ts:140`) moves into the factory that the Telegram-aware composition root injects. The dispatcher is transport-agnostic at the type level — it does not know it is using Telegram — even though in production only the Telegram factory is wired.

**What this is NOT:** the dispatcher is not made transport-pluggable in the sense of accepting multiple transports at runtime. There is exactly one transport (Telegram). The win is that the *type dependency* is gone: relocating the dispatcher to `orchestration/` does not drag `src/tg/` along, and the scheduler imports from `orchestration/` cleanly.

Specs: `Turn serialization lives in the orchestration layer` (the "SHALL NOT reference the MessageBuffer type" and "obtains the buffer through its injected factory" clauses).

### D3. Encapsulate the `runners` map behind behavior methods

**Chosen:** make `runners` private (`private readonly runners`). Add `getRunner(sessionId): AgentRunner | null` (returns the current runner or null) and possibly `hasRunner(sessionId): boolean`. Replace `dispatcher.runners.get(session.id)` at `intake.ts:274, 381` with `dispatcher.getRunner(session.id)`.

**Why:** the public map lets intake poke runner lifecycle internals directly. Two call sites read it: `intake.ts:274` (deferred-command queue path) and `intake.ts:381` (stale-runner check before scheduling). Both are answered by a `getRunner` method.

**Constraint:** `promptQueues` is also currently public (`turn-dispatcher.ts:70`). Verification shows no external reads of `promptQueues` — only `runners` is read externally. `promptQueues` can be made private too, but that is not load-bearing for this change; it's a cleanup left to build discretion.

Specs: `Turn dispatcher runners map is encapsulated`.

### D4. The scheduler's dispatcher type union collapses

**Chosen:** `SchedulerOptions.dispatcher` (`loop.ts:93`) changes from `SchedulerDispatcher | TurnDispatcher` to `SchedulerDispatcher`. The redundant `TurnDispatcher` import at `loop.ts:5` is deleted.

**Why:** `TurnDispatcher` structurally satisfies `SchedulerDispatcher`. The union was only there to let the type checker accept a concrete `TurnDispatcher`; once the dispatcher is relocated and `SchedulerDispatcher` is the canonical seam, the union adds nothing.

**Constraint:** `src/index.ts:23` passes the concrete dispatcher to `SchedulerLoop`. After this change it still passes the same object (now typed as `SchedulerDispatcher`); no runtime change.

Specs: `Turn serialization lives in the orchestration layer` (the "scheduler imports from orchestration" clause).

## File Changes

### `src/orchestration/dispatcher.ts` (new — relocated from `src/tg/turn-dispatcher.ts`)

The `TurnDispatcher` class moves here. Changes:
- `runners` becomes `private readonly`.
- Add `getRunner(sessionId): AgentRunner | null`.
- `createMessageBuffer` always delegates to `this.createMessageBufferFn`; the `new MessageBuffer` fallback (`turn-dispatcher.ts:135`) is removed. The factory is mandatory at construction (throw if absent, or make the option required).
- The class no longer imports `MessageBuffer` from `src/tg/mod.ts`. It imports only types it needs (`Bot` for the factory signature is no longer needed if the factory is fully opaque).

Covers `Turn serialization lives in the orchestration layer`, `Turn dispatcher runners map is encapsulated`.

### `src/tg/turn-dispatcher.ts` (deleted)

The file is removed; a re-export shim is NOT added (callers update imports). If a temporary shim is needed during the move, it should be removed in the same phase.

### `src/tg/intake.ts` (modified)

- Update import from `"./turn-dispatcher.ts"` to `"../orchestration/dispatcher.ts"`.
- Construct the dispatcher with a mandatory `createMessageBuffer` factory that builds `MessageBuffer` for a locator (this is the logic currently at `turn-dispatcher.ts:132-144` — it moves into intake, where Telegram rendering belongs).
- Replace `dispatcher.runners.get(session.id)` at `intake.ts:274, 381` with `dispatcher.getRunner(session.id)`.

Covers `Turn serialization lives in the orchestration layer` (intake injects the factory), `Turn dispatcher runners map is encapsulated` (intake uses `getRunner`).

### `src/scheduler/loop.ts` (modified)

- Delete `import type { TurnDispatcher } from "../tg/turn-dispatcher.ts"` (`loop.ts:5`).
- Change `SchedulerOptions.dispatcher` from `SchedulerDispatcher | TurnDispatcher` to `SchedulerDispatcher` (`loop.ts:93`).
- The dispatcher is now imported (type-only) from `../orchestration/dispatcher.ts` only if needed for the `SchedulerDispatcher` definition; otherwise `SchedulerDispatcher` is self-contained.

Covers `Turn serialization lives in the orchestration layer` (scheduler no longer imports from `tg/`).

### `src/bot.ts` (modified)

- Update `import type { TurnDispatcher } from "./tg/turn-dispatcher.ts"` (`bot.ts:21`) to `from "./orchestration/dispatcher.ts"`.
- The return type of `buildBot` (`bot.ts:78`) changes the `dispatcher: TurnDispatcher` reference's import path; the type itself is unchanged.

### `src/index.ts` (modified)

- Update any import of `TurnDispatcher` to the new path (if `index.ts` imports it directly — verify during build; it may only receive the dispatcher via `buildBot`'s return).

### Tests (modified)

- `src/tg/intake.test.ts` (or equivalent): update dispatcher construction to pass the buffer factory; replace any `.runners.get` assertions with `getRunner`.
- `src/scheduler/loop.test.ts`: the `makeFakeDispatcher` fake (`loop.test.ts:30`) already implements `SchedulerDispatcher`; it is unchanged. Any test asserting the union type is updated.
- Any test importing `TurnDispatcher` from `./tg/turn-dispatcher` updates its import path.
