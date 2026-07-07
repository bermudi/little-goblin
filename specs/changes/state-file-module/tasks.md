# Tasks

## Phase 1: Create the state-file module

- [ ] Add `src/sessions/state-file.ts` exporting `loadJsonFile<T>(path: string, defaultValue: T): T` (readFileSync → JSON.parse; ENOENT → default; SyntaxError → log warning + default; else throw) and `saveJsonFile(path: string, value: unknown): void` (`atomicWrite(path, JSON.stringify(value, null, 2) + "\n")`). Wraps `atomicWrite` from `src/fs.ts`; does not own atomic-write. Covers: `JSON state files load and save through one module`.
- [ ] Add `src/sessions/state-file.test.ts` covering: parsed JSON returned when file exists; default returned on ENOENT; default returned and warning logged on malformed JSON; non-ENOENT/non-Syntax errors propagate; save produces `JSON.stringify(v, null, 2) + "\n"` via atomicWrite. Covers all five scenarios under `JSON state files load and save through one module`.
- [ ] Run `bun test src/sessions/state-file.test.ts` and `bun run typecheck`.

Commit: `phase 1: add JSON state-file module`

## Phase 2: Migrate the three session consumers

- [ ] Update `src/sessions/state.ts`: `loadState` → `loadJsonFile<SessionState | null>(statePath(home, id), null)`; `saveState` → `saveJsonFile(statePath(home, state.id), state)`. Delete the try/catch recipe. Covers modified: `Persist session state atomically`.
- [ ] Update `src/sessions/bindings.ts`: `loadBindings` → `loadJsonFile(pathFor(home), structuredClone(DEFAULT_BINDINGS))`; `saveBindings` → `saveJsonFile(pathFor(home), bindings)`. Delete the try/catch recipe. Covers modified: `Persist bindings atomically`.
- [ ] Update `src/sessions/topic-settings.ts`: `loadTopicSettings` → `loadJsonFile(topicSettingsPath(home), structuredClone(DEFAULT_SETTINGS))`; `saveTopicSettings` → `saveJsonFile(topicSettingsPath(home), settings)`. Delete the try/catch recipe. Leave slot logic unchanged. Covers modified: `Topic settings file`.
- [ ] Run `bun test src/sessions` and `bun run typecheck`. Existing session tests must pass unchanged (behavior identical).

Commit: `phase 2: migrate session state files to the module`

## Phase 3: Boundary check and validation

- [ ] Grep `src/sessions/` for any remaining `readFileSync(..., "utf-8")` + `JSON.parse` + ENOENT/Syntax catch patterns outside `state-file.ts`; fix stragglers. Confirm `memory/store.ts` is NOT touched (it is Markdown, not JSON — out of scope per the corrected proposal).
- [ ] Run full validation: `litespec validate state-file-module`, `bun test`, `bun run typecheck`.

Commit: `phase 3: finalize state-file module boundary`
