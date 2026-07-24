# external-agents

## ADDED Requirements

### Requirement: ACP servers host external-agent runs

Every newly started external-agent run SHALL communicate with its coding agent through ACP over newline-delimited JSON on child-process stdio. The runner SHALL start one configured ACP server process per run, initialize it with client identity `goblin`, advertise only implemented client capabilities, and create one ACP session rooted at the run's canonical project directory before sending the task with `session/prompt`. It SHALL reject an ACP frame larger than 2 MiB measured on UTF-8 bytes, retain at most 64 KiB of server stderr, and execute at most 32 concurrent agent-to-client requests per connection with deterministic overload errors beyond that cap and no unbounded queue.

The runner SHALL normalize validated ACP `session/update` notifications into bounded `status` and `output` events. A prompt response SHALL claim a pending runner outcome directly: `end_turn` claims `completed`; `max_tokens`, `max_turn_requests`, and `refusal` claim `failed` with a bounded reason; and `cancelled` claims `cancelled` unless an earlier pending outcome such as `timed_out` wins. It MUST NOT invent an `input_required` stop reason or parse provider-native Codex or Claude event formats. The ACP server process and logical ACP session SHALL have separate lifecycles: terminating the local server does not by itself make a cleanly detached resumable run terminal.

#### Scenario: Built-in agent starts through ACP

- **WHEN** Goblin starts an enabled built-in Codex, Claude, or Devin run
- **THEN** the runner SHALL start that agent's code-owned ACP server command
- **AND** initialize the ACP connection before creating and prompting the session
- **AND** the run SHALL NOT start a provider-native JSON adapter or PTY fallback

#### Scenario: Custom ACP server starts

- **WHEN** Goblin starts a configured custom ACP server id
- **THEN** the runner SHALL use the trusted command, arguments, profile-mode mapping, and select-option values from deployment configuration
- **AND** the model-facing tool SHALL NOT supply or override that material or the working directory
- **AND** the run SHALL fail before task delivery if the session does not advertise the configured mode and option values

#### Scenario: ACP output is malformed

- **WHEN** an ACP server writes malformed JSON or a response that violates the ACP schema
- **THEN** the adapter SHALL reject the invalid protocol message without casting it to an expected type
- **AND** the run SHALL fail with a bounded diagnostic that excludes task text and environment values

#### Scenario: ACP client-request concurrency is saturated

- **WHEN** an ACP server has 32 agent-to-client requests executing and sends another
- **THEN** Goblin SHALL return a deterministic bounded overload error
- **AND** MUST NOT enqueue unbounded work or start the rejected operation

#### Scenario: Server and session lifetimes are distinct

- **WHEN** a resumable run's ACP server process is terminated during Goblin shutdown
- **THEN** the persisted run and ACP session id SHALL remain non-terminal
- **AND** startup recovery MAY create a fresh server process and resume the logical session

### Requirement: Goblin autonomously operates ACP sessions

Goblin SHALL act as the autonomous ACP client for external-agent sessions. It SHALL send task and follow-up prompts, answer permission requests from code-owned policy, and serve bounded filesystem operations without requiring Telegram-user input. External agents MUST NOT receive direct Telegram access.

Before each prompt, Goblin SHALL apply configured ordinary select options first, then enforce the active security profile last and verify the resulting advertised state. Codex and Claude use code-owned session modes (`read-only`/`agent` and `plan`/`acceptEdits`); Devin uses code-owned `auto`/`accept-edits` command arguments. Built-in definitions MUST NOT select approval-bypass/full-access behavior. Custom servers use trusted operator-mapped mode ids whose semantics Goblin cannot independently prove. A missing/rejected mode or option SHALL fail before prompt delivery.

During a prompt, Goblin SHALL track `current_mode_update` and `config_option_update`. Any update that moves a built-in away from its expected profile, or changes a configured option away from its expected value, SHALL invalidate verified policy, cancel the prompt, and fail the run with bounded `profile_drift`. Permission handling SHALL grant nothing unless policy is currently verified. For custom servers, equality with the trusted configured mode id is the enforceable postcondition. These checks are defense in depth under decision 0012's same-user residual-risk boundary, not an ACP sandbox guarantee.

For `session/request_permission`, Goblin SHALL validate the current session id, bounded tool-call shape, and currently verified profile state. `read-only` SHALL select offered rejection, preferring one-shot. `workspace-write` MAY select `allow_once` but MUST NOT select persistent/unrecognized grants. Offered rejection alone does not cancel the run. With no acceptable option, Goblin SHALL return ACP `cancelled`, cancel the prompt, and fail with bounded `permission_policy_incompatible`; it MUST NOT treat `cancelled` as continuation.

ACP filesystem paths SHALL be at most 4,096 characters. Reads SHALL validate `line`/`limit` as positive safe integers, cap `limit` at 10,000 lines, honor one-based slicing, and reject rather than truncate a response over 1 MiB UTF-8 bytes. Writes SHALL require `workspace-write` and content at most 1 MiB UTF-8 bytes. Existing targets SHALL reject symlinks and resolve inside the canonical project. For a missing target, its real existing parent directory SHALL be inside the project; Goblin SHALL create no parent directories and SHALL atomically write/rename within that verified parent. These path checks are best-effort defense in depth under the same-user race boundary stated by decision 0012.

