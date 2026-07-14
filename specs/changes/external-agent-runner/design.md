# External Agent Runner — Design

## Architecture

### Module placement

External coding-agent orchestration is a new agent-layer module at `src/external-agents/`. It is a sibling of `src/subagents/`, not a generalized replacement for it:

- `SubagentRunner` owns pi `AgentSession` construction, named-agent definitions, memory scope, recursive spawning, and pi persistence.
- `ExternalAgentRunner` owns OS processes, external CLI protocols, normalized run records, resource limits, and external-process cancellation.

Both modules are process-wide and session-aware, but their interfaces and implementations remain independent. This preserves locality: backend CLI behavior stays in `external-agents`, while pi behavior stays in `subagents`.

```text
Telegram turn / scheduled turn
          |
     AgentRunner
          |
  external_agent tool
          |
  ExternalAgentRunner
          |
  ExternalAgentAdapter seam
       /      |       |       \
   Codex   Claude   Devin   AgentPty
   JSON    JSONL     ACP     rpc/PTY
       \      |       |       /
       normalized ExternalAgentEvent
          |
  ExternalRunStore (scratch/external-agents)
```

### Public runner interface

The runner presents behavior rather than backend mechanics:

```ts
interface ExternalAgentRunner {
  init(): Promise<void>;
  start(input: StartExternalAgentInput): Promise<ExternalRunSummary>;
  status(runId: string, ownerSessionId: string): Promise<ExternalRunDetail>;
  message(runId: string, ownerSessionId: string, text: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  cancelOwned(runId: string, ownerSessionId: string): Promise<void>;
  list(ownerSessionId: string): Promise<ExternalRunSummary[]>;
  cancelBySession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}
```

`start` accepts backend, task, owner session id, and a project directory supplied by trusted wiring. The tool factory closes over owner and project directory; these values never appear in tool input. `cancelOwned`, `status`, and `message` perform indistinguishable not-found checks for cross-session access. `cancel` exists for orchestration code that already owns the runner and run id.

### Adapter seam

The internal seam hides command lines and protocol events:

```ts
interface ExternalAgentAdapter {
  readonly backend: ExternalAgentBackend;
  start(input: AdapterStartInput, emit: (event: ExternalAgentEvent) => void): Promise<ExternalAgentHandle>;
}

interface ExternalAgentHandle {
  send?(text: string): Promise<void>;
  inspect?(): Promise<void>;
  cancel(): Promise<void>;
}
```

`start` either returns a live handle or throws a typed startup error. `InteractiveRequiredError` includes `safeToRetry: boolean`; only `safeToRetry === true` is eligible for PTY fallback. Once returned, the handle emits exactly one normalized terminal event unless the runner has already won the terminal-state race through cancel or timeout.

Normalized events are deliberately small:

```ts
type ExternalAgentEvent =
  | { type: "status"; message: string; at: string }
  | { type: "output"; text: string; at: string }
  | { type: "input_required"; message: string; at: string }
  | { type: "completed"; result: string; at: string }
  | { type: "failed"; error: string; at: string };
```

Adapters validate provider events at their seam. The runner does not import provider event types or inspect provider JSON.

### Native adapters

All native adapters receive the same task, absolute project directory, permission profile, sanitized environment, and process host. Prompts are written through stdin or protocol messages rather than interpolated into a shell command. No adapter invokes a shell.

#### Codex

`CodexAdapter` starts `codex exec` in JSON mode with `-C <projectDir>`, `--color never`, `--ask-for-approval never`, and a code-owned sandbox mapping:

- `read-only` → `--sandbox read-only`
- `workspace-write` → `--sandbox workspace-write`

The task is sent on stdin. The adapter parses JSONL incrementally, extracts meaningful progress/output, and uses Codex's terminal event/final message as the result. Process exit without a terminal event is a failure. An early, recognized TTY-required response may raise `InteractiveRequiredError(safeToRetry: true)` only before an event indicates task execution began.

