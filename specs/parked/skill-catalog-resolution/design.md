# skill-catalog-resolution — Design

## Architecture

### Resolver separates catalogs from policy

`src/agent/skills/` becomes one deep module with four public concepts:

```ts
type SkillSource = "goblin" | "environment" | "host";
type SourceSelection =
  | { mode: "all" }
  | { mode: "none" }
  | { mode: "selected"; names: readonly SkillName[] };
type SkillPolicy = Record<SkillSource, SourceSelection>;
type ResolvedSkillSet = {
  skills: readonly ResolvedSkill[];
  diagnostics: readonly SkillDiagnostic[];
  fingerprint: string;
};
```

The default policy is Goblin all, environment all, host none. Names use pi/Agent Skills validation (`[a-z0-9-]`, bounded length); selected names are sorted/deduplicated at the input boundary.

`SkillCatalogResolver.resolve(environment, policy)` maps source to exact roots:

```text
goblin      $GOBLIN_HOME/.agents/skills
personal    $GOBLIN_HOME/workspace/.agents/skills
project     <canonical root>/.agents/skills
            <canonical root>/.pi/skills
host        <homedir>/.agents/skills
```

Missing optional roots are empty catalogs. Each existing root is loaded separately with pi's exported `loadSkillsFromDir`, which supplies parsing and Agent Skills diagnostics without invoking pi's package/ancestor discovery. The resolver attaches source identity, canonicalizes each file path, applies `all/none/selected`, and returns immutable DTOs.

The same canonical file selected through two roots is deduplicated. Distinct files with the same declared name are an error after policy filtering, with every source/path reported. A selected name absent from its source is also an error. This avoids Pi's order-dependent “first skill wins” behavior.

The fingerprint is stable JSON over canonical environment identity, canonical policy, and selected `{source,name,canonicalPath}` tuples. Skill bodies are not hashed or logged; filesystem edits require runtime recreation or the dependent explicit reload operation.

### AgentRunner consumes a resolved set

Runner composition resolves environment compatibility first, skills second, pi backend third. `AgentRunner`/`PiAgentBackend` receive `ResolvedSkillSet`, not raw roots or Config policy. The backend constructs `DefaultResourceLoader` with:

```ts
{
  noSkills: true,
  additionalSkillPaths: resolved.skills.map(skill => skill.filePath),
  noContextFiles: true,
  systemPrompt
}
```

Pi reparses selected files into its runtime format, but cannot add host, ancestor, package, `agentDir`, or project skills. Goblin remains responsible for the source boundary; Pi remains responsible for skill formatting/progressive disclosure.

For the build boundary before `surface-skill-policy`, dispatcher composition supplies `DEFAULT_SKILL_POLICY`. Internal runtimes with personal environments receive the same default unless their feature explicitly supplies a narrower policy later.

### Config policy disappears instead of being translated

`skillSources` is removed from `ConfigFileSchema`, `Config`, fixtures, and loader branches. The raw config boundary explicitly rejects that obsolete key with guidance to remove it; silently stripping it would make an operator believe policy still applies. No process-global replacement is added.

## Decisions

### Decision: Exact roots, no ambient Pi discovery

**Chosen:** call pi's parser on explicit source roots and pass explicit selected paths with `noSkills: true`.

**Why:** Pi's default combines host, project ancestors, packages, and agentDir. That cannot enforce immutable project-root authority or independent source selection. Reimplementing skill parsing would be wasteful; using `loadSkillsFromDir` keeps standard compliance.

### Decision: Goblin, environment, and host are distinct authorities

**Chosen:** model source provenance explicitly.

**Why:** “Global” was ambiguous. `$GOBLIN_HOME/.agents` belongs to this Goblin deployment; CWD catalogs belong to an execution environment; `~/.agents` belongs to the Unix user. Policy needs to select these independently.

### Decision: Project roots do not walk ancestors

**Chosen:** exact `<projectRoot>/.agents/skills` and `.pi/skills` only.

**Why:** canonical project root is the conversation's filesystem authority. Loading `/srv/.agents/skills` because the project is `/srv/a` would import instructions outside that declared boundary. Explicit root paths are predictable and testable.

### Decision: Conflicts fail rather than override

**Chosen:** duplicate selected names from distinct files are errors.

**Why:** Precedence would become a hidden authority policy and differ with path order. Source-qualified selection lets the user resolve a conflict intentionally by disabling one source/name.

### Decision: No hot watcher or body hashing

**Chosen:** catalog contents are snapshotted at runtime creation.

**Why:** skills are already startup/runtime resources, not live mutable state. Watchers and per-turn hashing add complexity. `/skills reload`, `/new`, `/resume`, and ordinary runtime recreation provide explicit refresh points.

## File Changes

### New files

- **`src/agent/skills/types.ts`** — source/selection/policy/resolved DTOs, defaults, canonical serialization, and validation.
- **`src/agent/skills/resolver.ts`** — exact root mapping, pi parsing, source filtering, canonical dedupe/conflict handling, fingerprinting, and structured diagnostics.
- **`src/agent/skills/mod.ts`** — narrow barrel.
- **`src/agent/skills/resolver.test.ts`** — source combinations, personal/project roots, no ancestor/host ambient load, selections, missing names, same-file dedupe, conflicts, malformed skills, and stable fingerprint.

### Modified files

- **`src/schema.ts`** — reject obsolete `skillSources` with actionable validation.
- **`src/config.ts`** — remove `Config.skillSources` and assignment.
- **`src/config.test.ts` and Config fixtures across tests** — remove the field and assert visible rejection.
- **`src/orchestration/dispatcher.ts`** — verify environment, resolve default policy, log provenance, and pass frozen skills into runner creation.
- **`src/agent/mod.ts`** — accept resolved skills instead of deciding discovery from Config; export necessary skill DTOs.
- **`src/agent/backend.ts`** — set `noSkills: true`, pass only selected files, preserve `noContextFiles` and explicit prompt.
- **`src/agent/mod.test.ts`, `src/agent/contract.test.ts`, backend tests** — exact loader options and absence of ambient discovery.
- **`src/sessions/environment.ts`** — expose only the existing environment-to-root helper needed by resolver; no skill policy enters sessions.

### Intentionally unchanged

- **Surface settings and commands** — dependent `surface-skill-policy` replaces the default.
- **Named/generic subagent loaders** — dependent patch handles inheritance/isolation.
- **Pi `agentDir`** — remains `$GOBLIN_HOME/state/pi` for auth/models and is not a skill source.
