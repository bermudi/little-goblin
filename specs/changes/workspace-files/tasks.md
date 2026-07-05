# workspace-files — Tasks

## Phase 1: Add heartbeatMdPath and resolveHeartbeatPrompt

- [x] Add `heartbeatMdPath(home: string): string` to `src/pi-host.ts`, returning `join(home, "workspace", "HEARTBEAT.md")`.
- [x] Add `resolveHeartbeatPrompt(home: string): string` to `src/scheduler/loop.ts` that reads `heartbeatMdPath(home)`; on success (file present and non-empty after `trim()`) returns `[heartbeat] ${content.trimEnd()}`, on ENOENT or empty/whitespace-only returns `HEARTBEAT_PROMPT`, on non-ENOENT errors propagates.
- [x] Verify `SchedulerLoop` has access to `home`; if not, add it to the constructor params.
- [x] In `processOne()`, replace `isHeartbeat ? HEARTBEAT_PROMPT : schedule.prompt` with `isHeartbeat ? resolveHeartbeatPrompt(this.home) : schedule.prompt`.
- [x] Add path helper test for `heartbeatMdPath`.
- [x] Add `resolveHeartbeatPrompt` tests: file present (content used with prefix), file absent (constant fallback with exactly one `[heartbeat]` marker), file empty/whitespace-only (falls back to constant), non-ENOENT read error propagates.
- [x] Run `bun test src/scheduler/loop.test.ts`.

## Phase 2: Integration tests and verify

- [x] Add heartbeat dispatch integration test: HEARTBEAT.md exists, heartbeat is due, dispatched prompt contains file content with `[heartbeat]` prefix.
- [x] Add heartbeat dispatch integration test: HEARTBEAT.md absent, heartbeat is due, dispatched prompt is the constant.
- [x] Add test: edit HEARTBEAT.md between ticks, verify next heartbeat uses updated content.
- [x] Update `AGENTS.md` (repo root): document the workspace prompt file read exception per decision `workspace-prompt-file-reads` (0009) — read-only access to `workspace/` prompt files via path helpers is permitted alongside the existing `config.ts` exception (0007).
- [x] Run `bun test` full suite.
