# ACP External Agents — Tasks

Each phase is one commit boundary. The codebase must typecheck and pass the complete Bun test suite at the end of every phase. Do not use `npx`/`bunx` to run ACP bridges; they are exact application dependencies.

## Phase 1: Add the configured ACP server catalog

- [ ] Add failing schema/config tests for the exact custom command/args/profile-mode/string-select/resume-epoch limits, NUL and unknown-field rejection, id collisions, no environment field, and deep freezing from `external agent configuration is explicit and bounded`.
- [ ] Add exact dependencies `@agentclientprotocol/claude-agent-acp@0.59.0`, `@agentclientprotocol/codex-acp@1.1.2`, and `@lydell/node-pty@1.2.0-beta.12` with Bun; inspect `bun.lock` and package lifecycle scripts before accepting the lockfile change.
- [ ] Extend `src/schema.ts` and `src/config.ts` with the bounded custom server map while temporarily retaining `ptyFallback` until the runtime cutover in phase 4.
- [ ] Add failing `src/external-agents/servers.test.ts` coverage for built-in command resolution, custom definitions, enabled-id union, deterministic sorted fingerprints, and collision rejection.
- [ ] Implement `src/external-agents/servers.ts` with code-owned built-in profile mappings, trusted custom mappings, exact local package-bin resolution, and canonical SHA-256 fingerprints including built-in package versions or custom `resumeEpoch`; accept no environment overrides.
- [ ] Add fake-stdio preflight tests for valid initialize, malformed/oversized frames, incompatible protocol, timeout, missing command, Claude/Codex missing required support, diagnostic Devin/custom support with eligibility still false, no session creation, and disabled omission.
- [ ] Refactor `src/external-agents/preflight.ts` to probe every enabled built-in/custom definition with bounded ACP `initialize`, terminate the process, and emit only non-sensitive resume-capability diagnostics; retain the old native/`agent-pty` probes only until phase 4 switches execution.
- [ ] Inspect exact Claude/Codex bridge package metadata/source, require `sessionCapabilities.resume`, and pin versions in tests. Do not require or call `loadSession`.
- [ ] Run `bun run typecheck`, focused config/server/preflight tests, and full `bun test`; inspect the diff for runtime downloads, lifecycle scripts, unbounded config strings, or secret-bearing environment paths.
- [ ] Commit with message `phase 1: add configured ACP server catalog`.

## Phase 2: Build the generic ACP connection

- [ ] Extend the fake ACP fixture to script initialize, session creation/resume, client requests, updates, prompt stop reasons, malformed frames, and connection loss without provider credentials.
- [ ] Add failing `src/external-agents/acp.test.ts` coverage for initialize-before-session, 2 MiB frame and 64 KiB stderr limits, rooted `session/new`, checkpoint callback before first prompt, checkpoint rejection before task delivery, every real ACP stop reason, prompt cancellation, and bounded diagnostics; prove no `input_required` stop is assumed.
- [ ] Add failing permission tests for offered reject, verified-profile `allow_once`, no persistent grants, and no-safe-option ACP cancellation that fails the run with `permission_policy_incompatible`; never test cancelled as continuation.
- [ ] Add failing filesystem tests for one-based safe `line`/`limit`, 10,000-line and 1 MiB UTF-8 byte limits, over-limit rejection, existing symlinks, missing-file verified-parent creation, atomic writes, and read-only denial.
- [ ] Add failing policy tests proving ordinary options apply before security mode, resulting state is verified after new/resume, mode/config drift cancels with `profile_drift`, and permission grants require currently verified state.
- [ ] Implement `src/external-agents/acp.ts` with typed routing and lifecycle primitives, a 32-request no-queue concurrency cap, permission-policy failure semantics, bounded ACP filesystem behavior, and profile postcondition monitoring.
- [ ] Add the ACP connection/server seams to `src/external-agents/types.ts` without changing production runner selection yet; keep every existing adapter test passing.
- [ ] Run pinned Claude/Codex initialize and authenticated create/terminate/fresh-process-resume smoke tests; failure SHALL block cutover. Assert `resumeEligible: true` only for those exact definitions and false for Devin/custom regardless of advertised support.
- [ ] Run focused ACP tests, `bun run typecheck`, and full `bun test`; inspect for raw-frame logging, task/session-id leakage, unsafe casts, unbounded pending requests, and accidental Telegram approval paths.
- [ ] Commit with message `phase 2: add generic ACP connection`.

