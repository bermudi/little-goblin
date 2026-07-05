# workspace-layout — Tasks

## Phase 1: Update path helpers

- [x] Update `src/sessions/paths.ts`: `sessionsDir` → `state/sessions/`, `configPath` → `state/bindings.json`, `topicSettingsPath` → `state/topic-settings.json`, `schedulesPath` → `state/schedules.json`.
- [x] Update `src/pi-host.ts`: `workdirPath` → `scratch/workdir/`, `piAgentDir` → `state/pi/`, `agentsMdPath` → `workspace/AGENTS.md`, `soulMdPath` → `workspace/SOUL.md`. Add new `skillsPath(home)` helper returning `join(home, "workspace", "skills")`.
- [x] Update `src/memory/paths.ts`: `memoryDir` → `state/memory/`.
- [x] Update `src/subagents/paths.ts`: `subagentsRoot` → `scratch/subagents/`, `namedAgentsRoot` → `workspace/agents/`.
- [x] Update inline path construction in `src/agent/mod.ts` line 206: `join(home, "skills")` → `skillsPath(home)` (import from `pi-host.ts`).
- [x] Update inline path construction in `src/subagents/named-agents.ts` line 93: `join(home, "skills")` → `skillsPath(home)` (import from `pi-host.ts`).
- [x] Update error message strings in `src/agent/system-prompt.ts`: `$GOBLIN_HOME/SOUL.md` → `$GOBLIN_HOME/workspace/SOUL.md`, `$GOBLIN_HOME/AGENTS.md` → `$GOBLIN_HOME/workspace/AGENTS.md`.
- [x] Verify `src/subagents/runner.ts` has no inline `join(home, ...)` path construction; all paths resolve through `src/subagents/paths.ts` helpers.
- [x] Update expected path strings in `src/memory/paths.test.ts`: `memoryDir` assertions now expect `state/memory/` prefix; derived helpers (`scopeMemoryPath`, `userPath`, `archiveTopicPath`) propagate — verify their assertions too.
- [x] Update expected path strings in `src/pi-host.test.ts`: `workdirPath` → `scratch/workdir/`, `piAgentDir` → `state/pi/`, `agentsMdPath` → `workspace/AGENTS.md`, `soulMdPath` → `workspace/SOUL.md`. Add assertion for new `skillsPath(home)` → `workspace/skills/`.
- [ ] Note: `src/sessions/paths.test.ts` and `src/subagents/paths.test.ts` do not currently exist. If path-helper unit tests are added for these modules during implementation, they MUST assert the new paths (`state/sessions/`, `state/bindings.json`, `state/topic-settings.json`, `state/schedules.json` for sessions; `scratch/subagents/`, `workspace/agents/` for subagents).
- [x] Run `bun test src/memory/paths.test.ts src/pi-host.test.ts` to verify path helper unit tests pass (these test the helpers directly).

## Phase 2: Update ensureGoblinHome and migration

- [x] Rewrite `ensureGoblinHome()` in `src/config.ts` with three-phase approach: (1) create top-level groups (`workspace/`, `state/`, `scratch/`); (2) run migration loop; (3) create remaining subdirectories (`workspace/skills/`, `workspace/agents/`, `state/sessions/`, `state/memory/`, `state/pi/`, `scratch/workdir/`, `scratch/subagents/`). Remove the old `pi-agent/` → `goblin/` migration.
- [x] Add migration loop: for each legacy→new path pair, if old exists and new doesn't, `renameSync(old, new)`. If both exist, log warning and skip. Critical: migration-target subdirs must NOT be pre-created before migration runs.
- [x] Update `src/config.test.ts`: update directory creation assertions for the new tree; add migration tests (fresh install, legacy install with directories, legacy install with files, already-migrated, conflict, legacy directory migration despite top-level groups existing, partial-failure propagation — a `renameSync` that throws (e.g. cross-device) MUST propagate and stop startup rather than being swallowed or partially retried).
- [x] Run `bun test src/config.test.ts`.

## Phase 3: Update bindings and topic-settings

