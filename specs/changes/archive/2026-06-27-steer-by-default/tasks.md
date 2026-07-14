## Phase 1: AgentRunner.followUp

Add the `followUp` method to `AgentRunner` and remove the dead `isStreaming` branch from `prompt()`. This phase delivers the steer primitive that the bot layer will call in Phase 2. No bot-level changes yet — the method is tested in isolation against the mocked pi session.

- [x] In `src/agent/mod.ts`, add `followUp(content: string | (TextContent | ImageContent)[]): Promise<void>`:
  - Throws if `this.session` is null ("Cannot steer: session not initialized. Call prompt() first.")
  - Throws if `!this.session.isStreaming` ("Cannot steer: session is not streaming.")
  - Calls `this.normalizeContentForModel(content)` (reuses the existing private method — same `ModelNotCapableError` path)
  - String content → `await this.session.followUp(contentForModel)`
  - Multimodal content → unpack to `texts.join("\n")` + `images` array, call `await this.session.followUp(text, images.length > 0 ? images : undefined)`
  - Does NOT reset `this.callbacks`, `this.accumulatedText`, does NOT inject memory snapshot
- [x] In `src/agent/mod.ts`, remove the `if (this.session.isStreaming) { ... followUp ... } else { ... }` branch from `prompt()` (lines 329-342). `prompt()` now unconditionally calls `this.session.sendUserMessage(contentForModel)`. Add a guard: if `this.session.isStreaming`, throw `"Cannot prompt while streaming; use followUp()."` — this makes the contract explicit and catches bot-layer bugs.
- [x] Update `src/agent/mod.test.ts`:
  - Update tests under the "In-flight prompts use pi's followUp queueing" requirement: the second rapid `prompt()` call no longer routes to `followUp` internally. Tests that expected `session.followUp` to be called from `prompt()` now call `runner.followUp()` directly.
  - Add test: `followUp("text")` while `session.isStreaming === true` → calls `session.followUp("text")`, does NOT call `sendCustomMessage`, does NOT reset `this.callbacks`
  - Add test: `followUp` while `session.isStreaming === false` → throws "Cannot steer: session is not streaming."
  - Add test: `followUp` before `init()` (no session) → throws "session not initialized"
  - Add test: `followUp` with image content on image-incapable model → throws `ModelNotCapableError`
  - Add test: `followUp` with multimodal content on image-capable model → calls `session.followUp(text, [image])`
  - Add test: `prompt()` while `session.isStreaming === true` → throws "Cannot prompt while streaming; use followUp()."
- [x] Verify: `bun test src/agent/mod.test.ts` passes
- [x] Verify: `bun run tsc --noEmit` passes (strict mode)

Implements spec requirement: **In-flight prompts use pi's followUp queueing** (MODIFIED, agent capability).

## Phase 2: Steer in the text handler

Wire the bot's `message:text` handler to call `runner.followUp()` when the runner is streaming, instead of unconditionally routing through `promptQueues`. This is the core behavior change.

- [x] In `src/bot.ts`, modify the `message:text` handler (lines 433-454):
  - After `getOrCreateRunner` and the `text` guard, add the steer branch with race fallback (matching `design.md` Decision 1):
    ```typescript
    if (runner.isStreaming) {
      void runner.followUp(prepareUserContent(ctx, text)).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not streaming")) {
          // Race: turn ended mid-steer. Land the message as a fresh turn.
          const buffer = createMessageBuffer(locator);
          schedulePrompt(session, runner, async (isCurrent) => {
            if (!isCurrent()) return;
            await runner.prompt(prepareUserContent(ctx, text), buffer);
          }, (err) => {
            log.error("runner prompt failed (steer race fallback)", { error: String(err), sessionId: session.id });
          });
        } else {
          log.warn("steer failed", { error: msg, sessionId: session.id });
        }
      });
      return;
    }
    ```
  - Keep the existing `schedulePrompt` path for the idle case (create buffer, schedule, prompt)
- [x] Update `src/bot.test.ts`:
  - Add test: text message while `runner.isStreaming === true` → `runner.followUp` is called, `runner.prompt` is NOT called, no new `MessageBuffer` is created, update handler resolves without awaiting the turn
  - Add test: text message while idle → `runner.prompt` is called via `schedulePrompt` (existing behavior preserved)
  - Add test: steer failure (followUp rejects) → logged via `log.warn`, does not crash the handler
  - Add test: steer race — `followUp` rejects with "not streaming" (turn ended mid-steer) → bot falls back to `schedulePrompt` + `runner.prompt` with a fresh `MessageBuffer`, message is not dropped
  - Add test: steer race — `followUp` rejects with a non-"not streaming" error (runner disposed) → logged via `log.warn`, no fallback turn scheduled
  - Update the existing "same-session work remains ordered" test (around line 310): the scenario now expects the second message to steer into the first (call `followUp`), not to wait
