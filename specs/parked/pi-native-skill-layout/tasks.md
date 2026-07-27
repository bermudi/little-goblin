# pi-native-skill-layout — Tasks

## Phase 1: Establish scoped skill catalog paths

- [ ] Add pure `goblinSkillsPath()` and `personalEnvironmentSkillsPath()` helpers plus a deprecated `skillsPath()` Goblin-catalog alias in `src/workspace/paths.ts`. Satisfies “Workspace path module centralizes goblin-owned paths.”
- [ ] Update startup directory initialization to create both canonical `.agents/skills/` roots through those helpers without changing current runtime selection behavior.
- [ ] Add path/config tests for exact locations, catalog distinctness, fresh home, existing home, and retained prompt/workspace paths.
- [ ] Run `bun test src/workspace/paths.test.ts src/config.test.ts` and `bun run typecheck`.

## Phase 2: Migrate the legacy Goblin catalog

- [ ] Add `src/workspace/skill-layout.ts` with legacy/destination inspection, populated-collision refusal, whole-directory atomic rename, canonical directory creation, and structured migration outcome. Satisfies “Legacy Goblin skills migrate without merging.”
- [ ] Order `ensureGoblinHome()` so migration runs before destination creation can mask legacy state; wire structured migration logging in normal startup and config validation.
- [ ] Add tests for legacy-only, empty destination, both-populated, destination-only, neither, interrupted/rerun, non-directory, permission, and non-ENOENT failures.
- [ ] Update decision-0007 guardrail references to cite decision 0034's narrow workspace skill-layout mutation boundary.
- [ ] Run touched tests, `bun run typecheck`, and `litespec validate pi-native-skill-layout`.
