# pi-native-skill-layout

## Motivation

Goblin stores reusable main-agent skills under `$GOBLIN_HOME/workspace/skills/`, a path pi does not discover by convention. The path works only because every resource loader manually injects it through `additionalSkillPaths`. That custom layout became especially misleading once `$GOBLIN_HOME/workspace` became the personal Execution Environment: skills local to that environment and skills intended to follow Goblin into every project need separate homes, but the current directory means both at once.

Pi already defines a portable project convention, `.agents/skills/`. Goblin should use that convention and give the two scopes distinct locations before adding per-Surface selection.

## Scope

This change affects two capabilities: `workspace` and `config`.

### Workspace

- Define **Goblin skill catalog** storage at `$GOBLIN_HOME/.agents/skills/`. These are deployment-wide assistant skills that may later be selected on personal or project Surfaces.
- Define the personal **environment skill catalog** at `$GOBLIN_HOME/workspace/.agents/skills/`. These are skills authored for the personal workspace and are not synonymous with Goblin-wide skills.
- Replace the ambiguous `skillsPath()` contract with explicit `goblinSkillsPath()` and `personalEnvironmentSkillsPath()` helpers. A temporary compatibility alias may point to the Goblin catalog while callers migrate.
- Keep path construction pure and centralized.

### Config and migration

- Create both catalog directories during startup.
- Idempotently migrate the legacy `$GOBLIN_HOME/workspace/skills/` tree to `$GOBLIN_HOME/.agents/skills/`, because legacy skills were injected into every main and generic-agent environment and therefore had Goblin-wide semantics.
- Refuse a migration when both legacy and destination paths contain data; do not merge or overwrite skill definitions silently.
- Preserve `$GOBLIN_HOME/workspace/.agents/skills/` as a distinct catalog rather than treating it as the migration destination.

## Non-Goals

- **Skill selection:** source toggles, allowlists, collision behavior, and host skills belong to `skill-catalog-resolution` and `surface-skill-policy`.
- **Runner behavior:** this change preserves current behavior through the compatibility helper; it does not change which skills a runtime receives.
- **Project discovery:** project `.agents/skills/` and `.pi/skills/` are handled after immutable Execution Environments exist.
- **Named subagents:** their definition layout migrates in `subagent-skill-inheritance`.
- **Skill registry/database:** the filesystem remains canonical.
- **Prompt layout:** `SOUL.md`, `AGENTS.md`, and heartbeat behavior are unchanged.
