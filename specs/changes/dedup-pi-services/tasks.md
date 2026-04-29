## Phase 1: Add pi-host module

- [x] Create `src/pi-host.ts` exporting `PiServices` type, `createPiServices(home)`, `workdirPath(home)`, `piAgentDir(home)`, `agentsMdPath(home)`
- [x] Create `src/pi-host.test.ts` with path helper tests (moved from agent/paths.test.ts)
- [x] Verify: `bun test src/pi-host.test.ts` passes

**Commit:** `phase 1: add pi-host module with shared service construction and path helpers`

## Phase 2: Migrate AgentRunner to pi-host

- [x] Update `src/agent/mod.ts`: replace inline AuthStorage/ModelRegistry/SettingsManager construction with `createPiServices(home)`, import path helpers from `../pi-host.ts`
- [x] Remove the dead AGENTS.md read + try/catch from `AgentRunner.init()` (content is read but never passed to pi; a pre-existing dead code path)
- [x] Verify: `bun test src/agent/` passes

**Commit:** `phase 2: migrate AgentRunner pi service construction to pi-host, drop dead AGENTS.md read`

## Phase 3: Migrate SubagentRunner to pi-host, delete old paths module

- [ ] Update `src/subagents/mod.ts`: import `PiServices` and `createPiServices` + path helpers from `../pi-host.ts`, replace `SharedServices` interface with `PiServices`, swap `getSharedServices()` body to call `createPiServices()`
- [ ] Delete `src/agent/paths.ts`
- [ ] Delete `src/agent/paths.test.ts`
- [ ] Verify: full test suite passes — `bun test`
- [ ] Verify: TypeScript compiles clean — `tsc --noEmit`

**Commit:** `phase 3: migrate SubagentRunner to pi-host, delete agent/paths module`
