# commands

## ADDED Requirements

### Requirement: Name command persists bound session title

The `/name <name>` command SHALL cancel any active turn, require a bound session, and persist the provided name as the bound session's `SessionState.title`.

If no session is bound to the chat, the reply SHALL be "No active session to name."

If no name is provided, the reply SHALL be "Usage: /name <session name>".

#### Scenario: Name bound session

- **WHEN** `/name memory refactor` is sent in a chat with a bound session
- **THEN** the bound session's `title` SHALL be set to `"memory refactor"`
- **AND** the reply SHALL include the session ID and title

#### Scenario: Name with no bound session

- **WHEN** `/name memory refactor` is sent in a DM with no bound session
- **THEN** the reply SHALL say `"No active session to name."`

#### Scenario: Name without argument

- **WHEN** `/name` is sent
- **THEN** the reply SHALL show usage

### Requirement: Resume command binds chat to an existing resumable session

The `/resume <id-or-name>` command SHALL cancel any active turn, find an existing resumable session by exact ID, unique ID prefix, or exact title, and bind the current Telegram surface to that session.

The command SHALL NOT archive, delete, or mutate the previously bound session. If switching away from an in-memory runner, the old runner SHALL be disposed so future messages use the resumed session's runner.

If no target is provided, the reply SHALL list named resumable sessions. Anonymous sessions SHALL be omitted from this listing.

If no session matches, the reply SHALL report that no session was found for the target.

If multiple sessions match, the reply SHALL report the ambiguity and list matching session IDs and titles.

Archived sessions under `sessions/archive/` SHALL NOT be considered by `/resume`.

#### Scenario: Resume by exact session ID

- **WHEN** `/resume abc123def0` is sent
- **AND** a resumable session with ID `abc123def0` exists
- **THEN** the current chat surface SHALL be bound to `abc123def0`
- **AND** the reply SHALL include the resumed session ID

#### Scenario: Resume by ID prefix

- **WHEN** `/resume abc123` is sent
- **AND** exactly one resumable session ID starts with `abc123`
- **THEN** the current chat surface SHALL be bound to that session

#### Scenario: Resume by exact title

- **WHEN** `/resume memory refactor` is sent
- **AND** exactly one resumable session has title `"memory refactor"`
- **THEN** the current chat surface SHALL be bound to that session

#### Scenario: Resume ambiguous target

- **WHEN** `/resume abc` is sent
- **AND** more than one resumable session ID starts with `abc`
- **THEN** the command SHALL NOT change the current binding
- **AND** the reply SHALL list matching sessions

#### Scenario: Resume named prior session after new

- **WHEN** `/name ttt` is sent in a chat with a bound session
- **AND** `/new` is sent in the same chat
- **AND** `/resume ttt` is sent in the same chat
- **THEN** the chat surface SHALL be rebound to the session named `ttt`
- **AND** the session created by `/new` SHALL remain under `sessions/<id>/` as a resumable unbound session

#### Scenario: Archived sessions are not resumed

- **WHEN** `/archive` is used on a session named `ttt`
- **AND** `/resume ttt` is sent
- **THEN** `/resume` SHALL NOT find that archived session

#### Scenario: Resume without argument lists named sessions

- **WHEN** `/resume` is sent
- **AND** at least one resumable session has a title
- **THEN** the reply SHALL list named resumable sessions with their IDs and titles
- **AND** unnamed sessions SHALL be omitted

#### Scenario: Resume without argument and no named sessions

- **WHEN** `/resume` is sent
- **AND** no resumable session has a title
- **THEN** the reply SHALL say no named sessions exist yet

### Requirement: Name and resume are cancel-capable commands

The `/name` and `/resume` commands SHALL be added to the cancel-capable command set in `bot.ts`, giving them the same interrupt semantics as `/model`, `/debug`, `/archive`, `/new`, `/compact`, and `/cancel`.

#### Scenario: Resume during active turn

- **WHEN** `/resume <target>` is sent while the agent is streaming
- **THEN** the current turn SHALL be aborted with cascade before the binding changes

#### Scenario: Name during active turn

- **WHEN** `/name <name>` is sent while the agent is streaming
- **THEN** the current turn SHALL be aborted with cascade before the title changes

### Requirement: Help command lists name and resume

The `/help` command SHALL list `/name <name>` and `/resume <id-or-name>` in the available command list.

#### Scenario: Help output includes session management commands

- **WHEN** `/help` is sent
- **THEN** the reply SHALL include `/name`
- **AND** the reply SHALL include `/resume`

## MODIFIED Requirements

### Requirement: New command switches to a fresh resumable session

The `/new` command SHALL cancel any active turn, create a fresh session bound to the same chat surface (DM, forum topic, or supergroup), and switch to it. If the chat surface previously had a bound session, that previous session SHALL remain under `sessions/<id>/` as an unbound resumable session. `/new` MUST NOT archive the previous session. The forum topic title MUST NOT be modified — the topic surface is user-owned per decision `topic-ui-is-user-owned` (0002).

#### Scenario: New with prior bound session

- **WHEN** `/new` is sent while a session is bound to the chat
- **THEN** a new session SHALL be created and bound to the same chat surface
- **AND** the previously bound session SHALL remain under `sessions/<old-id>/`
- **AND** the previously bound session SHALL be included in resume lookup
- **AND** the previously bound session SHALL NOT be moved to `sessions/archive/<old-id>/`

#### Scenario: New in a forum topic

- **WHEN** `/new` is sent in a forum topic
- **THEN** the active turn SHALL be aborted (if streaming, with cascade to subagents)
- **AND** a fresh session SHALL be created and bound to the same `(chat, topic)`
- **AND** the previous topic session SHALL remain resumable
- **AND** the topic title MUST NOT be modified
