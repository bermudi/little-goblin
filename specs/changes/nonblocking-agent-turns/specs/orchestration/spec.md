# orchestration

## ADDED Requirements

### Requirement: Agent turns do not block unrelated updates

Telegram message handlers SHALL schedule normal agent work without waiting for the work promise to settle, so one busy agent turn or slow media pre-processing step does not hold grammy's global update handling path. Scheduled work SHALL remain serialized for the same session to protect `AgentRunner`'s per-turn callback state and preserve message order. Scheduled work SHALL stop before user-visible side effects when its runner is no longer the active runner for that session.

#### Scenario: Busy turn releases the update handler

- **GIVEN** an active session whose runner prompt remains pending
- **WHEN** a non-command text message is handled
- **THEN** the Telegram update handler SHALL resolve before the runner prompt settles

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

#### Scenario: Same-session work remains ordered

- **GIVEN** an active session whose first scheduled work item remains pending
- **WHEN** a second non-command message for the same session is handled
- **THEN** the second work item SHALL NOT start until the first work item settles
