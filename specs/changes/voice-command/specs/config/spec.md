# config

## ADDED Requirements

### Requirement: VOICE_NAME configures Edge TTS voice

The system SHALL accept an optional `VOICE_NAME` environment variable specifying the Microsoft Edge TTS voice to use for the `/voice` command and `text_to_speech` tool. When absent, the voice SHALL default to `en-US-EmmaMultilingualNeural`. The value SHALL be a valid Edge TTS voice name (e.g. `en-US-AndrewMultilingualNeural`, `en-US-AnaNeural`). Validation of the voice name is deferred to `edge-tts` at invocation time — invalid names produce a clear error from the subprocess.

#### Scenario: VOICE_NAME not set

- **WHEN** the `VOICE_NAME` environment variable is not present
- **THEN** the `/voice` command and `text_to_speech` tool SHALL use `en-US-EmmaMultilingualNeural`

#### Scenario: VOICE_NAME set to a male voice

- **WHEN** `VOICE_NAME=en-US-AndrewMultilingualNeural`
- **THEN** both `/voice` and `text_to_speech` SHALL pass `--voice en-US-AndrewMultilingualNeural` to `uvx edge-tts`

### Requirement: Edge TTS availability checked at startup

The system SHALL verify that `uvx edge-tts` is callable during startup by running `uvx edge-tts --version`. If the check fails, the system SHALL log a warning and continue — the bot operates without voice capability, and `/voice` or `text_to_speech` will fail with a clear error at invocation time.

#### Scenario: edge-tts available at startup

- **WHEN** `uvx edge-tts --version` exits successfully
- **THEN** the system SHALL proceed normally

#### Scenario: edge-tts not available at startup

- **WHEN** `uvx edge-tts --version` fails (command not found, Python missing, etc.)
- **THEN** the system SHALL log a warning including the error
- **AND** the bot SHALL start normally
- **AND** subsequent `/voice` or `text_to_speech` calls SHALL fail with a clear error message
