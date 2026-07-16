# PTY Run Adoption

## Status

proposed

## Context

Decision 0013 made every external-agent run non-resumable because a new Goblin process could not prove ownership of an old native child from a PID or PTY name alone. The external-agent runner subsequently established stronger PTY identity: each fallback session has a run-derived name, a session-derived owner, a code-owned backend command, and a canonical project directory, all held by a same-user daemon reached through a protected Unix socket.

The `agent-pty` daemon is already independent of individual client connections. If it also exposes immutable session identity, lifecycle state, and bounded cursor-based output replay, Goblin can prove that a persisted PTY record and daemon session describe the same delegated task without adopting an arbitrary OS PID. Native child processes still lack this ownership seam.

## Decision

Goblin SHALL adopt a non-terminal PTY-backed external-agent run after process restart only when the same live `agent-pty` daemon reports an exact match for the persisted run-derived session name, owner-derived namespace, code-owned backend executable, and canonical project directory. The record SHALL also contain its original absolute timeout deadline and output cursor. Missing, legacy, expired, or mismatched records MUST NOT be guessed or re-executed.

Goblin process shutdown SHALL detach valid PTY-backed runs while explicit cancellation, timeout, and Goblin session disposal remain destructive. Native external-agent runs remain non-resumable and SHALL be cancelled or marked interrupted. The daemon itself SHALL run in a systemd service independent of `goblin.service`; daemon or host loss remains a hard interruption boundary.

This decision narrows the blanket non-resumability clause in decision 0013 for validated `adapterKind: "pty"` runs only. Decision 0013 continues to govern storage bounds, native runs, and PTY records that cannot satisfy this proof.

## Consequences

- Easier: routine Goblin deploys and process crashes no longer discard healthy interactive coding work.
- Easier: reconciliation is based on stable daemon-owned identity instead of unsafe PID adoption.
- Harder: Goblin must distinguish detach from cancel, persist deadlines/cursors, restore concurrency accounting, and reconcile startup races.
- Harder: `agent-pty` must retain bounded output and exited-session state until explicit removal.
- Constraint: restarting `agent-pty` or rebooting the host still interrupts every PTY run; no recovery claim extends across that boundary.
