# agent

## ADDED Requirements

### Requirement: AgentRunner injects dream fragment as per-turn aside

The `AgentRunner` SHALL inject the most recent dream fragment as a bounded aside via `AgentSession.sendCustomMessage(aside, { deliverAs: "nextTurn" })` before each `prompt()` call, alongside the existing memory snapshot injection. The aside SHALL be omitted when no dream fragment exists (the fragment store returns `null`). The aside SHALL NOT be injected on `followUp()` calls — it is per-turn, and the running turn already received its aside at `prompt()` time.

The aside text SHALL be formatted as a section with the heading `## last dream`, followed by the fragment text, followed by a parenthetical line `(dreamt <YYYY-MM-DD>, REM phase)`. The heading, fragment text, and parenthetical line SHALL each be on their own line.

The fragment text SHALL be the raw text from `fragment.json`'s `text` field, truncated to 400 characters. The date SHALL be derived from the `dreamtAt` timestamp, formatted as `YYYY-MM-DD`. The aside SHALL be bounded to the fragment text plus the two-line header/footer — no additional context, no theme tags, no session metadata.

The aside SHALL be injected as a separate `sendCustomMessage` call from the memory snapshot. The two asides are independent: the memory snapshot may be `null` while the dream aside is present, and vice versa. The dream aside SHALL be injected after the memory snapshot (if any) so the model sees memory context first, then the dream.

The dream fragment SHALL be read fresh from `fragment.json` on every `prompt()` call so that newly produced fragments become visible on subsequent turns without restarting the session.

#### Scenario: Dream aside injected on prompt with fragment present

- **WHEN** `AgentRunner.prompt()` is called and `fragment.json` exists with a valid fragment
- **THEN** the runner SHALL call `sendCustomMessage(aside, { deliverAs: "nextTurn" })` with the formatted dream aside
- **AND** the aside SHALL be injected after the memory snapshot (if any)
- **AND** the aside SHALL contain the fragment text and the dream date

#### Scenario: Dream aside omitted when no fragment exists

- **WHEN** `AgentRunner.prompt()` is called and `fragment.json` does not exist or is invalid
- **THEN** the runner SHALL NOT inject a dream aside
- **AND** the memory snapshot injection SHALL proceed independently

#### Scenario: Dream aside not injected on followUp

- **WHEN** `AgentRunner.followUp()` is called while streaming
- **THEN** the runner SHALL NOT inject a dream aside
- **AND** the runner SHALL NOT inject a memory snapshot
- **AND** the in-flight turn's existing context SHALL remain unchanged

#### Scenario: Fresh fragment read each turn

- **WHEN** a new dream fragment is produced between turn N and turn N+1
- **AND** `AgentRunner.prompt()` is called for turn N+1
- **THEN** the dream aside injected for turn N+1 SHALL contain the new fragment text
- **AND** the old fragment SHALL NOT appear

#### Scenario: Dream aside and memory snapshot are independent

- **WHEN** `AgentRunner.prompt()` is called and the memory snapshot is `null` (all memory empty) but a dream fragment exists
- **THEN** the runner SHALL inject the dream aside
- **AND** the runner SHALL NOT inject a memory snapshot
