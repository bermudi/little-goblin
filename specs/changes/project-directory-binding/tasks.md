# Tasks: Project Directory Binding

- [x] Add `projectDir?: string` to `SessionState` type
- [x] Add `SessionManager.setProjectDir()` method with atomic state rewrite
- [x] Add `projectDir` to `AgentRunnerOptions` and use it for cwd/agentDir
- [x] Wire `/project` command into bot.ts message handler
- [x] Add `/project` to `CANCEL_CAPABLE_COMMANDS`
- [x] Implement `executeProject()` with path validation, tilde expansion, relative resolution
- [x] Add try/catch around command handler with user-facing error reply
- [x] Add cascade timeout suffix to reply
- [x] Dispose runner with try/finally to always delete from map
- [x] Write unit tests for `executeProject()` (11 cases)
- [x] Write unit tests for `SessionManager.setProjectDir()` (3 cases)
- [x] Create litespec artifacts (proposal, specs, design, tasks)
