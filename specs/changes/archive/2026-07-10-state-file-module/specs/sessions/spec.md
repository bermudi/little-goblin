# sessions

## ADDED Requirements

### Requirement: JSON state files load and save through one module

The system SHALL provide a JSON state-file module that is the exclusive interface for reading and writing the session JSON state files (`state.json`, `bindings.json`, `topic-settings.json`). The module SHALL expose a load function that takes a file path and a caller-supplied default, and a save function that takes a file path and a value. Memory store files (`memory.md`, `user.md`) are Markdown and are NOT consumers of this module.

The load function SHALL implement the read recipe: `readFileSync` → `JSON.parse`; on `ENOENT` SHALL return the caller-supplied default; on `SyntaxError` SHALL log a warning and return the caller-supplied default; all other errors SHALL propagate (fail loud). The save function SHALL serialize the value as pretty-printed JSON with a trailing newline and write it via the existing `atomicWrite` primitive (tmp + rename). The module SHALL NOT own atomic-write itself — it wraps `src/fs.ts`'s `atomicWrite`.

Each caller SHALL supply its own default value and its own result type; the module is generic over `T`. The module SHALL NOT hardcode defaults for any specific state file.

#### Scenario: Load returns parsed JSON when the file exists

- **WHEN** `loadJsonFile<BindingsFile>(path, DEFAULT_BINDINGS)` is called and `path` contains valid JSON
- **THEN** it SHALL return the parsed value typed as `BindingsFile`
- **AND** SHALL NOT invoke the default

#### Scenario: Load returns default on ENOENT

- **WHEN** `loadJsonFile(path, DEFAULT)` is called and the file does not exist
- **THEN** it SHALL return the caller-supplied default
- **AND** SHALL NOT throw

#### Scenario: Load returns default on malformed JSON and logs

- **WHEN** `loadJsonFile(path, DEFAULT)` is called and the file contains invalid JSON
- **THEN** it SHALL log a warning including the path and error
- **AND** SHALL return the caller-supplied default
- **AND** SHALL NOT throw

#### Scenario: Load propagates non-ENOENT, non-Syntax errors

- **WHEN** `loadJsonFile(path, DEFAULT)` is called and `readFileSync` throws a permission error
- **THEN** the error SHALL propagate to the caller
- **AND** the default SHALL NOT be returned

#### Scenario: Save writes atomically

- **WHEN** `saveJsonFile(path, value)` is called
- **THEN** it SHALL serialize `value` as `JSON.stringify(value, null, 2) + "\n"`
- **AND** SHALL write it via `atomicWrite` (tmp file + rename)
- **AND** SHALL NOT bypass atomicity

## MODIFIED Requirements

### Requirement: Persist session state atomically

The system SHALL write session state using atomic write (tmp file + rename) to prevent corruption. State SHALL be loaded and saved through the JSON state-file module (`loadJsonFile`/`saveJsonFile`); the module owns the read recipe and the atomic-write wrapper. The default for a missing `state.json` SHALL be `null` (session treated as missing), preserving existing behavior.

#### Scenario: Session state saved

- **WHEN** `saveState()` is called
- **THEN** it SHALL write to a temp file named `.state-<id>.tmp` in the session directory
- **AND** rename the temp file to `state.json` atomically

#### Scenario: Session state loaded through the module

- **WHEN** `loadState()` is called and `state.json` exists
- **THEN** it SHALL return the parsed state via `loadJsonFile`
- **AND** when `state.json` does not exist, it SHALL return `null` (the caller-supplied default)

### Requirement: Persist bindings atomically

The system SHALL write `state/bindings.json` (session bindings) using atomic write with unique temp names. Bindings SHALL be loaded and saved through the JSON state-file module; the default for a missing or malformed `bindings.json` SHALL be the empty bindings structure.

#### Scenario: Bindings saved

- **WHEN** `saveBindings()` is called
- **THEN** it SHALL write to a temp file with name `.bindings.<random8chars>.tmp` in `state/`
- **AND** rename the temp file to `state/bindings.json` atomically

#### Scenario: Bindings loaded through the module

- **WHEN** `loadBindings()` is called and `bindings.json` is missing or malformed
- **THEN** it SHALL return the default empty bindings structure via `loadJsonFile`

### Requirement: Topic settings file

The system SHALL maintain a `state/topic-settings.json` file under `$GOBLIN_HOME` that stores per-chat-surface settings including `projectDir`. Topic settings SHALL be loaded and saved through the JSON state-file module; the default for a missing or malformed file SHALL be the empty settings structure. The locator-keyed slot logic (which settings record a given `(chatId, topicId)` resolves to) SHALL remain in `topic-settings.ts` — it is not part of the read/write recipe.

Note: prior to this change, `loadTopicSettings` swallowed all read errors. After this change it matches the shared module policy: `ENOENT` and `SyntaxError` return the default; all other errors propagate (fail loud). This is a deliberate behavior change.

#### Scenario: Load topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `state/topic-settings.json` exists
- **THEN** it SHALL return the parsed settings via `loadJsonFile`

#### Scenario: Default topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `state/topic-settings.json` does not exist
- **THEN** it SHALL return an empty default structure (the caller-supplied default)

#### Scenario: Malformed topic settings

- **WHEN** `loadTopicSettings()` is called
- **AND** `state/topic-settings.json` exists but contains invalid JSON
- **THEN** it SHALL return an empty default structure via `loadJsonFile`
- **AND** it SHOULD log a warning

#### Scenario: Non-JSON errors propagate (behavior change)

- **WHEN** `loadTopicSettings()` is called
- **AND** `readFileSync` throws a non-`ENOENT`, non-`SyntaxError` error (e.g. permission denied)
- **THEN** the error SHALL propagate to the caller (fail loud)
- **AND** SHALL NOT be swallowed into the default
- **NOTE** prior to this change, `topic-settings.ts` swallowed all errors; this scenario pins the new fail-loud behavior