- [x] Verify: `bun test src/bot.test.ts` passes
- [x] Verify: `bun run tsc --noEmit` passes

Implements spec requirement: **Agent turns do not block unrelated updates** (MODIFIED, orchestration capability) — steer branch.

## Phase 3: /queue command

Add the `/queue` command as a non-cancel-capable command that serializes text behind the running turn via the existing `promptQueues` mechanism.

- [x] In `src/commands/dispatch.ts`, extend the `SideEffect` union with `{ kind: "queue-prompt"; session: SessionState; text: string }`
- [x] In `src/commands/dispatch.ts`, add a `case "/queue":` to the switch (before `default:`):
  - If `!session` → `replied("No active session.")`
  - Parse arg: `rawText.slice("/queue".length).trim()`; if empty → `replied("Usage: /queue <text>")`
  - Push `{ kind: "queue-prompt", session, text: arg }` side effect
  - Ack reply: `existingRunner?.isStreaming ? "Queued. Will run after the current turn." : "Running."` (the turn starts immediately when idle; `bot.ts` does `await ctx.reply(result.reply)` unconditionally, so the reply must never be empty)
- [x] Do NOT add `"/queue"` to `CANCEL_CAPABLE_COMMANDS` (line 32)
- [x] In `src/bot.ts`, process the `queue-prompt` side effect in the side-effect loop (after the `runner-disposed` branch, ~line 416):
  - `getOrCreateRunner(effect.session, locator, ctx)` → `queueRunner`
  - `createMessageBuffer(locator)` → `queueBuffer`
  - `schedulePrompt(effect.session, queueRunner, async (isCurrent) => { if (!isCurrent()) return; await queueRunner.prompt(prepareUserContent(ctx, effect.text), queueBuffer); }, (err) => { log.error("queued prompt failed", { error: String(err), sessionId: effect.session.id }); })`
- [x] In `src/commands/help.ts`, add `/queue <text>` to `HELP_REPLY`
- [x] Add tests in `src/bot.test.ts`:
  - `/queue do this` while streaming → `interruptAndCascade` is NOT called, `runner.abort` is NOT called, `schedulePrompt` is called with the text, reply includes "Queued"
  - `/queue do this` while idle → `schedulePrompt` is called, reply is `"Running."` (work starts immediately)
  - `/queue` with no arg → reply is "Usage: /queue <text>", nothing scheduled
  - `/queue do this` with no session → reply is "No active session.", nothing scheduled
- [x] Add tests in `src/commands/dispatch.test.ts`:
  - `/queue` is not in `CANCEL_CAPABLE_COMMANDS`
  - `/help` reply includes `/queue <text>`
- [x] Verify: `bun test` passes (full suite)
- [x] Verify: `bun run tsc --noEmit` passes

Implements spec requirements:
- **Queue command enqueues text for the next idle turn** (ADDED, commands)
- **Queue command is not cancel-capable** (ADDED, commands)
- **Help command lists queue** (ADDED, commands)

## Phase 4: Spec reconciliation and canon alignment

This phase does not change behavior — it reconciles the canon specs with the new code so the canon reflects the shipped behavior. Run after Phases 1-3 are green.

- [x] Verify the canon specs in `specs/canon/agent/spec.md`, `specs/canon/orchestration/spec.md`, and `specs/canon/commands/spec.md` still match the deltas in `specs/changes/steer-by-default/specs/` (the deltas will be merged at archive time, but confirm no other active change has conflicting modifications to the same requirements)
- [x] Check `specs/glossary.md` for terms introduced by this change: "steer" and "queue" (in the dispatch sense). Add entries if they meet the glossary criteria (project-specific meaning, used across artifacts). "Steer" qualifies — it's the project term for `followUp`-based mid-turn injection, distinct from general usage. "Queue" is borderline (common term) but the `/queue` command gives it a specific project meaning.
- [x] Run `litespec validate steer-by-default` — confirm no structural issues
- [x] Manual smoke test (homelab): send goblin a long task, then send a corrective message mid-turn — confirm the correction is incorporated without waiting for the first turn to finish. Then test `/queue` to confirm serialize-and-wait still works.
