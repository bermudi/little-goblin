## Architecture

```
goblin.json5 ──→ Config.skillSources ──→ AgentRunner.init()
                                           │
                                           ├─ "goblin-only" → DefaultResourceLoader(noSkills: true, additionalSkillPaths: [$GOBLIN_HOME/skills])
                                           ├─ "user"        → DefaultResourceLoader(noSkills: false, additionalSkillPaths: [$GOBLIN_HOME/skills])
                                           └─ "auto"        → no resourceLoader, pi creates its own
```

No new modules. The config field flows through the existing `Config` → `AgentRunner` path. Subagents are unaffected — they use `buildResourceLoader` from `named-agents.ts` which already has its own isolation logic.

## Decisions

### Three-mode enum, not boolean or freeform paths

**Chosen:** `skillSources: "goblin-only" | "user" | "auto"` as a string enum.

**Why not a boolean** (`isolateSkills: true/false`): Two degrees of openness (user-only vs. full auto) don't collapse into one bit. A boolean would force choosing one as the "true" meaning and lose the other.

**Why not a freeform array** (`skillPaths: [...]`): Exposing pi's `additionalSkillPaths` directly leaks pi internals into goblin's config surface. The three modes map to well-understood behaviors and can always be extended later.

**Constraints:** Adding a new mode requires updating the Zod enum and the resource loader switch. This is intentional — modes are not plugins.

**Breaking change note:** The default (`goblin-only`) is stricter than the current code, which runs with `noSkills: false`. Deploying this change without adding `skillSources: "user"` to `goblin.json5` will remove auto-discovered skills. This is intentional — the previous "hardcode fix" was incomplete (it didn't set `noSkills: true`), so this change actually delivers the isolation it promised.

### "auto" omits the resourceLoader entirely

**Chosen:** When `skillSources` is `"auto"`, pass no `resourceLoader` to `createAgentSession`, letting pi construct its own `DefaultResourceLoader` with full discovery.

**Why not construct one with `noSkills: false`:** Pi's internal `DefaultResourceLoader` handles packages, extensions, and cwd-ancestor skill dirs. Reconstructing all of that externally is fragile and would diverge from pi's defaults over time. The only thing we pin in `"auto"` mode is `agentDir` (via the `createAgentSession` call), which keeps auth/model paths isolated while letting skill discovery roam.

**Caveat:** Pi's internally-constructed `DefaultResourceLoader` uses goblin's in-memory `settingsManager` (empty defaults), so no package-based skills resolve. The `"auto"` mode gives pi's auto-discovery of `~/.agents/skills/` and cwd ancestor dirs, but not packages. This is acceptable — if an operator wants package-based skills, they should configure pi's settings file at `$GOBLIN_HOME/goblin/settings.json`.

### agentDir is always $GOBLIN_HOME/goblin/

All three modes pass `agentDir: piAgentDir(home)` to `createAgentSession`. This was the isolation fix from the previous change — it prevents `~/.pi/agent/` from being used for auth/models regardless of skill discovery mode.

## File Changes

### `src/schema.ts`
- Add `skillSources: z.enum(["goblin-only", "user", "auto"]).default("goblin-only")` to `ConfigFileSchema`.
- **Spec requirement:** skillSources config field

### `src/config.ts`
- Add `skillSources: cfg.skillSources` to the `Config` object in `loadConfig()`.
- Add `skillSources` to the `Config` interface: `skillSources: "goblin-only" | "user" | "auto"`.
- **Spec requirement:** Expose typed Config interface, skillSources config field

### `src/agent/mod.ts`
- Read `this.cfg.skillSources` in `init()` and branch on it:
  - `"goblin-only"` → add `noSkills: true` to the existing `DefaultResourceLoader` constructor (behavior change — current code lacks this flag)
  - `"user"` → current behavior (keep `DefaultResourceLoader` without `noSkills`)
  - `"auto"` → do not pass `resourceLoader` to `createAgentSession`
- All three modes pass `agentDir: piAgentDir(home)`.
- **Spec requirement:** Main agent skill discovery is configurable

### `src/agent/mod.test.ts`
- Add tests for each `skillSources` mode verifying the correct resource loader construction.
- **Spec requirement:** Main agent skill discovery is configurable

### `src/config.test.ts`
- Add test verifying `skillSources` defaults to `"goblin-only"` when absent.
- Add test verifying each valid value passes validation.
- Add test verifying invalid value is rejected.
- **Spec requirement:** skillSources config field
