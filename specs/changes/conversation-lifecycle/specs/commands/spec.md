# commands

## ADDED Requirements

### Requirement: Commands use conversation terminology

Command descriptions, help, diagnostics, status text, errors, and success replies SHALL use “conversation” for Goblin's durable history. They MUST NOT use “session” for a surface, binding, conversation, or conversation runtime; references to pi's `AgentSession` and retained compatibility/path names are exempt.

#### Scenario: Help is rendered

- **WHEN** `/help` lists lifecycle, model, compact, queue, voice, or schedule commands
- **THEN** descriptions that refer to durable Goblin history SHALL say “conversation”

#### Scenario: Missing binding is reported

- **WHEN** a command requires a bound conversation but the surface is unbound
- **THEN** its reply SHALL say “No active conversation” rather than “No active session”

### Requirement: Commands inspect before creating

Slash-command dispatch SHALL inspect the current surface binding without invoking ordinary-message resolve-or-start. Only `/new` and dependency-owned commands whose explicit contract creates a conversation may create one; status, listing, mutation, and unknown commands MUST NOT accidentally create a conversation.

#### Scenario: Status command on an unbound surface

- **WHEN** `/start`, `/debug`, `/archive`, `/name`, or a listing command is sent on an unbound surface
- **THEN** command dispatch SHALL observe no current conversation
- **AND** SHALL NOT create one as a side effect of resolution

### Requirement: Model and thinking commands update the Surface

`/model` and `/think` SHALL read and write preferences for the invoking Surface rather than the bound Conversation. A bound runtime MAY apply the preference immediately, but the persisted value SHALL survive `/new`, `/resume`, and `/archive` and SHALL be used by the next runtime on that Surface. These commands MUST NOT create a Conversation when invoked on an unbound Surface.

#### Scenario: Model survives new

- **WHEN** the user selects a model on a Surface and then runs `/new`
- **THEN** the fresh Conversation's runtime SHALL use the same Surface model preference

#### Scenario: Resumed conversation adopts destination thinking

- **GIVEN** a compatible Conversation is resumed onto a Surface with a thinking preference
- **WHEN** its runtime is created
- **THEN** it SHALL use the destination Surface's thinking preference

#### Scenario: Preference on unbound Surface

- **WHEN** `/model` or `/think` is used on an unbound Surface
- **THEN** it MAY update that Surface's preference without creating a Conversation

## MODIFIED Requirements

### Requirement: Implement /start command for DM session creation

The system SHALL provide `/start` as a welcome and current-status command on supported surfaces. It SHALL inspect the current binding without creating or rotating a conversation. On an unbound surface it SHALL explain that the next ordinary message will start a conversation and that `/new` can start one explicitly.

#### Scenario: Start with active conversation

- **WHEN** `/start` is sent on a surface with a bound conversation
- **THEN** the reply SHALL welcome the user and include the active conversation ID
- **AND** no binding or conversation state SHALL change

#### Scenario: Start on an unbound DM

- **WHEN** `/start` is sent on an unbound DM surface
- **THEN** no conversation SHALL be created
- **AND** the reply SHALL explain that the user can send a message or use `/new`

### Requirement: Handle /start in forum topic

`/start` in a topic SHALL use the same non-creating welcome/status behavior as every other supported surface and SHALL address the topic through its canonical `Surface` value.

#### Scenario: Start in an unbound topic

- **WHEN** `/start` is sent in an unbound topic
- **THEN** it SHALL NOT claim that a conversation already exists
- **AND** SHALL NOT create one

### Requirement: New command resets the chat to a fresh session

The queue-timing `/new` command SHALL rotate the invoking surface to a fresh conversation in that surface's effective execution environment. The previous conversation SHALL remain unarchived, unbound, and resumable; model/thinking preferences, schedules, and heartbeat configuration SHALL remain on the surface. The command MUST NOT mutate topic UI.

#### Scenario: New during active turn

- **WHEN** `/new` is sent while the current conversation is running a turn
- **THEN** it SHALL defer behind that turn with the existing queued acknowledgement
- **AND** the lifecycle module SHALL dispose the old runtime before committing the rotation
- **AND** queued work captured by the old runtime SHALL fail the stale-runtime guard

#### Scenario: New with prior conversation

- **WHEN** `/new` is sent on a surface with a bound conversation
- **THEN** a fresh conversation SHALL be created and bound to the same surface and environment
- **AND** the prior conversation SHALL remain resumable
- **AND** the reply SHALL include the new conversation ID

#### Scenario: New on an unbound surface

- **WHEN** `/new` is sent on an unbound supported surface
- **THEN** a fresh conversation SHALL be created and bound

### Requirement: New command creates a fresh resumable session

`/new` SHALL create a fresh resumable conversation through the lifecycle module and SHALL leave the prior conversation available to compatible `/resume` lookup. It SHALL NOT directly edit bindings, archive the prior conversation, or coordinate runner side effects in the command caller.

#### Scenario: Prior conversation remains resumable

- **WHEN** `/new` rotates away from a named conversation
- **THEN** `/resume` lookup on a surface with the same execution environment SHALL still include that conversation

### Requirement: Archive command queues and archives session

The queue-timing `/archive` command SHALL ask the lifecycle module to dispose the current conversation runtime, move the conversation directory to `state/sessions/archive/<id>/`, and clear its binding. It SHALL leave surface settings, schedules, heartbeat configuration, and Telegram topic UI unchanged. The next authorized ordinary message on the surface SHALL lazily start a fresh conversation.

#### Scenario: Archive during streaming

- **WHEN** `/archive` is sent while a turn is running
- **THEN** it SHALL defer until the turn settles
- **AND** archive through the lifecycle module

