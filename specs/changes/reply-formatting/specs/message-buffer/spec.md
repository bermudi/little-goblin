# message-buffer

## MODIFIED Requirements

### Requirement: Response text streams via edits

Text deltas from `onTextDelta` SHALL accumulate into a response message, edited periodically (not per-delta), and roll over to a new message at 4096 characters. Each contiguous run of assistant text between tool calls forms one such response message; tool boundaries seal the current message and start a new one as described in **Response message segments at tool boundaries**. Within a single segment, behavior is unchanged.

Response `sendMessage` and `editMessageText` calls SHALL set `parse_mode: "MarkdownV2"` so the model's markdown (bold, italic, code spans, fenced code blocks, links) renders natively in Telegram. When Telegram returns a 400 parse error on a MarkdownV2 send or edit, the buffer SHALL strip markdown formatting from the text and retry the same call as plain text (no `parse_mode`). The plain-text retry SHALL use a cleanup function that removes MarkdownV2 escape backslashes and formatting markers (`*bold*`, `_italic_`, `~strike~`, `||spoiler||`, `` `code` ``) to produce readable text, not raw syntax. The retry SHALL occur at most once per send/edit attempt; if the plain-text retry also fails, the error SHALL be handled by the existing `handleApiError` path.

The rollover split logic SHALL escape MarkdownV2-special characters in the split boundary so that a split does not produce an unpaired formatting marker that triggers a 400. If the split lands inside an inline code span (odd backtick count before the split point), the split SHALL move backward to before the last unescaped backtick.

#### Scenario: Text accumulation

- **WHEN** `onTextDelta` is called 50 times with ~10 chars each within a single segment (no tool boundary)
- **THEN** the buffer SHALL accumulate into one string
- **AND** send at most ~1 edit per second (≥1100ms minimum between edits) to stay under Telegram's per-chat write budget
- **AND** each edit SHALL set `parse_mode: "MarkdownV2"`

#### Scenario: 4096 rollover

- **WHEN** accumulated text within a single segment exceeds 4096 characters
- **THEN** the current message SHALL be sent as-is with `parse_mode: "MarkdownV2"`
- **AND** a new response message SHALL be started for subsequent deltas in the same segment

#### Scenario: MarkdownV2 parse error falls back to plain text

- **WHEN** a `sendMessage` or `editMessageText` with `parse_mode: "MarkdownV2"` returns a 400 error indicating a parse failure
- **THEN** the buffer SHALL strip markdown formatting from the text
- **AND** retry the same send or edit without `parse_mode`
- **AND** the plain-text retry SHALL occur at most once
- **AND** if the plain-text retry also fails, the existing `handleApiError` path SHALL handle the error

#### Scenario: Rollover split avoids breaking inline code spans

- **WHEN** a rollover split point falls inside an inline code span (odd unescaped backtick count before the split)
- **THEN** the split SHALL move backward to before the last unescaped backtick
- **AND** both resulting chunks SHALL be valid MarkdownV2

### Requirement: Big output escapes to file attachment

When response text exceeds ~20KB, the buffer SHALL send the full content as a `reply.md` file attachment with a short summary text message. The summary message SHALL be sent with `parse_mode: "MarkdownV2"`.

#### Scenario: Large output

- **WHEN** accumulated text exceeds 20000 characters
- **THEN** content SHALL be written to a temp file
- **AND** sent as `InputFile` with caption "Full response attached"
- **AND** the text message SHALL contain first 500 chars + "... [truncated, see file]"

## ADDED Requirements

### Requirement: Plain-text fallback is sticky per message

When a response message's MarkdownV2 send or edit fails with a 400 parse error and the buffer retries with plain text, the buffer SHALL set a `responseIsPlainText` flag for that message. All subsequent edits to the same message SHALL use plain text (no `parse_mode`) without attempting MarkdownV2 first. This prevents repeated MarkdownV2 failures on every subsequent edit as more tokens arrive.

The flag SHALL be reset when a new response message is created (tool boundary seal, rollover to a new message, or `onAgentEnd` creating a final message). The reset allows MarkdownV2 to be attempted fresh on the new message, since different content may parse successfully.

#### Scenario: Fallback sticks for subsequent edits

- **WHEN** a MarkdownV2 edit fails with a 400 parse error and the plain-text retry succeeds
- **AND** more text deltas arrive and the next flush edits the same message
- **THEN** the buffer SHALL send the edit without `parse_mode` (plain text)
- **AND** SHALL NOT attempt MarkdownV2 first

#### Scenario: Fallback resets on new message

- **WHEN** a tool boundary seal creates a new response message after a plain-text fallback on the prior message
- **THEN** the new message SHALL attempt MarkdownV2 on its first send
- **AND** the `responseIsPlainText` flag SHALL be `false` for the new message

