# orchestration

## MODIFIED Requirements

### Requirement: Agent turns do not block unrelated updates

The Telegram intake module (`src/tg/intake.ts`) SHALL schedule normal agent work without waiting for the work promise to settle, so one busy agent turn or slow media pre-processing step does not hold grammy's global update handling path. `src/bot.ts` SHALL remain a thin grammy adapter: its `bot.on(...)` handlers SHALL delegate to intake methods and SHALL NOT own scheduling, steer, or queue logic themselves. Scheduled work SHALL stop before user-visible side effects when its runner is no longer the active runner for that session.

For non-command text messages on a session whose runner is currently streaming, intake SHALL steer the message into the running turn via `AgentRunner.followUp()` rather than enqueue it. For `/queue <text>` commands, intake SHALL serialize the supplied text via the per-session promise queue. Media messages (photo, document, voice, audio) SHALL serialize via the per-session promise queue regardless of streaming state, because `followUp` is text-only. For voice messages that require Groq transcription, the transcription step SHALL run inside the same scheduled media task as the download and prompt, so the update handler continues to resolve without waiting for transcription.

> **Note:** The existing steer, cancel, `/queue`, photo/media serialization, and stale-runner guard scenarios are restated canon (existing implemented behavior from the `telegram-intake` and `command-registry` changes) and are not modified by this change. Only the two voice-specific scenarios below are new.

#### Scenario: Slow voice transcription releases the update handler

- **GIVEN** an active session whose Telegram voice download or Groq transcription remains pending
- **WHEN** a voice message is handled
- **THEN** the Telegram update handler SHALL resolve before transcription settles
- **AND** the transcription and prompt SHALL remain serialized through the per-session promise queue

#### Scenario: Stale ASR work does not side-effect

- **GIVEN** an active session whose scheduled voice transcription remains pending
- **WHEN** a runner-disposing command replaces the session runner before transcription finishes
- **THEN** the stale ASR work SHALL NOT save files, reply, or prompt the replaced runner after transcription returns
