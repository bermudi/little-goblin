# Durable External-Agent Runs — Design

## Architecture

### Durability boundary

The design uses two stores with different jobs:

```text
Goblin process                                      agent-pty service
┌──────────────────────────────┐                   ┌──────────────────────────┐
│ ExternalAgentRunner          │  JSON RPC/socket  │ Daemon                   │
│  ├─ persisted run metadata   │──────────────────▶│  ├─ live PTY handles     │
│  ├─ events/result on disk    │◀──────────────────│  ├─ exit state           │
│  └─ local observer handles   │                   │  └─ bounded output rings │
└──────────────────────────────┘                   └──────────────────────────┘
       survives Goblin restart                           survives clients
```

Goblin's `ExternalRunStore` remains authoritative for task-level identity, ownership, status, deadline, and model-visible output. The daemon remains authoritative for whether a PTY process exists, its immutable launch identity, its exit state, and output not yet consumed by Goblin. Startup reconciliation joins those records by derived identity; neither side alone is sufficient to claim an adoptable run.

This implements `PTY-backed runs are adoptable across Goblin restarts` without adopting OS PIDs. It follows decision 0019 and narrows decision 0013 only for validated PTY records. The daemon and its buffers remain in-memory: losing `agent-pty` is an explicit interruption boundary.

### agent-pty protocol additions

`packages/core/src/protocol.ts` gains two commands and richer list entries:

```ts
type CapabilitiesCommand = { id?: string | number; cmd: "capabilities" };
type CapabilitiesResponse = {
  id?: string | number;
  ok: true;
  cmd: "capabilities";
  protocolVersion: 2;
  features: ("cursor-output" | "lifecycle-inventory")[];
};

type ReadOutputCommand = {
  id?: string | number;
  cmd: "read-output";
  name: string;
  after?: number;
  maxBytes?: number;
};

type ReadOutputResponse = {
  id?: string | number;
  ok: true;
  cmd: "read-output";
  chunks: { cursor: number; text: string }[];
  nextCursor: number;
  latestCursor: number;
  hasMore: boolean;
  truncated: boolean;
};
```

The daemon clamps `maxBytes` to 64 KiB and defaults it to 32 KiB. A chunk larger than the response bound is split at UTF-8-safe boundaries when captured, so `read-output` never has to return a partial stored chunk. Cursor zero means "before the first chunk". An omitted `after` has the same meaning. Cursors are opaque safe integers incremented once per stored chunk; clients compare/order them but do not derive byte positions from them.

Each `Session` appends `onData` text to both the existing terminal bridge and an `OutputRing`. The ring drops oldest complete chunks until its UTF-8 size is at most 2 MiB and remembers the greatest dropped cursor. A request older than that boundary starts at the oldest retained chunk and returns `truncated: true`. Exited sessions and their rings remain in the daemon map until `remove`; existing daemon shutdown still kills children and loses the map.

`SessionListEntry` adds:

```ts
{
  state: "running" | "exited";
  exitedAt?: string;
  exitCode?: number;
  signal?: number;
  latestOutputCursor: number;
}
```

The existing `name`, `command`, `cwd`, `pid`, `createdAt`, `killedAt`, and `owner` fields remain compatible. `Session` records `exitedAt` in the same `onExit` callback that records `exitInfo`. `capabilities` is side-effect free and discloses no session data; preflight uses it instead of creating a probe PTY.

### Persisted PTY checkpoint

`ExternalAgentRunRecord` gains optional migration-safe fields:

```ts
interface ExternalAgentRunRecord {
  // existing fields
  deadlineAt?: string;
  ptySessionName?: string;
  ptyOutputCursor?: number;
}
```

`deadlineAt` is assigned when execution first starts and is not reset during fallback or adoption. `ptySessionName` is assigned from `goblin-${run.id}` before PTY spawn. Owner, backend executable, and canonical cwd are derived from existing trusted metadata rather than copied as additional mutable strings. `ptyOutputCursor` begins at zero.

The fields stay optional in store validation so terminal records written by the previous release remain inspectable. A non-terminal PTY record missing any adoption field is legacy and follows the explicit interrupt-and-clean path. Timestamps are parsed and validated before use; malformed deadlines are non-adoptable rather than treated as unlimited.

Output checkpoints use an at-least-once ordering that avoids silent loss:

1. `AgentPtyHandle` drains one or more `read-output` pages after the persisted cursor.
2. It requests bounded rendered scrollback/snapshot text when output changed, strips no data from the daemon ring, and emits a normalized output event carrying the page's final cursor as an internal optional `sourceCursor` field.
3. `ExternalRunStore` appends that event to `events.jsonl`.
4. Only after append succeeds does the runner update `meta.ptyOutputCursor` and atomically save `meta.json`.

If Goblin dies between steps 3 and 4, startup derives the effective cursor as the maximum of metadata and the newest retained event `sourceCursor`, preventing an already-persisted page from being intentionally duplicated. If history was later trimmed, the corresponding metadata checkpoint was already saved in the normal path. Cursor fields remain internal and are omitted from `external_agent(status)` formatting.

The raw ring is the change/replay signal; model-visible output continues to come from bounded terminal rendering so ANSI control sequences and cursor movement do not leak into results. Prompt detection continues to inspect the latest rendered screen. A replay truncation emits the existing normalized `truncation` event and sets `eventsTruncated`/`resultTruncated` as appropriate.

### Attach, detach, cancel

`ExternalAgentHandle` gains an optional `detach(): Promise<void>` operation. `AgentPtyAdapter.attach(input)` validates no model input; it receives a trusted persisted record plus already-validated inventory entry and constructs `AgentPtyHandle` for the derived session name without calling `spawn` or `type`.

`AgentPtyHandle` separates a local observation abort controller from remote cancellation:

- `detach()` marks the handle detached and aborts in-flight `read-output`, `snapshot`, or `wait-for-exit` RPC calls. It never sends `kill` or `remove`.
- `cancel()` first stops observation, then sends bounded best-effort `kill` and `remove` RPCs as today.
- `waitForExit()` treats local detach as a typed internal `DetachedError`, not a process failure.

`ExternalAgentRunner` adds `shutdown(): Promise<void>` for process shutdown while retaining `cancelBySession()` for session lifecycle. `shutdown()` rejects new starts, cancels native runs, and detaches PTY runs. A per-run `detaching` flag makes `executeRun` consume `DetachedError` without a terminal transition and skip its current unconditional final cancellation. PTY startup is a race: shutdown waits a bounded five seconds for an in-flight PTY `start()` to return a handle, then detaches it. If startup cannot resolve safely within the bound, the runner cancels that run rather than leaving an untracked ambiguous child; a hard Goblin crash is handled later by startup reconciliation.

Explicit `/cancel`, timeout, `cancelBySession`, and adapter terminal cleanup do not call the detach-only path. This keeps `External-agent runs follow Goblin session lifecycle` behavior sharp: process shutdown preserves, owner/session disposal destroys.

### Startup reconciliation

`ExternalAgentRunner.init()` performs reconciliation before Telegram polling or new starts:

1. Load valid run records and clean expired terminal directories.
2. If PTY fallback is enabled, fetch `capabilities` and one full session inventory. Index daemon sessions by name.
3. Mark every non-terminal native record `interrupted`; native handles cannot be adopted.
4. For each non-terminal PTY record:
   - require valid `deadlineAt`, `ptySessionName`, and `ptyOutputCursor`;
   - derive expected name, owner, backend executable, and canonical cwd;
   - require exact equality with one inventory entry;
   - on missing/legacy/mismatch, mark `interrupted` and clean only the derived conflicting Goblin PTY when present;
   - if running at/after its deadline, kill/remove and mark `timed_out`;
   - if exited, drain retained output, choose terminal state from exit status when `exitedAt <= deadlineAt` or `timed_out` otherwise, persist, then remove;
   - if live and unexpired, attach a handle, restore its remaining timeout, and start its observer promise.
5. Remove daemon sessions in the reserved `goblin-<UUID>` namespace that have no corresponding non-terminal record. Other owners/namespaces remain untouched.
6. Restore concurrency accounting for every adopted observer before accepting starts.
7. Emit one structured summary log with counts for adopted, completed-on-recovery, failed-on-recovery, expired, interrupted, and orphan-cleaned. It contains no task or terminal output.

The concurrency limiter gains `restore(count)`. Restored active count may exceed `maxConcurrent` after configuration is lowered. Acquisition remains blocked while `active >= max`; each terminal observer releases once, and no adopted run is killed merely to enforce the new cap. Existing start cancellation and queue behavior remain unchanged.

### Process supervision and deployment

`scripts/agent-pty.service` runs the existing foreground CLI command:

```ini
[Unit]
Description=agent-pty daemon for Little Goblin
After=local-fs.target

[Service]
Type=simple
User=goblin
Group=goblin
Environment="HOME=/var/lib/goblin"
ExecStart=/usr/local/bin/agent-pty daemon
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

When PTY fallback is enabled, `install-service.sh` installs/enables this unit and installs `/etc/systemd/system/goblin.service.d/agent-pty.conf` containing `Wants=agent-pty.service` and `After=agent-pty.service`. It deliberately does not use `PartOf`, `BindsTo`, or `Requires`, so stopping/restarting Goblin does not propagate to the daemon and a daemon failure does not stop Telegram. The daemon's own restart cannot recover existing PTYs; Goblin's next RPC failure/startup reconciliation reports those runs honestly.

`src/validate-config.ts` gains a non-secret `--deployment-json` output containing only `{ "ptyFallback": boolean }`. The root installer invokes it as the Goblin user with the production `GOBLIN_HOME`; shell code does not parse JSON5 itself. Disabled installs remove a stale Goblin drop-in created by this feature but do not stop or delete a separately running daemon without operator action. Enabled installs require `/usr/local/bin/agent-pty` and fail with an actionable error rather than downloading an unpinned external repository.

`update.sh` restarts only `goblin.service`; it does not restart `agent-pty.service`. Updating the separate agent-pty installation remains an operator action and may interrupt PTYs, consistent with the declared daemon boundary.

## Decisions

### D1: Durability applies only to PTY-backed runs

**Chosen:** Adopt only runs with `adapterKind: "pty"`; native processes remain non-resumable.

**Why:** The daemon has stable ownership and a reconnectable protocol. Native adapters hold direct pipes and process-group handles inside the old Goblin process. PID adoption or automatic task retry cannot prove identity and may duplicate repository edits.

**Constraint:** Most successful structured runs remain non-durable because PTY is currently a safe-startup fallback, not the primary adapter. The tool must not imply otherwise.

### D2: Reconcile persisted intent against daemon-owned fact

**Chosen:** Require exact record/inventory identity and derive expected values from trusted metadata.

**Why:** A PTY name alone is too weak. Name + owner + code-owned executable + canonical cwd under the same-user socket boundary is sufficient for this single-user deployment without adopting arbitrary processes.

**Constraint:** Owner is namespacing, not authentication. Another same-user process with socket access remains inside the existing trust boundary.

### D3: Cursor replay is bounded and in memory

**Chosen:** Add a 2 MiB per-session chunk ring and cursor RPC to agent-pty; keep durable output in Goblin's existing store.

**Why:** Cursor replay closes the client-disconnect gap without turning agent-pty into a database or duplicating Goblin's retention model. Complete chunks make pagination deterministic.

**Constraint:** Daemon loss loses unread output. Goblin reports truncation/interruption instead of promising host-level durability.

### D4: Checkpoint output at least once, never silently skip it

**Chosen:** Append the event before advancing metadata and recover effective cursors from event tails.

**Why:** Atomic commit across `events.jsonl` and `meta.json` is unavailable. Advancing first can permanently lose model-visible output; append-first limits the failure mode to detectable/recoverable duplication.

**Constraint:** Internal output events gain source-cursor metadata, but the model-facing tool does not expose daemon cursors.

### D5: Detach is a distinct lifecycle operation

**Chosen:** Add handle detach and runner process shutdown rather than overloading cancel/dispose with flags.

**Why:** Cancellation changes durable task state and kills remote work; detach changes only local observation ownership. A boolean `cancel({ preserve: true })` would make destructive call sites easy to misuse.

**Constraint:** Shutdown/startup races need explicit tests, especially a PTY spawned immediately before SIGTERM.

### D6: Absolute deadlines survive restart

**Chosen:** Persist one `deadlineAt` and restore only its remaining duration.

**Why:** Restarting a relative timer silently extends configured resource limits. Exit timestamps also make timeout-vs-completion reconciliation deterministic while Goblin was offline.

**Constraint:** Legacy records without a valid deadline are not adoptable.

### D7: systemd supervises the daemon independently

**Chosen:** A separate `agent-pty.service` plus a one-way Goblin ordering drop-in.

**Why:** A detached subprocess still remains in `goblin.service`'s cgroup and is killed by a normal service restart. systemd already owns host process supervision and journaling; recreating restart policy in Goblin or agent-pty would be a shallow supervisor.

**Constraint:** The operator must install a compatible executable at `/usr/local/bin/agent-pty`. Restarting the daemon interrupts runs by design.

### D8: Capability negotiation is explicit

**Chosen:** Add a side-effect-free `capabilities` RPC and require protocol version 2 features before reconciliation.

**Why:** Testing support by sending unknown commands or creating a PTY mutates daemon state and produces ambiguous errors. Explicit negotiation fails early and cleanly.

**Constraint:** Protocol additions remain backward-compatible for old clients, but durable Goblin requires the new daemon.

## File Changes

### agent-pty repository

- `packages/core/src/protocol.ts` — add validated `capabilities` and `read-output` command/response unions; enrich `SessionListEntry` lifecycle fields. Implements `agent-pty replays bounded output by cursor`.
- `packages/core/src/session.ts` — add the bounded output ring, monotonic chunk cursors, `exitedAt`, and read pagination while preserving terminal rendering. Implements output replay and exited-session inspection.
- `packages/core/src/daemon.ts` — serve capabilities/read-output, return lifecycle-rich inventory, and retain exited sessions until remove. Implements cursor replay and adoption inventory.
- `packages/core/src/index.ts` — export the new protocol types without changing existing callers.
- `packages/cli/src/index.ts` — include the new commands in CLI/rpc dispatch and keep `agent-pty daemon` foreground-compatible with systemd.
- `packages/core/test/unit/protocol.test.ts` — validate new command bounds, unknown fields, capability response, cursors, and malformed lifecycle responses.
- `packages/core/test/integration/sessions.test.ts` — cover ordered replay, pagination, UTF-8 bounds, truncation, exited retention, and remove.
- `packages/core/test/integration/cli.test.ts` — cover `rpc` capability/read-output round trips and one-response stdout.
- `packages/core/test/integration/lifecycle.test.ts` — prove client disconnect does not lose sessions/output and daemon shutdown remains destructive.
- `README.md` and `MANUAL.md` — document protocol version 2, replay limits, exited retention, and the daemon durability boundary.

### little-goblin repository

- `src/external-agents/types.ts` — add optional persisted deadline/session/cursor fields, internal source cursor, detachable handle shape, and typed detach signal. Supports persisted checkpoints and lifecycle separation.
- `src/external-agents/store.ts` — validate migration-safe fields and read the newest retained PTY source cursor for crash-safe checkpoint recovery. Implements `external run records are bounded and persisted`.
- `src/external-agents/agent-pty.ts` — add capability/inventory/read-output RPC types, attach, detach, cursor draining, rendered-output recovery, and exact session validation helpers. Implements both external-agent durability requirements.
- `src/external-agents/runner.ts` — persist absolute deadlines, reconcile native/PTY/orphan records, restore concurrency, observe adopted handles, and add detach-aware process shutdown. Implements `PTY-backed runs are adoptable across Goblin restarts`.
- `src/external-agents/preflight.ts` — require protocol version 2 capability names when PTY fallback is enabled. Implements modified executable preflight.
- `src/external-agents/store.test.ts` — cover old terminal metadata, legacy non-terminal PTY handling, new field validation, and source-cursor recovery.
- `src/external-agents/agent-pty.test.ts` — cover attach without spawn/type, detach without kill/remove, paginated replay, truncation, prompt inspection, and exited output recovery.
- `src/external-agents/runner.test.ts` — cover exact adoption, mismatches, orphans, daemon loss, deadline/exit ordering, over-limit restoration, shutdown races, and destructive session cancellation.
- `src/external-agents/preflight.test.ts` — cover missing, old, malformed, and compatible agent-pty protocols.
- `src/index.ts` — call detach-aware external shutdown while retaining independent guarded shutdown steps. Implements modified orchestration lifecycle.
- `src/validate-config.ts` and `src/validate-config.test.ts` — expose/test non-secret `--deployment-json` for service installation.
- `scripts/agent-pty.service` — add the independently supervised companion daemon unit.
- `scripts/install-service.sh` — conditionally install/enable the companion and Goblin ordering drop-in from validated deployment config; remove stale feature-owned drop-in when disabled.
- `scripts/install.sh` — pass production config context into conditional service installation and preserve the daemon across Goblin updates.
- `scripts/update.sh` — run compatible preflight before restarting Goblin and explicitly leave `agent-pty.service` untouched.
- `scripts/goblin.service` — retain the base service without a hard agent-pty dependency; conditional ordering lives in the installer-owned drop-in.
- deployment/script tests following existing shell-test conventions, or focused command-fixture tests if no shell harness exists — verify enabled/disabled unit installation and no restart propagation.
- `specs/glossary.md` — add `adopted external-agent run` as the validated PTY run reconstructed by a new Goblin process, distinct from retry/re-execution.
- `specs/decisions/0019-pty-run-adoption.md` — record the validated PTY exception to decision 0013's non-resumable lifecycle.