#### Scenario: Fallback resets on rollover

- **WHEN** a 4096-char rollover creates a new response message after a plain-text fallback on the prior chunk
- **THEN** the new message SHALL attempt MarkdownV2 on its first send

### Requirement: MarkdownV2 escape helper

A `src/tg/format.ts` module SHALL export an `escapeMdV2(text: string): string` function that escapes all MarkdownV2-special characters (`_*[]()~`>#+-=|{}.!\\`) with a preceding backslash, except inside fenced code blocks (```...```) and inline code spans (`...`) where content SHALL be left untouched. The function SHALL be used by the system reply formatter and MAY be used by the buffer for split-boundary escaping.

#### Scenario: Plain text escaped

- **WHEN** `escapeMdV2("Hello. World [test] (foo)")` is called
- **THEN** it SHALL return `"Hello\\. World \\[test\\] \\(foo\\)"`

#### Scenario: Code span content preserved

- **WHEN** `escapeMdV2("See `const x = 1` for details")` is called
- **THEN** the content inside the backticks (`const x = 1`) SHALL NOT be escaped
- **AND** the text outside the backticks SHALL be escaped

#### Scenario: Fenced code block content preserved

- **WHEN** `escapeMdV2("Here:\n```js\nconst x = a.b;\n```\nDone.")` is called
- **THEN** the lines inside the fenced block SHALL NOT be escaped
- **AND** the text outside the fenced block SHALL be escaped

### Requirement: System reply formatter

A `src/tg/format.ts` module SHALL export a `systemReply(text: string, tag: SystemTag): string` function that wraps the text as a MarkdownV2-formatted system message with a monospaced tag prefix. The returned string SHALL be ready to send with `parse_mode: "MarkdownV2"`.

`SystemTag` SHALL be a union type of `"ok" | "error" | "warn" | "info" | "queued"`.

The format SHALL be: `` `[tag]` `` followed by a space and the escaped text. The tag SHALL be wrapped in backticks so it renders as monospaced text in Telegram. The text SHALL be escaped via `escapeMdV2` so it is safe for MarkdownV2.

#### Scenario: Success tag

- **WHEN** `systemReply("Project bound to /home/goblin", "ok")` is called
- **THEN** it SHALL return a string starting with `` `[ok]` ``
- **AND** the path SHALL be escaped for MarkdownV2 (e.g. `/home/goblin` → `/home/goblin` with `.` escaped if present)

#### Scenario: Error tag

- **WHEN** `systemReply("Failed to save file.txt", "error")` is called
- **THEN** it SHALL return a string starting with `` `[error]` ``

#### Scenario: Queued tag

- **WHEN** `systemReply("Will run after this turn.", "queued")` is called
- **THEN** it SHALL return a string starting with `` `[queued]` ``

### Requirement: sendSystemReply helper

A `src/tg/format.ts` module SHALL export a `sendSystemReply(message: TelegramIntakeMessage, text: string, tag: SystemTag, opts?: { silent?: boolean }): Promise<void>` function that formats the text via `systemReply` and sends it via `message.reply` with `parse_mode: "MarkdownV2"` and `disable_notification: true` (unless `opts.silent === false`).

The `message.reply` call SHALL pass the formatted text and a second argument `{ parse_mode: "MarkdownV2", disable_notification: true }` (or `{ parse_mode: "MarkdownV2" }` when silent is false). grammy's `message.reply` accepts `Other` options as a second parameter.

On 400 parse error from `message.reply`, the helper SHALL retry once with plain text (no `parse_mode`), stripping the tag prefix's backticks so the tag renders as `[ok]` in plain text. If the plain-text retry also fails, the error SHALL be logged and swallowed (system replies must not crash the bot).

#### Scenario: Silent system reply

- **WHEN** `sendSystemReply(message, "Project bound to /path", "ok")` is called
- **THEN** `message.reply` SHALL be called with the formatted MarkdownV2 text
- **AND** `disable_notification` SHALL be `true`

#### Scenario: Non-silent system reply

- **WHEN** `sendSystemReply(message, "Session archived.", "ok", { silent: false })` is called
- **THEN** `message.reply` SHALL be called with the formatted MarkdownV2 text
- **AND** `disable_notification` SHALL NOT be set

#### Scenario: Parse error falls back to plain text

- **WHEN** `message.reply` returns a 400 parse error
- **THEN** the helper SHALL retry with plain text (no `parse_mode`)
- **AND** the plain-text version SHALL render the tag as `[ok]` without backticks
- **AND** if the retry also fails, the error SHALL be logged and swallowed
