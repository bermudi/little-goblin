# Doctor — proposed design

**Approved for source implementation.** Standing monitoring, live unit
installation, client publication, service restarts and deployment still
require separate operator approval.
Coordinate with the onboarding proposal in `design/setup.md` on
`feat/onboarding`; neither branch should independently change shared helpers.

## Goal and boundary

Give the operator and Goblin one bounded, non-interactive diagnostic pass
that identifies decay before the next task encounters it. Onboarding asks
what is missing before installation; doctor asks what is broken after it.
Reuse detection, not setup actions.

`bun run doctor [--json] [--strict] [--phase preflight|installed]` is the
proposed CLI, defaulting to `installed`. `preflight` is start-ready
inspection after dependency sync and explicit operator provisioning:
expected boot-created layout/database, not-yet-installed units and
not-yet-built assets are skipped, not failures. It is not an untouched
checkout's "everything is healthy" mode. The installer supplies
`GOBLIN_HOME` and invokes the command from its explicit checkout. After
building, it uses shared asset detection before enable/start.

Goblin consumes it through the existing bash tool and a workspace launcher;
no new native tool, Telegram command, channel, or scheduler is needed.
The launcher belongs to installation/bootstrap, never to doctor itself.

Diagnosis is read-only with respect to application state: no scaffolding,
config writes, schema creation, migrations, checkpoints, repair, warming,
unlocking, downloads, service starts/restarts, or memory retention. A
synthetic local embedding request is diagnostic computation, not a durable
memory write. Provider generation and MCP calls are outside the first patch.

## Shared checks and ownership

The coordinating doctor session is the proposed integration owner:
shared safe parser fixes in `src/auth.ts` / `src/config.ts`, the diagnostic
contract/module/CLI, package script and eventual core design ruling.
The onboarding session owns `scripts/install.sh`, prerequisite guidance,
installation order, scaffolding/launcher wiring and first-boot actions.
Agree shared-helper edits before either branch changes them; land shared
checks before the installer consumer. Install/deploy callers must not
parse human CLI output.

Keep the initial seam small: flat functions and types, not a registry,
plugin framework, or separate health service. Proposed files are
`src/health.ts` / `src/health.test.ts` for shared detection and
`src/doctor.ts` / `src/doctor.test.ts` for command orchestration/rendering.
The onboarding audit establishes the installer as a concrete consumer.
This is a recommended split pending approval, not a framework for
hypothetical reuse.

Caller policy must distinguish prerequisites, pre-install state and an
installed system. A database absent before first boot is not corruption;
an enabled feature's missing installation is not the same as a disabled
feature. Do not make an installer require a running service before it can
install that service.

| Check | Initial doctor expectation | Onboarding reuse |
| --- | --- | --- |
| Config | Parse with existing schema; validate configured provider/model references locally | Prepared configuration before enable/start |
| Workspace | Required files/directories readable; optional prompt files explicitly classified | Distinguish seedable paths from prerequisites |
| Auth metadata | File permissions/shape, referenced record presence, prohibited direct owner-session commands; never resolve arbitrary refs | Gate credentials configuration before enable |
| Snapshots | Required pass-keys profiles available; age and refresh service/timer state | Explain/provision missing snapshots explicitly |
| SQLite | Existing database readable, expected tables compatible, bounded integrity inspection | Post-boot validation only |
| Storage | Free bytes/inodes on relevant local filesystems | Capacity before installing/starting |
| Memory | Configured API readiness, local container health when applicable | Optional stack prerequisites and post-install readiness |
| Embeddings | Actual synthetic embed through the configured local relay | Validate the installed local embedding path |
| Installation | Service state and WorkingDirectory, client assets, launcher target | Post-install verification |

The default target is explicitly the caller's home (`GOBLIN_HOME`, else
`~/goblin`) and diagnostic checkout/revision. Never silently redirect checks
to production because a user unit happens to exist. Record these paths and
revision in the report; each finding names its scope.

