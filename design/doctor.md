# Doctor

For commands and interpretation, see
[Operations](../docs/operations.md#diagnostics-and-first-start-acceptance).

## Purpose and authority

Doctor is diagnosis, not repair. It does not provision credentials, resolve
arbitrary auth commands, modify application data, download, warm or unlock
wallets, start services, or call paid providers or MCP.

One exception is a bounded synthetic request to the associated,
operator-configured local embedding model. It may load or refresh model
caches, but does not retain a memory fact or override embedding keep-alive.
SQLite inspection can update shared-memory coordination sidecars; the
guarantee is no application-data mutation, not zero filesystem writes.

A successful diagnosis grants no installation, deployment or restart
authority.

## Target and phase policy

Doctor inspects the caller's selected home and executing checkout, not an
implicitly substituted production home. Installed and diagnostic checkout
identity may differ; that alone is a warning, not proof of breakage. The
running process's loaded settings and revision remain unverified.

Preflight is after dependency installation and operator provisioning, not a
claim that a pristine checkout is healthy. Expected first-boot absences
must not appear as successful checks. Inspection against the diagnostic
revision is not proof of installed schema compatibility or corruption.

## Checks and coverage

Unknown coverage must stay explicit, not green. In particular, metadata or
local readiness does not prove credential validity, bank permissions,
provider responses, frontend execution, running queues or end-to-end
delivery. A usable old key snapshot warns rather than expiring; a missing
or locked snapshot does not prove a running process lost its memoized key.

Embedding probes require an established association with the configured
local installation; do not probe an unrelated local model. Installed memory
unit drift is a warning, not proof of breakage or permission to replace
operator-edited units. Measured capacity is not a guarantee of future
durable writes.

Delegation checks target active projects, not Goblin's own workspace
(operator, 2026-11-19). Observer outage findings report durable declarations
without resetting them or probing the named thread.

The herdr-core check must not call its CLI: `server status` can start a
core (#739). Before first use or after a reboot, not installed or not
running is expected. A setup failure for the current binary pin matters;
a failure for a retired pin does not.

## Reports, failures and execution

Reports must not expose auth values or records, arbitrary command output,
config or environment dumps, credential-bearing URLs, raw external bodies
or unsafe error payloads. Diagnostics are safe summaries, not a channel for
secrets into agent context. JSON output and operational diagnostics remain
separate.

External work is bounded and cancellable. Cancellation must reclaim the
worker process group even if its leader has exited.

## Verification and deferred work

Source-pinned or synthetic checks do not prove a real installation ready.
Doctor complements deployment acceptance; neither proves future provider
access or delivery. Independent scheduling and notification are deferred:
the bot's own credentials can fail, so it cannot be the only alarm.

## Precedents

OpenClaw's read-only lint and Hermes's read-only SQLite inspection informed
the design. Their migration behavior and paid default probes were not
adopted.
