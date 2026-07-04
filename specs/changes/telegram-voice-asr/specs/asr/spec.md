# asr

## ADDED Requirements

### Requirement: Groq ASR provider transcribes audio bytes

The system SHALL provide an internal ASR module with a narrow provider-shaped function for transcribing audio bytes. The only implemented provider SHALL be Groq. The Groq implementation SHALL send a multipart request to `https://api.groq.com/openai/v1/audio/transcriptions` with the configured model and bearer token, parse the returned transcript text, and return a typed result without throwing for ordinary API failures.

The result type SHALL be a discriminated union:

- `{ ok: true; text: string }` — successful transcription. `text` is the trimmed transcript. A successful HTTP response with an empty or whitespace-only `text` field SHALL be returned as `{ ok: true, text: "" }`; the ASR module MUST NOT treat empty text as a failure.
- `{ ok: false; error: string }` — failure. `error` is a sanitized, non-secret message. Failures include non-2xx responses, malformed JSON, missing key, and network/timeout failures.

The ASR module MUST NOT include the bearer token in any result or log line.

#### Scenario: Successful Groq transcription

- **WHEN** the Groq endpoint returns JSON containing a non-empty `text` field
- **THEN** the ASR module SHALL return `{ ok: true, text }` with trimmed transcript text

#### Scenario: Empty transcript returned as success

- **WHEN** the Groq endpoint returns a 2xx response with an empty or whitespace-only `text` field
- **THEN** the ASR module SHALL return `{ ok: true, text: "" }`
- **AND** SHALL NOT return a failure result for empty text

#### Scenario: Groq API error

- **WHEN** the Groq endpoint returns a non-2xx status
- **THEN** the ASR module SHALL return `{ ok: false, error }` with a sanitized error message
- **AND** SHALL NOT include the bearer token in the result or logs

#### Scenario: Network error

- **WHEN** the Groq request fails due to a network error or timeout
- **THEN** the ASR module SHALL return `{ ok: false, error }`
- **AND** the caller SHALL be able to reply to the user without inspecting thrown exceptions

#### Scenario: Request timeout bounded

- **WHEN** the Groq request exceeds the configured timeout
- **THEN** the ASR module SHALL abort the request and return `{ ok: false, error }` with a timeout indication
- **AND** SHALL NOT hang indefinitely