Systemd `WorkingDirectory` supplies a separate installed-checkout identity.
Inspect client assets under that checkout when it is known; label these
results separately from caller-home checks. If the installed and diagnostic
checkouts/revisions differ or cannot be matched, warn that installed
compatibility is unverified. Schema expectations belong to the diagnostic
revision, not to an inferred live revision. Do not dump service environments
to guess its home. A deployment caller must explicitly supply/verify its
target context before reusing checks.

Schema compatibility checks required structures, not exact schema equality.
With differing revisions, a missing required structure fails compatibility
with the diagnostic revision; it is not labeled installed corruption.
Installed-schema compatibility stays unverified until target identity is
established. Preflight never requires a newly added table/column before boot
has performed the existing initialization.

Do not assume a successful disk/config check proves the running process
loaded that config. Boot-memoized credentials, provider validity and live
queues cannot be inferred from a separate process. The report describes
inspected coverage, not an end-to-end guarantee that Goblin can answer.

## Result and output contract

One typed report drives text and JSON. Each check has a stable ID,
`pass | warn | fail | skip`, duration, safe evidence and an optional
manual next step. Include a report version, observation time, target scope,
coverage and summary counts. Results remain deterministically ordered
even when probes run concurrently.

- Disabled features are skipped, with a reason.
- Configured dependency outages fail by default.
- Unavailable prerequisite checks block dependents; dependent skips name
  the blocker, while the prerequisite failure determines the exit code.
- Usable but stale snapshots warn; age is not an expiry gate. Locked
  wallets fail for fresh resolution, without claiming the running bot has
  already lost its memoized credentials.
- Unknown inspection coverage is explicit, not a green check.
- Filesystem errors retain path/operation/errno; non-ENOENT is never
  relabeled "missing".

Exit codes: `0` means no failures; `1` means failures (or warnings with
`--strict`); `2` means invalid invocation or inability to produce a report.
Text and JSON use identical semantics. JSON stdout is exactly one report,
not mixed with logs. Operational diagnostics go to stderr. This requires
a deliberate exception to ordinary stdout logging, recorded in the core
design before implementation; do not globally change runtime logging.

Output is suitable for model context. Do not echo auth records, command
strings, credential values, config dumps, credential-bearing URLs, raw
external bodies, arbitrary subprocess output, or validation exceptions
that include original input. Construct safe errors at each boundary:
check ID, operation, errno/HTTP status, failure category and remedy.
Human shell commands in remedies do not contain secrets.

## Execution and unresolved feasibility

Local operational probes are proposed to run by default. No paid model
calls or broad provider connectivity survey. External subprocesses are
non-interactive, argv-based where possible, with bounded captured output.
Each probe gets an actual deadline and cancellation; the command has an
overall watchdog covering blocking reads/SQLite and subprocess cleanup.
Proposed overall budget: 45 seconds, embedding probe at most 15 seconds.
Timeouts are recorded by the runner, not guessed from exit 143 or strings.

Before implementation, verify these interfaces without importing live
secret values into agent context:

1. Pin the real `pass-keys status` contract; source currently reports only
   availability, age and key names, but has no structured JSON interface.
   Do not invent output shapes or execute `get` to test health.
2. Determine the relay address/model from the installed configuration
   through a narrow validated internal read, not a hardcoded g7 address,
   environment dump, or arbitrary sourcing of an env file. Remote memory
   installations must report local embedding inspection as unsupported,
   not probe the caller's unrelated Ollama. First establish that the
   configured Hindsight API belongs to the local installation, then compare
   allowlisted embedding provider/base-URL/model fields with relay settings.
   Relay-file presence alone is not sufficient association.

   Hindsight readiness, embeddings and application access are separate
   findings. `/health/ready` does not establish Bearer credentials or bank
   access. Without an approved safe credential mechanism, label those
   application checks unverified rather than execute arbitrary auth refs
   or report overall memory health as passed.
