# commands

## MODIFIED Requirements

### Requirement: Command dispatch is Telegram-side-effect-free

The command dispatch in `bot.ts`'s `message:text` handler SHALL be implemented as `handleCommand(opts: DispatchOpts): Promise<DispatchResult>` exported from `src/commands/dispatch.ts`. The function SHALL resolve the command token via `resolveCommand()` from `src/commands/registry.ts`; if no def matches or the def has no `handler` (i.e. a grammy-only def), it SHALL return `{ kind: "fallthrough" }`. `/cancel` SHALL own its own interrupt cascade inside its handler; dispatch itself SHALL call `def.handler(...)` without a timing pre-check. The function may call command executors that mutate session state through `SessionManager`, but it MUST NOT mutate the grammy `Context`, MUST NOT call `bot.api.*` methods, MUST NOT receive or touch the `agentRunners` map, and MUST NOT call `runner.dispose()` on any existing runner. It returns a structured result describing the Telegram replies and runner lifecycle side effects the caller must apply.

The `DispatchResult` for `kind: "replied"` SHALL include an optional `tag` field of type `SystemTag` (`"ok" | "error" | "warn" | "info" | "queued"`), defaulting to `"ok"` when omitted. The caller SHALL use this tag when sending the reply via `sendSystemReply`. Command handlers SHALL set `tag` to reflect the semantic category of their reply: `"error"` for failures, `"warn"` for config issues and soft warnings, `"info"` for usage text and state feedback, `"queued"` for queue acks.

#### Scenario: Dispatch takes deps as a parameter

- **WHEN** `handleCommand` is invoked
- **THEN** it SHALL receive a `Deps` object that includes the `manager`, `subagentRunner`, `cfg`, and a `tryResolveModel` helper
- **AND** it SHALL receive an `interruptAndCascade` reference that can be overridden in tests
- **AND** the `Deps` object SHALL be the only way the function reaches into the bot's wiring state

#### Scenario: Dispatch returns side effects, not direct mutations

- **WHEN** `handleCommand` is invoked with a dispatched command (e.g. `/new`, `/archive`, `/model`)
- **THEN** the returned `DispatchResult.reply` SHALL be the text to send back to the user
- **AND** the returned `DispatchResult.tag` SHALL indicate the semantic category for formatting
- **AND** the returned `DispatchResult.sideEffects` SHALL describe runner-map mutations the caller must perform (e.g. `runner-created`, `runner-disposed`)
- **AND** the function itself SHALL NOT mutate `runners`, SHALL NOT call `runner.dispose()`, and SHALL NOT send a `ctx.reply` — the caller does that

#### Scenario: Unknown command returns fallthrough

- **WHEN** `handleCommand` is invoked with a command that resolves to no def (or a grammy-only def with no `handler`)
- **THEN** the returned `DispatchResult.kind` SHALL be `"fallthrough"`
- **AND** the caller SHALL continue to normal agent routing

#### Scenario: Cancel owns cascade interrupt

- **WHEN** `handleCommand` is invoked for `/cancel`
- **THEN** the `/cancel` handler SHALL call the injected `interruptAndCascade` with the existing runner (if any), the subagent runner, the cascade timeout, and the session id
- **AND** the cascade `CascadeResult` SHALL be used for honest timeout reporting in the reply text

#### Scenario: Dispatch is testable in isolation

- **WHEN** a unit test constructs a `Deps` bundle with fake `manager`, fake `subagentRunner`, and a stubbed `interruptAndCascade`
- **THEN** `handleCommand` SHALL execute the dispatch logic without requiring a real grammy `Bot` instance, a real `SubagentRunner`, or any `bot.api.*` calls
- **AND** the test SHALL assert on the returned `DispatchResult` (reply text, tag, and side-effect list)

#### Scenario: Error handler sets error tag

- **WHEN** a command handler catches an exception and returns a "Failed to ..." reply
- **THEN** the `DispatchResult.tag` SHALL be `"error"`

#### Scenario: Usage reply sets info tag

- **WHEN** a command handler returns a usage string (e.g. `"Usage: /queue <text>"`)
- **THEN** the `DispatchResult.tag` SHALL be `"info"`

#### Scenario: Queue ack sets queued tag

- **WHEN** the `/queue` handler returns `"Queued. Will run after the current turn."`
- **THEN** the `DispatchResult.tag` SHALL be `"queued"`
- **AND** when the runner is idle and the handler returns `"Running."`, the tag SHALL be `"ok"`

### Requirement: Queue command enqueues text for the next idle turn

The `/queue <text>` command is instant-timing. It SHALL enqueue the supplied text via the per-session promise queue so it runs as a fresh turn via `AgentRunner.prompt()` only after the current turn (and any prior queued work) settles. It SHALL NOT abort the running turn.

If no `<text>` is supplied, the reply SHALL be `"Usage: /queue <text>"` with `tag: "info"` and nothing SHALL be enqueued.

If no session is bound to the chat, the reply SHALL be `"No active session."` with `tag: "info"` and nothing SHALL be enqueued.

If the runner is idle when `/queue` is handled, the supplied text SHALL run immediately as a fresh turn (the queue is empty, so the work starts now).

#### Scenario: Queue behind a running turn

- **WHEN** `/queue then check the tests` is sent while goblin is streaming
- **THEN** the text `"then check the tests"` SHALL be enqueued via the per-session promise queue
- **AND** the running turn SHALL NOT be aborted
- **AND** a reply SHALL acknowledge the queue with `tag: "queued"` (e.g. `"Queued. Will run after the current turn."`)

#### Scenario: Queue when idle runs immediately

- **WHEN** `/queue then check the tests` is sent while goblin is idle
- **THEN** the text SHALL run as a fresh turn immediately via `AgentRunner.prompt()`
- **AND** the reply SHALL be `"Running."` with `tag: "ok"`

#### Scenario: Queue without text

- **WHEN** `/queue` is sent without a trailing argument
- **THEN** the reply SHALL be `"Usage: /queue <text>"` with `tag: "info"`
- **AND** nothing SHALL be enqueued

#### Scenario: Queue with no active session

- **WHEN** `/queue do something` is sent in a DM with no active session
- **THEN** the reply SHALL be `"No active session."` with `tag: "info"`
- **AND** nothing SHALL be enqueued

## ADDED Requirements

### Requirement: Command handlers strip legacy emoji prefixes

Command handlers and intake message-reply strings SHALL NOT include the `❌` emoji prefix in reply text sent via `message.reply` or `sendSystemReply`. The monospaced tag prefix from `sendSystemReply` replaces emoji as the visual distinction for system messages. Existing reply strings that contain `❌` SHALL have the emoji and any surrounding whitespace stripped before the string is passed to `sendSystemReply`. Guest-mode inline query articles (`article()` calls using `⏳` and `⚠️`) are NOT affected — they use a different delivery path (`answerGuestQuery`).

#### Scenario: Error reply without emoji

- **WHEN** a command handler or intake path sends an error reply via `message.reply` or `sendSystemReply`
- **THEN** the reply text SHALL NOT start with `❌`
- **AND** the `sendSystemReply` helper SHALL prepend `` `[error]` `` as the tag

#### Scenario: Guest-mode articles are not affected

- **WHEN** a guest-mode inline query produces a busy or error article
- **THEN** the `⏳` and `⚠️` emoji in `article()` calls SHALL be preserved
- **AND** these articles SHALL NOT pass through `sendSystemReply`