## Phase 3: Host bounded ACP virtual terminals

- [ ] Add failing `src/external-agents/acp-terminal.test.ts` tests for workspace-write create, real PTY semantics through an injected PTY factory, immediate opaque id return, bounded UTF-8 tail output, truncation at character boundaries, exit status, wait cancellation, kill, release, and dispose-all.
- [ ] Add failing security tests for read-only denial, cwd/realpath escape, cross-session ids, env/NULs, command/argument limits, 128-argument and eight-unreleased-entry caps (including exited/killed entries), non-safe output limits, clamping, and no shell interpolation.
- [ ] Implement `src/external-agents/acp-terminal.ts` with a fakeable `@lydell/node-pty` seam, one terminal registry per run, a maximum 2 MiB UTF-8 tail buffer, and exactly-once process exit/cleanup settlement.
- [ ] Register `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, and `terminal/release` in `src/external-agents/acp.ts`; advertise terminal capability only after every method is wired.
- [ ] Keep ACP transport on stdio pipes and give PTYs only to requested terminal commands; add a regression test proving terminal control bytes cannot enter ACP JSON parsing.
- [ ] Wire terminal cleanup through normal completion, failure, active-prompt cancellation, timeout, connection loss, detach, and adapter startup failure.
- [ ] Re-run environment tests proving terminal children receive only `prepareEnv()` and no request-provided environment values, Goblin secrets, `GOBLIN_HOME`, provider keys, or `SSH_AUTH_SOCK`.
- [ ] Run focused ACP terminal/connection tests, `bun run typecheck`, and full `bun test`; inspect for unbounded buffers, split UTF-8, leaked PTY children, cross-run ids, and blocking cleanup.
- [ ] Commit with message `phase 3: host bounded ACP virtual terminals`.

## Phase 4: Cut external-agent execution over to ACP

- [ ] Add failing type/store tests for configured ids, `adapterKind: "acp"`, advertised support versus `acpResumeEligible`, exact bounds, readiness/lineage/boot fields, `stopping`, and pending status; preserve terminal legacy records and reject partial checkpoints.
- [ ] Add failing runner tests proving slot/initial metadata/boot-id/deadline ordering and checkpoint-before-task. After-spawn failure SHALL enter `stopping` and release only after confirmed exit; failed cleanup SHALL retain the slot and block starts.
- [ ] Extend `src/external-agents/types.ts` and `src/external-agents/store.ts` for ACP records and configured ids while retaining `native`/`pty` only as legacy input formats.
- [ ] Refactor `src/external-agents/runner.ts` to resolve server definitions, create/prompt ACP sessions, checkpoint before task delivery, map all real stop reasons directly to runner states, and remove native-to-PTY fallback while preserving timeout, concurrency, ordering, and terminal guards.
- [ ] Implement immutable `message` chaining: require owned `end_turn` lineage head plus support/eligibility, atomically reject any existing child (terminal or not) or non-terminal session user, create a child with new deadline/link, resume fresh, and never reopen the source. Test A→B then reject message(A) and allow message(B).
- [ ] Update `src/external-agents/tool.ts`, `src/agent/mod.ts`, and tests to advertise the built-in/custom id union while keeping command, args, cwd, environment, permission, session, mode/config, and terminal details outside model input.
- [ ] Remove `ptyFallback` from the strict config schema and remove the temporary native/PTY preflight branches; add final rejection and ACP-only preflight tests.
- [ ] Move only bounded exact-owner `kill-owner` RPC into `src/external-agents/legacy-pty.ts`; test timeout/failure propagation and prove it exposes no spawn, attach, output, or input operation.
- [ ] Change startup legacy reconciliation so terminal native/PTY records remain unchanged, non-terminal native records become `interrupted`, and non-terminal PTY records become `interrupted` only after exact-owner cleanup; cleanup failure SHALL abort initialization before polling/new starts and leave the record non-terminal.
- [ ] Delete provider-specific `codex.ts`, `claude.ts`, `devin.ts`, `agent-pty.ts`, and superseded adapter tests only after all production imports use `acp.ts`; preserve equivalent behavior in generic ACP, terminal, runner, and legacy-cleanup tests.
- [ ] Update `src/external-agents/mod.ts` exports and hand-built fixtures for dynamic agent ids and ACP adapter kinds.
- [ ] Run focused config/ACP/terminal/runner/store/tool/preflight/legacy-cleanup tests, `bun run typecheck`, and full `bun test`.
- [ ] Inspect the cutover diff for task/session-id logging, model-controlled process configuration, provider-native fallback remnants, unsafe legacy PTY operations, shell interpolation, and runtime package downloads.
- [ ] Commit with message `phase 4: run external agents through ACP`.

## Phase 5: Resume ACP sessions across Goblin restart

- [ ] Add failing recovery tests for clean-detach proof, same-boot crash block, changed-boot atomic interruption, marker clearing, exact fingerprint resume, policy reapplication, no task/`session.load` replay, non-resume servers, drift, expired deadlines, and failures.
- [ ] Add failing concurrency tests proving restored/stopping runs occupy slots, release only after confirmed exit, and may exceed a lowered maximum while blocking acquisition.
- [ ] Restore concurrency and arm `deadlineAt` before spawn; bound task operations by remaining time, then use a separate fixed 10-second cleanup grace with no task work. Cover deadline during initialize/resume and cleanup-grace expiry leaving `stopping`.
- [ ] Extend the concurrency limiter with explicit active/max accounting or a tested `restore(count)` operation.
- [ ] Add failing adapter/runner tests for child-exit-before-marker, same/changed boot behavior, `stopping` persistence, cleanup timeout, detach/cancel/completion races, pending-outcome immutability, and exactly-once cleanup/release.
- [ ] Add `detach()` and `shutdown()`; write readiness only after confirmed exit. Cancel/timeout/disposal/completion claim pending outcomes and become terminal only after cleanup; successful completion preserves the provider session without reopening the run.
- [ ] Update `src/index.ts` to await detach-aware external shutdown after scheduler stop while preserving independent guarded cleanup for subagents, main runners, and Telegram.
- [ ] Verify `src/orchestration/dispatcher.ts` keeps `/cancel`, `/new`, `/resume`, `/archive`, and `/project` on destructive `cancelBySession`; extend dispatcher tests.
- [ ] Add an end-to-end fake server for clean teardown/fresh-process resume and no task replay; add SIGKILL-style fixtures proving same-boot block and changed-boot interruption without resume.
- [ ] Exercise shutdown with a non-resumable custom server and a resumable fake: the former becomes `interrupted`; the latter remains non-terminal until startup continuation finishes.
- [ ] Run focused ACP/store/runner/orchestration tests, `bun run typecheck`, full `bun test`, and `litespec validate acp-external-agents`.
- [ ] Inspect the complete diff for secret/content logging, accidental `session/load`, fresh timeout grants, process-survival or exactly-once claims, non-destructive session disposal, orphan PTYs, unbounded waits, and runtime downloads.
- [ ] Update decision 0030 and the glossary if implementation discoveries changed terminology; ensure decision 0019 remains abandoned and `durable-external-agent-runs` remains marked superseded.
- [ ] Commit with message `phase 5: resume ACP sessions after restart`.
