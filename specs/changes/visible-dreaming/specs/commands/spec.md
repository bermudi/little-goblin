# commands

## ADDED Requirements

### Requirement: Implement /dreams command

The system SHALL provide a `/dreams` command that surfaces the dream diary. The command SHALL be instant-timing: it runs immediately regardless of streaming state and does not abort or defer the current turn. The command SHALL NOT require a bound session — it reads from the dream diary files directly, not from session state.

The command SHALL accept an optional argument:

- No argument: list the last 7 nights of the dream diary as one line per night. Each line SHALL show the date, a theme summary or "quiet", and a ✨ marker for nights that produced a dream fragment. The reply SHALL begin with `dream journal — last 7 nights`.
- `full`: show the full text of the most recent dream fragment, or `No dreams yet.` if no fragment exists. The reply SHALL include the fragment text, the date it was dreamt, and the theme tags that grounded it.
- `on`: enable proactive dream messages. Writes `{ enabled: true }` to `prefs.json`. Replies `Dream messages enabled. Goblin will share its dreams (≤1/day).`
- `off`: disable proactive dream messages. Writes `{ enabled: false }` to `prefs.json`. Replies `Dream messages disabled.`

#### Scenario: /dreams with no argument shows 7-night summary

- **WHEN** `/dreams` is sent with no argument
- **THEN** the reply SHALL begin with `dream journal — last 7 nights`
- **AND** SHALL list one line per night for the last 7 nights
- **AND** nights with fragments SHALL be marked with ✨
- **AND** nights without fragments SHALL show "quiet"

#### Scenario: /dreams full shows most recent fragment

- **WHEN** `/dreams full` is sent and a dream fragment exists
- **THEN** the reply SHALL include the full fragment text
- **AND** SHALL include the date the fragment was dreamt
- **AND** SHALL include the theme tags that grounded the fragment

#### Scenario: /dreams full with no fragments

- **WHEN** `/dreams full` is sent and no dream fragment exists
- **THEN** the reply SHALL be `No dreams yet.`

#### Scenario: /dreams on enables dream messages

- **WHEN** `/dreams on` is sent
- **THEN** `{ enabled: true }` SHALL be written to `prefs.json` atomically
- **AND** the reply SHALL be `Dream messages enabled. Goblin will share its dreams (≤1/day).`

#### Scenario: /dreams off disables dream messages

- **WHEN** `/dreams off` is sent
- **THEN** `{ enabled: false }` SHALL be written to `prefs.json` atomically
- **AND** the reply SHALL be `Dream messages disabled.`

#### Scenario: /dreams does not require a bound session

- **WHEN** `/dreams` is sent in a DM with no active session
- **THEN** the command SHALL succeed and return the dream diary summary
- **AND** SHALL NOT reply with "No active session" or similar

#### Scenario: /dreams is instant-timing

- **WHEN** `/dreams` is sent while the agent is streaming
- **THEN** the command SHALL execute immediately
- **AND** SHALL NOT abort or defer the current turn

### Requirement: /dreams is registered in the command registry and help

The `/dreams` command SHALL be registered in `COMMAND_REGISTRY` with timing classification `instant`. The `/help` command SHALL include `/dreams [full|on|off]` in its listing with a description. The command's `argsHint` SHALL be `[full|on|off]`.

#### Scenario: Help output includes dreams

- **WHEN** `/help` is sent
- **THEN** the reply SHALL include `/dreams [full|on|off]` — `<description>`

#### Scenario: /dreams registered as instant-timing

- **WHEN** the command registry is initialized
- **THEN** `/dreams` SHALL declare timing `instant`