#### Claude Code

`ClaudeAdapter` starts `claude -p --input-format text --output-format stream-json` with a code-owned permission mapping:

- `read-only` → `--permission-mode plan`
- `workspace-write` → `--permission-mode acceptEdits`

The task is sent on stdin. The adapter validates stream-JSON events and accumulates assistant result text. Permission or trust prompts that cannot be represented in print mode become typed input-required startup errors only when reported before work begins; other errors fail the run. Native Claude runs do not expose `send` in this phase.

#### Devin

`DevinAdapter` uses the official `@agentclientprotocol/sdk` pinned to `1.1.0` (published more than seven days before this design) to act as an ACP client for `devin --permission-mode <mode> --sandbox acp`:

- `read-only` → Devin permission mode `auto`; ACP permission requests that would write are denied.
- `workspace-write` → Devin permission mode `accept-edits`; requests outside the project directory or outside that profile are denied.

The client initializes the connection, creates a session rooted at the absolute project directory, sends the task as a prompt, converts session updates to normalized events, and maps the prompt stop reason to completion or failure. It does not implement a general terminal or filesystem host for Devin; unsupported client requests are denied explicitly. Native Devin runs do not expose `send` in this phase.

### Process host and environment

`ProcessHost` is an internal seam used by native adapters and tested with deterministic fake processes. The production adapter uses argument-array process spawning with piped stdio, line iteration, exit observation, and signal delivery.

`buildExternalAgentEnv(process.env)` constructs a new object from an explicit allowlist: `HOME`, `PATH`, `USER`, `LOGNAME`, `LANG`, keys beginning with `LC_`, selected `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, `TMPDIR`, `TERM`, `COLORTERM`, and `SSH_AUTH_SOCK`. Undefined entries are omitted. `GOBLIN_HOME`, Telegram tokens, Goblin provider keys, and generic `*_API_KEY` variables are never copied.

Native adapters pass this exact map to their child. The PTY adapter includes the same map in `agent-pty`'s spawn protocol, preventing the daemon's broader environment from leaking into the PTY child.

### AgentPty adapter

Little Goblin does not add a local filesystem dependency on `../agent-pty`. `AgentPtyAdapter` invokes the installed `agent-pty rpc` executable and exchanges one validated request/response through stdin/stdout. This keeps production installation location-independent and keeps environment values out of argv.

The PTY session name is `goblin-<runId>` and owner is `goblin:<sessionId>`. Backend and permission profile select a code-owned interactive command/argument array; the task is supplied as the backend's initial prompt without shell interpolation. The spawn request includes the exact sanitized child environment.

PTY fallback is intentionally an escape hatch, not the normal completion detector:

1. A native adapter reports `InteractiveRequiredError({ safeToRetry: true })` before work begins.
2. The runner records a fallback status event and starts `AgentPtyAdapter` for the same run.
3. The run enters `input_required`; `status` calls `handle.inspect()`, which obtains bounded snapshot/scrollback text and emits normalized output.
4. `message` sends literal text followed by Enter only while the run is `input_required`, then returns it to `running` until inspection reports another prompt or the process exits.
5. Natural PTY exit produces completion/failure from exit status and bounded terminal output. Cancel calls `kill`, then `remove`; session-level orphan cleanup may also call `kill-owner`.

No screen coordinates, key names, snapshot ids, hashes, or PTY session names cross the agent-facing tool interface.

### Run state and persistence

`ExternalRunStore` owns all filesystem behavior. New path helpers in `src/external-agents/paths.ts` construct:

```text
$GOBLIN_HOME/scratch/external-agents/
  <runId>/
    meta.json
    events.jsonl
    result.txt       # completed runs only
