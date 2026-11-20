# Deployment

For rollout and recovery commands, see [Operations](../docs/operations.md).

## Purpose and authority

Running the rollout is the operator's authorization to restart Goblin. It
does not authorize unit installation, memory-stack deployment or pushing
Git refs. Diagnosis grants no deployment or repair authority.

## The model

The service runs an immutable release of a tracked commit, including the
client, rather than the development checkout. A client change therefore
requires a release and restart. This deliberately trades restart-free client
iteration for eliminating independently deployed client/backend skew.
Offline clients can still serve an older cached shell.

The rollout waits for idle before flipping the release. A turn arriving
between the last idle check and restart can still be fenced by shutdown;
the wait narrows the race but cannot eliminate it.

## Invariants

Only complete releases become addressable. The running process and the
`live` link can temporarily disagree after a flip and before restart; status
must expose that condition. Release retention is an operator decision.

## Config across releases (2026-11-16)

Config belongs to the home, not the release. The rollout snapshots and
restores release-specific config because older strict schemas can reject
newer settings (#645). Differing current settings are preserved before
restoration. An older release without a snapshot requires manual recovery
from the operator's backups.

## What the gate still buys

The release is checked before the flip and the new invocation is checked
after restart. The test suite gates merges in CI, not rollouts.

**There is no automatic rollback.** Failed acceptance leaves the selected
release in place and exits nonzero; the operator decides whether to roll
back. This keeps the running revision and the failure visible.
