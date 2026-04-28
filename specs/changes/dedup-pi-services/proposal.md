## Motivation

Pi service construction is duplicated across `AgentRunner.init()` and `SubagentRunner.getSharedServices()`. Both build the same trio — `AuthStorage`, `ModelRegistry`, `SettingsManager` — with identical paths under `$GOBLIN_HOME/pi-agent/`. The subagent module reaches across into `agent/paths.ts` for `piAgentDir` and `workdirPath`, which are pi-installation paths mislabeled as agent paths.

Extracting a single `pi-host` module eliminates the duplication, fixes the import direction, and makes any future pi configuration changes a single-site edit.

## Scope

- Create `src/pi-host.ts` exporting `createPiServices(home)` that returns `{ authStorage, modelRegistry, settingsManager }` and re-exports the path helpers (`workdirPath`, `piAgentDir`, `agentsMdPath`) from one canonical location.
- Move `piAgentDir`, `workdirPath`, `agentsMdPath` out of `src/agent/paths.ts` into `src/pi-host.ts`. Update `src/agent/paths.ts` to be a re-export barrel (preserving existing importers during the transition) or delete it after updating all importers.
- Replace the inline pi service construction in `AgentRunner.init()` with a call to `createPiServices()`.
- Replace `SubagentRunner.getSharedServices()` with a call to `createPiServices()`. The `SharedServices` interface and lazy-init logic in the subagent runner can be simplified or removed.
- Update all imports: `subagents/mod.ts` stops importing from `agent/paths.ts` and imports from `pi-host.ts` instead. `agent/mod.ts` does the same.
- Remove the dead `readFileSync(agentsMdPath(...))` call from `AgentRunner.init()` as an incidental cleanup (content is read but never passed to pi — a pre-existing dead code path).

## Non-Goals

- Not changing the `SessionManager` construction — that remains per-runner/per-subagent because it's semantically different (in-memory for goblin sessions, on-disk for subagents).
- Not touching `resolveModel()` or the model registry — those are separate concerns.
- Not extracting event translation (the duplicate switch statements) — that's a separate refactor.
- Not changing the `ResourceLoader` construction for named vs generic subagents — those paths depend on subagent identity, not just pi configuration.
- Not wiring AGENTS.md into the system prompt — the dead read is removed as cleanup; wiring belongs in a separate change.
