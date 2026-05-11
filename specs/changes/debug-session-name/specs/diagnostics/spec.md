# diagnostics — Session Name in /debug

## Capability

The `/debug` command outputs a structured diagnostics snapshot. When a session has been named via `/name`, the output should include the human-readable name.

## Delta

### ADDED

- `Diagnostics` gains a `sessionName: string | null` field, populated from `SessionState.title`.
- `formatDiagnostics` renders `Session Name: <name>` immediately after `Session: <id>` when the name is present, and `Session Name: unavailable` when it is absent.

### MODIFIED

- `gatherDiagnostics` extracts `deps.session.title ?? null` into the new field.
- `formatDiagnostics` includes the new line in its output array.
- `diagnostics.test.ts` assertions and stubs are updated to cover the new field.

## Scenarios

### Scenario: Named session

Given a session with `title: "ttt-v2"`  
When `/debug` is invoked  
Then the output contains `Session: <id>` followed by `Session Name: ttt-v2`

### Scenario: Unnamed session

Given a session with no `title`  
When `/debug` is invoked  
Then the output contains `Session Name: unavailable`
