# pi-host

## MODIFIED Requirements

### Requirement: Pi-host exposes Goblin prompt file paths

The `src/pi-host.ts` module SHALL expose canonical path helpers for Goblin-owned prompt files under `$GOBLIN_HOME/workspace/`, including `agentsMdPath(home)`, `soulMdPath(home)`, and `heartbeatMdPath(home)`.

#### Scenario: Prompt path helpers available

- **WHEN** a consumer imports Goblin prompt path helpers from `src/pi-host.ts`
- **THEN** `agentsMdPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/AGENTS.md`
- **AND** `soulMdPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/SOUL.md`
- **AND** `heartbeatMdPath(home)` SHALL resolve to `$GOBLIN_HOME/workspace/HEARTBEAT.md`
