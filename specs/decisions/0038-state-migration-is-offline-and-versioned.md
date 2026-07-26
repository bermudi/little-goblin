# State Migration Is Offline And Versioned

## Status

accepted

## Context

Seven active stabilization changes each specify their own on-disk migration, and each independently demands crash-restart safety:

- `telegram-surface-identity` — `bindings.json`, `topic-settings.json`, and schedule locators to SurfaceId keys; requires migration that can "accept mixed-generation input, and remain idempotent after an interrupted migration".
- `immutable-project-environments` — promotes `scratch/workdir` contents into `workspace` with a "restart-safe manifest and collision refusal", then assigns environments to every legacy session.
- `pi-native-skill-layout` — moves `workspace/skills/` to `$GOBLIN_HOME/.agents/skills/`, ordered inside `ensureGoblinHome()` so destination creation cannot mask legacy state.
- `conversation-lifecycle` — splits Conversation/Surface ownership, converts schedule ownership and heartbeat prompts; requires "idempotent canonical/mixed-generation reruns after any per-file write boundary".
- `transcript-surface-provenance` — rewrites transcript files with `sourceSurfaceId`, adds a nullable memory-index column, and invalidates guessed index rows; requires "idempotent recovery at every boundary".
- `delegated-work-ownership` — rewrites external-agent and subagent records with owner/origin/environment fields.
- `inner-life` — reconciles interrupted wake and effect records.

`ARCHITECTURE.md` sequences these into a fourteen-step startup order. That ordering is a shared mutable global: seven independently authored changes each assert their own position in it, and no single module owns the invariant. Each also carries the most expensive-to-test code in the plan — interrupted-write fixtures, mixed-generation fixtures, partial-restart convergence tests — written seven times.

The demand for restart safety comes from labelling all of this "startup work". It conflates two different things:

- **Migration** — a one-time transformation of persisted data from an old format to a new one. It runs once in the lifetime of a deployment and then never again.
- **Reconciliation** — recovery of in-flight operational state after an unclean stop: interrupted inner-life wakes, durable delegated runs, pending completion deliveries, replayable project-assignment intent. This runs on every boot, forever.

Reconciliation genuinely must be crash-safe, because a crash is its normal input. Migration does not, because Goblin is a single-user, single-process homelab service with exactly one deployment, a systemd unit, an existing `scripts/backup.sh`, and an existing `scripts/update.sh` that already stops for `bun install` and `validate-config`. The process can simply be stopped.

Alternatives considered. Keeping per-change restart-safe startup migration preserves the current specs but pays the full testing cost seven times and leaves the startup order unowned. A single startup migration registry fixes the ownership problem but retains crash-safety obligations that a stoppable single-tenant service does not need. Neither justifies its cost against an operator who can run one command with the bot stopped.

## Decision

`$GOBLIN_HOME/state/` SHALL carry a single monotonic `stateVersion`, persisted in one canonical location and owned by one migration module.

Migrations SHALL be an ordered, append-only list of steps in that module, each mapping exactly one version to its successor. A change that alters persisted layout adds a step; it MUST NOT wire its own migration into `src/index.ts`, and it MUST NOT define its own position in a global startup order.

Migrations SHALL run offline through an explicit `bun run migrate` command with the service stopped, and SHALL NOT run implicitly at startup. The command SHALL take a backup before its first mutation, compute and validate every transformation before writing, fail loudly on ambiguity without selecting a winner, and abort the whole run on any failure.

Startup SHALL read `stateVersion` and refuse to begin polling when it does not equal the version the running code requires, naming the required version and the `bun run migrate` remedy. `scripts/update.sh` SHALL stop the service, back up, migrate, and restart.

Migrations SHALL NOT be required to be idempotent, restart-safe, mixed-generation tolerant, or rerunnable after a partial write. Recovery from a failed migration is restoration from the backup taken by the same command.

**Reconciliation is not migration and is not covered by this decision.** Per-boot recovery of interrupted inner-life wakes, durable delegated runs, pending completion deliveries, and replayable project-assignment intent SHALL remain at startup, remain fail-before-polling, and remain crash-safe. Each such reconciler SHALL be named as reconciliation, never as migration, and SHALL operate only on current-version data.

The memory SQLite schema retains its own in-process versioned migration in `src/memory/db.ts`, governed by decisions 0015 and 0020. It is a database schema, not the `state/` filesystem layout.

## Consequences

Seven bespoke restart-safe migrations collapse into one ordered list behind one version counter, and the fourteen-step startup order loses its migration steps entirely. The interrupted-write, mixed-generation, and partial-restart-convergence requirements are removed from `immutable-project-environments`, `pi-native-skill-layout`, `conversation-lifecycle`, `transcript-surface-provenance`, and `delegated-work-ownership`; each keeps its compute-before-write and refuse-on-ambiguity requirements, which are about correctness rather than crash recovery. Those five remaining changes need a patch to strip the restart-safety language before they are built.

Migration correctness becomes far easier to test: a fixture directory in, a fixture directory out, no interruption matrix.

The cost is operator discipline. An operator who pulls new code and restarts without migrating gets a service that refuses to poll rather than one that silently self-heals. That is the intended trade: a homelab assistant that will not start is a better failure than one that quietly half-migrates a transcript history. `scripts/update.sh` must be updated in the same change that introduces the version gate, or the first version bump will strand the deployment.

A future second deployment, a multi-tenant Goblin, or an inability to stop the process would invalidate this decision.
