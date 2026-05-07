# Capability: Project Directory Command

## ADDED Requirement: /project binds session to directory

The `/project` command SHALL bind the current Telegram session to a filesystem directory. The binding is persisted in the session's `state.json` and takes effect on the next agent turn.

### Scenario: binding to an existing directory
- **WHEN** the user sends `/project /home/daniel/project` in a session
- **THEN** the session's `projectDir` is set to `/home/daniel/project`
- **AND** the agent replies "Project bound to `/home/daniel/project`"
- **AND** the next message recreates the agent runner with that directory as cwd and agentDir

### Scenario: clearing the binding
- **WHEN** the user sends `/project none` or `/project clear`
- **THEN** the session's `projectDir` is cleared
- **AND** the agent replies "Project directory cleared."

### Scenario: no active session
- **WHEN** the user sends `/project` without an active session
- **THEN** the agent replies "No active session. Start a conversation first."

### Scenario: missing argument
- **WHEN** the user sends `/project` with no path argument
- **THEN** the agent replies "Usage: `/project <path>` or `/project none` to clear."

### Scenario: path does not exist
- **WHEN** the user sends `/project /nonexistent/path`
- **THEN** the agent replies "Path does not exist or is not a directory."

### Scenario: path is a file
- **WHEN** the user sends `/project /etc/passwd`
- **THEN** the agent replies "Path does not exist or is not a directory."

## ADDED Requirement: path parsing and resolution

The command SHALL parse the argument using space-safe extraction (everything after `/project `) and resolve paths before validation.

### Scenario: tilde expansion for home directory
- **WHEN** the user sends `/project ~`
- **THEN** the path is expanded to the user's home directory

### Scenario: tilde expansion for home subdirectory
- **WHEN** the user sends `/project ~/foo`
- **THEN** the path is expanded to `$HOME/foo`

### Scenario: relative path resolution
- **WHEN** the user sends `/project ./src`
- **THEN** the path is resolved to an absolute path relative to the goblin process CWD

### Scenario: paths with spaces
- **WHEN** the user sends `/project /home/daniel/my projects/foo`
- **THEN** the full path including spaces is captured and resolved

## ADDED Requirement: cascade-cancel safety

`/project` SHALL be treated as a cancel-capable command. Before executing, any in-flight agent stream and live subagents SHALL be aborted.

### Scenario: agent is streaming when /project arrives
- **WHEN** the agent is mid-stream
- **AND** the user sends `/project ~/foo`
- **THEN** the stream is aborted via interruptAndCascade
- **AND** the project binding is applied
- **AND** the reply includes any cascade timeout suffix if applicable

## ADDED Requirement: runner disposal on change

When the project directory is changed, the existing AgentRunner SHALL be disposed and removed from the active runner map. The next user message SHALL lazily create a new runner with the updated directory.

### Scenario: runner disposal during /project
- **WHEN** `/project` changes the binding
- **THEN** the existing runner is disposed
- **AND** it is removed from the runner map even if dispose() throws
- **AND** the next message creates a fresh runner with the new projectDir

## ADDED Requirement: session state persistence

The project directory binding SHALL be persisted in the session's `state.json` and survive process restarts.

### Scenario: binding survives restart
- **WHEN** a session has `projectDir` set
- **AND** goblin restarts
- **THEN** resolving the session loads the `projectDir` from state.json
- **AND** the next message creates a runner with that directory