#### Scenario: Profile drift during a prompt

- **WHEN** a session update changes the current mode or a configured option away from the verified expected value
- **THEN** Goblin SHALL invalidate permission grants, cancel the active prompt, and fail the run with `profile_drift`
- **AND** it MUST NOT answer a later permission request with `allow_once`

#### Scenario: Workspace-write permission request

- **WHEN** an ACP agent requests permission during a `workspace-write` run
- **AND** its options include `allow_once`
- **THEN** Goblin SHALL select `allow_once` without waiting for Telegram input
- **AND** it MUST NOT select a persistent allow option

#### Scenario: Read-only permission request offers rejection

- **WHEN** an ACP agent requests permission during a `read-only` run and offers a rejection option
- **THEN** Goblin SHALL select rejection without Telegram input
- **AND** that rejection alone SHALL NOT cancel the run

#### Scenario: Permission request offers no safe outcome

- **WHEN** a permission request offers neither a policy-acceptable grant nor rejection
- **THEN** Goblin SHALL return ACP's `cancelled` outcome and fail the run with `permission_policy_incompatible`
- **AND** it SHALL NOT claim that the prompt can continue after cancellation

#### Scenario: Goblin follows up after a completed turn

- **GIVEN** an owned run completed with `end_turn`, retained a resume-eligible ACP session, and has no existing child run
- **WHEN** Goblin calls `external_agent message` with that run id and follow-up text
- **THEN** the runner SHALL create and return a new child run id, start a fresh server, resume the same ACP session, and send the follow-up as the child run's first prompt
- **AND** the completed source run SHALL remain immutable
- **AND** no second non-terminal child run SHALL use that ACP session concurrently

#### Scenario: Filesystem request escapes project

- **WHEN** an ACP server requests a filesystem read or write outside the run's canonical project directory
- **THEN** Goblin SHALL reject the request
- **AND** it MUST NOT disclose content from the escaped path

#### Scenario: Ranged text read

- **WHEN** `fs/read_text_file` supplies valid one-based `line` and `limit`
- **THEN** Goblin SHALL return that line range without exceeding 10,000 lines or 1 MiB UTF-8 bytes
- **AND** reject invalid integers or an over-limit response rather than silently truncate file content

#### Scenario: Write creates a missing file safely

- **WHEN** `workspace-write` requests a missing file whose real existing parent is inside the project
- **THEN** Goblin SHALL atomically create it in that parent without creating directories
- **AND** reject a symlink target, escaped parent, invalid UTF-8, or content over 1 MiB

### Requirement: ACP terminal methods use bounded run-scoped virtual PTYs

