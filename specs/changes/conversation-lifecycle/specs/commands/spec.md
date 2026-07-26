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

### Requirement: Start command reports Surface conversation status

The system SHALL provide `/start` as a welcome and current-status command on supported surfaces. It SHALL inspect the current binding without creating or rotating a conversation. On an unbound surface it SHALL explain that the next ordinary message will start a conversation and that `/new` can start one explicitly.

#### Scenario: Start with active conversation

- **WHEN** `/start` is sent on a surface with a bound conversation
- **THEN** the reply SHALL welcome the user and include the active conversation ID
- **AND** no binding or conversation state SHALL change

#### Scenario: Start on an unbound DM

- **WHEN** `/start` is sent on an unbound DM surface
- **THEN** no conversation SHALL be created
- **AND** the reply SHALL explain that the user can send a message or use `/new`

### Requirement: New command rotates the Surface to a fresh Conversation

The queue-timing `/new` command SHALL rotate the invoking surface to a fresh conversation in that surface's effective execution environment. The previous conversation SHALL remain unarchived, unbound, and resumable; model/thinking preferences, schedules, and heartbeat configuration SHALL remain on the surface. The command MUST NOT mutate topic UI.

#### Scenario: New during active turn

- **WHEN** `/new` is sent while the current conversation is running a turn
- **THEN** it SHALL immediately acknowledge `Queued.` and defer behind that turn
- **AND** the lifecycle module SHALL dispose the old runtime before committing the rotation
- **AND** queued work captured by the old runtime SHALL fail the stale-runtime guard

#### Scenario: New with prior conversation

- **WHEN** `/new` is sent on a surface with a bound conversation
- **THEN** a fresh conversation SHALL be created and bound to the same surface and environment
- **AND** the prior conversation SHALL remain resumable
- **AND** the reply SHALL include the new conversation ID

#### Scenario: New fails while quiescing prior runtime

- **GIVEN** the Surface is bound to Conversation P
- **WHEN** `/new` cannot quiesce P's runtime
- **THEN** the command SHALL report failure
- **AND** no fresh Conversation SHALL be created
- **AND** P SHALL remain bound and resumable without reusing the invalidated runtime object

#### Scenario: New on an unbound surface

- **WHEN** `/new` is sent on an unbound supported surface
- **THEN** a fresh conversation SHALL be created and bound

### Requirement: New command preserves the prior resumable Conversation

`/new` SHALL create a fresh resumable conversation through the lifecycle module and SHALL leave the prior conversation available to compatible `/resume` lookup. It SHALL NOT directly edit bindings, archive the prior conversation, or coordinate runner side effects in the command caller.

#### Scenario: Prior conversation remains resumable

- **WHEN** `/new` rotates away from a named conversation
- **THEN** `/resume` lookup on a surface with the same execution environment SHALL still include that conversation

### Requirement: Archive command queues and archives the current Conversation

The queue-timing `/archive` command SHALL ask the lifecycle module to dispose the current conversation runtime, atomically clear its binding, and then move the conversation directory to `state/sessions/archive/<id>/`. It SHALL leave surface settings, schedules, heartbeat configuration, and Telegram topic UI unchanged. The next authorized ordinary message on the surface SHALL lazily start a fresh conversation.

#### Scenario: Archive during streaming

- **WHEN** `/archive` is sent while a turn is running
- **THEN** it SHALL immediately acknowledge `Queued.` and defer until the turn settles
- **AND** archive through the lifecycle module

#### Scenario: Archive leaves surface automation

- **WHEN** a bound conversation is archived on a surface with enabled schedules
- **THEN** the surface SHALL become unbound
- **AND** the schedules SHALL remain enabled and pending without creating a conversation

#### Scenario: Archive with no conversation

- **WHEN** `/archive` is sent on an unbound surface
- **THEN** the reply SHALL say `No active conversation to archive.`

#### Scenario: Archive storage move fails

- **WHEN** the lifecycle module clears the binding but cannot move the Conversation directory
- **THEN** `/archive` SHALL report failure
- **AND** the Conversation SHALL remain unbound, unarchived, and resumable
- **AND** surface settings and automation SHALL remain unchanged

### Requirement: Name command persists the bound Conversation name

The instant-timing `/name <name>` command SHALL persist the current conversation's name. It SHALL require a bound conversation and SHALL use conversation terminology in usage, success, and error replies.

#### Scenario: Name without argument

- **WHEN** `/name` is sent without a Conversation name
- **THEN** the reply SHALL be exactly `Usage: /name <conversation name>`
- **AND** no Conversation record SHALL change

#### Scenario: Name current conversation

- **WHEN** `/name memory refactor` is sent on a bound surface
- **THEN** the bound conversation's name SHALL become `memory refactor`
- **AND** the reply SHALL include its conversation ID and name

