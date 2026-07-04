# agent

## MODIFIED Requirements

### Requirement: cwd is the shared goblin workspace

Every `AgentRunner` SHALL pass `cwd = workdirPath($GOBLIN_HOME)` to `createAgentSession()`, where `workdirPath` is imported from `src/pi-host.ts`. Per-session workdirs MUST NOT be used.

#### Scenario: Runner created

- **WHEN** an `AgentRunner` is instantiated in any session
- **THEN** pi's `AgentSession` SHALL run with cwd `$GOBLIN_HOME/scratch/workdir/`

### Requirement: Shared services point at $GOBLIN_HOME/goblin/

The `AgentRunner` SHALL obtain pi's `AuthStorage`, `ModelRegistry`, and `SettingsManager` from the `createPiServices()` function exported by `src/pi-host.ts`. `AuthStorage` and `ModelRegistry` SHALL be configured to read from and write to `$GOBLIN_HOME/state/pi/` so authentication and model configuration persist across restarts and are shared by every session. `SettingsManager` SHALL be an in-memory instance with empty defaults.

#### Scenario: AuthStorage location

- **WHEN** an `AgentRunner` is created
- **THEN** pi's `AuthStorage` SHALL use `$GOBLIN_HOME/state/pi/auth.json`

#### Scenario: Two sessions share the auth file path

- **WHEN** two `AgentRunner` instances are created in two different sessions
- **THEN** each runner's `AuthStorage` SHALL point at the same `$GOBLIN_HOME/state/pi/auth.json` path

#### Scenario: Services obtained from pi-host

- **WHEN** `AgentRunner.init()` builds pi services
- **THEN** it SHALL call `createPiServices(home)` from `src/pi-host.ts`
- **AND** it SHALL NOT construct `AuthStorage`, `ModelRegistry`, or `SettingsManager` inline

### Requirement: Pi SessionManager runs in-memory for main goblin sessions

The `AgentRunner` SHALL pass `SessionManager.inMemory()` to `createAgentSession()`. Pi's conversation history for the main goblin MUST NOT be persisted to disk by pi.

#### Scenario: No pi session files written

- **WHEN** a goblin turn completes
- **THEN** no JSONL file SHALL be created by pi in `$GOBLIN_HOME/scratch/workdir/` or anywhere pi-managed

### Requirement: Complete event log written to sessions/<id>/events.jsonl

The `AgentRunner` SHALL subscribe to pi's `AgentSession` events and append every event as a JSON object on its own line to `$GOBLIN_HOME/state/sessions/<sessionId>/events.jsonl`. No event type is filtered out.

#### Scenario: Text delta event

- **WHEN** pi emits `text_delta`
- **THEN** a JSON line with the delta and ISO-8601 timestamp SHALL be appended to `events.jsonl`

#### Scenario: Tool call event

- **WHEN** pi emits `tool_call`
- **THEN** a JSON line with tool name, arguments, and timestamp SHALL be appended

#### Scenario: Observability-only events included

- **WHEN** pi emits `compaction_start`, `auto_retry_start`, or `queue_update`
- **THEN** each SHALL be appended as a JSON line

#### Scenario: Append is atomic per line

- **WHEN** two events are written in rapid succession
- **THEN** each line SHALL be complete and valid JSON
- **AND** neither SHALL be interleaved with the other

### Requirement: Main agent skill discovery is configurable

The `AgentRunner` SHALL construct its `DefaultResourceLoader` based on the `skillSources` config field:

- `"goblin-only"` — `noSkills: true`, `additionalSkillPaths: ["$GOBLIN_HOME/workspace/skills/"]`. Only goblin's own skills directory is available.
- `"user"` — `noSkills: false`, `additionalSkillPaths: ["$GOBLIN_HOME/workspace/skills/"]`. Pi's default auto-discovery runs (which includes `~/.agents/skills/` and cwd ancestor `.agents/skills/` dirs), plus goblin's skills.

In all modes, `agentDir` SHALL be `$GOBLIN_HOME/state/pi/` so pi's global resource lookups stay isolated from `~/.pi/agent/`.

#### Scenario: goblin-only mode (default)

- **WHEN** `skillSources` is `"goblin-only"` or absent
- **THEN** the `DefaultResourceLoader` SHALL be constructed with `noSkills: true` and `additionalSkillPaths: ["$GOBLIN_HOME/workspace/skills/"]`
- **AND** skills from `~/.agents/skills/` SHALL NOT be available to the agent

#### Scenario: user mode

- **WHEN** `skillSources` is `"user"`
- **THEN** the `DefaultResourceLoader` SHALL be constructed with `noSkills: false` and `additionalSkillPaths: ["$GOBLIN_HOME/workspace/skills/"]`
- **AND** skills from `~/.agents/skills/` and cwd ancestor `.agents/skills/` directories SHALL be available to the agent
