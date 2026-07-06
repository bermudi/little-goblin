# telegram

## ADDED Requirements

### Requirement: Intake system replies use tagged formatting

The intake module (`src/tg/intake.ts`) SHALL send all system replies via `sendSystemReply(message, text, tag)` from `src/tg/format.ts` instead of calling `message.reply(text)` directly. The tag SHALL be determined by the surrounding context:

- Download failures, save failures, command crash acks → `"error"`
- Save confirmations, project bound, session created → `"ok"`
- ASR not configured, no project directory set → `"warn"`
- No active session, no speech detected → `"info"`
- Queue acks → `"queued"`

The `recordAssistantReply` calls that log system replies for transcript purposes SHALL continue to log the raw text (without the tag prefix), preserving the existing transcript format.

#### Scenario: Download failure tagged as error

- **WHEN** an image download fails and intake sends a reply
- **THEN** `sendSystemReply` SHALL be called with tag `"error"`
- **AND** the reply SHALL be formatted with `` `[error]` `` prefix
- **AND** `recordAssistantReply` SHALL log the raw text without the tag prefix

#### Scenario: Save confirmation tagged as ok

- **WHEN** a document is saved to the project directory
- **THEN** `sendSystemReply` SHALL be called with tag `"ok"`
- **AND** the reply SHALL be formatted with `` `[ok]` `` prefix

#### Scenario: Queue ack tagged as queued

- **WHEN** a queue-timing command is deferred behind a streaming turn
- **THEN** `sendSystemReply` SHALL be called with tag `"queued"`
- **AND** the reply SHALL be formatted with `` `[queued]` `` prefix

#### Scenario: No active session tagged as info

- **WHEN** `replyNoActiveSession` is called
- **THEN** `sendSystemReply` SHALL be called with tag `"info"`
- **AND** the reply SHALL be formatted with `` `[info]` `` prefix

### Requirement: Command dispatch reply uses tagged formatting

The intake dispatch point SHALL send command results via `sendSystemReply(message, result.reply, result.tag ?? "ok")` when `result.kind === "replied"`. The `result.tag` field on `DispatchResult` provides the semantic category; when absent, `"ok"` SHALL be used as the default.

#### Scenario: Successful command reply

- **WHEN** a dispatched command returns `{ kind: "replied", reply: "Project bound to /path", tag: "ok" }`
- **THEN** the intake SHALL call `sendSystemReply(message, "Project bound to /path", "ok")`

#### Scenario: Failed command reply

- **WHEN** a dispatched command returns `{ kind: "replied", reply: "Failed to save.", tag: "error" }`
- **THEN** the intake SHALL call `sendSystemReply(message, "Failed to save.", "error")`

#### Scenario: Command reply without explicit tag defaults to ok

- **WHEN** a dispatched command returns `{ kind: "replied", reply: "Done.", sideEffects: [] }` (no `tag` field)
- **THEN** the intake SHALL call `sendSystemReply(message, "Done.", "ok")`

### Requirement: Grammy-only commands use tagged formatting

The `/start` and `/ping` commands (registered via `bot.command()` with `grammyHandler`) SHALL send their replies using `systemReply(text, "info")` from `src/tg/format.ts` to format the text, then pass the result to `ctx.reply` with `parse_mode: "MarkdownV2"` and `disable_notification: true`. These commands use `ctx.reply` directly (grammy handler path) rather than `TelegramIntakeMessage.reply`, so they do not go through `sendSystemReply`. The tag SHALL be `"info"` for both `/start` (informational welcome) and `/ping` (smoke-test status).

#### Scenario: /start reply

- **WHEN** `/start` is sent
- **THEN** the reply text SHALL be formatted via `systemReply(text, "info")`
- **AND** `ctx.reply` SHALL be called with the formatted text and `{ parse_mode: "MarkdownV2", disable_notification: true }`
- **AND** the reply SHALL render with `` `[info]` `` prefix in Telegram

#### Scenario: /ping reply

- **WHEN** `/ping` is sent
- **THEN** the reply text SHALL be formatted via `systemReply(text, "info")`
- **AND** `ctx.reply` SHALL be called with the formatted text and `{ parse_mode: "MarkdownV2", disable_notification: true }`
- **AND** the reply SHALL render with `` `[info]` `` prefix in Telegram
