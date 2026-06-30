## Architecture

```
                ┌──────────────────────────────────────────────┐
                │  src/bot.ts  (thin grammy adapter, ~163 lines) │
                │  buildBot(): construct Bot, mount allowlist,   │
                │  registerCommands, wire one-line bot.on, catch │
                └───────────────┬──────────────────────────────┘
                                │  intakeMessageFromCtx(ctx)
                                │  → TelegramIntakeMessage
                                ▼
                ┌──────────────────────────────────────────────┐
                │  src/tg/intake.ts  (turn orchestration seam)   │
                │  createTelegramIntake(options) → {              │
                │    handleText, handlePhoto, handleDocument,    │
                │    handleVoice, handleAudio, handleTopicDesc } │
                │                                                │
                │   resolveActiveTurn  ──► SessionManager.resolve │
                │        │                + getProjectDir         │
                │        ▼                                      │
                │   schedulePrompt  ───► per-session promise      │
                │        │              queue + isCurrent guard   │
                │        ▼                                      │
                │   createRunner / getOrCreateRunner ──► β-tools  │
                │        │              scoped to (chatId, thread)│
                │        ▼                                      │
                │   downloadFileBytes / downloadPhoto            │
                │   (20 MiB cap, Telegram file API)              │
                └────┬──────────┬───────────┬───────────┬────────┘
                     │          │           │           │
              ┌──────▼──┐ ┌────▼─────┐ ┌───▼────┐ ┌────▼──────┐
              │ Agent   │ │ Message  │ │ Memo-  │ │ commands/ │
              │ Runner  │ │ Buffer   │ │ ryStore│ │ dispatch  │
              └─────────┘ └──────────┘ └────────┘ └───────────┘
```

The boundary is strict: `bot.ts` knows grammy and nothing else. `intake.ts` knows turn orchestration and consumes domain collaborators (`AgentRunner`, `SessionManager`, `MemoryStore`, `MessageBuffer`, command dispatch) without knowing grammy exists. The adapter translates one grammy `Context` into one `TelegramIntakeMessage` (a plain struct with `locator`, `isSupergroup`, `threadId`, `reply`, `prepare`) and hands it to intake.

`TelegramIntakeMessage` is the seam's test surface. Because it carries closures for `reply` and `prepare`, a test builds one without a grammy `Bot`; because intake accepts injectable `createAgentRunner` and `createMessageBuffer` factories, a test swaps in a `MockAgentRunner` and a fake buffer. This is the leverage the refactor buys: the whole intake decision tree (command → resolve → schedule → stale-guard → download → prompt) is exercisable in milliseconds with no network and no grammy update construction.

## Decisions

### Intake is constructed with shared mutable state injected

**Chosen:** `createTelegramIntake(options)` receives the `Config`, `Bot`, `SessionManager`, `SubagentRunner`, `MemoryStore`, the shared `agentRunners: Map<string, AgentRunner>`, an optional shared `promptQueues`, and the injectable `createAgentRunner` / `createMessageBuffer` factories. `buildBot` owns the `runners` map and passes it in; the returned `{ bot, manager, subagentRunner, agentRunners }` still surfaces it for `main()`.

**Why:** The runners map and prompt queue are process-singleton state that must be shared between intake and `main()` (which reads `agentRunners` for shutdown). Injecting them — rather than having intake allocate internally — keeps `buildBot` as the composition root and lets tests inject a fresh map per test. The optional factories default to the real `AgentRunner` / `MessageBuffer`, so production wiring is unchanged.

**Rejected alternative:** Have intake own the runners map internally and expose getters. This would split ownership of "the active runners" between `buildBot` (which constructs it) and intake (which would mutate it), and would make the `main()` shutdown path reach through extra accessors. A single injected map is simpler.

### resolveActiveTurn returns a scheduling closure, not a runner

**Chosen:** `resolveActiveTurn(message, kind)` returns `ActiveTurn | null`. `ActiveTurn` carries `locator`, `session`, `projectDir`, and a `schedule(run, failureLog, opts)` closure that internally calls `getOrCreateRunner` + `schedulePrompt`. Media handlers write `turn.schedule(async (runner, isCurrent) => { ... }, ...)`.

**Why:** The four media handlers (photo, document, voice, audio) share the exact same prologue — resolve locator → resolve session → no-session reply policy → fetch runner → enqueue with stale guard. Pulling that into `resolveActiveTurn` removes four near-duplicate copies of the policy and guarantees the no-session DM-vs-topic rule is identical across media kinds. The closure captures the runner lookup so the handler body only specifies *what the work does* (download, write, prompt), not *how it gets scheduled*.

**Rejected alternative:** Return `{ locator, session, projectDir, runner }` directly and let each handler call `schedulePrompt` itself. This re-spreads the scheduling policy across four handlers and re-introduced the duplication the refactor exists to kill.

### schedulePrompt is the single stale-runner guard site

