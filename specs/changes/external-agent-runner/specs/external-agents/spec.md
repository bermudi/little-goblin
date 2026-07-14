# external-agents

## ADDED Requirements

### Requirement: ExternalAgentRunner owns external-agent run lifecycle

The system SHALL provide one process-wide `ExternalAgentRunner` that owns every external-agent run from creation through a terminal state. Each run SHALL have a UUID, backend (`codex`, `claude`, or `devin`), owning Goblin `sessionId`, bound project directory, created/updated timestamps, and one status from `starting`, `running`, `input_required`, `completed`, `failed`, `cancelled`, `timed_out`, or `interrupted`.

The terminal statuses SHALL be `completed`, `failed`, `cancelled`, `timed_out`, and `interrupted`. A terminal run MUST NOT transition back to a non-terminal status. Cancel, timeout, or disposal during `adapter.start()` SHALL synchronously claim the terminal state; any handle returned after that point SHALL be cancelled exactly once and MUST NOT trigger a fallback or non-terminal transition.

#### Scenario: Start creates an owned run

- **WHEN** `ExternalAgentRunner.start()` receives an allowed backend, task, Goblin session id, and bound project directory
- **THEN** it SHALL return a run handle containing a new UUID without waiting for the coding task to finish
- **AND** the run SHALL record the Goblin session id and project directory
- **AND** the run SHALL transition from `starting` to `running` when its adapter starts

#### Scenario: Adapter completes successfully

- **WHEN** a run's adapter emits a successful completion with final text
- **THEN** the runner SHALL set the run status to `completed`
- **AND** the final text SHALL be available through run status inspection

#### Scenario: Terminal state is immutable

- **WHEN** a run is already `cancelled`
- **AND** its adapter later emits completion or failure
- **THEN** the run SHALL remain `cancelled`

#### Scenario: Cancel during startup wins

- **WHEN** `cancel(runId)` is called while `adapter.start()` is still pending
- **THEN** the run SHALL synchronously become `cancelled`
- **AND** if the adapter later returns a live handle, the runner SHALL cancel that handle exactly once
- **AND** the run MUST NOT transition to `running`, `input_required`, or `completed`

#### Scenario: Timeout during startup wins

- **WHEN** a run's timeout fires while `adapter.start()` is still pending
- **THEN** the run SHALL synchronously become `timed_out`
- **AND** if the adapter later returns a live handle, the runner SHALL cancel that handle exactly once
- **AND** the run MUST NOT fall back to PTY

### Requirement: External agent adapters normalize native protocols

The runner SHALL depend on external coding agents through an `ExternalAgentAdapter` seam. The Codex adapter SHALL consume Codex's JSON event mode, the Claude adapter SHALL consume Claude Code's stream-JSON mode, and the Devin adapter SHALL consume Devin's ACP or structured non-interactive mode. Each adapter MUST validate untrusted process output and normalize it to common `status`, `output`, `input_required`, `completed`, and `failed` events before the runner consumes it.

Malformed lines SHALL produce a normalized failure or diagnostic event according to adapter policy and MUST NOT be cast blindly to an expected event type.

#### Scenario: Codex emits JSON events

- **WHEN** the Codex process emits valid JSON events describing progress and a final response
- **THEN** the Codex adapter SHALL convert them to normalized events
- **AND** `ExternalAgentRunner` SHALL NOT parse Codex-specific event shapes

#### Scenario: Malformed native output

- **WHEN** a native process emits an invalid structured event
- **THEN** its adapter SHALL reject or classify that event without throwing an unhandled parsing exception
- **AND** the run SHALL either continue with a diagnostic event or terminate as `failed`

#### Scenario: Adapter command construction

- **WHEN** a native adapter starts a run
- **THEN** it SHALL construct the executable and safe permission arguments from code-owned backend policy
- **AND** no executable name, arbitrary argument, or environment override from tool input SHALL be forwarded

#### Scenario: Claude emits stream-JSON events

- **WHEN** the Claude process emits a stream-JSON event with assistant content and a final completion marker
- **THEN** the Claude adapter SHALL convert them to normalized `output` and `completed` events
- **AND** `ExternalAgentRunner` SHALL NOT parse Claude-specific JSON shapes

#### Scenario: Devin ACP session is rooted and denies out-of-profile requests

- **WHEN** the Devin ACP client initializes a session rooted at `/srv/project`
- **THEN** it SHALL create the session with that absolute project directory
- **AND** a permission or filesystem request outside the configured profile or project root SHALL be denied
- **AND** the adapter SHALL emit a normalized `failed` event with a clear denial reason

### Requirement: external processes receive a sanitized environment