```

`meta.json` contains identity, owner, backend, project directory, status, timestamps, optional terminal error/input detail, adapter kind (`native | pty`), and truncation flags. It does not persist the task. The task text is not written to `meta.json`, `events.jsonl`, or `result.txt`. The in-memory run keeps the task only while needed to start or safely retry. `meta.json` and `result.txt` use `atomicWrite`; JSONL writes use one serialized append per complete line.

Adapter callbacks for a single run are processed through a per-run ordered queue. The queue serializes event append, metadata update, and result write operations in the order the events are accepted. A terminal event is not exposed through `status` until the result is persisted and the queue has drained the preceding events. Before an event append would exceed 2 MiB, the store appends one final truncation event if it fits, sets `eventsTruncated` in metadata, and drops later output events while preserving terminal metadata/result. Individual output and final-result caps are applied before writes. Status reads only the bounded tail required for a 16,000-character response; list sorts metadata by creation time and returns at most 20 owned records.

`init()` creates no paths itself beyond using the directory created by `ensureGoblinHome()`. It loads valid metadata and marks every non-terminal persisted record `interrupted`, because no in-memory process handle can be proven owned after restart. Malformed metadata fails loud rather than silently deleting history.

### Start and completion data flow

```text
external_agent(start)
  -> reserve concurrency slot synchronously
  -> verify backend enabled + projectDir
  -> allocate UUID and persist starting meta
  -> schedule executeRun(run) without awaiting completion
  -> return run summary

executeRun
  -> adapter.start(...)
  -> save handle; transition running
  -> consume normalized callbacks through a per-run ordered queue
      -> append bounded event
      -> update status/meta
      -> write result on completed
      -> release slot on terminal
  -> on safe interactive startup error, switch to AgentPtyAdapter
  -> on other error, fail terminally