The ACP client SHALL advertise terminal capability and implement `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, and `terminal/release`. A terminal created for an ACP session SHALL use an actual local pseudo-terminal, an opaque code-generated terminal id, array-based command execution without shell interpolation, a cwd whose `realpath` is equal to or contained by the run's canonical project directory, and the code-owned sanitized external-agent environment.

Terminal creation SHALL be denied for `read-only` runs. A `workspace-write` request MAY choose a command of 1–4,096 characters and at most 128 arguments of at most 4,096 characters each; NUL characters, non-empty request environment, escaped cwd, cross-run terminal ids, and more than eight unreleased terminal registry entries per run SHALL be rejected. Exited or killed terminals count until `terminal/release`. `outputByteLimit` SHALL default to 2 MiB, reject non-safe/non-positive integers, and clamp larger safe integers to 2 MiB. Retained output SHALL remain valid UTF-8 and report `truncated: true` after discarding bytes. ACP v1 terminal hosting SHALL NOT expose keystroke or arbitrary stdin forwarding.

All live terminals for a run SHALL be killed and released on explicit cancellation, timeout, ACP disconnect, run completion, or graceful local shutdown. Terminal children SHALL NOT be adopted across restart. A record lacking proof of clean local teardown SHALL follow the hard-crash startup block in `resumable ACP runs continue through a fresh server process` rather than assuming orphaned terminals died.

#### Scenario: Workspace-write agent creates a terminal

- **WHEN** a `workspace-write` ACP session calls `terminal/create` with a command, arguments, and a cwd inside its project
- **THEN** Goblin SHALL start the command in a run-scoped pseudo-terminal
- **AND** return an opaque terminal id without waiting for command completion

#### Scenario: Read-only terminal is denied

- **WHEN** a `read-only` ACP session calls `terminal/create`
- **THEN** Goblin SHALL reject the request
- **AND** no child process SHALL start

#### Scenario: Terminal cwd escapes project

- **WHEN** `terminal/create` supplies a cwd outside the run's canonical project directory
- **THEN** Goblin SHALL reject the request
- **AND** no terminal id SHALL be allocated

#### Scenario: Terminal cwd symlink escapes project

- **WHEN** `terminal/create` supplies a path inside the project whose resolved target is outside the canonical project directory
- **THEN** Goblin SHALL reject the request after `realpath` resolution
- **AND** no terminal id SHALL be allocated

#### Scenario: Terminal environment injection is rejected

- **WHEN** `terminal/create` supplies one or more environment entries
- **THEN** Goblin SHALL reject the request
- **AND** the child process MUST NOT receive those entries

#### Scenario: Terminal request exceeds structural bounds

- **WHEN** `terminal/create` supplies an empty or overlong command, more than 128 arguments, an overlong argument, or would exceed eight unreleased terminal entries for the run
- **THEN** Goblin SHALL reject the request before starting a child or allocating a terminal id

#### Scenario: Terminal output limit is not a safe positive integer

- **WHEN** `terminal/create` supplies a non-integer, non-safe, zero, or negative `outputByteLimit`
- **THEN** Goblin SHALL reject the request rather than relying on lossy JavaScript uint64 conversion

#### Scenario: Terminal output exceeds its bound

- **WHEN** terminal output exceeds the clamped retained-output limit
- **THEN** `terminal/output` SHALL return bounded valid UTF-8 and `truncated: true`
- **AND** truncation SHALL move to a valid UTF-8 character boundary rather than retain a partial code point
- **AND** terminal memory usage SHALL remain bounded

#### Scenario: Terminal release is destructive

- **WHEN** the agent calls `terminal/release` for its terminal
- **THEN** Goblin SHALL kill the command if still running and release the terminal record
- **AND** subsequent operations on that terminal id SHALL fail

### Requirement: resumable ACP runs continue through a fresh server process

The runner SHALL preserve accepted-start order: synchronously reserve a slot, atomically persist initial metadata containing the configured server id in `backend`, the current Linux host boot id, and one absolute deadline, then start the server. Before the first task prompt, it SHALL add an ACP session id of 1–4,096 characters, a 64-character lowercase hexadecimal fingerprint, advertised resume support, and code-owned resume eligibility. Only the exact pinned Claude/Codex definitions whose fresh-process smoke gates passed SHALL be resume-eligible in this change; Devin and custom definitions SHALL be persisted as ineligible even if they advertise resume. Task text MUST NOT enter Goblin artifacts. Persistence failure SHALL prevent task delivery and begin bounded cleanup; the slot is released only after child exit is confirmed, otherwise the run remains `stopping` and blocks starts.

Graceful shutdown SHALL disconnect a resumable run without `session/cancel` or `session/close`, terminate and confirm exit of its local server and every unreleased terminal, and only then set `recoveryReadyAt` while leaving it non-terminal. If cleanup or that write fails, the record SHALL remain non-terminal without a marker. On startup, a same-boot non-terminal ACP record without valid `recoveryReadyAt` SHALL block initialization because a crash may have left work active. If the persisted host boot id differs from the current boot id, startup MAY safely conclude old OS children cannot exist, atomically mark the unclean record `interrupted`, and continue without resuming it.

For each cleanly detached record, startup SHALL validate deadline/fingerprint, restore its slot, and arm deadline enforcement before spawn. It SHALL clear `recoveryReadyAt` before starting a fresh server, then initialize, verify resume, call `session/resume`, re-enforce policy/options, and send continuation. Initialize, resume, and continuation SHALL use no more than the remaining task deadline. When task time expires or another terminal outcome is claimed, Goblin SHALL stop task execution and use a separate fixed 10-second cleanup grace; that grace MUST NOT permit more agent work or extend `deadlineAt`. The terminal outcome is persisted/exposed only after confirmed child exit. Cleanup-grace expiry leaves the run `stopping` with `pendingTerminalStatus` and blocks startup/new starts.

Recovery SHALL be conversation continuation, not process adoption or exactly-once execution. Goblin SHALL NOT resend the original task, claim the interrupted prompt continued offline, or use `session/load` to replay history. A legacy native record, expired record, missing server, changed fingerprint, absent resume capability, or failed resume SHALL become terminal without guessing another session id. Legacy PTY records SHALL follow verified migration cleanup before any terminal transition.

#### Scenario: Initial metadata precedes ACP execution

- **WHEN** an external-agent start reserves a concurrency slot
- **THEN** Goblin SHALL persist initial metadata and the absolute deadline before starting the ACP server
- **AND** a failure to create initial metadata SHALL release the slot and start no process

#### Scenario: Session checkpoint precedes first prompt

- **WHEN** ACP `session/new` returns a session id for a new run
- **THEN** Goblin SHALL persist session id, advertised resume support, code-owned resume eligibility, fingerprint, and existing deadline before `session/prompt`
- **AND** a checkpoint failure SHALL prevent task delivery and claim pending `failed`
- **AND** release the slot only after local child exit is confirmed

#### Scenario: Session creation fails before checkpoint

- **WHEN** the ACP server fails or rejects `session/new`
- **THEN** the run SHALL claim pending `failed` and enter `stopping`
- **AND** Goblin SHALL terminate the server/terminals and release the slot exactly once after confirmed exit
- **AND** no task prompt or ACP checkpoint SHALL be persisted

#### Scenario: Matching cleanly detached ACP session resumes after restart

- **GIVEN** a non-terminal ACP run has valid `recoveryReadyAt`, an unexpired deadline, and a matching server fingerprint
- **AND** the fresh server advertises resume capability
- **WHEN** startup recovery clears the marker and calls `session/resume` successfully
- **THEN** the runner SHALL already have restored the run's concurrency slot and armed its remaining timeout
- **AND** apply configured select options, enforce the profile policy last, and verify resulting state
- **AND** send the code-owned continuation prompt without resending the original task

#### Scenario: Resumed runs block starts above a lowered limit

- **GIVEN** three valid ACP runs are resumable and configuration now sets `maxConcurrent` to two
- **WHEN** Goblin restores all three runs
- **THEN** all three SHALL continue
- **AND** no new external-agent run SHALL start until active run count falls below two

#### Scenario: Gracefully detached active prompt does not survive restart

- **WHEN** graceful shutdown begins while an ACP prompt is in flight
- **THEN** the old server process and terminals SHALL be terminated and confirmed exited before `recoveryReadyAt` is persisted
- **AND** the system MUST NOT report that the in-flight process continued while Goblin was offline
- **AND** any recovery SHALL occur as a new prompt in the existing ACP session

#### Scenario: Same-boot hard crash leaves no recovery proof

- **GIVEN** a non-terminal ACP record lacks `recoveryReadyAt`
- **AND** its persisted host boot id equals the current host boot id
- **WHEN** startup reconciliation runs
- **THEN** initialization SHALL fail before Telegram polling or new external starts
- **AND** Goblin MUST NOT resume the session, mark the run stopped, or automatically reuse its project

#### Scenario: Host reboot proves old children are gone

- **GIVEN** a non-terminal ACP record lacks `recoveryReadyAt`
- **AND** its persisted host boot id differs from the current Linux host boot id
- **WHEN** startup reconciliation runs
- **THEN** Goblin SHALL atomically mark the run `interrupted` without resume or task replay
- **AND** startup MAY continue because prior-boot OS processes cannot still be running

#### Scenario: Deadline expires during resume handshake

- **GIVEN** startup begins recovery before the persisted deadline
- **WHEN** initialize or `session/resume` reaches that deadline
- **THEN** Goblin SHALL abort task execution and enter `stopping` with pending `timed_out`
- **AND** use only the separate 10-second cleanup grace
- **AND** expose `timed_out` only after child exit confirms, without granting a new task interval

#### Scenario: Cleanup grace expires

- **WHEN** the 10-second cleanup grace expires before every local child confirms exit
- **THEN** the run SHALL remain `stopping` with its pending terminal outcome
- **AND** Goblin SHALL block new starts and MUST NOT report the child as stopped

#### Scenario: Resume capability or eligibility is unavailable

- **GIVEN** a non-terminal ACP run whose server lacks advertised resume support or whose definition is not code-owned resume-eligible
- **WHEN** Goblin starts again
- **THEN** the run SHALL become `interrupted`
- **AND** Goblin MUST NOT replay the original task or invent a replacement session id

#### Scenario: Server definition changed

- **GIVEN** a non-terminal ACP run was created under one server-definition fingerprint
- **WHEN** its configured command, arguments, profile modes, select options, built-in package version, or custom resume epoch produces a different fingerprint at startup
- **THEN** Goblin SHALL mark the run `interrupted`
- **AND** MUST NOT send its ACP session id to the changed server definition

#### Scenario: Deadline elapsed while offline

- **GIVEN** a resumable ACP record whose absolute deadline is at or before startup time
- **WHEN** startup recovery runs
- **THEN** the run SHALL become `timed_out` without starting a continuation prompt
- **AND** restart MUST NOT grant a fresh timeout interval

#### Scenario: Continuation may repeat side effects

- **WHEN** a resumed agent continues an interrupted task
- **THEN** the continuation prompt SHALL instruct it to inspect existing session and filesystem state before acting
- **AND** Goblin MUST NOT claim exactly-once execution for repository or external side effects

## MODIFIED Requirements

### Requirement: ExternalAgentRunner owns external-agent run lifecycle

The process-wide `ExternalAgentRunner` SHALL own every external-agent run. Each new run SHALL have a UUID, a configured ACP server id persisted in `backend`, owning Goblin session id, bound project directory, timestamps, and one status from `starting`, `running`, `stopping`, `completed`, `failed`, `cancelled`, `timed_out`, or `interrupted`. New ACP runs SHALL NOT use `input_required`.

The terminal statuses SHALL remain `completed`, `failed`, `cancelled`, `timed_out`, and `interrupted`, and SHALL be immutable. `stopping` SHALL mean a terminal outcome has been claimed in `pendingTerminalStatus` but local child exit is not yet confirmed. Cancel, timeout, disposal, prompt completion/failure, or startup failure SHALL synchronously claim exactly one pending terminal outcome and prevent later ACP updates from changing it. The runner SHALL expose the terminal status only after result/event ordering is satisfied and all known local server/terminal children confirm exit. If bounded cleanup fails, the run SHALL remain `stopping`, retain the pending outcome, block new external starts, and MUST NOT be reported as stopped.

#### Scenario: Start creates an owned ACP run

- **WHEN** `start()` receives an enabled ACP server id, task, Goblin session id, and bound project directory
- **THEN** it SHALL return a new run UUID without waiting for the task
- **AND** record the configured server id in `backend`
- **AND** transition from `starting` to `running` after the ACP session checkpoint and before prompt observation

#### Scenario: End turn completes after cleanup

- **WHEN** an ACP prompt returns `end_turn`
- **THEN** the runner SHALL claim pending `completed`, persist ordered output/result, and enter `stopping`
- **AND** transition to `completed` only after local children confirm exit

#### Scenario: Cancel during startup wins

- **WHEN** cancel is accepted while ACP startup is pending
- **THEN** the run SHALL claim pending `cancelled` and MUST NOT deliver the task
- **AND** any later server/handle SHALL be cleaned exactly once
- **AND** no later update SHALL transition the run to `running` or `completed`

#### Scenario: Cleanup cannot confirm exit

- **WHEN** a run has claimed a terminal outcome but its fixed cleanup grace expires before all known local children exit
- **THEN** it SHALL remain `stopping` with that pending outcome
- **AND** new external starts SHALL be blocked
- **AND** status MUST NOT report the pending terminal outcome as completed cleanup

#### Scenario: Terminal state is immutable

- **WHEN** a run is terminal and a late ACP update or process exit arrives
- **THEN** its terminal status SHALL remain unchanged

### Requirement: concurrency and timeout limits are enforced centrally

`ExternalAgentRunner` SHALL reserve the process-wide concurrency slot synchronously before metadata writes or process spawn. A rejected start MUST NOT create a run id, metadata, or process. Starting, running, and stopping runs SHALL occupy a slot; restored activity MAY exceed a lowered maximum and SHALL block new acquisition until below the limit.

Each run SHALL have one absolute task deadline. On expiry the runner SHALL synchronously claim pending `timed_out`, enter `stopping`, abort all task/protocol work, and begin the separate fixed 10-second cleanup grace. The task deadline MUST NOT be reset by follow-up or recovery, and cleanup grace MUST NOT execute task work. `timed_out` SHALL persist and the slot release only after local child exit confirms; failed cleanup leaves `stopping`, retains the slot, and blocks starts.

#### Scenario: Concurrency cap reached

- **WHEN** occupied slots equal `maxConcurrent` and another start is requested
- **THEN** the request SHALL fail with no run id, metadata, or process

#### Scenario: Concurrent starts reserve atomically

- **WHEN** `maxConcurrent + 1` starts race
- **THEN** at most `maxConcurrent` SHALL reserve slots and create run ids
- **AND** the rejected request SHALL create no filesystem state

#### Scenario: Run exceeds task deadline

- **WHEN** a run reaches its absolute deadline
- **THEN** it SHALL enter `stopping` with pending `timed_out` and task execution SHALL cease
- **AND** `timed_out` SHALL be exposed only after child exit confirms within cleanup

#### Scenario: Timeout cleanup cannot confirm exit

- **WHEN** timeout cleanup grace expires with a known local child unconfirmed
- **THEN** the run SHALL remain `stopping`, retain its slot, and block new starts
- **AND** a late ACP event MUST NOT overwrite pending `timed_out`

### Requirement: external processes receive a sanitized environment

Every built-in or custom ACP server process and every ACP-hosted terminal child SHALL receive a new code-owned environment map rather than `process.env`. The map SHALL contain only the minimum execution variables required for local CLI operation (`HOME`, `PATH`, `USER`, `LOGNAME`, locale variables, selected `XDG_*` paths, `TMPDIR`, and terminal variables). It MUST exclude Goblin configuration values and secret-bearing variables including Telegram tokens, `GOBLIN_HOME`, provider API-key variables, and `SSH_AUTH_SOCK`. Authentication for external CLIs SHALL use their existing user-scoped credential stores. Neither model-facing tool input, custom ACP server configuration, nor an ACP terminal request SHALL add environment overrides.

#### Scenario: Bot token exists in parent environment

- **WHEN** Goblin starts an ACP server or ACP-hosted terminal while its parent environment contains `BOT_TOKEN` and provider API keys
- **THEN** none of those variables SHALL appear in the child environment

#### Scenario: CLI discovery remains available

- **WHEN** Goblin starts an ACP server or terminal child
- **THEN** the sanitized environment SHALL preserve `PATH` and the configured user home variables needed to locate executables and user-scoped authentication

#### Scenario: Custom server cannot add environment

- **WHEN** an operator configures a custom ACP server
- **THEN** its schema SHALL NOT accept an environment override map
- **AND** the server SHALL receive the same sanitized environment policy as built-in servers

### Requirement: external_agent tool exposes task-level actions

The main Goblin agent SHALL receive one `external_agent` tool when at least one built-in or custom ACP server is enabled. Its action SHALL be one of `start`, `status`, `message`, `cancel`, or `list`.

- `start` SHALL accept only a configured agent id and task, derive `sessionId` and `projectDir` from the calling runner, and return a run id immediately.
- `status` SHALL accept a run id owned by the calling session and return status, agent id, timestamps, bounded recent output, pending cleanup outcome when `stopping`, and final result when terminal.
- `message` SHALL accept a completed lineage-head run id and follow-up text, synchronously claim the source ACP session, and return a new child run id after scheduling fresh-server resume plus prompt. It SHALL require matching ownership, `end_turn` completion, code-owned resume eligibility, advertised resume support, current fingerprint compatibility, no existing child (terminal or non-terminal), and no non-terminal session user. The source remains immutable; the child gets a new absolute deadline.
- `cancel` SHALL accept a run id and cancel that owned run.
- `list` SHALL return bounded metadata for runs owned by the calling session.

The tool MUST NOT accept a cwd, executable, CLI arguments, environment, permission mode, owner session id, timeout, ACP session id, ACP mode/config option, terminal id, or terminal action. Custom agent ids SHALL be validated against the enabled ids captured by the tool factory; an arbitrary string MUST NOT select an unconfigured command.

#### Scenario: Start built-in ACP agent

- **WHEN** Goblin calls `external_agent({ action: "start", agent: "codex", task: "Fix the failing test" })`
- **AND** Codex is enabled and the calling session is bound to `/srv/project`
- **THEN** the tool SHALL start the code-owned Codex ACP server with cwd `/srv/project`
- **AND** return the run id before the prompt completes

#### Scenario: Start custom ACP agent

- **WHEN** Goblin calls `start` with a configured custom agent id
- **THEN** the tool SHALL resolve only that id's trusted server definition
- **AND** MUST NOT accept command or argument overrides from the call

#### Scenario: Start without project binding

- **WHEN** `start` is called from a session with no configured project directory
- **THEN** the tool SHALL return a clear error requiring `/project`
- **AND** no ACP server process SHALL start

#### Scenario: Cross-session access is rejected

- **WHEN** session B calls `status`, `message`, or `cancel` with a run id owned by session A
- **THEN** the tool SHALL return `External agent run not found`
- **AND** it MUST NOT disclose that the run exists

#### Scenario: Message creates an immutable continuation run

- **WHEN** `message` targets an owned run completed by `end_turn` with a compatible resume-capable session
- **THEN** the tool SHALL return a distinct child run id
- **AND** the source run SHALL remain completed
- **AND** the child SHALL use the same internal ACP session id with a new absolute deadline

#### Scenario: Message is unsupported for this source

- **WHEN** `message` targets a non-terminal, failed, non-resume-eligible, fingerprint-incompatible, or non-head run
- **THEN** the tool SHALL return a clear unsupported-state error
- **AND** no follow-up prompt SHALL be sent

#### Scenario: Stale lineage source is rejected

- **GIVEN** completed run A has child B and B later completes
- **WHEN** Goblin calls `message(A, ...)`
- **THEN** the tool SHALL reject A as a stale lineage source
- **AND** `message(B, ...)` MAY create the next child when B otherwise qualifies

#### Scenario: Tool omitted when disabled

- **WHEN** no built-in backend or custom ACP server is enabled
- **THEN** `external_agent` SHALL NOT be registered on the main agent

### Requirement: external agent configuration is explicit and bounded

The JSON5 configuration SHALL accept an optional `externalAgents` object with:

- `backends`: an array containing unique built-in ids from `codex`, `claude`, and `devin`, defaulting to `[]`;
- `servers`: a record of at most eight custom ACP server definitions, defaulting to `{}`; each key SHALL match `[a-z][a-z0-9-]{0,31}` and each value SHALL contain a 1–4,096 character `command`, at most 32 `args` of at most 4,096 characters each, required `profileModes.readOnly` and `profileModes.workspaceWrite` ids of 1–128 characters, at most 32 `configOptions` whose ids are 1–128 characters and whose string select values are 1–512 characters, and an optional 1–128 character `resumeEpoch` defaulting to `"1"`;
- `maxConcurrent`: an integer from 1 through 8, defaulting to `2`;
- `timeoutMs`: an integer from 60,000 through 7,200,000, defaulting to 1,800,000;
- `permissionProfile`: `read-only` or `workspace-write`, defaulting to `read-only`.

The removed `ptyFallback` key and unknown fields MUST fail validation. NUL characters, a custom id colliding with an enabled built-in, duplicate built-ins, missing profile modes, non-string config values, over-limit strings/counts, out-of-range numeric limits, and unknown permission profiles MUST fail startup validation. The parsed `Config` SHALL expose a deeply frozen typed object. Custom commands and mode mappings are trusted operator configuration under the same-user risk boundary; they MUST NOT be accepted or mutated through the model-facing tool. Operators SHALL increment `resumeEpoch` when replacing custom server code incompatibly at the same command path.

#### Scenario: Configuration absent

- **WHEN** `externalAgents` is absent from `goblin.json5`
- **THEN** config loading SHALL produce no enabled ACP server ids
- **AND** external-agent execution SHALL be disabled

#### Scenario: Built-ins and custom servers are enabled

- **WHEN** configuration enables `codex` and defines custom server `opencode`
- **THEN** the tool SHALL advertise exactly `codex` and `opencode`
- **AND** each id SHALL resolve to its code-owned or operator-trusted ACP server definition

#### Scenario: Custom id collides with built-in

- **WHEN** `backends` includes `codex` and `servers` also defines `codex`
- **THEN** startup validation SHALL fail

#### Scenario: Custom profile mapping is incomplete

- **WHEN** a custom server omits either `profileModes.readOnly` or `profileModes.workspaceWrite`
- **THEN** startup validation SHALL fail before the server can be enabled

#### Scenario: Numeric or boolean config option is rejected

- **WHEN** a custom `configOptions` value is numeric or boolean
- **THEN** startup validation SHALL fail because this change supports only advertised ACP select-value ids

#### Scenario: Removed PTY fallback is rejected

- **WHEN** configuration contains `ptyFallback`
- **THEN** startup validation SHALL fail with an error identifying the removed key

#### Scenario: Dangerous profile rejected

- **WHEN** configuration sets `permissionProfile` to `dangerous` or an approval-bypass value
- **THEN** startup validation SHALL fail

### Requirement: enabled external executables are preflighted

Startup preflight SHALL start each enabled ACP server with a bounded timeout, complete initialize, validate, and terminate without creating a session. Missing/malformed/oversized/incompatible ACP MUST fail with configured server id. Claude/Codex SHALL require advertised resume and carry code-owned `resumeEligible: true` only for exact package versions whose build smoke gate passed. Devin/custom definitions SHALL carry `resumeEligible: false` in this change regardless of advertised capability; preflight MAY report advertised support diagnostically but MUST NOT use it for automatic resume.

Built-in Claude and Codex ACP bridge packages SHALL be exact-version application dependencies and MUST NOT be downloaded by `npx`, `bunx`, or a registry request at runtime. Their package version, policy, and eligibility SHALL enter the fingerprint. Before native adapters are removed, both pinned bridges MUST pass authenticated create-session, terminate-process, fresh-process resume smoke tests; inability SHALL block cutover. The installed Devin command remains an external prerequisite and is explicitly non-resume-eligible in this change.

#### Scenario: Built-in ACP bridge missing

- **WHEN** Codex is enabled but its pinned ACP bridge cannot be started
- **THEN** startup preflight SHALL fail with an error naming Codex and the attempted bridge
- **AND** Telegram polling SHALL NOT start

#### Scenario: Custom server is not ACP

- **WHEN** a configured custom command starts but does not complete a valid ACP initialize handshake
- **THEN** startup preflight SHALL fail with an error naming the custom id

#### Scenario: Custom server remains non-resume-eligible

- **WHEN** a custom ACP server initializes, with or without advertised resume support
- **THEN** preflight SHALL allow startup and record diagnostic support truthfully
- **AND** its definition SHALL remain code-owned `resumeEligible: false`
- **AND** graceful process shutdown SHALL interrupt its active runs after confirmed cleanup rather than preserve them

#### Scenario: Disabled server is absent

- **WHEN** Claude is not enabled and its bridge executable is absent
- **THEN** external-agent preflight SHALL NOT fail because of Claude

### Requirement: external run records are bounded and persisted

Each run SHALL persist under `$GOBLIN_HOME/scratch/external-agents/<runId>/` using path helpers. `meta.json` SHALL be written atomically, normalized events SHALL be appended as complete JSON lines to `events.jsonl`, and a completed final response SHALL be written atomically to `result.txt`. The runner SHALL NOT intentionally persist the task text in any run artifact or return it by `status` or `list`.

The runner SHALL bound individual normalized output events to 32,000 characters, retained `events.jsonl` content to 2 MiB per run, final result text to 128,000 characters, `status` recent-output responses to 16,000 characters, and `list` responses to the 20 newest owned runs. Truncation SHALL be explicit in persisted metadata and tool results.

Events, metadata updates, and result writes for one run SHALL follow acceptance order. A terminal state SHALL NOT be exposed until result persistence, preceding events, and confirmed local cleanup complete. For ACP records, `backend` SHALL contain the configured server id; no second server-id field is added. Records SHALL accept bounded `acpSessionId`, `acpResumeSupported`, `acpResumeEligible`, `acpServerFingerprint`, `deadlineAt`, `recoveryReadyAt`, `continuedFromRunId`, `hostBootId`, and `pendingTerminalStatus`. Session ids SHALL be 1–4,096 characters, fingerprints 64 lowercase hex, boot ids canonical UUIDs, pending status one terminal status and present only with `stopping`, and timestamps valid ISO instants. Terminal legacy records SHALL remain readable unchanged.

A non-terminal legacy native record SHALL reconcile to `interrupted` without task replay. Before a non-terminal legacy PTY record becomes `interrupted`, startup SHALL use a bounded migration-only `agent-pty` request to kill its exactly owner-scoped daemon sessions. It MUST NOT inspect output, adopt a process, or send task input. If the executable, daemon, ownership proof, or cleanup request is unavailable, startup SHALL fail before polling or new starts and SHALL leave the record non-terminal rather than falsely reporting stopped work.

#### Scenario: Run starts

- **WHEN** an external run is accepted
- **THEN** its directory and atomic `meta.json` SHALL be created before ACP server execution begins
- **AND** metadata SHALL include id, owner session, configured ACP server id in `backend`, project directory, status, absolute deadline, and timestamps

#### Scenario: ACP session checkpoint records support and eligibility

- **WHEN** `session/new` returns
- **THEN** Goblin SHALL atomically checkpoint session id, fingerprint, advertised support, code-owned eligibility, and deadline before task delivery
- **AND** classify the run as resumable only when both booleans are true

#### Scenario: Excessive output

- **WHEN** ACP agent output exceeds a configured fixed cap
- **THEN** persistence and tool responses SHALL remain within the specified bounds
- **AND** the run SHALL record that output was truncated

#### Scenario: Startup finds legacy native run

- **WHEN** startup loads a non-terminal native record without ACP resume metadata
- **THEN** it SHALL atomically mark the run `interrupted`
- **AND** MUST NOT adopt a process or rerun the original task

#### Scenario: Startup cleans a legacy PTY run

- **WHEN** startup loads a non-terminal legacy PTY record
- **AND** its exactly owner-scoped `agent-pty` cleanup succeeds
- **THEN** Goblin SHALL atomically mark the record `interrupted`
- **AND** MUST NOT inspect, adopt, or send input to the legacy process

#### Scenario: Legacy PTY cleanup cannot be verified

- **WHEN** startup cannot complete exactly owner-scoped cleanup for a non-terminal legacy PTY record
- **THEN** startup SHALL fail before Telegram polling or new external starts
- **AND** the record SHALL remain non-terminal
- **AND** Goblin MUST NOT report the legacy work as stopped

#### Scenario: Terminal legacy record remains readable

- **WHEN** startup loads a terminal native or PTY record
- **THEN** status inspection SHALL continue to read its original metadata and bounded artifacts
- **AND** startup SHALL NOT rewrite it as an ACP record

#### Scenario: Event and result ordering is preserved

- **WHEN** an ACP session emits a burst of output updates followed by `end_turn`
- **THEN** the runner SHALL persist all accepted events in order
- **AND** `status` SHALL NOT expose `completed` until the result is persisted

#### Scenario: ACP prompt stops unsuccessfully

- **WHEN** a prompt returns `max_tokens`, `max_turn_requests`, or `refusal`
- **THEN** the run SHALL enter `stopping` with pending `failed` and a bounded reason after accepted output persists
- **AND** become `failed` and release its slot exactly once only after local child exit confirms

#### Scenario: Task text is not intentionally persisted

- **WHEN** a run completes or is resumed
- **THEN** Goblin's `meta.json`, `events.jsonl`, and `result.txt` SHALL NOT intentionally contain the original task text except when echoed by the provider
- **AND** recovery SHALL use a code-owned continuation prompt rather than a persisted copy of the task

### Requirement: cancellation is idempotent and owner-scoped

`ExternalAgentRunner.cancel(runId)` SHALL synchronously claim pending `cancelled`, enter `stopping`, and prevent later state changes before awaiting cleanup. Cleanup SHALL cancel the prompt, close the ACP session when supported, kill all run terminals, terminate the server, and use the fixed 10-second cleanup grace. Only confirmed child exit permits persisting `cancelled` and releasing the slot; cleanup expiry leaves `stopping` and blocks starts. Repeated cancellation of terminal/stopping runs SHALL not duplicate cleanup. `cancelBySession(sessionId)` SHALL attempt every owned non-terminal target even if one cleanup fails.

Process-shutdown detachment is not cancellation: it preserves only valid resumable metadata after clean detach and MUST NOT claim `cancelled`. Timeout SHALL synchronously claim pending `timed_out`, enter `stopping`, cancel task execution, and use the same cleanup grace without allowing late updates to overwrite the claim.

#### Scenario: Cancel running ACP run

- **WHEN** `cancel(runId)` targets a running ACP run
- **THEN** it SHALL enter `stopping` with pending `cancelled` before cleanup is awaited
- **AND** its active prompt and terminals SHALL receive cancellation attempts
- **AND** `cancelled` SHALL be exposed only after local child exit confirms

#### Scenario: Cancel all for session

- **WHEN** `cancelBySession("session-a")` is called
- **AND** sessions A and B both own running external runs
- **THEN** every run owned by session A SHALL be cancelled
- **AND** session B's runs SHALL remain active

#### Scenario: Concurrent timeout and cancel

- **WHEN** timeout and explicit cancel race for the same run
- **THEN** exactly one pending terminal outcome SHALL win
- **AND** prompt, terminal, and server cleanup SHALL run at most once

#### Scenario: Process shutdown cleanly detaches resumable run

- **WHEN** graceful process shutdown reaches a valid resumable ACP run
- **THEN** the runner SHALL terminate and confirm exit of local ACP resources without marking the run terminal
- **AND** atomically persist `recoveryReadyAt` only after that confirmation
- **AND** it MUST NOT send `session/cancel` or `session/close`

#### Scenario: Explicit cancel races with process shutdown

- **WHEN** explicit owner-scoped cancellation is accepted before or during shutdown detachment
- **THEN** pending `cancelled` SHALL supersede recovery and prevent startup resume
- **AND** local ACP cleanup SHALL still settle at most once
- **AND** `cancelled` SHALL persist only after confirmed child exit, even if detach already closed transport

## REMOVED Requirements

### Requirement: External agent adapters normalize native protocols

### Requirement: agent-pty is an internal interactive fallback

### Requirement: agent-pty protocol supports owned abortable sessions
