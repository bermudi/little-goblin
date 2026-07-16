# external-agents

## ADDED Requirements

### Requirement: PTY-backed runs are adoptable across Goblin restarts

A non-terminal external-agent run whose `adapterKind` is `pty` SHALL continue across a Goblin process restart when the same `agent-pty` daemon still owns a matching live or exited session. The persisted run record SHALL include the expected PTY session name, absolute timeout deadline, and last consumed output cursor. Startup adoption MUST validate exact session name, exact owner (`goblin:<ownerSessionId>`), expected backend executable, and canonical project directory before constructing a handle. Attach SHALL NOT spawn a process, resend the task, or repeat PTY initialization.

Process shutdown SHALL detach PTY handles without killing or removing their daemon sessions. Explicit run cancellation, timeout, session disposal, and terminal cleanup SHALL retain their destructive semantics. Native runs SHALL remain non-adoptable and SHALL be cancelled during process shutdown.

#### Scenario: Matching live PTY is adopted

- **GIVEN** a non-terminal PTY-backed record with an unexpired deadline
- **AND** `agent-pty` lists a live session whose name, owner, executable, and canonical cwd exactly match the record
- **WHEN** `ExternalAgentRunner.init()` reconciles startup state
- **THEN** the runner SHALL attach a reconstructed handle to that session
- **AND** the run SHALL retain its id, status, owner, deadline, and output cursor
- **AND** it MUST NOT spawn another backend or resend the original task

#### Scenario: Graceful Goblin restart detaches PTY work

- **GIVEN** Goblin owns a running PTY-backed run and a running native run
- **WHEN** Goblin receives SIGTERM for process shutdown
- **THEN** the PTY-backed run SHALL remain non-terminal in persisted metadata and its `agent-pty` session SHALL remain alive
- **AND** local observation of that PTY SHALL stop before process exit
- **AND** the native run SHALL receive a cancellation attempt and become terminal

#### Scenario: Explicit session disposal still cancels PTY work

- **GIVEN** a PTY-backed run owned by session A
- **WHEN** session A is disposed by `/new`, `/resume`, `/archive`, or `/project`
- **THEN** the run SHALL become `cancelled`
- **AND** its PTY session SHALL be killed and removed

#### Scenario: Identity mismatch is not adopted

- **GIVEN** a non-terminal PTY-backed record
- **AND** a daemon session has the expected name but a different owner, executable, or canonical cwd
- **WHEN** startup reconciliation runs
- **THEN** Goblin MUST NOT attach to that session
- **AND** the run SHALL become `interrupted` with a non-sensitive mismatch reason
- **AND** a conflicting session within Goblin's trusted `goblin-*` namespace SHALL receive isolated cleanup

#### Scenario: PTY session disappeared

- **GIVEN** persisted non-terminal PTY metadata
- **AND** the daemon has no matching session because it restarted, crashed, or lost the child
- **WHEN** startup reconciliation runs
- **THEN** the run SHALL become `interrupted`
- **AND** Goblin MUST NOT automatically rerun the task

#### Scenario: Deadline elapsed while Goblin was offline

- **GIVEN** a matching live PTY session whose persisted absolute deadline is at or before startup time
- **WHEN** startup reconciliation runs
- **THEN** Goblin SHALL kill and remove the PTY session
- **AND** the run SHALL become `timed_out`
- **AND** restart MUST NOT grant a new timeout interval

#### Scenario: PTY exited while Goblin was offline

- **GIVEN** a matching daemon session exited while Goblin was unavailable
- **WHEN** startup reconciliation runs
- **THEN** Goblin SHALL consume all retained output after the persisted cursor
- **AND** if the recorded exit time is at or before the deadline, it SHALL set the run to `completed` for exit code zero or `failed` for non-zero exit/signal
- **AND** if the recorded exit time is after the deadline, it SHALL set the run to `timed_out`
- **AND** it SHALL remove the daemon session only after terminal output and metadata are persisted

#### Scenario: Adopted work restores concurrency accounting

- **GIVEN** the daemon owns three valid PTY runs and configuration now sets `maxConcurrent` to two
- **WHEN** Goblin adopts all three runs
- **THEN** all three SHALL continue rather than being killed to satisfy the lowered limit
- **AND** no new external-agent run SHALL start until active ownership falls below the configured limit

