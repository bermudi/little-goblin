## Phase 1: Config schema and type changes
- [x] Add `skillSources: z.enum(["goblin-only", "user", "auto"]).default("goblin-only")` to `ConfigFileSchema` in `src/schema.ts`
- [x] Add `skillSources: "goblin-only" | "user" | "auto"` to the `Config` interface in `src/config.ts`
- [x] Wire `skillSources: cfg.skillSources` into the `Config` object in `loadConfig()`
- [x] Verify: `bun run --bun tsc --noEmit` passes

## Phase 2: Resource loader branching in AgentRunner
- [x] Update `AgentRunner.init()` in `src/agent/mod.ts` to read `this.cfg.skillSources` and branch:
  - `"goblin-only"` → add `noSkills: true` to existing `DefaultResourceLoader` options
  - `"user"` → keep existing `DefaultResourceLoader` as-is (no `noSkills` flag)
  - `"auto"` → do not pass `resourceLoader` to `createAgentSession`
- [x] All three modes pass `agentDir: piAgentDir(home)`
- [x] Verify: `bun run --bun tsc --noEmit` passes, `bun test` passes

## Phase 3: Tests
- [ ] Add test in `src/config.test.ts`: `skillSources` defaults to `"goblin-only"` when absent
- [ ] Add test in `src/config.test.ts`: each valid value (`"goblin-only"`, `"user"`, `"auto"`) passes validation
- [ ] Add test in `src/config.test.ts`: invalid value is rejected by Zod
- [ ] Add `DefaultResourceLoader` constructor-arg capture to the mock in `src/agent/mod.test.ts` (similar to `capturedCreateArgs`)
- [ ] Add test in `src/agent/mod.test.ts`: `"goblin-only"` passes `noSkills: true` to resource loader
- [ ] Add test in `src/agent/mod.test.ts`: `"user"` omits `noSkills` from resource loader constructor
- [ ] Add test in `src/agent/mod.test.ts`: `"auto"` omits `resourceLoader` from `createAgentSession` args
- [ ] Verify: `bun test` all green
