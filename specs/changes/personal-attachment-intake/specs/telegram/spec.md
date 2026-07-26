# telegram

## MODIFIED Requirements

### Requirement: Intake saves documents, voice, and audio into the project directory

For document, voice, and audio updates on an active Telegram turn, intake SHALL download and save the file under a destination derived exclusively from the Conversation's persisted `ExecutionEnvironment`. A personal environment SHALL use `$GOBLIN_HOME/workspace/attachments/`, created lazily through the sanctioned path helper. A project environment SHALL preserve the existing destination at the canonical project root. Although the personal Conversation's CWD is the workspace root, intake MUST confine raw uploads to its `attachments/` child and MUST NOT write an upload directly over root prompt files or the `skills/` tree.

Intake SHALL reduce supplied names with `basename`, trim them, and reject names that normalize to empty, `.` or `..`. Voice files SHALL retain the generated `voice-<timestamp>.<ext>` convention (`audio/ogg` → `oga`, unknown → `bin`). Saving MUST NOT overwrite an existing file: intake SHALL reserve the original name atomically when available and otherwise append a numeric suffix before the extension until it reserves a free name. The actual reserved path is authoritative for replies and prompts.

After saving, intake SHALL reply with the saved relative name and SHALL prompt the current runner with both any caption/transcript and an explicit saved-file note. A caption MUST NOT be forwarded alone when download, validation, directory creation, or saving fails. Such failure SHALL be user-visible and logged without prompting the runner as though it had received the attachment. Existing 20 MiB download limits, voice ASR behavior, per-Conversation queueing, and stale-runtime checks remain in force; intake MUST recheck runtime currency before filesystem writes, replies, and runner prompts.

#### Scenario: Captioned document in a personal environment

- **GIVEN** a Conversation with the personal execution environment
- **WHEN** the user uploads `notes.md` with caption `please review the ending`
- **THEN** intake SHALL download and save it under `$GOBLIN_HOME/workspace/attachments/notes.md`
- **AND** SHALL prompt the runner with the caption and a note identifying `attachments/notes.md`
- **AND** the runner SHALL be able to read that path relative to its personal CWD

#### Scenario: Uncaptioned document in a personal environment

- **WHEN** the user uploads a valid document without a caption in a personal environment
- **THEN** intake SHALL save it under the personal attachments directory
- **AND** SHALL prompt the runner that the user uploaded the actual reserved path
- **AND** SHALL NOT reply that `/project` is required

#### Scenario: Project document preserves its destination

- **GIVEN** a Conversation whose project execution environment is `/srv/project-a`
- **WHEN** the user uploads `notes.md`
- **THEN** intake SHALL save it as `/srv/project-a/notes.md` when that name is free
- **AND** SHALL identify `notes.md` in the prompt relative to the runner's project CWD

#### Scenario: Existing file is not overwritten

- **GIVEN** `attachments/notes.md` already exists in the personal workdir
- **WHEN** another `notes.md` is uploaded
- **THEN** intake SHALL atomically reserve a collision-free name such as `attachments/notes-2.md`
- **AND** SHALL leave the existing file unchanged
- **AND** the reply and prompt SHALL identify the reserved name rather than the requested name

#### Scenario: Captioned download failure is not disguised as success

- **WHEN** a captioned document is oversized or cannot be downloaded or saved
- **THEN** intake SHALL tell the user that the attachment could not be retained
- **AND** SHALL log the failure with non-secret file and destination context
- **AND** SHALL NOT prompt the runner with the caption alone

#### Scenario: Unsafe filename is rejected

- **WHEN** a document or audio filename normalizes to empty, `.` or `..`
- **THEN** intake SHALL reply that the filename is unsafe
- **AND** SHALL NOT write a file or prompt the runner with an attachment note

#### Scenario: Voice in a personal environment is saved and transcribed

- **GIVEN** Groq ASR is configured
- **WHEN** a voice update arrives for a personal Conversation and transcription succeeds
- **THEN** intake SHALL save the original under the personal attachments directory
- **AND** SHALL prompt the runner with `[Voice message transcript]`, the transcript, and the saved relative path

#### Scenario: Audio in a personal environment is saved

- **WHEN** an audio update with a valid filename arrives for a personal Conversation
- **THEN** intake SHALL save it under the personal attachments directory
- **AND** SHALL prompt the runner with any caption/metadata and the saved relative path

#### Scenario: Workspace prompt files cannot be replaced by uploads

- **WHEN** a personal user uploads a file named `SOUL.md`, `AGENTS.md`, or any other name
- **THEN** intake SHALL confine it to `$GOBLIN_HOME/workspace/attachments/`
- **AND** SHALL NOT replace `$GOBLIN_HOME/workspace/SOUL.md`, `$GOBLIN_HOME/workspace/AGENTS.md`, or anything under `$GOBLIN_HOME/workspace/.agents/skills/`

#### Scenario: Stale attachment work has no effects

- **GIVEN** attachment processing remains pending
- **WHEN** the Conversation runtime is invalidated before its filesystem write
- **THEN** intake SHALL NOT save, reply, or prompt from the stale work
