# agent

## MODIFIED Requirements

### Requirement: TurnCallbacks interface defined in agent/events.ts

The `TurnCallbacks` interface SHALL be defined in `src/agent/events.ts` with the following seven required methods:

- `onTextDelta(text: string)`
- `onToolStart(name: string, input: unknown)`
- `onToolEnd(name: string, isError: boolean)`
- `onStatusUpdate(message: string)`
- `onMessageStart(message: AgentMessage | undefined)`
- `onMessageEnd(message: AgentMessage | undefined)`
- `onAgentEnd()`

The interface SHALL additionally declare one optional method:

- `sendNotice?(text: string): Promise<void>` — out-of-band informational notice delivery to the turn's Telegram Surface, used for bounded non-blocking messages such as a prompt-file write summary. Failure handling is the caller's responsibility; the runner MUST treat a missing or throwing `sendNotice` as best-effort and MUST NOT fail a tool call because of it.

The interface SHALL be re-exported from `src/agent/mod.ts` for backward compatibility.

`onMessageStart` and `onMessageEnd` are boundary signals for assistant messages. Implementers that do not need per-message boundaries (e.g., `GuestReplySink`) MAY implement them as no-ops. Implementers that do not deliver Telegram notices MAY omit `sendNotice`.

#### Scenario: Existing consumers continue to compile

- **WHEN** `import { TurnCallbacks } from "../agent/mod.ts"` is used
- **THEN** the type SHALL include all seven required methods plus the optional `sendNotice`
- **AND** the type SHALL be identical to `import { TurnCallbacks } from "../agent/events.ts"`

#### Scenario: Guest sink accepts boundaries as no-ops

- **WHEN** `GuestReplySink` implements `TurnCallbacks`
- **THEN** `onMessageStart` and `onMessageEnd` SHALL be present
- **AND** they SHALL not modify the accumulated `.text`

#### Scenario: Notice is optional

- **WHEN** a `TurnCallbacks` implementer omits `sendNotice`
- **THEN** the runner SHALL skip notice delivery for that turn
- **AND** no tool call SHALL fail as a result

## ADDED Requirements

### Requirement: Prompt-file writes surface a bounded Surface notice

The main `AgentRunner` SHALL track `tool_execution_start`/`tool_execution_end` pairs by `toolCallId`. On a successful (`isError: false`) `write` or `edit` tool call whose resolved target path matches one of the agent-owned reserved prompt files, the runner SHALL invoke `callbacks.sendNotice` with a bounded, content-free summary identifying the modified file.

The reserved prompt-file set SHALL be exactly:

- `$GOBLIN_HOME/workspace/SOUL.md`
- `$GOBLIN_HOME/workspace/AGENTS.md`
- `$GOBLIN_HOME/workspace/HEARTBEAT.md`
- `$GOBLIN_HOME/state/sessions/<sessionId>/HEARTBEAT.md` (the session-scoped heartbeat)

The tool argument path SHALL be resolved with `~` expansion matching pi's own path handling and then resolved against the runtime CWD before comparison. The notice text SHALL be of the form `` Modified prompt file `<filename>`: <summary> ``. For `write`, the summary SHALL be `wrote N lines (C chars)` or `wrote empty file`. For `edit`, the summary SHALL be `N edit(s)`. The notice SHALL NOT include any file content.

Notice delivery SHALL be best-effort and non-blocking. A missing or throwing `sendNotice` callback MUST NOT fail the tool call or alter the tool result.

#### Scenario: Write to SOUL.md posts a content-free notice

- **WHEN** the runner observes a successful `write` tool call whose resolved path is `$GOBLIN_HOME/workspace/SOUL.md`
- **THEN** `callbacks.sendNotice` SHALL be invoked once with a summary naming `SOUL.md`
- **AND** the summary SHALL include line and character counts but no file content

#### Scenario: Edit to AGENTS.md posts a notice

- **WHEN** the runner observes a successful `edit` tool call whose resolved path is `$GOBLIN_HOME/workspace/AGENTS.md`
- **THEN** `callbacks.sendNotice` SHALL be invoked once with a summary naming `AGENTS.md` and an edit count
- **AND** no file content SHALL be included

#### Scenario: Session-scoped HEARTBEAT is covered

- **WHEN** the runner observes a successful write to `$GOBLIN_HOME/state/sessions/<sessionId>/HEARTBEAT.md`
- **THEN** `callbacks.sendNotice` SHALL be invoked with a summary naming `HEARTBEAT.md`

#### Scenario: Non-prompt-file write posts no notice

- **WHEN** the runner observes a successful `write` to a path outside the reserved set
- **THEN** `callbacks.sendNotice` SHALL NOT be invoked

#### Scenario: Failed tool call posts no notice

- **WHEN** the runner observes a `write` or `edit` tool call with `isError: true`
- **THEN** `callbacks.sendNotice` SHALL NOT be invoked

#### Scenario: Missing sendNotice does not fail the turn

- **WHEN** the runner would post a notice but `callbacks.sendNotice` is undefined or throws
- **THEN** the tool call SHALL still complete normally
- **AND** the runner SHALL log the notice failure without rethrowing
