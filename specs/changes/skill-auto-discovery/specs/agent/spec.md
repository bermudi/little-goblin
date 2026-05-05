# agent

## ADDED Requirements

### Requirement: Main agent skill discovery is configurable

The `AgentRunner` SHALL construct its `DefaultResourceLoader` based on the `skillSources` config field:

- `"goblin-only"` — `noSkills: true`, `additionalSkillPaths: ["$GOBLIN_HOME/skills/"]`. Only goblin's own skills directory is available.
- `"user"` — `noSkills: false`, `additionalSkillPaths: ["$GOBLIN_HOME/skills/"]`. Pi's default auto-discovery runs (which includes `~/.agents/skills/` and cwd ancestor `.agents/skills/` dirs), plus goblin's skills.
- `"auto"` — no `DefaultResourceLoader` is provided. Pi creates its own using full default discovery.

In all modes, `agentDir` SHALL be `$GOBLIN_HOME/goblin/` so pi's global resource lookups stay isolated from `~/.pi/agent/`.

#### Scenario: goblin-only mode (default)

- **WHEN** `skillSources` is `"goblin-only"` or absent
- **THEN** the `DefaultResourceLoader` SHALL be constructed with `noSkills: true` and `additionalSkillPaths: ["$GOBLIN_HOME/skills/"]`
- **AND** skills from `~/.agents/skills/` SHALL NOT be available to the agent

#### Scenario: user mode

- **WHEN** `skillSources` is `"user"`
- **THEN** the `DefaultResourceLoader` SHALL be constructed with `noSkills: false` and `additionalSkillPaths: ["$GOBLIN_HOME/skills/"]`
- **AND** skills from `~/.agents/skills/` and cwd ancestor `.agents/skills/` directories SHALL be available to the agent

#### Scenario: auto mode

- **WHEN** `skillSources` is `"auto"`
- **THEN** no `resourceLoader` SHALL be passed to `createAgentSession`
- **AND** pi's full default auto-discovery SHALL run (cwd walk, user dirs, packages)