```

A concurrency slot is reserved synchronously before any `await` or filesystem write. If metadata creation fails, the slot is released immediately so a later start cannot observe a phantom reservation. The background promise always has an attached rejection handler. A run occupies a concurrency slot from accepted start through its first terminal transition. `starting` therefore counts toward the cap.

### Startup cancellation and handle resolution

A run can be cancelled, timed out, or disposed while `adapter.start()` is still pending. `transitionTerminal` synchronously claims the terminal state before any awaited cleanup. If the adapter later returns a live handle, the runner MUST cancel that handle exactly once and MUST NOT treat it as a successful start, emit a fallback event, or transition the run back to a non-terminal status. Any normalized events emitted by the late handle are discarded. `InteractiveRequiredError` is honored only if the startup error is reported before the terminal race is won; after that, the run is terminal and no PTY fallback is attempted.

### Cancellation and races

A single `transitionTerminal` helper owns terminal-state compare-and-set behavior. Cancel and timeout synchronously claim the terminal state before any await, clear the timeout, and atomically detach the handle reference. Only the winner invokes handle cancellation; late adapter events are retained only as debug logs and cannot change persisted status.

Native cancellation sends SIGTERM, waits up to two seconds, then sends SIGKILL to the owned child if needed. This forceful step is encapsulated by the adapter handle and is distinct from `interruptAndCascade`, which never sends OS signals itself. PTY cancellation issues `kill` and best-effort `remove` through `agent-pty rpc`.

`cancelBySession` snapshots matching non-terminal runs, claims each terminal state synchronously, then cleans all handles concurrently with per-run error isolation. `dispose()` uses the same path for every non-terminal run and sets a disposed guard that rejects new starts.

### Tool wiring

`createExternalAgentTool` follows existing TypeBox/`defineTool` patterns. One action schema uses optional fields with runtime action-specific validation:

- start requires `agent`, `task`;
- status/cancel require `id`;
- message requires `id`, `message`;
- list requires no additional field.

The factory closes over `ExternalAgentRunner`, `sessionId`, `projectDir`, enabled backends, and a callback getter. It emits only coarse status during the synchronous tool call. It never subscribes a Telegram callback to the background run.

`AgentRunnerOptions` gains an optional external runner. `buildCustomTools()` adds the tool only when the runner is present and enabled. No change is made to `SubagentRunner` tool construction, satisfying the main-only constraint.

### Orchestration and shutdown

`buildBot` constructs one `ExternalAgentRunner`, returns it with the existing shared modules, and passes it through intake into `TurnDispatcher`. `TurnDispatcher.createRunner` supplies it to main `AgentRunner`; `disposeRunner` awaits both session-scoped subagent and external-run cleanup while preserving the stale-runner behavior from `cascade-cancel`.

`interruptAndCascade` gains a minimal `InterruptableExternalAgentRunner` seam (`list(sessionId)` plus `cancel(id)`) and external counters in `CascadeResult`. It starts subagent and external cancellation after the main-agent abort attempt, bounds each call by the existing per-target timeout, and leaves other sessions untouched. Command reply formatting includes external timeout counts.

`index.ts` awaits `externalAgentRunner.init()` after home setup/build composition and before polling. Shutdown stops the scheduler first, then attempts external, subagent, main-runner, and bot cleanup in independent guarded steps so one failure does not skip the rest.

### Configuration and preflight

`ConfigFileSchema` gains the nested `externalAgents` object with schema defaults from the spec. A `superRefine` rejects duplicate backends. `loadConfig()` freezes both the root config and a copied external-agent object/array; callers do not receive mutable schema data.

`ensureGoblinHome()` adds `externalAgentsRoot(home)` from the new path-helper module, consistent with decision 0008. `runPreflight()` checks only enabled binaries with bounded version invocations. With PTY fallback enabled it invokes `agent-pty list-sessions`, which both verifies the executable and confirms the daemon protocol. The empty default allowlist keeps existing installations unchanged.

## Decisions

### D1: ExternalAgentRunner is separate from SubagentRunner

**Chosen:** A sibling module with its own run types, store, adapters, and cancellation.

**Why:** The two runners share only superficial lifecycle vocabulary. Generalizing them would expose pi-specific memory/session details to external processes or force the existing runner behind a wide lowest-common-denominator interface. Separate modules preserve depth and locality.

**Constraint:** Orchestration explicitly invokes both cancellation modules. This decision is recorded as `specs/decisions/0011-external-agent-runner-separation.md`.

### D2: One task-level tool, no PTY primitives

**Chosen:** One `external_agent` tool with five task/run actions.

**Why:** Goblin should understand task delegation and run ownership, not terminal emulation. Exposing `type`, `key`, and `snapshot` would move adapter complexity into prompts and every caller.

**Constraint:** Novel terminal interactions may report unsupported input rather than exposing a raw escape hatch.

### D3: Asynchronous run IDs instead of blocking tool calls

**Chosen:** `start` returns after process startup is scheduled; `status` retrieves progress/result.

**Why:** Coding tasks commonly outlive a model tool-call timeout. Returning an id also makes cancellation, concurrency, and Telegram turn lifetimes explicit.

**Constraint:** Goblin must poll status or schedule a later turn; this change does not push unsolicited completion messages to Telegram.

### D4: Native structured mode first, PTY only on safe startup retry

**Chosen:** Codex JSON, Claude stream JSON, and Devin ACP are primary. PTY fallback requires an explicit typed condition that guarantees work has not begun.

**Why:** Structured modes provide stable events and completion semantics. Blind fallback could execute the same editing task twice after a partial native run.

**Constraint:** Authentication and permission failures normally fail rather than opening an interactive terminal.

### D5: Devin uses the official ACP SDK pinned to 1.1.0

**Chosen:** `@agentclientprotocol/sdk@1.1.0` as an exact dependency.

**Why:** ACP is bidirectional JSON-RPC with permission and session callbacks; hand-rolling it would create a large shallow protocol implementation. Version 1.1.0 is established and compatible with the existing Zod 4 dependency, while newer 1.2.x releases are less than seven days old at planning time.

**Constraint:** The adapter implements a deliberately restrictive ACP client and denies unsupported requests.

### D6: agent-pty is consumed through a stdin/stdout RPC command

**Chosen:** Add `agent-pty rpc`; do not add `file:../agent-pty` or copy its package into Little Goblin.

**Why:** A sibling path dependency fails in `/opt/little-goblin` production deployments and couples two repositories' layouts. JSON over stdin carries exact environment data without argv leakage and preserves independent release/install paths.

**Constraint:** Operators enabling PTY fallback must install a compatible `agent-pty` executable on the Goblin service user's PATH. Preflight enforces this.

### D7: External child environments are allowlisted

**Chosen:** Build a new minimal environment and pass it to native and PTY children.

**Why:** Inheriting Goblin's environment would expose Telegram and model-provider credentials to a write-capable coding agent and every command it launches. CLI user-scoped auth avoids that leak.

**Constraint:** Operators must authenticate each CLI for the same OS user that runs Goblin. Environment-only API-key authentication is not supported; this is tracked in `specs/backlog.md`. This decision and the broader external-agent process security policy are recorded as `specs/decisions/0012-external-agent-process-security-policy.md`.

### D8: Runs require a project binding and cannot choose cwd

**Chosen:** The tool factory supplies the current session's `projectDir`; start fails without one.

**Why:** This turns cwd from model-controlled input into session-owned authority and aligns with project mode as a capability under decision 0004.

**Constraint:** External agents cannot operate in the generic Goblin scratch workdir.

### D9: Safe permission profiles are code-owned

**Chosen:** Only `read-only` and `workspace-write`, mapped separately per adapter; no bypass mode.

**Why:** A shared semantic profile is smaller and safer than exposing unstable provider flags. Adapter tests can pin the mapping as CLIs evolve.

**Constraint:** Some backend operations will fail when their CLI cannot satisfy the requested task without broader permission. That failure is returned honestly.

### D10: Scratch persistence is bounded and non-resumable

**Chosen:** Persist audit/status artifacts under scratch, mark non-terminal records interrupted at startup, and do not attempt process adoption.

**Why:** Native child identity and PTY ownership cannot prove that an old process is safe to control after a crash. Honest interruption is safer than PID-based adoption. Scratch also excludes potentially large outputs from backup by existing deployment policy.

**Constraint:** Results are not durable backup data; the repository changes made by an agent remain the durable outcome. This decision is recorded as `specs/decisions/0013-external-agent-scratch-lifecycle.md`.

### D11: Session cancellation uses the existing cascade seam

**Chosen:** Extend `interruptAndCascade`, `TurnDispatcher.disposeRunner`, and shutdown wiring rather than inventing a second cancellation route.

**Why:** Session ownership already determines when delegated work becomes orphaned. One lifecycle path avoids `/cancel`, `/new`, `/archive`, and `/project` drifting.

**Constraint:** The change depends on `cascade-cancel` and must be built after that change is complete.

### D12: agent-pty owner is isolation metadata, not authentication

**Chosen:** Exact owner strings support filtering and bulk cancellation; existing Unix-socket trust remains.

**Why:** The daemon is a same-user local tool. Adding authentication would be unrelated security-system scope, while owner metadata solves Goblin lifecycle isolation.

**Constraint:** Any process that can access the socket can still name another owner. Goblin does not treat owner as a security credential.

## File Changes

### agent-pty repository

- `packages/core/src/protocol.ts` — new discriminated command/response types and runtime validators for existing commands plus owner, exact env, and `kill-owner`.
- `packages/core/src/client.ts` — make `sendCommand` generic over protocol commands; add an options overload with timeout and `AbortSignal` while preserving numeric-timeout callers; validate responses and close the socket on abort.
- `packages/core/src/session.ts` — store optional owner and accept the exact child environment selected by daemon command handling.
- `packages/core/src/daemon.ts` — validate inbound commands, pass optional exact env, filter list by owner, include owner in entries, and implement isolated `kill-owner`.
- `packages/core/src/index.ts` — export protocol types/validators needed by CLI, MCP, Pi, and tests.
- `packages/cli/src/index.ts` — add `--owner` to spawn/list, add `kill-owner`, and add one-request stdin/stdout `rpc`; retain existing commands and output.
- `packages/core/test/integration/sessions.test.ts` — cover owner persistence/filtering, exact child environments, and ownerless compatibility.
- `packages/core/test/integration/lifecycle.test.ts` — cover `kill-owner` isolation and affected count.
- `packages/core/test/integration/cli.test.ts` — cover `rpc`, owner flags, and one-response stdout behavior.
- `packages/core/test/integration/wait.test.ts` — cover `AbortSignal`/socket-close disposal for long waits.
- `packages/core/test/helpers.ts` — add typed protocol helpers required by integration tests.
- `README.md` and `MANUAL.md` — document backward-compatible owner flags, `kill-owner`, `rpc`, exact-env protocol behavior, and that owner is not authentication.

### little-goblin repository

- `package.json` / `bun.lock` — add exact `@agentclientprotocol/sdk@1.1.0` for Devin ACP.
- `src/external-agents/types.ts` — run states, normalized events, summaries/details, limits, adapter/handle types, and typed startup errors.
- `src/external-agents/paths.ts` — all `$GOBLIN_HOME/scratch/external-agents` path construction per decision 0008.
- `src/external-agents/store.ts` — atomic metadata/result writes, bounded JSONL append/tail reads, owner-filtered list, and startup reconciliation.
- `src/external-agents/env.ts` — code-owned environment allowlist and secret exclusion.
- `src/external-agents/process.ts` — injectable structured-process host and graceful-then-forceful cancellation.
- `src/external-agents/codex.ts` — Codex command policy and JSON event parser.
- `src/external-agents/claude.ts` — Claude Code command policy and stream-JSON parser.
- `src/external-agents/devin.ts` — restrictive ACP client and Devin event normalization.
- `src/external-agents/agent-pty.ts` — `agent-pty rpc` transport, owner/session naming, bounded inspect, message, and cleanup.
- `src/external-agents/runner.ts` — lifecycle, concurrency, timeout, terminal-state arbitration, fallback, owner checks, session cancel, and disposal.
- `src/external-agents/tool.ts` — session-bound `external_agent` TypeBox tool and action validation.
- `src/external-agents/preflight.ts` — enabled-backend and optional PTY executable checks.
- `src/external-agents/mod.ts` — module barrel exposing only the runner, tool factory, preflight, and required types.
- `src/external-agents/*.test.ts` — colocated adapter fixture tests, store bound/reconciliation tests, environment tests, runner race/ownership tests, tool-schema tests, and preflight tests.
- `src/schema.ts` — nested `externalAgents` schema, defaults, ranges, enum, and duplicate rejection.
- `src/config.ts` — typed/frozen external-agent config and startup directory inclusion through the new path helper.
- `src/preflight.ts` — invoke external-agent preflight only for enabled configuration.
- `src/agent/mod.ts` — accept the optional shared runner and append the main-only external tool during lazy tool assembly.
- `src/agent/mod.test.ts` — verify enabled/disabled tool registration and session/project binding.
- `src/orchestration/dispatcher.ts` — carry the shared runner, inject it into main runners, and await session-scoped cleanup during disposal.
- `src/tg/intake.ts` and its tests — pass the shared runner into dispatcher composition without adding external-agent behavior to Telegram.
- `src/interrupt.ts` and `src/interrupt.test.ts` — add session-scoped external cancellation, timeout counters, isolation, and concurrent cancellation tests.
- `src/commands/registry.ts`, `src/commands/cancel.ts`, and their tests — carry the external runner through `DispatchDeps`, inject it into `/cancel`, report attempted/timed-out external runs, and preserve `Nothing to cancel` semantics.
- `src/bot.ts` and tests — construct/return one shared `ExternalAgentRunner` and wire it into intake/commands.
- `src/index.ts` — initialize reconciliation before polling and add guarded external-run shutdown.
- `specs/glossary.md` — add alphabetized `external agent`, `external-agent run`, and `native adapter` entries.
