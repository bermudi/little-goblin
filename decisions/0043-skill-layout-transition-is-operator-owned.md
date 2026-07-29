---
nospec: true
id: 0043
date: 2026-07-29
status: accepted
spine: false
amends: [0008, 0034, 0038]
---

# 0043: Skill Layout Transition Is Operator-Owned

## Context

Decision 0034 established native, scoped Agent Skills catalogs and originally
assigned the one-time move from `workspace/skills/` to `.agents/skills/` to a
new Goblin migration module. The only deployment is operator-controlled, its
legacy catalog was empty, and the move can be inspected and completed directly.

Keeping a permanent migration step, state-version bump, legacy path helper, and
collision machinery after that one deployment has moved would make future
runtime code appear to support a transition that can no longer occur.

## Decision

The `pi-native-skill-layout` transition is an operator-owned deployment action,
not a Goblin migration capability. The operator SHALL inspect both paths, move
the legacy catalog without merging populated roots, and create the distinct
personal-environment catalog before deploying the native-layout code.

Goblin SHALL contain no skill-layout migration step, legacy skill path helper,
or compatibility `skillsPath()` alias. Runtime callers SHALL name the scoped
`goblinSkillsPath()` helper directly. `ensureGoblinHome()` remains mkdir-only
and creates both canonical catalog roots.

This completed layout-only transition does not change machine-managed state, so
`CURRENT_STATE_VERSION` remains 4. Future persisted-state changes remain
governed by decision 0038 and are not generally exempted from versioned offline
migration.

## Consequences

- The repository exposes only current skill paths and cannot accidentally rerun
  or extend a historical filesystem move.
- The one deployment must be prepared manually before the native-layout code is
  started; repository code cannot repair an unprepared deployment.
- Decision 0008's centralized path-construction rule remains, but its ambiguous
  `skillsPath()` helper is replaced by scope-specific names.
- Decisions 0034 and 0038 no longer assign this already-completed transition to
  the migration runner.