- [ ] Update `src/sessions/bindings.ts`: temp file name `.config.<rand>.tmp` → `.bindings.<rand>.tmp` (if hardcoded). Verify `pathFor` uses `configPath` from `paths.ts`.
- [ ] Update `src/sessions/topic-settings.ts`: verify path uses `topicSettingsPath` from `paths.ts`. Update temp file naming if hardcoded.
- [ ] Run `bun test src/sessions/manager.test.ts src/sessions/topic-settings.test.ts`.

## Phase 4: Update onboard

- [ ] Update `src/onboard.ts`: if onboarding writes `SOUL.md` or `AGENTS.md`, update write paths to `workspace/SOUL.md` and `workspace/AGENTS.md`.
- [ ] Run `bun test src/onboard.test.ts`.

## Phase 5: Update test fixtures with inline paths

- [ ] Update `src/agent/mod.test.ts`: replace `join(home, "memory")` → `join(home, "state", "memory")`, `join(home, "sessions", ...)` → `join(home, "state", "sessions", ...)`, `join(home, "skills")` → `join(home, "workspace", "skills")`.
- [ ] Update `src/subagents/test/support.ts`: `join(home, "workdir")` → `join(home, "scratch", "workdir")`, `join(home, "goblin")` → `join(home, "state", "pi")`.
- [ ] Update `src/subagents/test/memory.suite.ts`: `join(tmp, "memory", ...)` → `join(tmp, "state", "memory", ...)`.
- [ ] Update `src/memory/reflector.test.ts`: `join(home, "sessions", sessionId)` → `join(home, "state", "sessions", sessionId)`.
- [ ] Update `src/commands/voice.test.ts`: `join(home, "sessions", sessionId)` → `join(home, "state", "sessions", sessionId)`.
- [ ] Update `src/bot.test.ts`: any inline path references to `sessions/`, `memory/`, `workdir/`, `goblin/` root-level dirs.
- [ ] Update `src/commands/integration.test.ts`: `cfg.goblinHome, "sessions"` → `cfg.goblinHome, "state", "sessions"`.
- [ ] Update `src/commands/dispatch.test.ts`: `harness.cfg.goblinHome, "sessions"` → `harness.cfg.goblinHome, "state", "sessions"`.
- [ ] Update `src/tg/intake.test.ts`: any inline path references.
- [ ] Run `bun test` for the full suite to catch remaining inline paths.

## Phase 6: Update AGENTS.md, glossary, and verify

- [ ] Update `AGENTS.md` (repo root): `$GOBLIN_HOME/memory/` → `$GOBLIN_HOME/state/memory/` in the Memory section. Update any other path references. Extend the guardrail exception list to include `config.ts` for `ensureGoblinHome`-owned startup mutation, per decision `config-startup-filesystem-mutation` (0007).
- [ ] Update `specs/glossary.md`: rewrite every path-bearing term to the new layout. Terms to update: `binding` (`config.json` → `state/bindings.json`), `SOUL.md` (`$GOBLIN_HOME/SOUL.md` → `$GOBLIN_HOME/workspace/SOUL.md`), `memory.md / user.md` (`$GOBLIN_HOME/memory/` → `$GOBLIN_HOME/state/memory/`), `named subagent` (`~/goblin/agents/<name>/` → `~/goblin/workspace/agents/<name>/` — definition dir only: `AGENTS.md` + `skills/`), `persona memory` (`agents/<name>/memory.md` → `state/memory/agents/<name>/memory.md` — the memory file lives under `state/memory/`, not `workspace/agents/`), `archived session` / `resumable session` / `unbound session` (`sessions/<id>/` → `state/sessions/<id>/`), `workdir` (`sessions/<id>/workdir/` → `state/sessions/<id>/workdir/`).
- [ ] Run `bun test` full suite — all tests must pass.
- [ ] Run `bun run src/index.ts` against a test `$GOBLIN_HOME` with legacy paths to verify migration works end-to-end.
- [ ] Verify the new directory tree is created correctly on a fresh `$GOBLIN_HOME`.
- [ ] When this change is archived to canon: amend the archived `scheduled-turns` spec (or add a superseded-by annotation) so the canon `schedulesPath` contract reflects `state/schedules.json` instead of the root-level `schedules.json`.
