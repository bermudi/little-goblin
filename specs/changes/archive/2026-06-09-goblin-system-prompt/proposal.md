## Motivation

Little Goblin currently lets pi construct the main agent's system prompt when no explicit prompt is supplied. In practice this can leak pi's coding-assistant identity into Telegram; a live session greeted the user as "your coding assistant" instead of using the deployed Goblin persona.

The fix is not to hardcode a private persona in source code. This is a public repo: the deployed agent's name, voice, and relationship to its user belong in `$GOBLIN_HOME`, not in TypeScript. Goblin needs a small code-owned prompt shell for runtime mechanics, plus deployment-owned files for identity and operating rules.

This change makes prompt ownership explicit:

- `$GOBLIN_HOME/SOUL.md` is the required deployment-owned identity and voice file.
- `$GOBLIN_HOME/AGENTS.md` is an optional deployment-owned operating-rules file.
- The product shell is small and contains only runtime mechanics, never private/deployed identity.
- Project instructions are loaded only from the exact bound `projectDir/AGENTS.md`, positively scoped as project guidance.
- The ambiguous `skillSources: "auto"` mode is removed so the main runner always uses an explicit resource loader.

## Scope

This change affects the `agent`, `config`, `orchestration`, `pi-host`, and `agent-runner-project-dir` capabilities.

Included behavior:

- Construct the main Goblin system prompt from:
  - required `$GOBLIN_HOME/SOUL.md`
  - optional `$GOBLIN_HOME/AGENTS.md`
  - a small product shell for Telegram/runtime/tool mechanics
  - optional exact `projectDir/AGENTS.md` as positively scoped project guidance
- Disable pi's implicit context-file loading for the main Goblin runner so global or compatibility instruction files are not imported.
- Require `SOUL.md` at startup preflight; fail before Telegram polling if missing.
- Warn at startup when `AGENTS.md` is missing, but do not fail.
- Extend onboarding/migration to create `SOUL.md` and `AGENTS.md` when missing, without overwriting existing files.
- During onboarding, ask for the conversational agent name and write it into `SOUL.md`; runtime does not inject a separate `agentName`.
- Remove `skillSources: "auto"` from config; users must choose `goblin-only` or `user`, with `goblin-only` remaining the default.

## Non-Goals

- No hardcoded deployed identity, user name, conversational agent name, or private persona in source code.
- No negative prompt fallback such as "do not be a coding assistant."
- No automatic runtime creation of prompt files during message handling or startup.
- No parsing, sanitizing, copying, or moving identity text from existing `AGENTS.md` into `SOUL.md`.
- No loading of global, ancestor, or compatibility instruction files such as `~/.agents/AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or `.cursor`.
- No changes to named subagent prompt loading.
- No changes to generic subagent prompt loading.
- No changes to memory storage, memory curation, or snapshot formatting.
