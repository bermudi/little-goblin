# Tasks: Binding-Scoped Project Directory

## Phase 1: Topic settings file and read/write API

- [x] Create `src/sessions/topic-settings.ts` with `TopicSettingsFile` interface (`topics`, `dm`, `supergroups`), `loadTopicSettings`, `saveTopicSettings`, `getProjectDir`, `bindProjectDir`
- [x] Add `topic-settings.test.ts` with load/save roundtrip, get/set per-topic and per-DM, atomic write verification
- [x] Add `topicSettingsPath` to `src/sessions/paths.ts`
- [x] Run `bun test src/sessions/topic-settings.test.ts`

## Phase 2: SessionManager delegates to topic settings

- [ ] Modify `src/sessions/manager.ts`: add `getProjectDir(locator)` delegating to `topic-settings.ts`; replace `setProjectDir(sessionId, dir)` with `bindProjectDir(locator, dir)` updating topic-settings instead of state.json
- [ ] Modify `src/sessions/manager.test.ts`: remove `setProjectDir` session tests; add `getProjectDir` delegation tests
- [ ] Run `bun test src/sessions/manager.test.ts`

## Phase 3: Bot reads projectDir from binding, /project writes to binding

- [ ] Modify `src/bot.ts`: `createRunner` reads `projectDir` via `manager.getProjectDir(locator)` instead of `session.projectDir`; `/project` handler passes `locator` to `manager.bindProjectDir(locator, dir)`
- [ ] Modify `src/commands/project.test.ts`: verify `setProjectDir` callback receives correct dir (no signature change in command logic itself)
- [ ] Run `bun test src/bot.ts` integration tests

## Phase 4: Deprecate SessionState.projectDir

- [ ] Modify `src/sessions/types.ts`: mark `projectDir` as `@deprecated` (keep in type for backward compat, but code stops reading it)
- [ ] Modify `src/sessions/manager.ts`: `createForChat` stops including `projectDir` in new `SessionState`; `resolve` recreation of stale topics produces state without `projectDir`
- [ ] Run `bun test` full suite

## Phase 5: Manual migration script (delivered separately, outside goblin source)

- [ ] Write standalone script to scan `sessions/*/state.json` for `projectDir`, populate `topic-settings.json` from bindings, strip `projectDir` from state.json files
- [ ] Document migration in `specs/changes/binding-scoped-project-dir/migration.md`
- [ ] Run migration on `$GOBLIN_HOME` and verify `/project` behavior

## Phase 6: Archive and spec adoption

- [ ] Run `litespec validate binding-scoped-project-dir`
- [ ] Run `litespec archive binding-scoped-project-dir` to merge deltas into canon
- [ ] Update `specs/canon/sessions/spec.md` (remove session-scoped projectDir)
- [ ] Update `specs/canon/project-command/spec.md` (update to binding-scoped)
- [ ] Update `specs/canon/agent-runner-project-dir/spec.md` (update source to binding, deprecate legacy field)
- [ ] Update `specs/backlog.md` if applicable
