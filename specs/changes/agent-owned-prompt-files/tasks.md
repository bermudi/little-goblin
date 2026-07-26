# agent-owned-prompt-files — tasks

- [x] Amend `specs/glossary.md:75` to call `SOUL.md` agent-owned.
- [x] Amend `specs/canon/agent/spec.md` prompt-file ownership language.
- [x] Update `src/agent/system-prompt.ts` section labels and log note.
- [x] Add `TurnCallbacks.sendNotice` and `MessageBuffer.sendNotice` implementation.
- [x] Add `AgentRunner` tracking and bounded notice for `write`/`edit` on reserved prompt files.
- [x] Add `agentsFilesOverride` filter to generic subagent `DefaultResourceLoader` in `src/subagents/named-agents.ts`.
- [x] Document `git-in-workspace` recovery path in `AGENTS.md` and `ARCHITECTURE.md`.
- [x] Update `src/agent/system-prompt.test.ts` to match renamed labels.
- [x] Add tests for prompt-file write notices in `src/agent/mod.test.ts`.
- [x] Add test for subagent deployment-prompt-file filter in `src/subagents/test/spawn.suite.ts`.
- [x] Run `bun run typecheck`.
- [x] Run `bun test` for affected suites.