**Chosen:** `schedulePrompt(session, runner, run, onError)` wraps `run` in an `isCurrent = () => runners.get(session.id) === runner` predicate, chains it onto the per-session promise queue, and routes rejections to `onError`. Media handlers thread `isCurrent()` checks between every await boundary inside their work body.

**Why:** The "stale work must not side-effect after a runner-disposing command" requirement has to be enforced in exactly one place or it drifts. Putting the predicate in `schedulePrompt` means every media path gets the guard by construction; the per-side-effect `isCurrent()` checks inside the work body are the granular early-exits the requirement demands (return after download, after write, before prompt).

### Steer-vs-queue stays in handleText, not resolveActiveTurn

**Chosen:** Text has its own `handleText` path that does *not* go through `resolveActiveTurn`. It resolves the session, checks for a command first (dispatching via `handleCommand` and applying side effects), then branches on `runner.isStreaming`: streaming → `steerOrFallbackToFreshTurn` (`followUp`, with a `"not streaming"` fallback to a fresh turn); idle → `scheduleFreshTurn`.

**Why:** Text is the only kind that can steer (`followUp` is text-only), and text is the only kind that carries commands. Routing text through `resolveActiveTurn`'s media-shaped closure would muddy both: media never steers, and commands need the pre-dispatch `existingRunner` lookup that text already does. Keeping text separate makes the two policies legible side by side rather than cramming them behind one closure.

### bot.ts keeps a ctx-shaped replyNoActiveSession shim

**Chosen:** `bot.ts` exports `replyNoActiveSession(ctx, locator, kind)` which builds a `TelegramIntakeMessage` from `ctx` and forwards to `intake.ts`'s exported `replyNoActiveSession(message, locator, kind)`. `bot.test.ts` imports the `ctx` shim; `intake.test.ts` imports the message-shaped one.

**Why:** `replyNoActiveSession` is used both inside intake (by `resolveActiveTurn`) and as a standalone export for code paths that resolve a locator without a full media handler. Keeping the message-shaped function as the real implementation in intake and a thin ctx→message adapter in `bot.ts` matches the overall adapter/intake split and lets each test file import the shape it naturally constructs.

### Media download helpers live in intake, not a separate module

**Chosen:** `downloadFileBytes`, `downloadFile`, `downloadPhoto` are exported from / internal to `intake.ts`. The 20 MiB cap (`MAX_FILE_BYTES`) is a module constant.

**Why:** They are only called from intake's media handlers and are tightly coupled to the intake error contract (return `null` + warn log on any failure, never throw). A separate `src/tg/download.ts` would be a one-call-site module. If a second consumer appears, lifting them out is trivial.

## File Changes

### `src/tg/intake.ts` (new)

The turn-orchestration seam. Exports `createTelegramIntake`, `replyNoActiveSession` (message-shaped), `downloadFileBytes`, and the `TelegramIntakeMessage` / `TelegramDocumentInput` / `TelegramVoiceInput` / `TelegramAudioInput` / `PromptContent` types. Implements every requirement in `specs/telegram/spec.md` and carries the policy previously attributed to `bot.ts` in `specs/orchestration/spec.md`.

### `src/tg/intake.test.ts` (new)

The intake seam test surface. Exercises `createTelegramIntake` with a `MockAgentRunner`, a fake `Bot["api"]`, a `TelegramIntakeMessage`, and injectable factories. Covers: command creation + idle prompt + streaming steer; runner-disposing side effects; `/queue` serialization; no-session DM-vs-topic reply; stale-runner photo drop; topic-tool scoping (thread id vs locator); document fallback without a `projectDir`.

### `src/bot.ts` (rewritten, ~713 → ~163 lines)

`buildBot` becomes a thin adapter: construct `Bot`, `configureVoice`, `new SessionManager`, `new SubagentRunner`, `new MemoryStore`, `createTelegramIntake({...})`, `bot.use(buildAllowlistMiddleware)`, `registerCommands`, and seven one-line `bot.on(...)` handlers that each build a `TelegramIntakeMessage` and delegate to `intake.*`. Adds `intakeMessageFromCtx(ctx)` and the ctx-shaped `replyNoActiveSession(ctx, locator, kind)` shim. Removes all runner/scheduling/steer/media logic. Returns `{ bot, manager, subagentRunner, agentRunners: runners }`.

### `src/bot.test.ts` (retained, pruned)

The pre-existing integration suite driving `built.bot.handleUpdate(...)` is retained as the adapter end-to-end safety net. Redundant cases now covered more cheaply at the intake seam in `intake.test.ts` are pruned to avoid duplicated coverage (see tasks).

### No changes to

- `src/agent/mod.ts`, `src/sessions/mod.ts`, `src/memory/mod.ts`, `src/commands/dispatch.ts`, `src/tg/mod.ts`, `src/tg/tools.ts`, `src/tg/user-context.ts` — intake calls them, does not alter them.
- `src/index.ts` — calls `buildBot` and reads `agentRunners` for shutdown; the returned shape is unchanged.