#### Scenario: Name unbound surface

- **WHEN** `/name memory refactor` is sent on an unbound surface
- **THEN** the reply SHALL say `No active conversation to name.`

### Requirement: Resume command binds the Surface to a resumable Conversation

The queue-timing `/resume <id-or-name>` command SHALL resolve exact ID, unique ID prefix, or exact name among non-archived conversations compatible with the destination surface's effective execution environment. A compatible target active elsewhere SHALL be atomically moved to the destination after its old runtime and the destination's displaced runtime are disposed. An incompatible, missing, or ambiguous target MUST leave bindings and runtimes unchanged. Missing targets SHALL be reported. Ambiguous matches SHALL list matching Conversation IDs and names. Without a target, the command SHALL list named compatible Conversations and SHALL explicitly report when none exist.

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

#### Scenario: Resume target is missing

- **WHEN** `/resume <target>` matches no compatible non-archived Conversation
- **THEN** the reply SHALL report that no Conversation was found for the target
- **AND** bindings and runtimes SHALL remain unchanged

#### Scenario: Resume target is ambiguous

- **WHEN** `/resume <target>` matches several compatible Conversations
- **THEN** the reply SHALL report ambiguity and list each matching Conversation ID and name
- **AND** bindings and runtimes SHALL remain unchanged

#### Scenario: Resume without target

- **WHEN** `/resume` is sent without a target
- **THEN** it SHALL list only named, non-archived conversations compatible with the invoking surface
- **AND** SHALL identify them as conversations

#### Scenario: Resume without target and no named Conversations

- **WHEN** `/resume` is sent and no named compatible Conversation exists
- **THEN** the reply SHALL say that no named Conversations exist yet

## MODIFIED Requirements

### Requirement: Handle /start in forum topic

`/start` in a topic SHALL use the same non-creating welcome/status behavior as every other supported surface and SHALL address the topic through its canonical `Surface` value.

#### Scenario: Start in an unbound topic

- **WHEN** `/start` is sent in an unbound topic
- **THEN** it SHALL NOT claim that a conversation already exists
- **AND** SHALL NOT create one

### Requirement: Debug command dumps diagnostics

`/debug` SHALL run immediately and report the active conversation ID and optional name using `Conversation:` and `Conversation Name:` labels. It SHALL report surface-owned model/thinking settings and automation separately from conversation-owned creation time, transcript, metrics, pi context, and immutable execution environment.

#### Scenario: Named conversation

- **WHEN** `/debug` is invoked for a conversation named `ttt-v2`
- **THEN** output SHALL contain `Conversation: <id>` followed by `Conversation Name: ttt-v2`

#### Scenario: Unbound surface

- **WHEN** `/debug` is invoked on an unbound surface
- **THEN** it SHALL report that no active conversation exists without creating one

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

### Requirement: Compact command triggers manual context compaction

The `/compact` command is queue-timing. If a turn is in flight, it SHALL defer behind it (acking "Queued.") so the runner is idle before compaction rewrites the transcript. It SHALL invoke `AgentRunner.compact()`, and reply with the result. Optional trailing text SHALL be forwarded as `customInstructions` to pi's compaction (e.g. `/compact focus on the database schema decisions`).

If no conversation is bound to the chat, the reply SHALL be "No active conversation to compact."

If the conversation exists but has nothing to compact (pi throws), the reply SHALL include the error message from pi (e.g. "Nothing to compact (conversation too small).").

If compaction succeeds, the reply SHALL include `tokensBefore` from the result (formatted as e.g. `"Compacted from ~42K tokens."`).

#### Scenario: Compact an active conversation

- **WHEN** `/compact` is sent in a chat with an active conversation that has multiple turns of history
- **AND** the agent is idle (not streaming)
- **THEN** `runner.compact()` SHALL be called
- **AND** a reply SHALL include the tokens-freed count (e.g. `"Compacted from ~42K tokens."`)

#### Scenario: Compact during active turn

- **WHEN** `/compact` is sent while the agent is streaming
- **THEN** the command SHALL be deferred behind the current turn (not aborted)
- **AND** an instant "Queued." ack SHALL be sent
- **AND** `runner.compact()` SHALL be called once the turn settles
- **AND** a reply SHALL be sent with the compaction result

#### Scenario: Compact with custom instructions

- **WHEN** `/compact focus on the schema decisions` is sent
- **THEN** `runner.compact("focus on the schema decisions")` SHALL be called

#### Scenario: Nothing to compact

