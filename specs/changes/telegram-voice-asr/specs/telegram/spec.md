# telegram

## ADDED Requirements

### Requirement: Voice intake transcribes Telegram voice messages

The intake module SHALL transcribe Telegram voice messages with the configured Groq ASR settings before prompting the agent. A successful transcription SHALL be framed as a text prompt beginning with `[Voice message transcript]`, followed by the transcript text. The voice handler SHALL continue to resolve the active turn once, schedule work through the per-session prompt queue, and apply the stale-runner guard before every user-visible side effect.

#### Scenario: Voice message becomes transcript prompt

- **WHEN** a Telegram voice update arrives for an active session and Groq transcription succeeds
- **THEN** intake SHALL prompt the runner with a fresh turn containing `[Voice message transcript]` and the transcript
- **AND** the prompt SHALL pass through the message `prepare` hook

#### Scenario: Voice message without projectDir still works

- **WHEN** a Telegram voice update arrives for an active session without a bound `projectDir`
- **AND** Groq transcription succeeds
- **THEN** intake SHALL prompt the runner with the transcript
- **AND** SHALL NOT reply with `No project directory is set. Use /project <path> to enable file saving.`

#### Scenario: Empty transcript is not prompted

- **WHEN** the ASR module returns `{ ok: true, text: "" }` (successful HTTP response with empty or whitespace-only transcript)
- **THEN** intake SHALL reply that no speech was detected
- **AND** SHALL NOT prompt the runner

#### Scenario: Transcription failure is user-visible

- **WHEN** the voice file downloads successfully but Groq transcription returns `{ ok: false, error }`
- **THEN** intake SHALL reply that the voice message could not be transcribed
- **AND** SHALL NOT prompt the runner with an attachment-only message
- **AND** the reply SHALL NOT include the Groq API key, bearer token, or raw error body

### Requirement: Voice intake preserves project file saving

For sessions with a bound `projectDir`, voice intake SHALL preserve the existing original-file saving behavior and include the saved-file note alongside the transcript. The saved voice file name SHALL continue to be `voice-<timestamp>.<ext>` where `audio/ogg` maps to `oga` and unknown mime types map to `bin`.

#### Scenario: Voice is saved and transcribed with projectDir

- **WHEN** a Telegram voice update arrives on a session with a bound `projectDir`
- **AND** the file downloads and transcription succeeds
- **THEN** intake SHALL write the original voice file into the project directory
- **AND** SHALL reply `Saved <name>.`
- **AND** SHALL prompt the runner with the transcript and a note that `<name>` was saved to the project directory

#### Scenario: Stale voice work does not save or prompt

- **GIVEN** an active session whose scheduled voice download or transcription remains pending
- **WHEN** a runner-disposing command replaces the session runner before the work finishes
- **THEN** the stale work SHALL NOT save the voice file
- **AND** SHALL NOT reply or prompt the replaced runner

## MODIFIED Requirements

### Requirement: Intake saves documents, voice, and audio into the project directory

For document, voice, and audio updates on a session with a bound `projectDir`, the intake module SHALL download the file, normalize its name, and write it into the project directory. Names SHALL be reduced with `basename`; document and audio names that normalize to `.` or `..` SHALL be rejected with a reply. Voice files SHALL be named `voice-<timestamp>.<ext>` derived from the mime type (`audio/ogg` → `oga`, else `bin`). After saving, intake SHALL reply with the saved name. Documents and audio SHALL prompt the runner with the caption or saved-file description as before. Voice SHALL prompt the runner with a Groq ASR transcript plus a saved-file note when transcription succeeds. On a session without a `projectDir`, document and audio behavior is unchanged; voice SHALL use Groq ASR when configured and SHALL only reply with a setup/failure message when transcription cannot run.

#### Scenario: Document saved with caption

- **WHEN** a document update arrives on a session with a `projectDir` and a caption
- **THEN** intake SHALL write the file under its normalized name
- **AND** SHALL reply `Saved <name>.`
- **AND** SHALL prompt the runner with the caption followed by a note that the file was saved

#### Scenario: Voice saved with transcript

- **WHEN** a voice update arrives on a session with a `projectDir`
- **AND** Groq transcription succeeds
- **THEN** intake SHALL write the file as `voice-<timestamp>.oga` for `audio/ogg`
- **AND** SHALL prompt the runner with `[Voice message transcript]`, the transcript, and a note that the file was saved

#### Scenario: Voice without projectDir uses ASR

- **WHEN** a voice update arrives on a session without a `projectDir`
- **AND** Groq transcription succeeds
- **THEN** intake SHALL prompt the runner with `[Voice message transcript]` and the transcript
- **AND** SHALL NOT require project-file saving

#### Scenario: Audio without a file name derives one

- **WHEN** an audio update arrives with no `file_name` but a performer and title
- **THEN** intake SHALL derive `<performer> - <title>.mp3`

#### Scenario: Unsafe document name is rejected

- **WHEN** a document name normalizes to `.` or `..`
- **THEN** intake SHALL reply `Rejected: unsafe filename.`
- **AND** SHALL NOT write a file

#### Scenario: Document without projectDir but with caption

- **WHEN** a document update arrives on a session with no `projectDir` and a caption
- **THEN** intake SHALL prompt the runner with the caption
- **AND** SHALL NOT reply with the no-`projectDir` message

#### Scenario: Media without projectDir or caption

- **WHEN** a document or audio update arrives on a session with no `projectDir` and no caption
- **THEN** intake SHALL reply `No project directory is set. Use /project <path> to enable file saving.`
- **AND** SHALL NOT prompt the runner
