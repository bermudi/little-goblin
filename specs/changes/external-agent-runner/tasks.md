# External Agent Runner — Tasks

This change spans two independent Git repositories. Phase 1 is committed in `~/build/agent-pty`; phases 2–8 are committed in `little-goblin`. Litespec checkbox updates remain in the Little Goblin change and are included in the next Little Goblin commit after an agent-pty-only phase rather than creating a documentation-only commit.

## Phase 1: Extend agent-pty ownership protocol

- [x] In `~/build/agent-pty`, add failing integration/unit tests for optional owner metadata, exact child environments, owner-filtered listing, isolated `kill-owner`, stdin/stdout `rpc`, abortable waits, and unchanged ownerless callers. Cover the spec requirement `agent-pty protocol supports owned abortable sessions` before implementation.
- [x] Add `packages/core/src/protocol.ts` with strict discriminated command/response types and runtime validation for all existing commands plus optional spawn `owner`/`env` and `kill-owner`. Reject malformed command fields at the daemon seam without `any` or unchecked casts.
- [x] Update `packages/core/src/session.ts` and `packages/core/src/daemon.ts` so sessions retain optional owner, spawn uses an exact provided environment instead of daemon `process.env`, list can filter/include owner, and `kill-owner` affects only exact owner matches while attempting every matching session.
- [x] Update `packages/core/src/client.ts` with generic typed responses and an options overload `{ timeout?, signal? }` while retaining the existing numeric timeout call form. On abort, reject with an abort error and close the socket so daemon wait handlers release subscriptions/timers.
- [x] Export protocol types/validators from `packages/core/src/index.ts`; migrate CLI, Pi extension, MCP, and test helpers off ad-hoc response casts where the new types apply without changing their existing public behavior.
- [x] Extend `packages/cli/src/index.ts` with backward-compatible `--owner` support for spawn/list, `kill-owner --owner <value>`, and `rpc`. `rpc` reads exactly one validated JSON request from stdin and writes exactly one JSON response to stdout; environment values never appear in argv.
- [x] Update existing agent-pty README/manual sections for owner flags, exact-env semantics, `kill-owner`, `rpc`, and the fact that owner is namespacing rather than authentication.
- [x] Run `bun run build` and `bun test` in `~/build/agent-pty`; fix all failures and confirm existing CLI, Pi extension, and MCP tests remain green.
- [x] Commit the agent-pty repository with message `phase 1: add owned agent-pty rpc sessions`.

## Phase 2: Add external run configuration and storage

- [x] Add failing config tests for absent defaults, enabled backend allowlists, duplicate/unknown backend rejection, numeric bounds, safe permission profiles, and frozen nested values from `external agent configuration is explicit and bounded`.
- [x] Add the nested `externalAgents` Zod schema in `src/schema.ts` and expose a deeply frozen typed value from `src/config.ts`, defaulting to no enabled backends.
- [x] Add `src/external-agents/paths.ts` for root/run/meta/events/result paths; update `ensureGoblinHome()` to create the root only through that helper, per decision 0008.
- [x] Add `src/external-agents/types.ts` with backend/status/event/record types, fixed output limits, terminal-state helpers, adapter/handle interfaces, and typed startup errors from `ExternalAgentRunner owns external-agent run lifecycle` and `External agent adapters normalize native protocols`.
- [x] Add failing `src/external-agents/store.test.ts` coverage for atomic metadata/result writes, complete JSONL events, all byte/character caps, explicit truncation, newest-20 owner-filtered list, malformed-record fail-loud behavior, stale non-terminal reconciliation, and the absence of the task text from `meta.json`, `events.jsonl`, and `result.txt`.
- [x] Implement `src/external-agents/store.ts` as the sole owner of run filesystem behavior; serialize concurrent appends per run and mark stale non-terminal records `interrupted` during initialization.
- [x] Add `src/external-agents/mod.ts` exports for the foundation types/store/path functions required by later phases.
- [x] Run targeted external-agent/config tests, `bun test`, and `bun run typecheck`.
- [x] Commit with message `phase 2: add external run configuration and storage`.

## Phase 3: Implement ExternalAgentRunner lifecycle

