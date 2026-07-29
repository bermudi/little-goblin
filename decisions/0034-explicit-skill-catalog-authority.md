---
nospec: true
id: 0034
date: 2026-07-26
status: accepted
spine: false
---

# 0034: Explicit Skill Catalog Authority

> Amended by decision 0043: the legacy catalog move is operator-owned, and
> Goblin contains no skill-layout migration boundary or compatibility path.

## Context

Goblin currently stores skills at `$GOBLIN_HOME/workspace/skills/` and injects that path into pi's `DefaultResourceLoader`. A process-wide `skillSources` switch decides whether pi ambient discovery is also enabled. This conflates deployment-wide Goblin skills, active-CWD skills, and host-user skills; enabling one authority can unintentionally enable ancestor, package, or host sources.

The personal Execution Environment now uses `$GOBLIN_HOME/workspace` as CWD, and multiple Telegram Surfaces may share one personal or project environment while needing different capability posture. Skill location, filesystem authority, and Surface selection therefore require separate identities.

Pi exposes standard `.agents/skills/` catalogs and public skill parsing APIs, so Goblin need not invent a skill format even when it controls discovery.

## Decision

Skill authority is explicit and layered:

- **Goblin catalog:** `$GOBLIN_HOME/.agents/skills/`, user-authored skills eligible across execution environments.
- **Environment catalog:** exact `$GOBLIN_HOME/workspace/.agents/skills/` for personal, or exact `<projectRoot>/.agents/skills/` and `<projectRoot>/.pi/skills/` for project.
- **Host catalog:** exact `~/.agents/skills/`, disabled by default and selectable explicitly.
- **Named-agent catalog:** `$GOBLIN_HOME/workspace/agents/<name>/.agents/skills/`, isolated by default.

A Surface owns selection policy for Goblin, environment, and host catalogs. The policy does not change a Conversation's immutable Execution Environment. Runtime creation combines Conversation environment with destination Surface policy into a frozen resolved manifest. Generic subagents inherit that manifest; named agents use their isolated catalog.

Goblin SHALL use pi's Agent Skills parser/loader but SHALL NOT rely on ambient skill discovery for main or generic runtimes. Exact roots are selected explicitly, project discovery does not walk above canonical `projectRoot`, and distinct selected skills with duplicate names fail rather than using path-order precedence.

Legacy `$GOBLIN_HOME/workspace/skills/` has Goblin-wide semantics and is moved once by the operator to `$GOBLIN_HOME/.agents/skills/`. Goblin retains only the canonical scoped paths.

## Consequences

- A personal workspace skill can be selected on one Surface without appearing on every topic sharing that workspace.
- Two Surfaces sharing a project root may expose different Goblin/host skills without changing CWD or history compatibility.
- Host skills never enter Goblin merely because pi would normally discover them.
- The process-wide `skillSources` config field is removed.
- Filesystem catalogs remain canonical; there is no skill registry database or marketplace.
- Skill catalog edits take effect on runtime recreation or explicit reload, not through a watcher.
- Decision 0004's statement that project capability relies on pi ambient auto-loading is superseded for skills; exact project `AGENTS.md` remains explicit project guidance.
- Decision 0007's mkdir-only config exception remains narrow; no skill-layout migration writes occur in Goblin.

## Alternatives Considered

### Use pi ambient discovery unchanged

Rejected. It couples project skills to host, ancestors, agentDir, and packages and cannot implement per-Surface source policy.

### Treat `$GOBLIN_HOME/workspace/.agents/skills` as Goblin-global

Rejected. Workspace is the personal execution root. Calling its skills global prevents one Surface from distinguishing personal-environment skills from capabilities intended to follow Goblin into projects.

### Create Surface-specific skill directories

Rejected. Telegram identity would leak into user-authored filesystem layout and encourage duplicated skill definitions. Surface policy selects from shared catalogs instead.

### Persist a skill registry in state

Rejected. The filesystem and Agent Skills metadata already form the catalog. A database would duplicate authority and create synchronization problems.