3. Use read-only SQLite handles that include uncheckpointed WAL rows
   without initializing or migrating application data. Do not use
   `immutable` to ignore WAL, nor copy only the main database. Handle schema
   mismatch and contention with explicit findings; close handles on every
   path. A local Bun experiment verified WAL visibility and unchanged main
   DB/WAL bytes, but also showed that opening a DB+WAL fixture without SHM
   creates a `-shm` file. SQLite read-only is not a zero-filesystem-writes
   guarantee. If that stronger requirement is chosen, skip the live scan
   until a safe inspection method exists; do not promise it from the SQL
   flag alone.
4. Establish which memory-volume filesystems can be safely discovered
   with narrowly formatted Podman metadata. Otherwise report the missing
   storage coverage. `$GOBLIN_HOME` alone does not cover PostgreSQL.
5. Audit imports/output: ordinary config/auth helpers may log or attach
   unsafe parser details. Reuse validation rules without inheriting their
   stdout or error-message behavior. `parseConfig` is the inert validation
   seam; `resolveModel` resolves auth/constructs providers and is not.
   Preserve the install gate's prohibition of direct owner-session commands
   across all records; effective reference presence still follows runtime
   last-wins semantics. Do not silently weaken installation's stricter lint.

Initial threshold recommendations: warn after 24 hours since successful
snapshot refresh (the existing timer runs twice daily); disk warning below
5 GiB and failure below 1 GiB; inode warning below 10% and failure below 1%.
These are proposal defaults, not newly imposed operational policy.
Capacity checks do not prove a future write/fsync will succeed.

## Delivery plan and verification

1. Agree with onboarding on the shared result contract, check ownership,
   phase-dependent expectations and integration-file ownership.
2. Fix safe config/auth-parser errors at their shared origin as a security
   prerequisite, with operator-approved implementation and synthetic
   sentinel tests covering runtime/installer/doctor output. A disposable
   reproduction showed that an unquoted fake value is echoed by Bun's
   native JSON error, which `parseAuthFile` currently forwards. Do not
   retain that unsafe message as an error cause. No live secret was read.
3. Implement local detection and the text/JSON command, then keys/memory/
   embedding probes. Add the package script with the approved package
   tooling; do not hand-edit dependency manifests.
4. Onboarding consumes preflight/shared asset checks, adds bounded local
   startup acceptance, and exposes the workspace launcher through setup.
   Document invocation and manual remedies in `docs/operations.md`.
5. Only after the CLI is trustworthy, propose reuse in
   `scripts/deploy.sh` and independent unattended checking separately.

Installer-owned first-boot acceptance is bounded and invocation-specific:
record the attempted start boundary and systemd invocation/restart
identity, require boot-complete and `long polling started` evidence from
that invocation, and request actual loopback `/app/` HTML/assets. Read
only the needed safe log fields; do not print arbitrary journal bodies.
Today's two startup signals are info-level and can be suppressed.
Recommend making just those known, safe lifecycle events unfiltered through
the existing log sink before the installer depends on them. The coordinating
doctor session owns this small shared readiness correction and its tests
(`src/log.ts`, `src/index.ts`, `src/tg/mod.ts`); no new public endpoint,
readiness file, or configurable-log-level restriction is needed.
Restart, polling failure, bind failure or deadline expiry prevents an
acceptance pass. `Type=simple`, `is-active`, old log lines and asset
presence alone are insufficient. This is local startup acceptance, not
proof of future polling/generation/delivery; operator message/app
interaction remains the end-to-end test.

Fresh setup must refuse to treat an existing installed service as a fresh
target and direct updates to approved `scripts/deploy.sh`. No unit or
client publication occurs implicitly during diagnosis. Repair/reinstall
of an existing installation is a separate explicit operator action, not
permission inferred from "idempotent."

Boundary tests: missing/locked/stale snapshots; missing auth refs without
resolving values; permission/I/O errors; low disk/inodes; absent/corrupt/
incompatible/busy DB; concurrent WAL writes; missing client/service;
disabled vs configured-broken memory; wrong relay/model; malformed and
oversized responses; stalled body reads; subprocess timeout and cleanup;
one failed check does not stop the others; text/JSON/strict exit parity;
no application-state initialization or durable mutation; fixture secret
sentinels absent from stdout/stderr/report.

