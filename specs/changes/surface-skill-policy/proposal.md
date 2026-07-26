# surface-skill-policy

## Motivation

Skill catalogs have different owners, but catalog existence alone cannot express where a skill should be active. All personal topics share `$GOBLIN_HOME/workspace` as their Execution Environment, even when a workspace skill makes sense only in one topic. Conversely, two project-bound topics may share one canonical project root while intentionally differing on whether Goblin-wide or host-user skills are exposed.

Skill selection is therefore a Surface setting, not an Execution Environment identity and not Conversation history. It must survive `/new`, follow the destination Surface on `/resume`, and rebuild the runtime when changed.

## Scope

This change depends on `telegram-surface-identity` and `skill-catalog-resolution`. It affects three capabilities: `sessions`, `commands`, and `orchestration`.

### Surface settings

- Persist a `SkillPolicy` in SurfaceId-keyed settings, with independent `goblin`, `environment`, and `host` selections.
- Each selection is `all`, `none`, or `selected` with unique Agent Skill names.
- Surfaces without a stored policy use Goblin `all`, environment `all`, host `none` without requiring eager settings writes.
- Policy survives Conversation rotation, movement, archive, and temporary unbinding. Multiple Surfaces sharing one project root remain independently configurable.

### `/skills` command

- Add non-creating status and mutation commands:
  - `/skills` shows the effective policy and currently resolvable skills with source/path provenance;
  - `/skills <goblin|environment|host> all|none` selects all or none from one source;
  - `/skills <goblin|environment|host> only <name>...` stores an explicit selected set;
  - `/skills reload` rebuilds the current runtime from unchanged policy after filesystem edits.
- Reads are instant and do not create a Conversation. Mutations/reload use queue timing so an in-flight turn settles before its runtime is replaced.
- Reject unknown sources, invalid skill names, missing selected skills, and cross-source name collisions with actionable paths and no partial policy update.

### Runtime orchestration

- Resolve the destination Surface’s effective policy together with the bound Conversation’s immutable Execution Environment before runner construction.
- Include a canonical policy fingerprint in runtime context validity. A policy mutation invalidates/removes the old runtime before a new one can be returned.
- On `/resume`, the destination Surface’s policy wins; the Conversation retains history/environment while the new runtime receives destination skills.
- Emit structured logs for policy source modes, selected skill provenance, diagnostics, collisions, and runtime replacement.

## Non-Goals

- **Skill authoring UI or marketplace:** users edit filesystem catalogs.
- **Reusable named profiles:** add only after repeated Surface policies demonstrate a real need.
- **Conversation-owned skills:** skill policy deliberately survives `/new` and does not move with history.
- **Project registry defaults:** each Surface is independent even when project roots match.
- **Host Pi directory discovery:** host means exact `~/.agents/skills/`, not `~/.pi/agent/skills/` or arbitrary packages.
- **Subagent behavior:** handled by `subagent-skill-inheritance`.
