# orchestration

## MODIFIED Requirements

### Requirement: Agent turns do not block unrelated updates

Telegram message handlers SHALL schedule normal agent work without waiting for the work promise to settle, so one busy agent turn or slow media pre-processing step does not hold grammy's global update handling path. Scheduled work SHALL stop before user-visible side effects when its runner is no longer the active runner for that session.

For non-command text messages on a session whose runner is currently streaming, the bot SHALL steer the message into the running turn via `AgentRunner.followUp()` rather than enqueue it. The update handler SHALL resolve as soon as the `followUp` call is dispatched (it does not await the turn's completion). The in-flight `MessageBuffer` continues to render the same turn; no new status line or response bubble is created for the steered message itself.

If the turn ends between the `isStreaming` check and the `followUp` call (a race), `followUp` SHALL throw an error containing "not streaming" and the bot SHALL fall back to scheduling a fresh turn via `schedulePrompt` + `AgentRunner.prompt()` with a new `MessageBuffer`. The message MUST NOT be silently dropped — it lands as a new turn instead of a steer.

For non-command text messages on a session whose runner is idle, the bot SHALL schedule a new turn via `AgentRunner.prompt()`. Same-session turns that do not overlap (the runner is idle when the next message arrives) SHALL remain ordered: the second SHALL NOT start until the first settles.

For `/queue <text>` commands, the bot SHALL serialize the supplied text via the per-session promise queue so it runs as a fresh turn only after the current turn (and any prior queued work) settles. This is the only path that uses the queue for text.

Media messages (photo, document, voice) SHALL continue to serialize via the per-session promise queue regardless of streaming state, because `followUp` is text-only in this change.

#### Scenario: Busy turn releases the update handler

- **GIVEN** an active session whose runner prompt remains pending
- **WHEN** a non-command text message is handled
- **THEN** the Telegram update handler SHALL resolve before the runner prompt settles

#### Scenario: Steer reaches a busy runner

- **GIVEN** an active session whose runner is streaming
- **WHEN** a non-command text message is handled for that session
- **THEN** the bot SHALL call `runner.followUp(text)` without awaiting the turn's completion
- **AND** the in-flight `MessageBuffer` SHALL continue to render the same turn
- **AND** no new status message or response bubble SHALL be created for the steered message

#### Scenario: Steer race falls back to a fresh turn

- **GIVEN** an active session whose runner is streaming when the bot checks `isStreaming`
- **WHEN** the turn ends between the `isStreaming` check and the `runner.followUp(text)` call
- **THEN** `followUp` SHALL throw an error containing "not streaming"
- **AND** the bot SHALL fall back to `schedulePrompt` + `runner.prompt(text, newBuffer)` so the message runs as a fresh turn
- **AND** the message SHALL NOT be silently dropped

#### Scenario: Cancel reaches a busy runner

- **GIVEN** an active session whose runner prompt remains pending
- **WHEN** `/cancel` is handled for that session
- **THEN** the command SHALL reach the active runner and reply without waiting for the pending prompt to settle

#### Scenario: Slow media pre-processing releases the update handler

- **GIVEN** an active session whose media download remains pending
- **WHEN** a media message is handled
- **THEN** the Telegram update handler SHALL resolve before the media download settles

#### Scenario: Stale media work does not side-effect

- **GIVEN** an active session whose scheduled media download remains pending
- **WHEN** a runner-disposing command replaces the session runner before the download finishes
- **THEN** the stale media work SHALL NOT save files, reply, or prompt the replaced runner after the download returns

#### Scenario: Overlapping same-session text is steered

- **GIVEN** an active session whose runner is idle
- **WHEN** a non-command text message arrives, starts a turn, and a second non-command text message arrives while the first turn is still streaming
- **THEN** the second message SHALL be steered into the running turn via `followUp` (not enqueued as a separate turn)

#### Scenario: Non-overlapping same-session turns remain ordered

- **GIVEN** an active session whose first turn has settled (runner is idle again)
- **WHEN** a second non-command text message arrives for the same session
- **THEN** the second SHALL start as a fresh turn via `AgentRunner.prompt()`
- **AND** it SHALL NOT start before the first turn settles (the per-session promise queue enforces ordering)

#### Scenario: /queue serializes behind a running turn

- **GIVEN** an active session whose runner is streaming
- **WHEN** `/queue do this after you finish` is handled
- **THEN** the supplied text SHALL be enqueued via the per-session promise queue
- **AND** it SHALL NOT start until the current turn and any prior queued work settle
- **AND** it SHALL run as a fresh turn via `AgentRunner.prompt()` (with a new `MessageBuffer` and memory snapshot)

#### Scenario: /queue when idle runs immediately

- **GIVEN** an active session whose runner is idle
- **WHEN** `/queue do this` is handled
- **THEN** the supplied text SHALL run as a fresh turn via `AgentRunner.prompt()` without waiting

#### Scenario: Media message while streaming serializes

- **GIVEN** an active session whose runner is streaming
- **WHEN** a photo message is handled
- **THEN** the photo download and prompt SHALL be enqueued via the per-session promise queue
- **AND** it SHALL NOT start until the current turn settles