#### Scenario: Legacy non-terminal PTY metadata is not guessed

- **GIVEN** a pre-change non-terminal PTY record lacks the identity, deadline, or cursor fields required for adoption
- **WHEN** startup reconciliation runs
- **THEN** the record SHALL become `interrupted`
- **AND** any exactly owner-scoped legacy PTY session SHALL be cleaned up
- **AND** terminal legacy records SHALL remain readable through their normal retention period

### Requirement: agent-pty replays bounded output by cursor

For each daemon session, `agent-pty` SHALL retain a bounded in-memory sequence of raw PTY output chunks with an opaque monotonically increasing integer cursor. A validated `read-output` command SHALL accept a session name, an optional cursor, and a bounded response size, then return complete output chunks after that cursor, the next cursor, whether more retained output remains, and whether requested output was truncated from the replay buffer. Retained output SHALL be capped at 2 MiB per session and SHALL remain available after process exit until explicit session removal or daemon termination.

Session inventory SHALL expose immutable identity, running/exited lifecycle state, exit timestamp and exit code/signal when terminal, and the latest output cursor. A validated `capabilities` command SHALL return a protocol version and code-owned feature names so clients can reject incompatible daemons without creating a probe session. Existing snapshot, scrollback, wait, owner filtering, kill, and remove behavior SHALL remain compatible.

#### Scenario: Read output after known cursor

- **GIVEN** a session has emitted chunks at cursors 11 through 15
- **WHEN** `read-output` requests output after cursor 12
- **THEN** the response SHALL contain complete retained chunks beginning after 12 in original order
- **AND** it SHALL return the cursor corresponding to the last returned chunk

#### Scenario: Response is paginated within its bound

- **GIVEN** more retained output exists than one response may contain
- **WHEN** `read-output` is called
- **THEN** the response SHALL remain within the requested code-owned maximum
- **AND** `hasMore` SHALL be true
- **AND** another request using the returned cursor SHALL continue without an intentional gap

#### Scenario: Requested cursor fell out of replay

- **GIVEN** output after a caller's cursor has partly fallen out of the 2 MiB replay buffer
- **WHEN** the caller requests output after that cursor
- **THEN** `read-output` SHALL return the oldest retained complete chunk
- **AND** `truncated` SHALL be true
- **AND** Goblin SHALL set its existing output-truncation indicator

#### Scenario: Exited session remains inspectable

- **WHEN** a PTY child exits
- **THEN** `list-sessions` SHALL report it as exited with exit time and exit code or signal
- **AND** `read-output`, `snapshot`, and `scroll` SHALL remain available
- **AND** the daemon SHALL retain the session until explicit `remove`

#### Scenario: Client discovers durable protocol support

- **WHEN** a client invokes `capabilities`
- **THEN** the daemon SHALL return its protocol version and feature names including cursor output and lifecycle inventory
- **AND** the response SHALL NOT include session names, commands, cwd values, environment data, or terminal output

#### Scenario: Daemon termination remains a hard durability boundary

- **WHEN** the `agent-pty` daemon terminates
- **THEN** it SHALL kill its PTY children according to existing daemon cleanup behavior
- **AND** replay buffers and session inventory MAY be lost
- **AND** the next Goblin startup SHALL classify affected records as `interrupted`, not resumed

## MODIFIED Requirements

### Requirement: enabled external executables are preflighted

Startup preflight SHALL verify each enabled native backend executable by running its non-mutating version command with a bounded timeout. When `ptyFallback` is enabled, preflight SHALL also verify that the `agent-pty` executable is available, that its independently managed daemon answers `list-sessions`, and that its protocol supports cursor-based `read-output` plus lifecycle-rich session inventory. A missing, incompatible, or unusable required executable MUST fail preflight with the backend or `agent-pty` name; disabled backends SHALL NOT be checked.

#### Scenario: Enabled backend missing

- **WHEN** `codex` is enabled but its executable cannot be started
- **THEN** startup preflight SHALL fail with an error naming Codex
- **AND** Telegram polling SHALL NOT start

