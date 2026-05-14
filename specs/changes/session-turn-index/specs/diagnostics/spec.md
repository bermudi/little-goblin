# diagnostics

## ADDED Requirements

### Requirement: /debug shows turn index summary

The `/debug` command SHALL include turn index information in its diagnostics output: total turn count, and a one-line summary of the last turn (model, duration, stop reason, error if any).

#### Scenario: /debug with turns

- **WHEN** `/debug` is called for a session with turns
- **THEN** the diagnostics output SHALL include a line showing turn count
- **AND** a line showing the last turn's model, duration, stop reason
- **AND** if the last turn had an error, the error message

#### Scenario: /debug with no turns

- **WHEN** `/debug` is called for a session with no `turns.jsonl`
- **THEN** the diagnostics output SHALL show "Turns: 0" without error