Every native and PTY external-agent process SHALL receive a new code-owned environment map rather than `process.env`. The map SHALL contain only the minimum execution variables required for local CLI operation (`HOME`, `PATH`, `USER`, `LOGNAME`, locale variables, selected `XDG_*` paths, `TMPDIR`, terminal variables, and `SSH_AUTH_SOCK` when present). It MUST exclude Goblin configuration values and secret-bearing variables including Telegram tokens, `GOBLIN_HOME`, and provider API-key variables. Authentication for external CLIs SHALL use their existing user-scoped credential stores; forwarding Goblin's provider keys is not part of this change.

#### Scenario: Bot token exists in parent environment

- **WHEN** Goblin starts an external agent while its parent environment contains `BOT_TOKEN` and provider API keys
- **THEN** none of those variables SHALL appear in the spawned process environment

#### Scenario: CLI discovery remains available

- **WHEN** Goblin starts an external agent
- **THEN** the sanitized environment SHALL preserve `PATH` and the configured user home variables needed to locate the executable and its user-scoped authentication

#### Scenario: PTY daemon has broader environment

- **WHEN** `AgentPtyAdapter` asks the daemon to spawn an interactive backend
- **THEN** it SHALL pass the exact sanitized environment in the spawn request
- **AND** the daemon SHALL use that map instead of its own `process.env`

### Requirement: agent-pty is an internal interactive fallback

When PTY fallback is enabled, the runner SHALL use an `AgentPtyAdapter` behind the same adapter seam only after a native adapter reports a typed interactive-required condition marked safe to retry before task execution. It MUST NOT fall back after repository work may have begun, or on arbitrary process failure, authentication failure, timeout, or malformed output. Raw PTY actions and terminal details MUST NOT appear in the agent-facing tool schema.

The fallback SHALL preserve the run id, owner session, backend, task, project directory, timeout deadline, and normalized event history while restarting the backend in its interactive mode. A fallback transition SHALL be recorded as a normalized status event.

#### Scenario: Native adapter requires terminal interaction

- **WHEN** an enabled native adapter reports its typed interactive-required condition
- **AND** PTY fallback is enabled
- **THEN** the runner SHALL continue the same run through `AgentPtyAdapter`
- **AND** status inspection SHALL report the fallback transition without exposing PTY command primitives

#### Scenario: Ordinary native failure does not fall back

- **WHEN** a native adapter exits with an authentication or malformed-output failure
- **THEN** the run SHALL become `failed`
- **AND** the runner MUST NOT start a PTY session automatically

#### Scenario: PTY fallback disabled

- **WHEN** a native adapter requires terminal interaction
- **AND** PTY fallback is disabled
- **THEN** the run SHALL enter `input_required` with an explanation that interactive fallback is unavailable

### Requirement: external_agent tool exposes task-level actions

The main Goblin agent SHALL receive one `external_agent` tool when at least one external backend is enabled. Its action SHALL be one of `start`, `status`, `message`, `cancel`, or `list`.

- `start` SHALL accept only `agent` and `task`, derive `sessionId` and `projectDir` from the calling runner, and return a run id immediately.
- `status` SHALL accept a run id owned by the calling session and return status, backend, timestamps, bounded recent output, input-required detail, and final result when present.
- `message` SHALL accept a run id and text and delegate only when the active adapter supports input in the run's current state.
- `cancel` SHALL accept a run id and cancel that owned run.
- `list` SHALL return bounded metadata for runs owned by the calling session.

The tool MUST NOT accept a cwd, executable, CLI arguments, environment, permission mode, owner session id, timeout, or PTY action.

#### Scenario: Start from project-bound session

- **WHEN** Goblin calls `external_agent({ action: "start", agent: "codex", task: "Fix the failing test" })`
- **AND** Codex is enabled
- **AND** the calling session is bound to `/srv/project`
- **THEN** the tool SHALL start a Codex run with cwd `/srv/project`
- **AND** it SHALL return the run id before the task completes

#### Scenario: Start without project binding

- **WHEN** `start` is called from a session with no configured project directory
- **THEN** the tool SHALL return a clear error requiring `/project`
- **AND** no external process SHALL start

#### Scenario: Cross-session access is rejected

- **WHEN** session B calls `status`, `message`, or `cancel` with a run id owned by session A
- **THEN** the tool SHALL return `External agent run not found`
- **AND** it MUST NOT disclose that the run exists

#### Scenario: Message unsupported in current state

- **WHEN** `message` targets a run whose active adapter cannot accept input in its current state
- **THEN** the tool SHALL return a clear unsupported-state error
- **AND** the run status SHALL remain unchanged

#### Scenario: Tool omitted when disabled

- **WHEN** the configured external backend allowlist is empty
- **THEN** `external_agent` SHALL NOT be registered on the main agent

### Requirement: external agent configuration is explicit and bounded

The JSON5 configuration SHALL accept an optional `externalAgents` object with:

- `backends`: an array containing unique values from `codex`, `claude`, and `devin`, defaulting to `[]`;
- `maxConcurrent`: an integer from 1 through 8, defaulting to `2`;
- `timeoutMs`: an integer from 60,000 through 7,200,000, defaulting to 1,800,000;
- `permissionProfile`: `read-only` or `workspace-write`, defaulting to `read-only`;
- `ptyFallback`: a boolean defaulting to `false`.

The parsed `Config` SHALL expose these values as a frozen typed object. Unknown backend names, duplicate backend names, out-of-range limits, and unknown permission profiles MUST fail startup validation.

#### Scenario: Configuration absent

- **WHEN** `externalAgents` is absent from `goblin.json5`
- **THEN** config loading SHALL produce an empty backend allowlist
- **AND** external-agent execution SHALL be disabled

#### Scenario: Explicit safe configuration

- **WHEN** configuration enables `codex` and `claude` with `permissionProfile: "workspace-write"`
- **THEN** only those two adapters SHALL be available to the tool
- **AND** each adapter SHALL map `workspace-write` to its code-owned non-bypass permission arguments

#### Scenario: Dangerous profile rejected

- **WHEN** configuration sets `permissionProfile` to `dangerous` or an approval-bypass value
- **THEN** startup validation SHALL fail

### Requirement: enabled external executables are preflighted

Startup preflight SHALL verify each enabled native backend executable by running its non-mutating version command with a bounded timeout. When `ptyFallback` is enabled, preflight SHALL also verify that the `agent-pty` executable is available and its daemon can answer `list-sessions`. A missing or unusable required executable MUST fail preflight with the backend name and attempted executable; disabled backends SHALL NOT be checked.

#### Scenario: Enabled backend missing

- **WHEN** `codex` is enabled but its executable cannot be started
- **THEN** startup preflight SHALL fail with an error naming Codex
- **AND** Telegram polling SHALL NOT start

#### Scenario: PTY fallback dependency missing

- **WHEN** `ptyFallback` is true but `agent-pty list-sessions` cannot complete
- **THEN** startup preflight SHALL fail with an error naming `agent-pty`

#### Scenario: Disabled backend is absent

- **WHEN** Claude is not in the backend allowlist and its executable is absent
- **THEN** external-agent preflight SHALL NOT fail because of Claude

### Requirement: concurrency and timeout limits are enforced centrally

`ExternalAgentRunner` SHALL enforce the configured process-wide concurrency limit before starting an adapter. Concurrency slots SHALL be reserved synchronously before any metadata persistence or filesystem write, and released if metadata creation fails. The runner SHALL enforce each run's wall-clock timeout independently of adapter output. A rejected start MUST NOT create run metadata or start a process. A timeout SHALL request adapter cancellation, set the run to `timed_out`, and persist the terminal state even when adapter cancellation fails.

#### Scenario: Concurrency cap reached

- **WHEN** the number of non-terminal runs equals `maxConcurrent`
- **AND** another `start` is requested
- **THEN** the request SHALL fail with a concurrency-limit error
- **AND** no run id or process SHALL be created

#### Scenario: Run exceeds timeout

- **WHEN** a run remains non-terminal past its configured timeout
- **THEN** the runner SHALL call the active adapter handle's cancel operation
- **AND** the run SHALL become `timed_out`
- **AND** a late adapter event MUST NOT overwrite that status

#### Scenario: Concurrent starts respect the process-wide cap

- **WHEN** `maxConcurrent` simultaneous `start` requests arrive at the same time
- **THEN** the runner SHALL reserve concurrency slots synchronously before persisting any metadata
- **AND** at most `maxConcurrent` of those requests SHALL create a run id
- **AND** the `maxConcurrent + 1` request SHALL fail with a concurrency-limit error

### Requirement: external run records are bounded and persisted

Each run SHALL persist under `$GOBLIN_HOME/scratch/external-agents/<runId>/` using path helpers. `meta.json` SHALL be written atomically, normalized events SHALL be appended as complete JSON lines to `events.jsonl`, and a completed final response SHALL be written atomically to `result.txt`. The task text SHALL NOT be persisted in any run artifact or returned by `status` or `list`.

The runner SHALL bound individual normalized output events to 32,000 characters, retained `events.jsonl` content to 2 MiB per run, final result text to 128,000 characters, `status` recent-output responses to 16,000 characters, and `list` responses to the 20 newest owned runs. Truncation SHALL be explicit in persisted metadata and tool results.

Events, metadata updates, and result writes for a single run SHALL be processed in the order they are accepted. A terminal state SHALL NOT be exposed through `status` until the result is persisted and the ordered queue has drained the preceding accepted events.

#### Scenario: Run starts

- **WHEN** an external run is accepted
- **THEN** its directory and atomic `meta.json` SHALL be created before adapter execution begins
- **AND** the metadata SHALL include id, owner session, backend, project directory, status, and timestamps

