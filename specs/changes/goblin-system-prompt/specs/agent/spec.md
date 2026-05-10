# agent

## ADDED Requirements

### Requirement: Main AgentRunner constructs a Goblin system prompt

The main `AgentRunner` SHALL construct an explicit system prompt in its lazy session-initialization path before creating pi's `AgentSession`. The prompt SHALL combine deployment-owned prompt files, a small product shell, and optional project guidance. The prompt MUST be passed through the `DefaultResourceLoader` used by the main runner.

#### Scenario: Main runner receives explicit prompt

- **WHEN** the main `AgentRunner` initializes its pi `AgentSession` for the first prompt
- **THEN** the `DefaultResourceLoader` SHALL receive a `systemPrompt` string
- **AND** pi's default system prompt SHALL NOT be the source of the main Goblin identity

#### Scenario: Missing SOUL fails

- **WHEN** `$GOBLIN_HOME/SOUL.md` is missing
- **AND** the main `AgentRunner` attempts to construct the prompt
- **THEN** initialization SHALL fail with a configuration error

### Requirement: SOUL provides deployment identity and voice

The main Goblin system prompt SHALL include `$GOBLIN_HOME/SOUL.md` as the required deployment-owned identity and voice source. Runtime code MUST NOT inject a separate conversational agent name, user name, or private persona.

#### Scenario: SOUL included

- **WHEN** `$GOBLIN_HOME/SOUL.md` contains a deployed agent identity
- **THEN** the constructed system prompt SHALL include that content
- **AND** the runtime SHALL NOT add another agent name from config or source code

### Requirement: Deployment AGENTS provides optional operating rules

The main Goblin system prompt SHALL include `$GOBLIN_HOME/AGENTS.md` when it exists. Missing `$GOBLIN_HOME/AGENTS.md` SHALL NOT block `AgentRunner` initialization.

#### Scenario: AGENTS exists

- **WHEN** `$GOBLIN_HOME/AGENTS.md` exists
- **THEN** the constructed system prompt SHALL include it as deployment operating rules

#### Scenario: AGENTS missing

- **WHEN** `$GOBLIN_HOME/AGENTS.md` is missing
- **THEN** prompt construction SHALL continue using `SOUL.md` and the product shell

### Requirement: Product shell contains runtime mechanics only

The product shell SHALL be a small code-owned prompt scaffold for runtime mechanics such as Telegram channel behavior, tool truthfulness, destructive-action boundaries, section scoping, and memory-aside semantics. It MUST NOT contain deployed identity, user identity, conversational agent name, private persona, or negative anti-persona instructions.

#### Scenario: Product shell assembled

- **WHEN** the system prompt is constructed
- **THEN** it SHALL include runtime mechanics needed by the little-goblin process
- **AND** it SHALL NOT include a hardcoded deployed agent name or private user name

### Requirement: Goblin disables implicit context file loading

The main `AgentRunner` SHALL disable pi's implicit context-file loading and manually include only the prompt files allowed by Goblin's prompt builder.

#### Scenario: Global instruction file exists

- **WHEN** a global or compatibility instruction file exists outside `$GOBLIN_HOME` and the exact bound project file
- **THEN** the main Goblin system prompt SHALL NOT include that file

#### Scenario: Resource loader constructed

- **WHEN** the main `AgentRunner` constructs `DefaultResourceLoader`
- **THEN** it SHALL set `noContextFiles: true`

### Requirement: Memory remains per-turn context

The `AgentRunner` SHALL continue injecting memory snapshots as per-turn asides with `AgentSession.sendCustomMessage(snapshot, { deliverAs: "nextTurn" })`. Memory snapshots MUST NOT be concatenated into the constructed system prompt.

#### Scenario: Prompt constructed once, memory loaded per turn

- **WHEN** an `AgentRunner` handles two user turns in the same session
- **THEN** the system prompt SHALL be constructed during session initialization
- **AND** the memory snapshot SHALL be loaded fresh and sent before each user prompt

## MODIFIED Requirements

### Requirement: AgentRunner owns pi's AgentSession

The `AgentRunner` SHALL create pi's `AgentSession` via `createAgentSession()` lazily on the first prompt. In that lazy session-initialization path, before calling `createAgentSession()`, it SHALL construct the Goblin system prompt and provide it through the resource loader used for that session.

#### Scenario: Lazy creation

- **WHEN** `AgentRunner` is constructed
- **THEN** pi's `AgentSession` SHALL NOT be created yet
- **AND** no prompt files SHALL be read for that runner yet

#### Scenario: First prompt triggers creation

- **WHEN** the runner's `prompt()` method is called for the first time
- **THEN** pi's `AgentSession` SHALL be created before the prompt is dispatched
- **AND** the session SHALL receive the constructed Goblin system prompt
