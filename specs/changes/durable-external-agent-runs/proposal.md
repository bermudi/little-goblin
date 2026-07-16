# Durable External-Agent Runs

## Motivation

`ExternalAgentRunner` persists run metadata and output, but execution is intentionally non-resumable. A Goblin restart cancels every live external agent during graceful shutdown; after a crash, startup kills surviving `agent-pty` sessions and marks their records `interrupted`. This makes a service restart, deploy, or transient Goblin failure terminate long coding tasks even though the detached `agent-pty` daemon may still own a healthy process.

`agent-pty` already gives PTY children an ownership boundary independent of an individual client connection. Goblin can use that boundary honestly: persist enough identity, deadline, and output-cursor state to prove which PTY belongs to a run, detach from it during process shutdown, and reconcile it on startup. This provides continuity across Goblin restarts without pretending that a PTY can survive loss of its daemon or host.

The production systemd deployment also needs the `agent-pty` daemon in a service separate from `goblin.service`. A daemon lazily detached by a Goblin child still belongs to Goblin's systemd control group and is killed when that service restarts, defeating the durability boundary.

## Scope

### External-agents capability

- Make non-terminal PTY-backed external-agent runs adoptable after a Goblin restart when the same `agent-pty` daemon still owns the expected session.
- Persist a PTY session identity, absolute timeout deadline, and last consumed PTY output cursor in each PTY-backed run record. Continue to derive the PTY name from the run UUID and owner from the Goblin session UUID; do not persist the task.
- Extend `AgentPtyAdapter` with separate attach and detach behavior. Attach reconstructs a handle without spawning or resending the task; detach stops local observation without killing or removing the remote PTY.
- Reconcile persisted records against `agent-pty` session inventory at startup. Adopt only exact matches for session name, owner, backend executable, and canonical project directory. Mark missing or mismatched records `interrupted`, and kill/remove orphaned or conflicting `goblin-*` PTYs without adopting them.
- Restore adopted runs into the process-wide concurrency accounting. If restored runs meet or exceed the configured limit, reject or queue new work according to the existing limiter contract until slots are released; never kill valid adopted work merely because the limit was lowered.
- Restore each adopted run's original timeout deadline. An already-expired live PTY is killed and recorded as `timed_out`; restart does not grant a fresh timeout.
- Recover bounded PTY output generated while Goblin was offline through a monotonic daemon-owned output cursor. If the daemon's bounded replay buffer no longer contains the requested cursor, return the retained tail and explicitly mark output truncated.
- If a PTY exited while Goblin was offline, consume its remaining output and reconcile it to `completed` or `failed` from the daemon's recorded exit status before removing the PTY session.
- During process shutdown, cancel native child-process runs but detach valid PTY-backed runs so a subsequent Goblin process can adopt them. Explicit `/cancel`, session disposal (`/new`, `/resume`, `/archive`, `/project`), timeout, and ordinary terminal cleanup continue to kill/remove owned PTYs.

### agent-pty protocol

- Add bounded per-session raw-output replay with a monotonic cursor that remains valid across client disconnects for the lifetime of the daemon session.
- Add a validated `read-output` RPC returning bytes/text after a cursor, the new cursor, and an explicit truncation flag when older output has fallen out of the ring buffer.
- Include current lifecycle information in session inventory: running/exited state, exit timestamp, exit code or signal, immutable command/cwd/owner identity, and the latest output cursor.
- Preserve exited sessions until an explicit `remove`, allowing a restarted Goblin to collect terminal output and exit status.
- Keep owner metadata as same-user namespacing rather than authentication; adoption relies on the existing Unix-socket trust boundary and validates all returned fields.

### Orchestration and deployment

- Split process shutdown from session disposal. Goblin process shutdown invokes the external runner's detach-aware shutdown path; session disposal and cascade cancellation retain owner-scoped destructive cancellation.
- Ship and install an independently supervised `agent-pty` systemd service for deployments that enable PTY fallback. `goblin.service` starts after that companion service but restarting Goblin does not restart or stop it.
- Preflight durable PTY execution by verifying the installed protocol supports inventory lifecycle fields and cursor-based output replay, not merely that `list-sessions` returns successfully.
- Log reconciliation counts for adopted, expired, interrupted, and orphan-cleaned runs without logging task text or output.

## Non-Goals

- Native Codex JSON, Claude stream-JSON, and Devin ACP runs remain direct Goblin children and are not resumable. This change makes only runs that have actually switched to `adapterKind: "pty"` durable across Goblin restarts.
- No survival guarantee is made across `agent-pty` daemon crash/restart, machine reboot, kernel failure, or loss of the PTY master. Records whose daemon session disappeared become `interrupted` honestly.
- `agent-pty` does not become a generic job scheduler or service supervisor. There are no restart policies, cron jobs, arbitrary process tools, health checks, resource-control policy, or durable desired-state database.
- No raw PTY commands, cursor values, daemon session names, executable selection, cwd, or environment controls are exposed through the model-facing `external_agent` tool.
- No automatic retry or re-execution of a missing run. Re-running an editing task after an ambiguous failure could duplicate repository changes.
- No disk persistence of terminal output inside `agent-pty`. Its replay buffer survives client/Goblin disconnects only while the daemon remains alive; Goblin's existing bounded event store remains the durable record.
- No unsolicited completion turn or Telegram push. Goblin still learns run results through `external_agent(status)` or a later explicit scheduling capability.
- No change to explicit cancellation semantics or session ownership isolation.
