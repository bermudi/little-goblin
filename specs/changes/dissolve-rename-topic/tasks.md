# Tasks

## Phase 1: Code deletion

- [x] Delete `renameTopicSchema`, the `RenameTopicInput` type, and `createRenameTopicTool` from `src/tg/tools.ts`
- [x] Remove `createRenameTopicTool` from the import in `src/tg/intake.ts` and drop its call from `getBetaTools()`
- [x] Verify `bun test src/tg/` fails only on the now-deleted `rename_topic` tests (confirms no other code path depends on the tool)

## Phase 2: Spec deletion

- [x] Remove the "Rename topic tool renames forum topics" requirement and all its scenarios from `specs/canon/beta-tools/spec.md`
- [x] Remove `rename_topic` / `createRenameTopicTool` references from the "Bot.ts instantiates tools per session" requirement scenarios in `specs/canon/beta-tools/spec.md` (lines ~148-160)

## Phase 3: Test deletion

- [x] Remove the `rename_topic` describe block from `src/tg/tools.test.ts` (lines ~417-473) and any imports it alone used
- [x] Also remove the `rename_topic` test in `src/tg/intake.test.ts` ("uses thread id for topic tools while buffers stay locator-scoped", lines ~279-323) — the proposal's scope item 4 named only `tools.test.ts`, but this test asserts `createRenameTopicTool` is registered and `editForumTopic` is called, so it must go too for the suite to pass

## Phase 4: Verify

- [ ] `bun test` full suite green
- [ ] `litespec validate dissolve-rename-topic` passes
- [ ] Confirm `handleTopicDescription` and the `forum_topic_*` handlers in `bot.ts` are untouched (they are M1 observation, not M3 mutation)
- [ ] Grep confirms zero remaining references to `rename_topic` / `createRenameTopicTool` in `src/` and `specs/canon/`
