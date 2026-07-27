# telegram

## ADDED Requirements

### Requirement: MessageBuffer delivers out-of-band notices

`MessageBuffer` SHALL expose `sendNotice(text: string): Promise<void>` for bounded, non-blocking informational notices such as a prompt-file write summary. It SHALL deliver the text by reusing `sendSystemReply` with the `"info"` tag and silent delivery (`disable_notification: true`), sharing formatting and plain-text fallback with other system replies. It SHALL record a `telegram` metrics event in the `system` channel, reusing the existing `classifyTelegramError` path so success and Telegram-side failures are reported consistently with other sends. A Telegram-side failure SHALL propagate to the caller, which treats notice delivery as best-effort.

#### Scenario: Notice is sent as a silent info-tagged reply

- **WHEN** `MessageBuffer.sendNotice("Modified prompt file `SOUL.md`: wrote 12 lines (340 chars)")` is called
- **THEN** `sendSystemReply` SHALL be invoked with the text and tag `"info"`
- **AND** the message SHALL be sent with `disable_notification: true`
- **AND** a `telegram` metrics event with `channel: "system"` and `outcome: "success"` SHALL be recorded

#### Scenario: Telegram-side failure is classified and rethrown

- **WHEN** `bot.api.sendMessage` rejects during a notice
- **THEN** the error SHALL be classified via `classifyTelegramError`
- **AND** a `telegram` metrics event with `channel: "system"` and the classified outcome SHALL be recorded
- **AND** the error SHALL propagate to the caller