#### Scenario: PTY fallback dependency missing

- **WHEN** `ptyFallback` is true but the independently supervised `agent-pty` daemon cannot answer
- **THEN** startup preflight SHALL fail with an error naming `agent-pty`

#### Scenario: PTY protocol is too old

- **WHEN** `ptyFallback` is true but `agent-pty` lacks `read-output` or lifecycle-rich inventory responses
- **THEN** startup preflight SHALL fail before reconciliation or Telegram polling
- **AND** it SHALL report an incompatible `agent-pty` protocol without exposing session output

#### Scenario: Disabled backend is absent

- **WHEN** Claude is not in the backend allowlist and its executable is absent
- **THEN** external-agent preflight SHALL NOT fail because of Claude

### Requirement: external run records are bounded and persisted

Each run SHALL persist under `$GOBLIN_HOME/scratch/external-agents/<runId>/` using path helpers. `meta.json` SHALL be written atomically, normalized events SHALL be appended as complete JSON lines to `events.jsonl`, and a completed final response SHALL be written atomically to `result.txt`. The runner SHALL NOT intentionally persist the task text in any run artifact or return it by `status` or `list`. A provider may echo the task text in its output or final result; the runner is not required to redact such echoes, and those echoes are not considered intentional persistence.

The runner SHALL bound individual normalized output events to 32,000 characters, retained `events.jsonl` content to 2 MiB per run, final result text to 128,000 characters, `status` recent-output responses to 16,000 characters, and `list` responses to the 20 newest owned runs. Truncation SHALL be explicit in persisted metadata and tool results.

Events, metadata updates, and result writes for a single run SHALL be processed in the order they are accepted. A terminal state SHALL NOT be exposed through `status` until the result is persisted and the ordered queue has drained the preceding accepted events. PTY-backed metadata SHALL additionally persist its expected daemon session identity, absolute deadline, and last consumed output cursor atomically with status progress. These fields MUST NOT include task text, output text, credentials, or arbitrary process arguments.

#### Scenario: Run starts

- **WHEN** an external run is accepted
- **THEN** its directory and atomic `meta.json` SHALL be created before adapter execution begins
- **AND** the metadata SHALL include id, owner session, backend, project directory, status, and timestamps

#### Scenario: PTY fallback becomes adoptable

- **WHEN** a run safely switches from a native adapter to PTY fallback
- **THEN** metadata SHALL atomically record `adapterKind: "pty"`, the code-derived PTY identity, the existing absolute deadline, and the initial output cursor
- **AND** the task text MUST NOT be added to metadata

#### Scenario: Excessive output

- **WHEN** adapter output exceeds a configured fixed cap
- **THEN** persistence and tool responses SHALL remain within the specified bounds
- **AND** the run SHALL record that output was truncated

#### Scenario: Startup adopts a validated PTY run

- **WHEN** startup loads non-terminal PTY metadata and finds an exact matching daemon session before its deadline
- **THEN** it SHALL adopt the session according to `PTY-backed runs are adoptable across Goblin restarts`
- **AND** it SHALL preserve the non-terminal record rather than marking it interrupted

#### Scenario: Startup cannot adopt stale run

- **WHEN** startup loads a non-terminal native record or PTY metadata without an exact valid daemon match
- **THEN** it SHALL atomically mark the run `interrupted`
- **AND** status inspection SHALL explain that the prior process was not resumed
- **AND** it MUST NOT rerun the task

#### Scenario: Event and result ordering is preserved

- **WHEN** an adapter emits a burst of output events followed immediately by a completion event
- **THEN** the runner SHALL persist all accepted events in order
- **AND** `status` SHALL NOT expose the `completed` state until the result is persisted
- **AND** a late event arriving after completion is stored only for diagnostics, not as a state change

#### Scenario: Task text is not intentionally persisted

- **WHEN** a run completes with a final result
- **THEN** `meta.json`, `events.jsonl`, and `result.txt` SHALL NOT intentionally contain the original task text
- **AND** `status` and `list` responses SHALL NOT include the task text
- **AND** any task text present in `events.jsonl` or `result.txt` is treated as a provider echo, not as a runner persistence guarantee
