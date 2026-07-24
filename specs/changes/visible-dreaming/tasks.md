# visible-dreaming — Tasks

## Phase 1: Dream fragment store

- [ ] Create `src/memory/dream-fragment.ts` with `DreamFragment` and `DreamDiaryNight` types, and `readFragment` / `writeFragment` functions. `readFragment` returns `null` on ENOENT; `writeFragment` uses `atomicWrite` from `src/fs.ts`. Satisfies "Dream fragment store" requirement.
- [ ] Add `readDreamPrefs` / `writeDreamPrefs` to `src/memory/dream-fragment.ts`. `readDreamPrefs` returns `{ enabled: false }` on ENOENT; `writeDreamPrefs` uses `atomicWrite`. Satisfies "Dream message preferences" requirement.
- [ ] Add `readDeliveryRecord` / `writeDeliveryRecord` to `src/memory/dream-fragment.ts`. Same ENOENT/atomic patterns. Supports "Dream message delivery" requirement.
- [ ] Add `readDreamDiarySummary(home, nights)` to `src/memory/dream-fragment.ts`. Reads the operational `dreams/history.json` for the last N nights, returns `DreamDiaryNight[]`. The markdown `dreams/YYYY-MM-DD.md` files are export-only views and are not read by application code. Satisfies "Dream diary summary line for /dreams command" requirement.
- [ ] Add `appendDreamHistory(home, entry)` to `src/memory/dream-fragment.ts`. Appends a dated entry with `phase`, `summary`, and `fragmentProduced` to `dreams/history.json` using an atomic write. Called by the dreaming pipeline after each sleep phase.
- [ ] Re-export the public `dream-fragment` API from `src/memory/mod.ts` so other modules import through the memory barrel.
- [ ] Create `src/memory/dream-fragment.test.ts` with colocated tests: read absent fragment/prefs/delivery, write+read round-trip, diary summary with mixed activity, diary summary with no files.
- [ ] Run `bun run typecheck` and `bun test src/memory/dream-fragment.test.ts` to verify.

## Phase 2: Dream distillation in the dreaming pipeline

- [ ] Add `distillCallback` to `DreamingPipelineOptions` and `DreamingPipeline` (optional `(prompt: string) => Promise<string>`, same injection pattern as `extractor`). Add a `setDistillCallback(cb)` method.
- [ ] Add `distillDream(themes: Map<string, Set<string>>)` method to `DreamingPipeline`. Builds a distillation prompt from theme tags + session counts (no transcript text), calls `distillCallback`, truncates the response to 400 chars at nearest word boundary, calls `writeFragment`, and records `fragmentProduced: true` in the history only after `writeFragment` succeeds. No-op when `distillCallback` is null or themes map is empty. Satisfies "Dream distillation after REM sleep" requirement.
- [ ] Modify `remSleepInner()` in `src/memory/dreaming.ts` to call `this.distillDream(tagSessions)` after the promotion loop (after line 515) when `promoted > 0`. The `tagSessions` map is already available in scope.
- [ ] Add tests for `distillDream`: produces fragment when themes exist, no-op when themes empty, no-op when callback null, truncates at 400 chars, prompt forbids user analysis.
- [ ] Run `bun run typecheck` and `bun test` to verify.

## Phase 3: Wire distillation in the scheduler loop

- [ ] In `src/scheduler/loop.ts`, add a `createDistillCallback()` method (same pattern as `createModelExtractor`) that dispatches a distillation prompt via `enqueueInternalTurn` on the `__goblin_dreaming__` session and returns the model's text.
- [ ] In `startMemoryTimers()`, after setting the extractor, call `this.memoryEngine.dreaming.setDistillCallback(this.createDistillCallback())` when `enqueueInternalTurn` is available.
- [ ] Build the distillation prompt in the scheduler loop: instruct the model to write a first-person dream fragment (≤400 chars) from goblin's own perspective, grounded in the provided theme tags and session counts, forbidding naming the user or quoting private content.
- [ ] Run `bun run typecheck` and `bun test` to verify.

## Phase 4: Dream message delivery

- [ ] In `src/scheduler/loop.ts`, after `runRemSleep()` resolves in the REM timer callback (line 289-292), add a dream delivery step: read `readDreamPrefs()`, read `readDeliveryRecord()`, check that no delivery record exists or the last `deliveredAt` is more than 24 hours ago, resolve the primary session via `this.sessionSource.list()`, and call `this.dispatcher.enqueueScheduledTurn()` with the formatted `🌙 <fragment>` message. Write `writeDeliveryRecord()` with the current `deliveredAt` after successful dispatch.
- [ ] Extract the primary session resolution into a helper: filter `list()` for DM sessions (positive `chatId`, no `topicId`) first, fall back to the most recently created session (last element from `SessionManager.list()`, which sorts by `createdAt` ascending). Skip silently with debug log if none found. Satisfies "Dream message delivery" requirement.
- [ ] Add tests for the delivery path: enabled + no prior delivery → sends message; disabled → no message; delivered within 24 hours → no message; no session → skips with debug log.
- [ ] Run `bun run typecheck` and `bun test` to verify.

## Phase 5: Per-turn dream aside in AgentRunner

- [ ] In `src/agent/mod.ts`, import `readFragment` from `../memory/mod.ts`.
- [ ] In `prompt()`, after the memory aside injection (line 633) and before `sendUserMessage` (line 636), add: call `readFragment(this.cfg.goblinHome)`, format the `## last dream` aside (heading + fragment text + `(dreamt YYYY-MM-DD, REM phase)` line), and call `this.backend.sendCustomMessage(aside, { deliverAs: "nextTurn" })` when the fragment is non-null. Satisfies "AgentRunner injects dream fragment as per-turn aside" requirement.
- [ ] Verify `followUp()` does not inject the dream aside (no change needed — `followUp` already doesn't inject the memory snapshot).
- [ ] Add tests: dream aside injected when fragment exists, omitted when absent, not injected on followUp, fresh fragment read each turn, independent of memory snapshot.
- [ ] Run `bun run typecheck` and `bun test` to verify.

## Phase 6: /dreams command

- [ ] Create `src/commands/dreams.ts` with `executeDreams` handler. Reads the argument (`full` / `on` / `off` / none), calls the appropriate function exported from `../memory/mod.ts`, returns a `DispatchResult` with the formatted reply. Satisfies "Implement /dreams command" requirement.
- [ ] Register `/dreams` in `COMMAND_REGISTRY` in `src/commands/registry.ts` with `timing: "instant"`, `argsHint: "[full|on|off]"`, and the handler from `dreams.ts`. Satisfies "/dreams is registered in the command registry and help" requirement.
- [ ] Create `src/commands/dreams.test.ts` with tests: no-arg shows 7-night summary, `full` shows most recent fragment, `full` with no fragments, `on` enables prefs, `off` disables prefs, no session required, instant-timing.
- [ ] Run `bun run typecheck` and `bun test` to verify.
- [ ] Run `bun run typecheck` (full project `tsc --noEmit`) to confirm no regressions.
