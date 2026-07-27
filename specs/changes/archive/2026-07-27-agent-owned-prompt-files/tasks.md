# agent-owned-prompt-files — tasks

## Phase 1: Canon, glossary, and source labels

- [x] Amend `specs/glossary.md:75` to call `SOUL.md` agent-owned.
- [x] Amend `specs/canon/agent/spec.md` prompt-file ownership language.
- [x] Update `src/agent/system-prompt.ts` section labels and log note.
- [x] Update `src/agent/system-prompt.test.ts` to match renamed labels.

## Phase 2: Bounded Surface notice on reserved prompt-file writes

- [x] Add `TurnCallbacks.sendNotice` and `MessageBuffer.sendNotice` implementation.
- [x] Add `AgentRunner` tracking and bounded notice for `write`/`edit` on reserved prompt files.
- [x] Add tests for prompt-file write notices in `src/agent/mod.test.ts`.

## Phase 3: Subagent bootstrap filter

- [x] Add `agentsFilesOverride` filter to generic subagent `DefaultResourceLoader` in `src/subagents/named-agents.ts`.
- [x] Add test for subagent deployment-prompt-file filter in `src/subagents/test/spawn.suite.ts`.

## Phase 4: Recovery documentation and verification

- [x] Document `git-in-workspace` recovery path in `AGENTS.md` and `ARCHITECTURE.md`.
- [x] Run `bun run typecheck`.
- [x] Run `bun test` for affected suites.
