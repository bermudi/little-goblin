## Motivation

Pi's `DefaultPackageManager` hardcodes auto-discovery of skills from `~/.agents/skills/` (user home) and walks up from `cwd` looking for `.agents/skills/` directories. When goblin embeds pi as its agent loop, these discovery paths leak the operator's personal skills into goblin's Telegram sessions. This was surfaced when goblin responded to a Telegram message describing skills (like `web-content`) that exist only in the operator's `~/.agents/skills/`.

The current code constructs a `DefaultResourceLoader` with `additionalSkillPaths` pinned to `$GOBLIN_HOME/skills/` but does **not** set `noSkills: true`. This means pi's full auto-discovery still runs, including `~/.agents/skills/` and cwd ancestor walks. The default mode for this change (`goblin-only`) will set `noSkills: true`, which is a **behavior change** — it removes the auto-discovered skills. Some operators may want those skills, so this should be a config option.

## Scope

- Add a `skillSources` config field to `goblin.json5` controlling where goblin's main agent discovers pi skills.
- Three modes: `goblin-only` (default, strict isolation), `user` (current behavior — goblin skills plus `~/.agents/skills/` and cwd ancestor `.agents/skills/` dirs), `auto` (pi's full default auto-discovery including packages).
- Affects the main `AgentRunner` resource loader construction in `src/agent/mod.ts`.
- Subagents are unaffected — they already use isolated resource loaders via `buildResourceLoader`.
- Config schema, validation, and runtime wiring.

## Non-Goals

- Per-skill enable/disable — this is source-level granularity only.
- Changing subagent skill discovery — they have their own isolation via `named-agents.ts`.
- Skill path overrides beyond the three modes — custom paths are a separate concern.
