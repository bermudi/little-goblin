# Durable External-Agent Runs — Tasks

This change spans `~/build/agent-pty` and `little-goblin`. Each phase is a commit boundary in the named repository. The agent-pty protocol phase must land and be installed before Little Goblin phases that require protocol version 2 can run outside fakes.

## Phase 1: Add reconnectable output to agent-pty

- [ ] In `~/build/agent-pty`, add protocol unit tests for `capabilities`, `read-output`, command bounds, response validation, richer session lifecycle entries, and backward-compatible existing commands from `agent-pty replays bounded output by cursor`.
- [ ] Add session/integration tests for monotonic chunk cursors, ordered pagination, UTF-8-safe chunk boundaries, the 64 KiB response clamp, the 2 MiB ring cap, stale-cursor truncation, output retained after client disconnect, and output retained after child exit.
- [ ] Add lifecycle tests proving exited sessions expose `exitedAt` plus exit code/signal until explicit remove, while daemon shutdown still kills children and loses in-memory replay.
- [ ] Implement the bounded `OutputRing` in `packages/core/src/session.ts`; feed it from the existing PTY `onData` callback without changing terminal rendering.
- [ ] Extend `Session` exit bookkeeping and daemon `list-sessions` responses with running/exited state, exit time/status, and latest cursor.
- [ ] Extend `packages/core/src/protocol.ts`, response validation, exports, daemon dispatch, and CLI/rpc handling with side-effect-free protocol version 2 `capabilities` and bounded `read-output`.
- [ ] Update agent-pty README/manual documentation with cursor semantics, limits, exited retention, compatibility, and the daemon/host durability boundary.
- [ ] Run `bun run build` and `bun test` in `~/build/agent-pty`; inspect the diff for unbounded buffers/responses, split UTF-8, leaked environment/output in capabilities, broken owner filtering, and changed shutdown semantics.
- [ ] Commit the agent-pty repository with message `phase 1: add reconnectable PTY output`.

## Phase 2: Persist PTY deadlines and output checkpoints

- [ ] In Little Goblin, add failing store/type tests for optional migration-safe `deadlineAt`, `ptySessionName`, and `ptyOutputCursor`, malformed field rejection, legacy terminal-record readability, and newest retained event `sourceCursor` recovery from `external run records are bounded and persisted`.
- [ ] Add failing adapter/preflight tests for protocol version 2 capabilities, paginated `read-output`, cursor truncation, rendered snapshot/scrollback output, cursor-bearing normalized events, and clear rejection of old or malformed daemons.
- [ ] Extend external-agent record/event/handle types and store validation with the new internal fields without exposing cursors in tool status/list output.
- [ ] Set one absolute deadline when runner execution first begins; persist it before PTY fallback and schedule timers from remaining duration without changing existing native/PTY timeout outcomes.
- [ ] Persist the derived PTY session name and initial cursor before spawn; refactor live `AgentPtyHandle.inspect()` to drain cursor pages and use bounded terminal rendering for model-visible output.
- [ ] Append cursor-bearing output events before advancing and atomically saving `meta.ptyOutputCursor`; derive the effective cursor from metadata plus the newest retained event after load.
- [ ] Emit existing truncation metadata/events when agent-pty reports a stale replay cursor, preserving all current event/result/tool bounds.
- [ ] Change external-agent preflight to require protocol version 2 `cursor-output` and `lifecycle-inventory` capabilities when `ptyFallback` is enabled.
- [ ] Run focused external-agent store, adapter, runner, tool, and preflight tests; run `bun run typecheck` and then `bun test` in Little Goblin.
- [ ] Commit Little Goblin with message `phase 2: checkpoint PTY run progress`.

## Phase 3: Adopt validated PTY runs at startup

- [ ] Add failing runner tests for exact live adoption, attach without spawn/type/task replay, missing sessions, name/owner/executable/canonical-cwd mismatch, legacy non-terminal PTY records, native interruption, and isolated orphan cleanup from `PTY-backed runs are adoptable across Goblin restarts`.
- [ ] Add failing recovery tests for output produced while Goblin was offline, exited-zero completion, exited-nonzero failure, exit-before-deadline ordering, exit-after-deadline timeout, live expired timeout, and remove only after terminal persistence.
- [ ] Add failing concurrency tests proving adopted runs reserve slots before starts, every adopted observer releases exactly once, and valid runs continue when restored active count exceeds a lowered `maxConcurrent`.
- [ ] Add a trusted `AgentPtyAdapter.attach()` path that reconstructs a handle from validated inventory without spawning, typing, or accepting model-controlled identity.
- [ ] Replace blanket PTY owner cleanup in `ExternalAgentRunner.init()` with one-inventory reconciliation: interrupt native/legacy/missing/mismatched records, adopt exact live matches, reconcile exact exited matches, expire overdue matches, and remove only reserved-namespace orphans.
- [ ] Restore timeout timers and background observer promises for adopted live runs before accepting new starts; extend the concurrency limiter to account for restored work above its configured maximum.
- [ ] Log one reconciliation summary containing only adopted/completed/failed/expired/interrupted/orphan counts; verify task text, output, cwd, owner, and credentials are absent.
- [ ] Run focused external-agent runner/adapter/store tests, `bun run typecheck`, and full `bun test` in Little Goblin.
- [ ] Commit Little Goblin with message `phase 3: adopt surviving PTY runs`.

