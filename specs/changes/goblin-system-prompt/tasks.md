## Phase 1: Add prompt construction

- [x] Add `soulMdPath(home)` to `src/pi-host.ts` and cover it in `src/pi-host.test.ts`. Covers: "Pi-host exposes Goblin prompt file paths".
- [x] Add a focused main-Goblin prompt-construction module that reads required `$GOBLIN_HOME/SOUL.md`, optional `$GOBLIN_HOME/AGENTS.md`, and optional exact `projectDir/AGENTS.md`, then assembles them with a small product shell. Covers: "Main AgentRunner constructs a Goblin system prompt", "SOUL provides deployment identity and voice", "Deployment AGENTS provides optional operating rules", "Product shell contains runtime mechanics only", and "Project AGENTS is exact project guidance".
- [x] Export the product shell as a constant or function and unit test its approved section headings/mechanics without relying on model-output assertions. Covers: "Product shell contains runtime mechanics only".
- [x] Unit test prompt construction for required SOUL, optional AGENTS, product shell boundaries, exact project AGENTS, missing optional files, global/compatibility exclusion, and non-`ENOENT` read failures for optional deployment/project prompt files.
- [x] Add a shared missing-SOUL configuration error contract used by startup preflight and lazy runner prompt construction. Covers: "Prompt validation uses a shared error contract".
- [x] Run targeted prompt and pi-host tests.

## Phase 2: Wire main AgentRunner

- [x] Update the main `AgentRunner` lazy session-initialization path to build the Goblin system prompt before `createAgentSession()` and pass it through `DefaultResourceLoader({ systemPrompt })`. Covers: "AgentRunner owns pi's AgentSession".
- [x] Set `noContextFiles: true` on the main runner resource loader. Covers: "Goblin disables implicit context file loading".
- [x] Preserve `goblin-only` and `user` skill-source behavior while always using an explicit main-runner resource loader.
- [x] Preserve per-turn memory injection as `sendCustomMessage(..., { deliverAs: "nextTurn" })` without concatenating memory into the system prompt. Covers: "Memory remains per-turn context".
- [x] Update `src/agent/mod.test.ts` expectations for resource loader creation, constructed prompt propagation, `noContextFiles`, and project-bound prompt behavior.
- [x] Run targeted agent tests.

## Phase 3: Remove skillSources auto

- [x] Remove `"auto"` from the config schema and `Config` type. Covers: "Validate config with Zod schema".
- [x] Update config tests so `"goblin-only"` remains the default, `"user"` remains valid, and `"auto"` is rejected.
- [x] Update any tests or fixtures that still configure `skillSources: "auto"`.
- [x] Run targeted config tests plus agent resource-loader tests.

## Phase 4: Add startup preflight and onboarding migration

- [x] Add startup preflight before Telegram polling that fails on missing `$GOBLIN_HOME/SOUL.md` and warns on missing `$GOBLIN_HOME/AGENTS.md`. Covers: "Startup preflights Goblin prompt files".
- [x] Update onboarding to create missing `SOUL.md` by asking for conversational agent name and writing a concise identity-plus-voice template. Covers: "Onboarding creates deployment prompt files".
- [x] Update onboarding to create missing `AGENTS.md` with modest operating-rules defaults and never overwrite existing files.
- [x] Add onboarding warning for existing `AGENTS.md` without `SOUL.md`; do not copy or move content.
- [x] Run targeted startup/onboarding tests.

## Phase 5: Verify behavior

- [x] Run the relevant project test command covering config, pi-host, prompt construction, AgentRunner, startup preflight, and onboarding.
- [x] Manually smoke-test startup with missing `SOUL.md` and confirm the process fails before Telegram polling with an actionable error.
- [x] Deterministically verify the main runner passes a `DefaultResourceLoader` a prompt containing `SOUL.md` content, sets `noContextFiles: true`, and does not rely on pi implicit context loading.
- [x] Manually smoke-test a configured Goblin with `SOUL.md` and sanity-check that the first reply reflects the deployment identity.
- [x] Manually smoke-test a project-bound session and verify only exact `projectDir/AGENTS.md` is included as project guidance.
