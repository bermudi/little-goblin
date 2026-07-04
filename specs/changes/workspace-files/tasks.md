# workspace-files — Tasks

## Phase 1: Add heartbeatMdPath and resolveHeartbeatPrompt

- [ ] Add `heartbeatMdPath(home: string): string` to `src/pi-host.ts`, returning `join(home, "workspace", "HEARTBEAT.md")`.
- [ ] Add `resolveHeartbeatPrompt(home: string): string` to `src/scheduler/loop.ts` that reads `heartbeatMdPath(home)`; on success (file present and non-empty after `trim()`) returns `[heartbeat] ${content.trimEnd()}`, on ENOENT or empty/whitespace-only returns `HEARTBEAT_PROMPT`, on non-ENOENT errors propagates.
- [ ] Verify `SchedulerLoop` has access to `home`; if not, add it to the constructor params.
- [ ] In `processOne()`, replace `isHeartbeat ? HEARTBEAT_PROMPT : schedule.prompt` with `isHeartbeat ? resolveHeartbeatPrompt(this.home) : schedule.prompt`.
- [ ] Add path helper test for `heartbeatMdPath`.
- [ ] Add `resolveHeartbeatPrompt` tests: file present (content used with prefix), file absent (constant fallback with exactly one `[heartbeat]` marker), file empty/whitespace-only (falls back to constant), non-ENOENT read error propagates.
- [ ] Run `bun test src/scheduler/loop.test.ts`.

## Phase 2: Integration tests and verify

- [ ] Add heartbeat dispatch integration test: HEARTBEAT.md exists, heartbeat is due, dispatched prompt contains file content with `[heartbeat]` prefix.
- [ ] Add heartbeat dispatch integration test: HEARTBEAT.md absent, heartbeat is due, dispatched prompt is the constant.
- [ ] Add test: edit HEARTBEAT.md between ticks, verify next heartbeat uses updated content.
- [ ] Run `bun test` full suite.
