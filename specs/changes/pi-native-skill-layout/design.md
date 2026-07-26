# pi-native-skill-layout — Design

## Architecture

### Two user-authored catalogs replace one ambiguous directory

The layout distinguishes deployment-wide Goblin capabilities from skills local to the personal Execution Environment:

```text
$GOBLIN_HOME/
├── .agents/skills/                 # Goblin catalog
└── workspace/
    └── .agents/skills/             # personal environment catalog
```

`src/workspace/paths.ts` remains a pure `node:path` module and gains:

```ts
goblinSkillsPath(home): string
personalEnvironmentSkillsPath(home): string
```

The old `skillsPath(home)` remains temporarily as a deprecated alias of `goblinSkillsPath(home)`. This preserves current main/generic-agent behavior until `skill-catalog-resolution` and `subagent-skill-inheritance` replace ambiguous callers. No caller should infer selection policy from these helpers.

### Startup migrates old global semantics to the Goblin catalog

Legacy `$GOBLIN_HOME/workspace/skills/` was explicitly injected into main runners regardless of CWD and inherited by generic subagents. Its semantics were deployment-wide, so migration targets `$GOBLIN_HOME/.agents/skills/`, not the new personal environment catalog.

`src/workspace/skill-layout.ts` exposes a narrow idempotent operation returning a structured outcome (`none | migrated`). Startup ordering becomes:

1. create only `$GOBLIN_HOME`, `workspace`, and unrelated required base directories;
2. inspect legacy and destination catalog states;
3. if legacy has entries and destination is absent/empty, remove only the empty destination if necessary and `renameSync` the whole legacy directory;
4. if both contain entries, throw with both paths before mutation;
5. create both canonical catalog directories;
6. log a successful migration outcome, then continue preflight/polling.

A directory rename keeps each skill tree intact and is atomic on the same filesystem. Destination-only and neither states are idempotent. This narrowly expands the sanctioned workspace filesystem boundary under decision 0034; config still does not read arbitrary runtime state.

## Decisions

### Decision: Existing skills are Goblin-wide

**Chosen:** migrate `workspace/skills` to `$GOBLIN_HOME/.agents/skills`.

**Why:** Existing loaders injected that directory in personal and project modes. Moving it to `workspace/.agents/skills` would silently narrow established capabilities to the personal environment.

### Decision: Use `.agents/skills`, not a Goblin-only convention

**Chosen:** both catalogs use the cross-harness Agent Skills directory shape.

**Why:** Pi recognizes `.agents/skills`, and the directory remains usable by other harnesses. `.agent/skills` singular is not a pi location; `.pi/skills` would be needlessly pi-specific for Goblin-owned catalogs.

### Decision: Refuse populated merges

**Chosen:** both populated means startup failure.

**Why:** Skill-name precedence is authority, not a harmless file copy. Automatic merging could overwrite scripts or change which instructions win. The operator can compare and move definitions deliberately.

### Decision: Keep migration separate from resolution

**Chosen:** this change only establishes locations and compatibility.

**Why:** Catalog source policy requires immutable environments and Surface settings. Mixing that into filesystem relocation would exceed the module boundary and make rollback harder.

## File Changes

### New files

- **`src/workspace/skill-layout.ts`** — inspect/migrate/create the two canonical catalog roots and return a structured outcome. Implements “Legacy Goblin skills migrate without merging.”
- **`src/workspace/skill-layout.test.ts`** — legacy-only, empty destination, populated collision, destination-only, fresh, and rerun coverage.

### Modified files

- **`src/workspace/paths.ts`** — add `goblinSkillsPath` and `personalEnvironmentSkillsPath`; deprecate `skillsPath` as Goblin-catalog alias. Implements “Workspace path module centralizes goblin-owned paths.”
- **`src/workspace/paths.test.ts`** — exact native path assertions and distinctness.
- **`src/config.ts`** — order base creation, skill-layout migration, and canonical directory creation without constructing paths inline.
- **`src/config.test.ts`** — fresh/existing layout and migration conflict behavior.
- **`src/index.ts` and `src/validate-config.ts`** — log structured migration outcome before preflight.
- **`specs/decisions/0007-config-startup-filesystem-mutation.md` / project guardrail documentation** — cite decision 0034's narrow skill-catalog migration exception rather than implying config remains mkdir-only.

### Intentionally unchanged

- **`src/agent/backend.ts` and `src/subagents/*` callers** — continue through the compatibility alias until dependent changes establish policy.
- **Prompt loading** — SOUL/AGENTS provenance and `noContextFiles` remain unchanged.