## Phase 4: Detach PTY runs during Goblin shutdown

- [ ] Add failing adapter tests proving `detach()` aborts local waits without issuing `kill`/`remove`, while `cancel()` and timeout remain destructive.
- [ ] Add failing runner tests for mixed native/PTY process shutdown, adopted-run detach, explicit session cancellation after adoption, detach racing terminal exit, and PTY startup immediately before shutdown.
- [ ] Separate `AgentPtyHandle` observation cancellation from remote process cancellation and surface local detach through a typed internal signal that cannot mark a run failed.
- [ ] Add `ExternalAgentRunner.shutdown()` to reject new starts, cancel native runs, detach validated PTY runs, and resolve the bounded startup race without leaving ambiguous tracked work.
- [ ] Remove unconditional PTY cancellation from the runner execution `finally` path only for a proven detach; preserve terminal cleanup and exactly-once slot release for every other path.
- [ ] Update `src/index.ts` to await detach-aware external shutdown while preserving scheduler-first order and independent cleanup/logging for subagents, main runners, and Telegram.
- [ ] Verify `TurnDispatcher.disposeRunner`, cascade `/cancel`, `/new`, `/resume`, `/archive`, and `/project` still call destructive `cancelBySession` regardless of adapter kind.
- [ ] Run focused adapter/runner/orchestration/cancel tests, `bun run typecheck`, and full `bun test` in Little Goblin.
- [ ] Commit Little Goblin with message `phase 4: preserve PTY work across shutdown`.

## Phase 5: Supervise agent-pty independently in production

- [ ] Add failing tests for a non-secret `validate-config --deployment-json` result that reveals only whether PTY fallback is enabled.
- [ ] Add `scripts/agent-pty.service` with the Goblin user/home, foreground daemon command, journald output, and `Restart=on-failure`; do not add `PartOf`, `BindsTo`, or a reverse dependency on `goblin.service`.
- [ ] Extend `install-service.sh` to query validated production config, require `/usr/local/bin/agent-pty` only when enabled, install/enable the companion service, and maintain a feature-owned Goblin `Wants`/`After` drop-in without stopping the daemon on disabled reinstallation.
- [ ] Extend install/update script tests or command-fixture coverage for enabled installation, disabled installation without the executable, stale drop-in removal, idempotence, and a Goblin-only restart that never invokes `systemctl restart/stop agent-pty`.
- [ ] Keep `scripts/goblin.service` free of an unconditional agent-pty dependency; update `install.sh` to pass `/var/lib/goblin` config context and `update.sh` to preflight before restarting only Goblin.
- [ ] Add operator documentation for installing the compatible agent-pty executable, inspecting `journalctl -u agent-pty`, the first-install ordering, and the fact that daemon upgrades/restarts interrupt live PTYs.
- [ ] Add the alphabetized glossary entry `adopted external-agent run`; verify decision 0019 and the external-agent-runner decisions describe the PTY-only exception consistently.
- [ ] Run shell syntax checks on touched scripts, focused deployment/config tests, `bun run typecheck`, and full `bun test`; inspect generated unit/drop-in semantics with `systemd-analyze verify` when available.
- [ ] Re-run `bun run build` and `bun test` in `~/build/agent-pty` against the protocol version Little Goblin now requires.
- [ ] Commit Little Goblin with message `phase 5: supervise agent-pty independently`.

## Phase 6: Verify restart durability end to end

- [ ] Install/build the compatible agent-pty binary in a disposable service test environment and start `agent-pty.service` separately from `goblin.service`.
- [ ] Exercise a PTY-backed fake backend through start, output, Goblin SIGTERM/restart, startup adoption, additional output, and successful exit; verify one run id/deadline, no task replay, bounded recovered output, terminal persistence, and PTY removal.
- [ ] Exercise daemon loss during a PTY run; verify systemd restarts the daemon, Goblin reports the run `interrupted`, and no task is automatically re-executed.
- [ ] Exercise `/cancel` and session disposal after adoption; verify both remain destructive and another session's PTY remains untouched.
- [ ] Run `litespec validate durable-external-agent-runs`, both repositories' complete test/build commands, and inspect both diffs for secrets, task/output logging, arbitrary identity adoption, unbounded memory/output, unsafe shell interpolation, and accidental agent-pty restart coupling.
- [ ] Commit any verification fixtures or fixes in their owning phase/repository; do not create a verification-only production commit if no tracked changes remain.