Tests must pin reachable real interfaces before relying on fixtures.
Unreachable or source-only assumptions are labeled unverified. Fresh
review, `bun run typecheck`, `bun test` and comment-audit are required when
implementation touches code. Planning verification is reported separately.

### Planning verification

On the doctor worktree, the first gates failed because dependencies were
absent (missing Bun type definitions and imported packages). After
`bun install --frozen-lockfile`, with no tracked manifest/source changes:
`bun run typecheck` passed and `bun test` passed 1909 tests across 112 files.
Logs: `/tmp/goblin-doctor-plan-checks-17oPiw/`.

The SQLite experiment used disposable fixtures, not production state.
It observed a row still in WAL, successful `quick_check(1)` and unchanged
main DB/WAL hashes after read-only querying. A static DB+WAL fixture missing
SHM acquired `-shm` on opening. Artifacts:
`/tmp/goblin-doctor-sqlite-probe-D8ymxj/`. This does not verify safe snapshot
copying of a concurrently changing database. Neither quick-check's error
count nor SQLite busy-timeout supplies a whole-query deadline; use an
isolated process/watchdog for the proposed hard budget.

Fresh source review identified three corrections, incorporated here:
shared safe auth-parser errors before new reporting; separate Hindsight
readiness/application-auth/relay-identity coverage; and explicit caller
versus installed target context. Review did not execute live probes.

## Scheduling, updates and decisions

A nightly authorized program can invoke doctor, but cannot be the sole
alarm: bot/model/credential failure may prevent that program executing.
An independent systemd timer is a later recommendation. Its notification
path needs an explicit decision; journaling alone does not notify the
operator, and a locked wallet can also disable credential-based delivery.
No new standing program or timer is created by this proposal.

Doctor complements the deploy gate; it does not prove "updates always
work." Existing deployment tests, dependency/client refresh and approved
restart remain necessary. A future integration should reuse checks with
startup-aware retry rather than duplicate health logic.

Operator decisions, with recommended answers:

- Initial delivery: CLI/shared checks/launcher only; scheduling and deploy
  integration later.
- Default probes: configured local operational services, including the
  synthetic embedding request; no paid/provider generation.
- Severity: configured outages fail; stale usable snapshots warn.
- Sharing: small internal detection module, with phase-specific policy
  owned by callers and one `preflight|installed` selector; no general
  setup wizard, arbitrary selection framework or repair mode.
- SQLite safety: no application-data mutation, accepting SQLite's shared
  memory bookkeeping; if zero filesystem changes is required instead,
  report live integrity inspection as unsupported until verified.
- Thresholds/budget: start with the recommendations above, then tune from
  actual capacity/latency evidence.

## Evidence and borrowed mechanisms

- Current boundaries: `src/config.ts` (`ensureHomeLayout`, `loadConfig`),
  `src/auth.ts` (`parseAuthFile`, lazy resolution), `src/conversation.ts`
  (`openStore` creates schema and sets pragmas), `src/log.ts` (stdout logs),
  `scripts/install.sh`, `scripts/deploy.sh`, `design/auth.md` and
  `design/memory.md`.
- Existing probes: `deploy/memory/healthcheck.py` calls `/health/ready`;
  `goblin-embed-pin.service` embeds through the relay; memory-watch and
  key-refresh timers already own their respective actions.
- Issue #52 in `bermudi/little-goblin` was implemented in v1, not declined.
  Its old memory/state checks cannot be imported as current requirements.
- Borrow OpenClaw's read-only lint result/exit contract:
  `~/build/testing/openclaw/docs/cli/doctor/health-contract.md` and
  `lint.md`. Ordinary doctor may migrate state without `--fix`; do not copy
  that behavior.
- Borrow Hermes's ordered independent checks and dedicated read-only
  SQLite inspection: `~/build/testing/hermes-agent/hermes_cli/doctor.py`
  and `doctor_state.py`. Do not copy paid default connectivity calls or
  exception-swallowing report behavior.