#### Scenario: Excessive output

- **WHEN** adapter output exceeds a configured fixed cap
- **THEN** persistence and tool responses SHALL remain within the specified bounds
- **AND** the run SHALL record that output was truncated

#### Scenario: Startup finds stale run

- **WHEN** startup loads persisted metadata whose status is non-terminal but no live handle is owned by this runner
- **THEN** it SHALL atomically mark the run `interrupted`
- **AND** status inspection SHALL explain that the prior process was not resumed

#### Scenario: Event and result ordering is preserved

- **WHEN** an adapter emits a burst of output events followed immediately by a completion event
- **THEN** the runner SHALL persist all accepted events in order
- **AND** `status` SHALL NOT expose the `completed` state until the result is persisted
- **AND** a late event arriving after completion is stored only for diagnostics, not as a state change

#### Scenario: Task text is not persisted

- **WHEN** a run completes with a final result
- **THEN** `meta.json`, `events.jsonl`, and `result.txt` SHALL NOT contain the original task text
- **AND** `status` and `list` responses SHALL NOT include the task text

### Requirement: cancellation is idempotent and owner-scoped

`ExternalAgentRunner.cancel(runId)` SHALL synchronously mark a non-terminal run `cancelled` before awaiting adapter cleanup, then request cancellation, persist the terminal state, and release the concurrency slot. Repeated cancellation of a terminal run SHALL be a no-op. `cancelBySession(sessionId)` SHALL cancel all non-terminal runs owned by that session concurrently and SHALL attempt every target even if one cleanup fails.

#### Scenario: Cancel running run

- **WHEN** `cancel(runId)` targets a running run
- **THEN** its status SHALL become `cancelled` before adapter cancellation is awaited
- **AND** the terminal status SHALL be persisted

#### Scenario: Cancel all for session

- **WHEN** `cancelBySession("session-a")` is called
- **AND** sessions A and B both own running external runs
- **THEN** every run owned by session A SHALL be cancelled
- **AND** session B's runs SHALL remain active

#### Scenario: Concurrent timeout and cancel

- **WHEN** timeout and explicit cancel race for the same run
- **THEN** exactly one terminal transition SHALL win
- **AND** adapter cancellation SHALL be requested at most once

### Requirement: agent-pty protocol supports owned abortable sessions

`agent-pty` SHALL extend its protocol and `@agent-pty/core` client with validated command/response unions, abortable requests, optional opaque owner metadata, and optional exact child environments. Existing callers that omit owner and environment SHALL retain their current behavior.

`spawn` SHALL accept an optional owner string and optional string-to-string environment map; when the map is present, the PTY child SHALL receive exactly that map instead of daemon `process.env`. `list-sessions` SHALL accept an optional owner filter and SHALL include owner when present. A `kill-owner` command SHALL terminate every running PTY session with the exact owner and return the affected count without touching other owners. Aborting a client request SHALL close that request's socket so daemon-side wait subscriptions and timers are released.

The CLI SHALL add an `rpc` command that reads one validated protocol request from stdin and writes one protocol response to stdout. This allows Little Goblin to transmit owner and sanitized environment data without placing secrets in command-line arguments or depending on the sibling package. Owner is a namespacing field, not authentication; the daemon SHALL continue to rely on local Unix-socket access control.

#### Scenario: Existing ownerless spawn

- **WHEN** an existing CLI, Pi extension, or MCP caller spawns a session without owner
- **THEN** the session SHALL start as before
- **AND** existing response fields SHALL remain compatible

#### Scenario: Exact child environment

- **WHEN** `spawn` receives `env: { PATH: "/usr/bin", HOME: "/home/goblin" }`
- **THEN** the PTY child SHALL receive those values
- **AND** it SHALL NOT inherit any other variable from daemon `process.env`

#### Scenario: RPC request over stdin

- **WHEN** `agent-pty rpc` receives one valid spawn request on stdin
- **THEN** it SHALL send that request through the core client
- **AND** stdout SHALL contain exactly one JSON response

#### Scenario: Owner-filtered list

- **WHEN** sessions owned by `goblin:session-a`, `goblin:session-b`, and no owner exist
- **AND** `list-sessions` filters for `goblin:session-a`
- **THEN** only the exact matching sessions SHALL be returned

#### Scenario: Kill owner is isolated

- **WHEN** `kill-owner` is called for `goblin:session-a`
- **THEN** every running PTY session with that owner SHALL be killed
- **AND** sessions with any other owner or no owner SHALL remain unchanged

#### Scenario: Abort wait request

- **WHEN** a client abort signal fires during `wait-for`, `await-change`, or `wait-for-exit`
- **THEN** the client SHALL reject with an abort error and close its socket
- **AND** the daemon SHALL dispose the associated event subscription and timeout
