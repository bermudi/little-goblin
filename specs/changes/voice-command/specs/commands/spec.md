# commands

## ADDED Requirements

### Requirement: Voice command converts last assistant message to speech

The `/voice` and `/v` commands SHALL read the most recent assistant message from the session's `transcript.jsonl`, generate an MP3 voice file via Microsoft Edge TTS, and feed a synthetic prompt to the model instructing it to call `send_voice` with the generated audio path. The command SHALL be cancel-capable — it interrupts any active stream and cascades to subagents before executing.

#### Scenario: Voice command with a prior assistant message

- **WHEN** `/voice` is sent in a chat with an active session that has at least one completed assistant turn
- **AND** the agent is idle (not streaming)
- **THEN** the last assistant entry in `transcript.jsonl` SHALL be read
- **AND** the text content SHALL be extracted (from string or content-block array)
- **AND** `uvx edge-tts` SHALL be invoked with the text (via a temp file with `--file`), `--voice <VOICE_NAME>`, and `--write-media <tmpPath>`
- **AND** a synthetic prompt SHALL be dispatched to the agent: the audio path and instructions to use `send_voice`
- **AND** the model SHALL call `send_voice(voiceFile=<tmpPath>, ...)` to deliver the voice message

#### Scenario: Voice command during active stream

- **WHEN** `/voice` is sent while the agent is streaming
- **THEN** the current stream SHALL be aborted with cascade to subagents
- **AND** the last completed assistant message (from the transcript, not the in-progress partial) SHALL be used
- **AND** voice generation SHALL proceed as in the idle case

#### Scenario: Voice command with no assistant messages

- **WHEN** `/voice` is sent in a session that has no assistant entries in `transcript.jsonl`
- **THEN** the bot SHALL reply with text: "No messages to voice yet."

#### Scenario: Voice command with no active session

- **WHEN** `/voice` is sent in a DM with no active session
- **THEN** the bot SHALL reply with text: "No active session. Use /new to start one."

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

### Requirement: Voice command uses configurable Edge TTS voice

The voice used for Edge TTS synthesis SHALL be configurable via the `VOICE_NAME` environment variable, defaulting to `en-US-EmmaMultilingualNeural`. The configured voice name SHALL be passed as the `--voice` argument to `uvx edge-tts`.

#### Scenario: Default voice (no env var)

- **WHEN** `VOICE_NAME` is not set
- **THEN** `uvx edge-tts --voice en-US-EmmaMultilingualNeural` SHALL be used

#### Scenario: Custom voice via env var

- **WHEN** `VOICE_NAME=en-US-AndrewMultilingualNeural` is set
- **THEN** `uvx edge-tts --voice en-US-AndrewMultilingualNeural` SHALL be used

### Requirement: Voice command cleans up temporary audio files

The temporary MP3 file created by Edge TTS SHALL be deleted after the `send_voice` tool completes, or immediately if voice generation fails. Temporary files SHALL be created under the system temp directory (`os.tmpdir()`).

#### Scenario: Successful voice delivery

- **WHEN** the model calls `send_voice` with the generated audio path and it succeeds
- **THEN** the temporary file SHALL be deleted after the tool invocation completes

#### Scenario: Failed voice generation

- **WHEN** Edge TTS or the synthetic prompt flow fails
- **THEN** the temporary file SHALL be deleted before the error reply is sent

### Requirement: Voice command dispatches synthetic prompt through normal agent routing

The `/voice` command SHALL NOT call `bot.api.sendVoice` directly. It SHALL generate the audio file and then dispatch the instruction to use `send_voice` as a normal turn through the agent runner's `prompt()` method, using the same MessageBuffer setup as any user message. The synthetic prompt SHALL instruct the model to call `send_voice` with the audio file path and SHALL explicitly tell the model not to repeat or describe the content — the audio IS the message.

#### Scenario: Synthetic prompt instructs model not to repeat content

- **WHEN** the synthetic prompt is dispatched after voice generation
- **THEN** it SHALL contain the audio file path
- **AND** it SHALL instruct the model to call `send_voice`
- **AND** it SHALL explicitly state that the audio already contains the message, so the model MUST NOT repeat or describe the content in text

#### Scenario: Model sends voice with caption

- **WHEN** the synthetic prompt is dispatched after voice generation
- **THEN** the model MAY include an optional caption in its `send_voice` call
- **AND** the `send_voice` tool handler SHALL deliver the voice message to the chat

## MODIFIED Requirements

### Requirement: Help command lists available commands

The `/help` command SHALL reply with a list of all available commands.

#### Scenario: Help output

- **WHEN** `/help` is sent
- **THEN** a reply SHALL list all available commands: `/cancel`, `/new`, `/archive`, `/compact`, `/debug`, `/think`, `/model`, `/project`, `/name`, `/resume`, `/subagents`, `/cancel_subagent`, `/revive`, `/voice`, `/help`

### Requirement: Cancel cascades to all live subagents

All cancel-capable commands (`/cancel`, `/new`, `/archive`, `/debug`, `/voice`, `/v`) SHALL abort all live subagents in addition to the main agent.

#### Scenario: Cancel kills parent and subagents

- **WHEN** `/cancel` is sent while goblin is streaming and subagents are running
- **THEN** all live subagents SHALL be aborted
- **AND** the main agent SHALL be aborted
- **AND** a "Cancelled" reply SHALL be sent

#### Scenario: Cancel with no subagents

- **WHEN** `/cancel` is sent while goblin is streaming with no subagents
- **THEN** only the main agent SHALL be aborted (cascade is a no-op)

#### Scenario: /new cascades before creating session

- **WHEN** `/new` is sent while subagents are running
- **THEN** all subagents SHALL be aborted before creating the new session
- **AND** no orphan subagents SHALL reference the old session

### Requirement: Commands use interrupt semantics not queue

All session-affecting commands (`/new`, `/archive`, `/debug`, `/voice`, `/v`) SHALL cancel any active stream before executing.

#### Scenario: Rapid command spam

- **WHEN** `/new` then `/archive` sent in quick succession
- **THEN** each SHALL execute immediately, cancelling prior activity
- **AND** the session SHALL be in `sessions/archive/`
- **AND** the binding SHALL be cleared
- **AND** no runner SHALL be active for that chat
