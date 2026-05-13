# config

## ADDED Requirements

### Requirement: VOICE_NAME configures Edge TTS voice

The system SHALL accept an optional `VOICE_NAME` environment variable specifying the Microsoft Edge TTS voice to use for the `/voice` command. When absent, the voice SHALL default to `en-US-EmmaMultilingualNeural`. The value SHALL be a valid Edge TTS voice name (e.g. `en-US-AndrewMultilingualNeural`, `en-US-AnaNeural`). Validation of the voice name is deferred to `edge-tts` at invocation time.

#### Scenario: VOICE_NAME not set

- **WHEN** the `VOICE_NAME` environment variable is not present
- **THEN** the `/voice` command SHALL use `en-US-EmmaMultilingualNeural`

#### Scenario: VOICE_NAME set to a male voice

- **WHEN** `VOICE_NAME=en-US-AndrewMultilingualNeural`
- **THEN** the `/voice` command SHALL pass `--voice en-US-AndrewMultilingualNeural` to `uvx edge-tts`