- **WHEN** `/compact` is sent and the conversation has minimal history
- **THEN** a reply SHALL indicate the conversation is too small to compact (pi's error message)

#### Scenario: No active conversation

- **WHEN** `/compact` is sent in a DM with no active conversation
- **THEN** a reply SHALL say `"No active conversation to compact."`

### Requirement: Queue command enqueues text for the next idle turn

The `/queue <text>` command is instant-timing. It SHALL enqueue the supplied text via the per-Conversation promise queue so it runs as a fresh turn via `AgentRunner.prompt()` only after the current turn (and any prior queued work) settles. It SHALL NOT abort the running turn.

If no `<text>` is supplied, the reply SHALL be `"Usage: /queue <text>"` with `tag: "info"` and nothing SHALL be enqueued.

If no conversation is bound to the chat, the reply SHALL be `"No active conversation."` with `tag: "info"` and nothing SHALL be enqueued.

If the runner is idle when `/queue` is handled, the supplied text SHALL run immediately as a fresh turn (the queue is empty, so the work starts now).

#### Scenario: Queue behind a running turn

- **WHEN** `/queue then check the tests` is sent while goblin is streaming
- **THEN** the text `"then check the tests"` SHALL be enqueued via the per-Conversation promise queue
- **AND** the running turn SHALL NOT be aborted
- **AND** a reply SHALL acknowledge the queue with `tag: "queued"` (e.g. `"Queued. Will run after the current turn."`)

#### Scenario: Queue when idle runs immediately

- **WHEN** `/queue then check the tests` is sent while goblin is idle
- **THEN** the text SHALL run as a fresh turn immediately via `AgentRunner.prompt()`
- **AND** the reply SHALL be `"Running."` with `tag: "ok"`

#### Scenario: Queue without text

- **WHEN** `/queue` is sent without a trailing argument
- **THEN** the reply SHALL be `"Usage: /queue <text>"` with `tag: "info"`
- **AND** nothing SHALL be enqueued

#### Scenario: Queue with no active conversation

- **WHEN** `/queue do something` is sent in a DM with no active conversation
- **THEN** the reply SHALL be `"No active conversation."` with `tag: "info"`
- **AND** nothing SHALL be enqueued

### Requirement: Voice command converts last assistant message to speech

The `/voice` and `/v` commands SHALL read the most recent assistant message from the conversation's `transcript.jsonl`, generate an MP3 voice file via Microsoft Edge TTS, and feed a synthetic prompt to the model instructing it to call `send_voice` with the generated audio path. The command is instant-timing: it runs immediately and does not abort or defer the current turn.

#### Scenario: Voice command with a prior assistant message

- **WHEN** `/voice` is sent in a chat with an active conversation that has at least one completed assistant turn
- **AND** the agent is idle (not streaming)
- **THEN** the last assistant entry in `transcript.jsonl` SHALL be read
- **AND** the text content SHALL be extracted (from string or content-block array)
- **AND** `uvx edge-tts` SHALL be invoked with the text (via a temp file with `--file`), `--voice <VOICE_NAME>`, and `--write-media <tmpPath>`
- **AND** a synthetic prompt SHALL be dispatched to the agent: the audio path and instructions to use `send_voice`
- **AND** the model SHALL call `send_voice(voiceFile=<tmpPath>, ...)` to deliver the voice message

#### Scenario: Voice command during active stream

- **WHEN** `/voice` is sent while the agent is streaming
- **THEN** the running turn SHALL NOT be aborted (instant-timing)
- **AND** the last completed assistant message (from the transcript, not the in-progress partial) SHALL be used
- **AND** voice generation SHALL proceed as in the idle case

#### Scenario: Voice command with no assistant messages

- **WHEN** `/voice` is sent in a conversation that has no assistant entries in `transcript.jsonl`
- **THEN** the bot SHALL reply with text: "No messages to voice yet."

#### Scenario: Voice command with no active conversation

- **WHEN** `/voice` is sent in a DM with no active conversation
- **THEN** the bot SHALL reply with text: "No active conversation. Use /new to start one."

#### Scenario: Edge TTS subprocess fails

- **WHEN** `uvx edge-tts` exits with a non-zero code or is not available
- **THEN** the bot SHALL reply with text: `Voice generation failed: <error>` where `<error>` is the subprocess stderr or exit code
- **AND** no synthetic prompt SHALL be dispatched

#### Scenario: Shorthand /v alias

- **WHEN** `/v` is sent
- **THEN** it SHALL behave identically to `/voice`

#### Scenario: Assistant message has only non-text content blocks

- **WHEN** the last assistant message has only thinking, toolCall, or image content blocks (no text blocks)
- **THEN** `readLastAssistantMessage` SHALL return `null`
- **AND** the bot SHALL reply with text: "No messages to voice yet."

## REMOVED Requirements

### Requirement: Implement /start command for DM session creation

### Requirement: New command resets the chat to a fresh session

### Requirement: New command creates a fresh resumable session

### Requirement: Archive command queues and archives session

### Requirement: Name command persists bound session title

### Requirement: Resume command binds chat to an existing resumable session

### Requirement: Reject /start in non-forum groups
