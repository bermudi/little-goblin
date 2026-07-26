# skill-catalog-resolution

## Motivation

The process-wide `skillSources: "goblin-only" | "user"` switch conflates three independent authorities: Goblin-owned skills, skills supplied by the active execution environment, and host-user skills under `~/.agents/skills/`. Enabling project discovery also enables ambient host and ancestor discovery, while disabling it suppresses legitimate project skills. The result cannot answer basic questions such as “load this project’s skills but not my personal Goblin skills” or “allow one host skill on this Surface.”

With pi-native catalog paths and immutable Execution Environments available from prerequisite changes, skill discovery can become an explicit, observable resolution step instead of an incidental side effect of `DefaultResourceLoader`.

## Scope

This change depends on `pi-native-skill-layout` and `immutable-project-environments`. It affects three capabilities: `agent`, `agent-runner-project-dir`, and `config`.

### Skill catalogs and policy values

- Define three main-runtime sources:
  - `goblin`: `$GOBLIN_HOME/.agents/skills/`;
  - `environment`: `$GOBLIN_HOME/workspace/.agents/skills/` for personal, or exact `<projectRoot>/.agents/skills/` plus `<projectRoot>/.pi/skills/` for project;
  - `host`: exact `~/.agents/skills/`.
- Represent each source selection as `all`, `none`, or a validated set of selected skill names.
- Provide a default policy of Goblin `all`, environment `all`, host `none`.

### Explicit resolution

- Add a deep `SkillCatalogResolver` that scans only the exact roots authorized by the Execution Environment and policy. It does not walk above `projectRoot`, read `~/.pi/agent/skills/`, or load package-provided skills implicitly.
- Use pi’s skill parser/loader for Agent Skills validation and progressive-disclosure data while retaining Goblin’s explicit source boundaries.
- Resolve skill names and canonical paths before creating a runtime, deduplicate the same canonical file reached twice, and fail loudly when selected sources contain distinct skills with the same name.
- Fail when a `selected` policy names a missing skill rather than silently reducing capabilities.
- Return a frozen resolved set with source/path provenance and diagnostics suitable for structured logs and later `/skills` output.

### Agent runtime

- Construct `DefaultResourceLoader` with ambient skill discovery disabled and only the resolver’s selected paths supplied explicitly.
- Keep context-file discovery disabled and Goblin’s explicit system-prompt provenance unchanged.
- For the intermediate state before Surface policy lands, use the default policy for every main runtime.
- Treat project skill roots as derived from the Conversation’s immutable Execution Environment, never from mutable Surface path data.

### Configuration

- Remove `skillSources` from the JSON5 schema and `Config`; an existing key fails validation with actionable guidance to remove it and use Surface `/skills` policy rather than being silently ignored.
- Do not replace it with another process-global source switch. Per-Surface persistence belongs to the dependent change.

## Non-Goals

- **Surface selection commands and persistence:** owned by `surface-skill-policy`.
- **Named/generic subagents:** owned by `subagent-skill-inheritance`.
- **Pi packages, extensions, prompts, and themes:** this change governs skills only.
- **Automatic ancestor discovery:** exact Execution Environment roots are intentional authority boundaries.
- **Downloading or installing skills:** catalogs are user-authored filesystem content.
- **Hot filesystem watching:** resolution occurs at runtime creation; explicit reload arrives with Surface policy.