- [x] Add failing `src/external-agents/env.test.ts` proving the child environment preserves only the specified execution allowlist and excludes `GOBLIN_HOME`, Telegram credentials, provider keys, and generic `*_API_KEY` values from `external processes receive a sanitized environment`.
- [x] Implement `src/external-agents/env.ts` and use exact string values only; omit undefined values and do not mutate `process.env`.
- [x] Add `src/external-agents/process.ts` with an injectable argument-array `ProcessHost`, piped stdio/line iteration, exit observation, and owned-child cancellation that sends SIGTERM then SIGKILL after two seconds. Add deterministic tests with fake processes.
- [x] Add failing `src/external-agents/runner.test.ts` cases using at least two fake adapters: immediate run-id return, lifecycle transitions, normalized-event persistence, immutable terminal states, synchronous concurrency-slot reservation, concurrent-start boundary at `maxConcurrent + 1`, cancel/timeout/dispose during pending `adapter.start()`, late-handle cancellation without fallback or non-terminal transition, event ordering for burst-output-then-completion, timeout, late events, cancel/timeout races, owner-hiding lookups, message capability checks, session-scoped concurrent cancellation, startup reconciliation, and disposed-runner rejection.
- [x] Implement `src/external-agents/runner.ts` with injected adapter map/store/clock/process dependencies, synchronous concurrency-slot reservation with rollback on metadata failure, a per-run ordered event queue that sequences event append and terminal persistence, centralized terminal compare-and-set, bounded timer ownership, attached background rejection handling, `cancelOwned`, `cancelBySession`, and `dispose` from `ExternalAgentRunner owns external-agent run lifecycle`, `concurrency and timeout limits are enforced centrally`, and `cancellation is idempotent and owner-scoped`.
- [x] Keep PTY fallback disabled in this phase; typed `InteractiveRequiredError` SHALL produce `input_required` or failure according to configuration without starting an adapter that is not yet implemented.
- [x] Update `src/external-agents/mod.ts`; run targeted tests, `bun test`, and `bun run typecheck`.
- [x] Commit with message `phase 3: implement external agent run lifecycle`.

## Phase 4: Add Codex and Claude adapters

- [x] Record the installed Codex/Claude structured-mode contract used by the adapters in test fixtures or test builders without invoking a paid model. Add malformed-line, missing-terminal-event, nonzero-exit, safe-to-retry startup, and representative completion tests for both adapters.
- [x] Implement `src/external-agents/codex.ts` with `codex exec --json`, stdin task delivery, absolute `-C`, `--color never`, `--ask-for-approval never`, and exact read-only/workspace-write sandbox mappings. Validate every JSONL event before normalization.
- [x] Implement `src/external-agents/claude.ts` with print/stream-JSON mode, stdin task delivery, exact `plan`/`acceptEdits` permission mappings, validated event normalization, and no native `send` capability.
- [x] Ensure both adapters classify interactive startup only before any execution event and otherwise fail rather than retrying through PTY, satisfying `agent-pty is an internal interactive fallback`.
- [x] Add `src/external-agents/preflight.ts` with injectable process checks for enabled Codex/Claude version commands and bounded timeout/error messages from `enabled external executables are preflighted`; add tests proving disabled binaries are not checked.
- [x] Register Codex and Claude adapters through a code-owned adapter factory without exposing command arguments through runner/tool input.
- [x] Run targeted adapter/preflight tests, `bun test`, and `bun run typecheck`.
- [x] Commit with message `phase 4: add Codex and Claude native adapters`.

## Phase 5: Add Devin ACP adapter

- [x] Add exact dependency `@agentclientprotocol/sdk@1.1.0` with the package manager; do not use a floating range or a 1.2.x release published less than seven days before planning.
- [x] Add ACP client tests with in-memory/fake streams covering initialize, new session rooted at the absolute project directory, prompt/session updates, completion stop reasons, cancellation, denied unsupported requests, read-only write denial, workspace path confinement, malformed protocol failure, and process exit.
- [x] Implement `src/external-agents/devin.ts` using the official SDK against `devin --permission-mode <auto|accept-edits> --sandbox acp`; normalize agent message/status updates and deny unsupported terminal/filesystem/permission requests explicitly.
- [x] Extend external-agent preflight and adapter factory for enabled Devin; prove disabled Devin is not checked and missing enabled Devin fails clearly.
- [x] Run targeted Devin tests, `bun test`, and `bun run typecheck`.
- [x] Commit with message `phase 5: add Devin ACP adapter`.

## Phase 6: Add agent-pty fallback adapter

