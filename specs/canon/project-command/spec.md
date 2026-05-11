# Capability: Project Directory Command

## Requirements

### Requirement: /project binds session to directory

The `/project` command SHALL bind the current Telegram chat surface (topic or DM) to a filesystem directory. The binding SHALL be persisted in `topic-settings.json` and SHALL affect all current and future sessions on that chat surface.

#### Scenario: binding to an existing directory

- **WHEN** the user sends `/project /home/daniel/project` in a topic
- **THEN** `topic-settings.json` SHALL contain `projectDir: "/home/daniel/project"` for that topic
- **AND** the agent replies "Project bound to `/home/daniel/project`"
- **AND** the next message in that topic creates the agent runner with that directory as cwd and agentDir
- **AND** the binding survives `/new` because it is chat-surface-scoped

#### Scenario: clearing the binding

- **WHEN** the user sends `/project none` or `/project clear`
- **THEN** the `projectDir` for that chat surface SHALL be removed from `topic-settings.json`
- **AND** the agent replies "Project directory cleared."

#### Scenario: no active session

- **WHEN** the user sends `/project` without an active session
- **THEN** the agent replies "No active session. Start a conversation first."

#### Scenario: missing argument

- **WHEN** the user sends `/project` with no path argument
- **THEN** the agent replies "Usage: `/project <path>` or `/project none` to clear."

#### Scenario: path does not exist

- **WHEN** the user sends `/project /nonexistent/path`
- **THEN** the agent replies "Path does not exist or is not a directory."

#### Scenario: path is a file

- **WHEN** the user sends `/project /etc/passwd`
- **THEN** the agent replies "Path does not exist or is not a directory."

### Requirement: path parsing and resolution

The command SHALL parse the argument using space-safe extraction (everything after `/project `) and resolve paths before validation.

#### Scenario: tilde expansion for home directory

- **WHEN** the user sends `/project ~`
- **THEN** the path is expanded to the user's home directory

#### Scenario: tilde expansion for home subdirectory

- **WHEN** the user sends `/project ~/foo`
- **THEN** the path is expanded to `$HOME/foo`

#### Scenario: relative path resolution

- **WHEN** the user sends `/project ./src`
- **THEN** the path is resolved to an absolute path relative to the goblin process CWD

#### Scenario: paths with spaces

- **WHEN** the user sends `/project /home/daniel/my projects/foo`
- **THEN** the full path including spaces is captured and resolved

### Requirement: cascade-cancel safety

`/project` SHALL be treated as a cancel-capable command. Before executing, any in-flight agent stream and live subagents SHALL be aborted.

#### Scenario: agent is streaming when /project arrives

- **WHEN** the agent is mid-stream
- **AND** the user sends `/project ~/foo`
- **THEN** the stream is aborted via interruptAndCascade
- **AND** the project binding is applied
- **AND** the reply includes any cascade timeout suffix if applicable

### Requirement: runner disposal on change

When the project directory is changed, the existing AgentRunner SHALL be disposed and removed from the active runner map. The next user message SHALL lazily create a new runner with the updated directory.

#### Scenario: runner disposal during /project

- **WHEN** `/project` changes the binding
- **THEN** the existing runner is disposed
- **AND** it is removed from the runner map even if dispose() throws
- **AND** the next message creates a fresh runner with the new projectDir from the binding

### Requirement: /project binding persists across restarts

The `projectDir` binding set by `/project` SHALL persist in `topic-settings.json` and survive process restarts and `/new`.

#### Scenario: binding survives restart

- **WHEN** a topic has `projectDir: "/home/daniel/project"` in `topic-settings.json`
- **AND** goblin restarts
- **THEN** `getProjectDir(locator)` SHALL still return `"/home/daniel/project"`
- **AND** the next message in that topic creates the runner with that directory

#### Scenario: binding survives /new

- **WHEN** a topic has `projectDir: "/home/daniel/project"` in `topic-settings.json`
- **AND** the user sends `/new`
- **THEN** the new session SHALL NOT have `projectDir` in `state.json`
- **AND** `getProjectDir(locator)` SHALL still return `"/home/daniel/project"`
- **AND** the next message creates the runner with that directory
