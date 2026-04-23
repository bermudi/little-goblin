# Agent Runner — Tasks

## Phase 1: Goblin home layout for pi

- [ ] Update `src/config.ts` `ensureGoblinHome()` to also create `$GOBLIN_HOME/workdir/` and `$GOBLIN_HOME/pi-agent/`.
- [ ] Add `src/agent/paths.ts` with pure functions: `workdirPath(home)`, `piAgentDir(home)`, `agentsMdPath(home)`.
- [ ] Unit tests for `src/agent/paths.ts` verifying path composition against a fixture home.
- [ ] Update `AGENTS.md` at the repo root if any conventions change (likely none).
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 1: prepare $GOBLIN_HOME layout for the agent runner`

## Phase 2: Events log helper

- [ ] Add `src/agent/events.ts` exporting `appendEvent(sessionId: string, home: string, event: object): void`.
  - Opens `$GOBLIN_HOME/sessions/<id>/events.jsonl` with `O_APPEND`, writes one line (`JSON.stringify(event) + "\n"`) with a single `writeSync` call, closes. Single write ensures atomic per-line append.
  - Stamps every event with `ts: <ISO-8601>` if not already present.
- [ ] Unit test: write 1000 events concurrently (Promise.all of async calls), assert every line parses as valid JSON and count matches.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 2: add events.jsonl append helper`

## Phase 3: AgentRunner core

- [ ] Add `src/agent/mod.ts` exporting:
  - `export interface TurnCallbacks` with `onTextDelta`, `onToolStart`, `onToolEnd`, `onStatusUpdate`, `onAgentEnd`.
  - `export class AgentRunner` with constructor `(cfg: Config, sessionId: string, customTools: ToolDefinition[])`, methods `prompt(text: string, callbacks: TurnCallbacks): Promise<void>`, `abort(): Promise<void>`.
- [ ] Implement lazy `AgentSession` creation on first `prompt()` call.
  - Wires: cwd = `workdirPath(home)`, `AuthStorage.create(piAgentDir(home) + '/auth.json')`, `ModelRegistry.create(authStorage, piAgentDir(home) + '/models.json')`, `SettingsManager` at `piAgentDir(home) + '/settings.json'`, `sessionManager: SessionManager.inMemory()`, `customTools`.
  - Model chosen via `resolveModel(cfg.modelName)` from existing `src/agent/models.ts`.
- [ ] Read `$GOBLIN_HOME/AGENTS.md`. On success, prepend its content to the system prompt. On ENOENT, `log.warn` and proceed. On other errors, throw.
- [ ] Subscribe to `AgentSession` events and:
  - Dispatch `onTextDelta`/`onToolStart`/`onToolEnd`/`onStatusUpdate`/`onAgentEnd` per the mapping in the design.
  - Append every event verbatim to `events.jsonl` via `appendEvent()`.
- [ ] Implement `prompt()`:
  - If `session.isStreaming`, call `session.followUp(text)`.
  - Else, call `session.sendUserMessage(text)`.
- [ ] Implement `abort()` as `await session.abort()`.
- [ ] Verify `bun run typecheck` passes.

Commit: `phase 3: implement AgentRunner with pi wiring and event→callback mapping`

## Phase 4: Tests and lint guards

- [ ] Add `src/agent/mod.test.ts` covering:
  - Lazy pi creation (no session until first `prompt`).
  - Cwd and shared services paths are passed to pi correctly (inspect the `AgentSession` constructor arguments via a spy, or via the resulting file layout).
  - Custom tool callback fires `onToolStart`/`onToolEnd` with the right args.
  - `events.jsonl` contains one line per pi event across a complete turn.
  - `followUp` is used when `isStreaming === true`.
  - `abort()` resolves after idle.
- [ ] Add a lint/test check that walks `src/agent/**/*.ts` imports and asserts none match `^grammy` or `\.\./tg/`. Implement as a `bun test` that runs `grep -r` or a small AST walk.
- [ ] Verify `bun run typecheck` + `bun test` pass green.

Commit: `phase 4: test AgentRunner behavior and enforce telegram-agnostic boundary`

## Phase 5: Wire bot.ts to the runner (minimal)

- [ ] In `src/bot.ts`, add a `Map<string, AgentRunner>` keyed by `sessionId`.
- [ ] On message receive (after allowlist + session resolve), look up or lazily construct the runner for that session. For this change only, pass `customTools = []`.
- [ ] Build a minimal `TurnCallbacks` implementation that:
  - Accumulates `onTextDelta` into a string.
  - On `onAgentEnd`, sends one `ctx.reply(text)` with the accumulated content.
  - Logs tool starts/ends at debug level.
  - This is intentionally crude — real behavior arrives in the `message-buffer-streaming` change.
- [ ] Smoke test end-to-end: run `bun run dev`, send a "hello" to the bot, confirm a reply arrives and `events.jsonl` contains events.
- [ ] Verify `bun run typecheck` + `bun test` pass.

Commit: `phase 5: wire AgentRunner into bot.ts with a minimal reply callback`

## Phase 6: Validate and archive

- [ ] `litespec validate agent-runner` (strict).
- [ ] Manual review of the spec deltas vs the implementation.
- [ ] `litespec preview agent-runner` to see the canonical spec diff.
- [ ] `litespec archive agent-runner` when satisfied.
