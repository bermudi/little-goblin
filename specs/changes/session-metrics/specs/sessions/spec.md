# sessions

## MODIFIED Requirements

### Requirement: Create session filesystem layout

The system SHALL create the complete filesystem structure when creating a session. This structure SHALL include a `metrics.jsonl` file for per-session metrics.

#### Scenario: Session created

- **WHEN** `createForChat()` is called
- **THEN** it SHALL create: `state/sessions/<id>/` directory, `state/sessions/<id>/workdir/` directory, `state/sessions/<id>/events.jsonl` (empty), `state/sessions/<id>/transcript.jsonl` (empty), `state/sessions/<id>/metrics.jsonl` (empty), and `state/sessions/<id>/state.json`

## ADDED Requirements

### Requirement: metrics.jsonl is archived with the session

When a session is archived, the `metrics.jsonl` file SHALL be moved together with the rest of the session directory to `state/sessions/archive/<id>/metrics.jsonl`.

#### Scenario: Archive session

- **WHEN** a session is archived
- **THEN** `state/sessions/<id>/metrics.jsonl` SHALL be moved to `state/sessions/archive/<id>/metrics.jsonl`
- **AND** the original path SHALL NOT exist