#### Scenario: Archive leaves surface automation

- **WHEN** a bound conversation is archived on a surface with enabled schedules
- **THEN** the surface SHALL become unbound
- **AND** the schedules SHALL remain enabled and pending without creating a conversation

#### Scenario: Archive with no conversation

- **WHEN** `/archive` is sent on an unbound surface
- **THEN** the reply SHALL say `No active conversation to archive.`

### Requirement: Debug command dumps diagnostics

`/debug` SHALL run immediately and report the active conversation ID and optional name using `Conversation:` and `Conversation Name:` labels. It SHALL report surface-owned model/thinking settings and automation separately from conversation-owned creation time, transcript, metrics, pi context, and immutable execution environment.

#### Scenario: Named conversation

- **WHEN** `/debug` is invoked for a conversation named `ttt-v2`
- **THEN** output SHALL contain `Conversation: <id>` followed by `Conversation Name: ttt-v2`

#### Scenario: Unbound surface

- **WHEN** `/debug` is invoked on an unbound surface
- **THEN** it SHALL report that no active conversation exists without creating one

### Requirement: Name command persists bound session title

The instant-timing `/name <name>` command SHALL persist the current conversation's name. It SHALL require a bound conversation and SHALL use conversation terminology in usage, success, and error replies.

#### Scenario: Name current conversation

- **WHEN** `/name memory refactor` is sent on a bound surface
- **THEN** the bound conversation's name SHALL become `memory refactor`
- **AND** the reply SHALL include its conversation ID and name

#### Scenario: Name unbound surface

- **WHEN** `/name memory refactor` is sent on an unbound surface
- **THEN** the reply SHALL say `No active conversation to name.`

### Requirement: Resume command binds chat to an existing resumable session

The queue-timing `/resume <id-or-name>` command SHALL resolve exact ID, unique ID prefix, or exact name among non-archived conversations compatible with the destination surface's effective execution environment. A compatible target active elsewhere SHALL be atomically moved to the destination after its old runtime and the destination's displaced runtime are disposed. An incompatible, missing, or ambiguous target MUST leave bindings and runtimes unchanged.

#### Scenario: Resume compatible unbound conversation

- **WHEN** `/resume <target>` uniquely selects an unbound compatible conversation
- **THEN** the lifecycle module SHALL bind it to the destination
- **AND** the destination's prior conversation SHALL remain stored and resumable

#### Scenario: Resume moves conversation from another surface

- **GIVEN** the target is active on compatible surface X
- **WHEN** `/resume <target>` is sent on surface Y
- **THEN** the target runtime on X and displaced runtime on Y SHALL be disposed before one atomic binding move
- **AND** the target SHALL be bound only to Y

#### Scenario: Resume incompatible conversation

- **WHEN** the target exists but its immutable execution environment differs from the destination's effective environment
- **THEN** `/resume` SHALL report the incompatibility
- **AND** SHALL NOT dispose a runtime or change a binding

#### Scenario: Resume without target

- **WHEN** `/resume` is sent without a target
- **THEN** it SHALL list only named, non-archived conversations compatible with the invoking surface
- **AND** SHALL identify them as conversations

### Requirement: Name and resume use the timing classification

`/name` SHALL remain instant-timing and `/resume` SHALL remain queue-timing. A deferred resume SHALL execute only while its captured runtime is still current; otherwise the stale-runtime guard SHALL drop it before lifecycle mutation.

#### Scenario: Resume during active turn

- **WHEN** `/resume <target>` is sent while the current runtime is streaming
- **THEN** it SHALL defer without aborting the turn
- **AND** SHALL move the binding only after the turn settles and the runtime is disposed

### Requirement: Schedule command manages explicit scheduled turns

The instant-timing `/schedule` command SHALL create, list, remove, pause, and resume schedules owned by the invoking surface rather than by its current conversation. Schedule management SHALL remain available while the surface is unbound; a newly due occurrence on an unbound surface remains pending. Existing source authority, time grammar, and display behavior SHALL be preserved.

#### Scenario: Schedule survives new and resume

- **GIVEN** a surface owns a schedule
- **WHEN** `/new` or `/resume` changes the bound conversation
- **THEN** `/schedule list` SHALL show the same schedule
- **AND** no schedule record SHALL be copied or retargeted

#### Scenario: Manage schedule while unbound

- **WHEN** `/schedule list`, `pause`, `resume`, or `remove` is sent on an unbound surface
- **THEN** it SHALL operate on that surface's schedules without creating a conversation

### Requirement: Schedule command manages heartbeat

`/schedule heartbeat` SHALL manage the invoking surface's explicit heartbeat record and surface-specific prompt configuration. Heartbeat SHALL remain disabled by default, use the existing 30-minute default, and survive conversation rotation, movement, archive, and temporary lack of a binding.

#### Scenario: Heartbeat status after rotation

- **GIVEN** heartbeat is enabled for a surface
- **WHEN** `/new` rotates its conversation
- **THEN** `/schedule heartbeat status` SHALL report the same interval and next run

### Requirement: Help command lists available commands

`/help` SHALL continue to derive its output from `COMMAND_REGISTRY`, and every description SHALL use the canonical lifecycle terms. Existing command names and aliases SHALL remain unchanged.

#### Scenario: Lifecycle commands in help

- **WHEN** `/help` is sent
- **THEN** `/new`, `/archive`, `/name`, `/resume`, `/debug`, `/compact`, `/queue`, `/voice`, and `/schedule` descriptions SHALL refer to conversations or surfaces as appropriate

## REMOVED Requirements

### Requirement: Reject /start in non-forum groups