- [x] Add failing `src/external-agents/agent-pty.test.ts` coverage for one-request `agent-pty rpc` transport, owner/session naming, exact sanitized spawn env, bounded inspect output, input-required status, literal message plus Enter, natural exit, kill/remove cleanup, malformed RPC response, and cancellation.
- [x] Implement `src/external-agents/agent-pty.ts` without a sibling package dependency. Invoke `agent-pty rpc` with protocol JSON on stdin, validate the single stdout response, and never expose PTY identifiers/actions through public run details.
- [x] Add backend-specific interactive command policies that preserve the configured read-only/workspace-write meaning and pass the task without shell interpolation.
- [x] Extend `ExternalAgentRunner` so only `InteractiveRequiredError.safeToRetry === true` before work begins can switch the same run to PTY. Persist the fallback status, preserve the timeout deadline, and prevent arbitrary failure/auth/timeout fallback.
- [x] Implement PTY `inspect`/`message` state transitions and best-effort kill/remove cleanup; use exact owner `goblin:<sessionId>` and run-derived session names.
- [x] Extend preflight to require successful `agent-pty list-sessions` only when `ptyFallback` is true; add missing/disabled/success tests.
- [x] Run targeted runner/PTY/preflight tests, `bun test`, and `bun run typecheck`.
- [x] Commit with message `phase 6: add internal agent-pty fallback`.

## Phase 7: Add the session-bound external_agent tool

- [x] Add failing `src/external-agents/tool.test.ts` coverage for the exact five actions, immediate start result, required fields per action, no cwd/executable/args/env/permission/timeout/PTY fields, backend allowlist, project-required error, owner-scoped status/message/cancel/list, indistinguishable cross-session not-found, bounded results, and disabled omission.
- [x] Implement `src/external-agents/tool.ts` with one TypeBox/`defineTool` definition that closes over trusted runner/session/project/config values and performs action-specific narrowing without `any`.
- [x] Ensure the tool reports only coarse status through a callback getter during the current call and never retains a turn callback for background output, satisfying `external_agent tool exposes task-level actions` and the orchestration callback scenarios.
- [x] Extend `AgentRunnerOptions` and lazy `buildCustomTools()` in `src/agent/mod.ts` to accept an optional external runner and append the tool only for enabled main runners. Do not modify `SubagentRunner` tool construction.
- [x] Extend `src/agent/mod.test.ts` for enabled/disabled registration, trusted session/project binding, callback delegation, and unchanged pi-subagent tool sets.
- [x] Run targeted tool/agent tests, `bun test`, and `bun run typecheck`.
- [x] Commit with message `phase 7: add session-bound external agent tool`.

## Phase 8: Wire lifecycle orchestration and verify

- [x] Add composition tests proving `buildBot` creates exactly one shared `ExternalAgentRunner`, intake/dispatcher/main runners receive it, and pi subagents do not. Update `src/bot.ts`, `src/tg/intake.ts`, and `src/orchestration/dispatcher.ts` accordingly.
- [x] Add dispatcher tests proving `disposeRunner(sessionId)` awaits external `cancelBySession` even without a cached main runner, preserves other sessions, and still performs the `cascade-cancel` subagent cleanup. Implement the wiring without weakening stale-runner guards.
- [x] Extend `InterruptableExternalAgentRunner`, `CascadeResult`, and `interruptAndCascade` in `src/interrupt.ts`; add tests for session isolation, external-only cancel, concurrent delegated-work cancellation, per-target timeout, and late cleanup.
- [x] Extend `DispatchDeps`, `/cancel` invocation, and `src/commands/cancel.ts` formatting/tests so attempted/timed-out external counts produce honest `Cancelled` versus `Nothing to cancel` replies from the modified command requirements.
- [x] Initialize external-run reconciliation before Telegram polling; extend shutdown in `src/index.ts` so scheduler, external runner, subagent runner, main runners, and bot each receive cleanup even if an earlier cleanup throws.
- [x] Invoke enabled-backend preflight from `src/preflight.ts`; add integration tests covering missing enabled binaries and unchanged startup with the default empty allowlist.
- [x] Add alphabetized glossary entries for `external agent`, `external-agent run`, and `native adapter` to `specs/glossary.md`.
- [x] Add deferred backlog entries for native interactive external-agent messaging and environment-based external-agent authentication to `specs/backlog.md`.
- [x] Promote durable external-agent runner separation, process security policy, and scratch-lifecycle decisions to `specs/decisions/` and cross-reference them from `design.md`.
- [x] Run `bun test` and `bun run typecheck` in Little Goblin; run `bun run build` and `bun test` in agent-pty; inspect both diffs for secrets, arbitrary command/cwd/env exposure, `any`, `console.log` in Little Goblin, unbounded output, and `$GOBLIN_HOME` path construction outside the new helper/config startup exception.
- [x] Commit Little Goblin with message `phase 8: wire external agent lifecycle orchestration`.
