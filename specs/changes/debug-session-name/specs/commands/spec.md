# commands

## ADDED Requirements

### Requirement: Diagnostics includes session name

The `/debug` command outputs a structured diagnostics snapshot. When a session has been named via `/name`, the output SHALL include the human-readable name.

- `Diagnostics` gains a `sessionName: string | null` field, populated from `SessionState.title`.
- `formatDiagnostics` renders `Session Name: <name>` immediately after `Session: <id>` when the name is present, and `Session Name: unavailable` when it is absent.

#### Scenario: Named session

- **WHEN** `/debug` is invoked on a session with `title: "ttt-v2"`
- **THEN** the output SHALL contain `Session: <id>` followed by `Session Name: ttt-v2`

#### Scenario: Unnamed session

- **WHEN** `/debug` is invoked on a session with no `title`
- **THEN** the output SHALL contain `Session Name: unavailable`

## MODIFIED Requirements

### Requirement: gatherDiagnostics extracts session name

`gatherDiagnostics` SHALL extract `deps.session.title ?? null` into the new `sessionName` field.

#### Scenario: Title present

- **WHEN** `deps.session.title` is `"my-session"`
- **THEN** `diagnostics.sessionName` SHALL be `"my-session"`

#### Scenario: Title absent

- **WHEN** `deps.session.title` is `undefined`
- **THEN** `diagnostics.sessionName` SHALL be `null`
