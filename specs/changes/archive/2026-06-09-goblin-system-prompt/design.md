## Architecture

Goblin will own prompt construction in the main `AgentRunner` lazy session-initialization path before handing control to pi. The main runner will always use an explicit `DefaultResourceLoader` with a constructed `systemPrompt` and `noContextFiles: true`.

The constructed prompt has four layers:

1. `$GOBLIN_HOME/SOUL.md` — required deployment-owned identity and voice.
2. `$GOBLIN_HOME/AGENTS.md` — optional deployment-owned operating rules.
3. Product shell — a small code-owned scaffold for runtime mechanics only.
4. `projectDir/AGENTS.md` — optional exact bound-project guidance, positively scoped to project work.

The product shell is deliberately not a persona fallback. It must not contain the deployed agent's name, the user's name, private voice, or negative anti-persona instructions. Onboarding owns creation of deployment prompt files; runtime validates them but does not create them.

Startup preflight and the lazy runner prompt-construction path share the same prompt-file validation semantics. Missing required `SOUL.md` is an actionable configuration error in both places; missing optional files are skipped; non-`ENOENT` read failures propagate.

This change also removes `skillSources: "auto"`. The main runner needs an explicit resource loader to control the system prompt. Rather than preserving an ambiguous mode where pi constructs the loader and prompt, operators must choose either `goblin-only` or `user` skill discovery. Skill discovery remains a separate policy from prompt/context-file discovery: even in `user` skill mode, the main runner disables pi context-file loading and uses only the Goblin prompt builder's allowed files.

Named subagents and generic subagents are out of scope. Their prompt-loading behavior remains unchanged.

## Decisions

This design follows `specs/decisions/0003-main-goblin-prompt-ownership.md`: main Goblin prompt/context loading is explicit, deployment identity lives in `$GOBLIN_HOME`, and subagent prompt loading remains separately owned.

### SOUL.md is required deployment identity

Chosen: runtime requires `$GOBLIN_HOME/SOUL.md`; startup preflight fails before Telegram polling if it is missing.

Why: if SOUL is missing, Goblin has no deployment-owned identity. Allowing pi or source code to fill that gap recreates the original bug.

Trade-off: existing deployments must run onboarding or create `SOUL.md` manually before the bot starts.

### Onboarding creates prompt files, runtime does not

Chosen: onboarding/migration asks for the conversational agent name and writes `SOUL.md` when missing. It also writes a modest default `AGENTS.md` when missing. Existing files are never overwritten.

Why: prompt files are user/deployment-owned configuration. Runtime mutation during startup or message handling would hide configuration problems and force generic identity choices.

Trade-off: migration is explicit. If an existing `AGENTS.md` contains old identity text, onboarding warns but does not copy or move content.

### Small product shell for mechanics only

Chosen: source code supplies only section framing and invariant runtime mechanics such as Telegram channel behavior, tool truthfulness, destructive-action boundaries, and memory-aside semantics.

Why: these are product/runtime behaviors, not deployed persona. Keeping the shell small prevents public source code from becoming private identity configuration.

Trade-off: deployment files carry the actual voice and operating preferences.

### Exact project AGENTS only

Chosen: when a session is project-bound, only exact `projectDir/AGENTS.md` is loaded as project guidance. No ancestor walk, global file, or compatibility file is loaded.

Why: implicit context discovery is the contamination path. Positive scoping gives project rules useful weight without treating them as identity.

Trade-off: repos that only provide `CLAUDE.md`, `.cursorrules`, or nested/ancestor `AGENTS.md` are ignored until an explicit future change adds that support.

### Remove skillSources auto

Chosen: `skillSources` becomes `"goblin-only" | "user"`, with `goblin-only` remaining the default. Config containing `"auto"` fails validation.

Why: `auto` meant no resource loader, which conflicts with controlled system prompt construction. Reconstructing pi's full default discovery externally would make `auto` a lie.

Trade-off: operators using `auto` must edit config and explicitly choose isolation or user/global skills.

## File Changes

- `src/pi-host.ts`
  - Add `soulMdPath(home)` alongside `agentsMdPath(home)`.
  - Covers: "Pi-host exposes Goblin prompt file paths".

- `src/pi-host.test.ts`
  - Add coverage for `soulMdPath(home)`.
  - Covers: "Pi-host exposes Goblin prompt file paths".

- `src/agent/system-prompt.ts` or equivalent focused module
  - Assemble required SOUL, optional deployment AGENTS, product shell, and optional exact project AGENTS.
  - Fail on missing SOUL, skip missing optional files, propagate non-`ENOENT` read failures.
  - Export the product shell through a concrete constant or function so tests can assert approved section headings and mechanics without brittle model-output checks.
  - Export or share the missing-SOUL error contract used by both startup preflight and runner initialization.
  - Avoid hardcoded deployed identity and negative anti-persona fallback.
  - Covers the prompt construction, SOUL, AGENTS, product shell, context-file exclusion, project guidance, and prompt-read requirements.

- `src/agent/mod.ts`
  - Call the prompt builder during `init()`.
  - Always construct an explicit `DefaultResourceLoader` for the main runner.
  - Set `noContextFiles: true`.
  - Preserve existing `goblin-only` and `user` skill-source behavior.
  - Preserve per-turn memory injection.

- `src/schema.ts`, `src/config.ts`, `src/config.test.ts`
  - Remove `"auto"` from `skillSources` schema/type/tests.
  - Keep default `"goblin-only"`.
  - Add rejection coverage for `"auto"`.

- Startup entrypoint (`src/index.ts` or current main module)
  - Add preflight after config/home setup and before `bot.start()`.
  - Fail on missing SOUL and warn on missing AGENTS.
  - Covers: "Startup preflights Goblin prompt files".

- `src/onboard.ts`
  - Ask for conversational agent name when creating missing `SOUL.md`.
  - Write identity-plus-voice `SOUL.md` template when missing.
  - Write modest operating-rules `AGENTS.md` template when missing.
  - Warn when AGENTS exists without SOUL; do not copy content.
  - Never overwrite existing prompt files.

- `src/agent/mod.test.ts` and new prompt/preflight/onboarding tests as appropriate
  - Cover resource-loader construction, `noContextFiles: true`, prompt propagation, required SOUL, optional AGENTS, project guidance, and config/onboarding/preflight behavior.
