# Doctor

## Purpose and authority

Give the operator and Goblin one bounded diagnostic pass that catches decay
before a task encounters it. Onboarding asks what is missing before first
boot; doctor asks what has broken since. They share detection, not actions.
See `design/setup.md` for installation and startup acceptance.

```sh
bun run doctor [--json] [--strict] [--phase preflight|installed]
```

Diagnosis does not initialize application state, resolve arbitrary auth
commands, repair configuration, migrate/checkpoint databases, download,
warm/unlock wallets, start/restart services, or retain memory. It does not
call paid model providers or MCP. A synthetic request to the associated,
operator-configured local embedding model is allowed. Like an ordinary
embedding request, it can load or refresh model caches; no embedding
`keep_alive` override or durable fact write is made.

The source implementation is approved. Deployment, unit installation,
client publication and service restarts require separate approval. A
successful diagnosis grants no repair or deployment authority.

## Consumers and structure

- Operator: text or machine-readable JSON.
- Resident: existing bash tool through `$GOBLIN_HOME/doctor`, reached as
  `../doctor` from its workspace. Its static tool description advertises
  the command and diagnosis-only authority. Bootstrap refreshes this symlink with
  the same collision policy as the MCP/mail launchers; doctor never
  creates it.
- Installer: explicit preflight/installed phases and shared asset checks.
  It never parses human doctor output.

`src/health.ts` owns detection, validated results and manual hints;
`src/health-sqlite.ts` owns isolated read-only SQL inspection;
`src/doctor.ts` owns the command watchdog, rendering and exits. Colocated
boundary tests cover each. There is no check registry, plugin framework,
health daemon, wizard or repair mode. Shared helper changes have one
integration owner; setup-specific scripts belong to onboarding.

## Target and phase policy

Default phase is `installed`. The target home is explicitly the caller's
`GOBLIN_HOME`, otherwise `~/goblin`; the diagnostic checkout is the one
executing doctor. Never silently substitute production's home. Every
finding labels its scope.

Systemd `WorkingDirectory` supplies a separate installed-checkout scope.
Check client assets there when known. A differing or missing checkout
identity is a warning, not proof that the installation is broken. Do not
dump service `Environment` to guess its home. Git revision identity and
running-process readiness remain explicitly unverified.

`preflight` runs after frozen dependencies and operator provisioning. It
skips expected first-boot layout/database, not-yet-installed units and
not-yet-built assets. It is not a pristine checkout's all-green mode.
The installer supplies its checkout/home, builds and checks assets before
publishing units, then performs invocation-specific startup acceptance
and installed-phase checks. Fresh setup refuses existing installations;
updates use the separately approved deploy path.

Schema inspection requires structures for the diagnostic code revision,
not exact schema equality. Missing structures fail that compatibility
check, not an inferred claim of installed corruption. Differing revisions
leave installed compatibility unverified. Preflight does not demand a
migration before boot has performed existing initialization.

## Checks and coverage

| Family | Evidence and limits |
| --- | --- |
| Config | Existing schema and local model/provider reference validation; no provider construction, catalog refresh or generation |
| Auth | Permissions, safe record parsing, effective last-wins references including configured optional features; strict prohibited-command lint scans all records |
| Keys | Referenced recognized `pass-keys get` profiles: metadata-only status, required key-name presence, snapshot age; installed refresh unit state |
| Workspace | Required readable files/directories, explicit optional or preflight skips |
| Storage | Available bytes and reported inodes for caller home and narrowly discovered local PostgreSQL volume; not a write/fsync guarantee |
| SQLite | WAL-aware read-only open, bounded integrity inspection, required base schema and expected boot-created subsystem-table presence (warn-tier); lazy tables excluded; no state-owner constructors or migrations |
| Installation | `goblin` and `goblin-herdr` user-unit state/checkout and readable client index/local asset references; the delegation host fails only while delegation is configured and its pane/wire stay unverified; not proof of successful boot or frontend execution |
| Sandbox | Configured-only: podman answers `info` and the configured image is in the local store; never creates, pulls or executes |
| Memory | Configured `/health/ready` returns 2xx; credentials, bank permissions and running queues remain unverified |
| Embedding | Local installation/container binding/mount and allowlisted embedding settings match a host-local relay/model before synthetic embedding; vectors omitted |

Status parsing is pinned to the local pass-keys Go source, including vault
keys beginning with digits and signed durations. No `get`, `warm`,
owner-session command or arbitrary auth thunk is executed. Only verified
status metadata supplies profile labels; malformed outputs/errors are not
forwarded. Locked/missing/broken snapshots fail fresh-resolution readiness,
without claiming that the running bot already lost memoized credentials.
Old usable snapshots warn rather than expire; future timestamps warn for
clock skew. OAuth, generic auth commands and upstream validity are not
verified by metadata availability.

Relay-file presence alone is not association. Validate the configured API
against the running local installation and allowlisted provider/base URL/
model fields before probing its relay. Unsupported or remote associations
warn/skip instead of testing unrelated local Ollama. Installed settings do
not establish the running process's loaded settings. Readiness, embedding
and application authorization are separate results.

Keep measured capacity evidence when later mount-identity inspection
fails. Missing inode accounting warns rather than inventing a healthy
percentage. Defaults: snapshot-age warning after 24 hours; space warning
below 5 GiB, failure below 1 GiB; inode warning below 10%, failure below 1%.

SQLite may create/update shared-memory coordination sidecars. The accepted
contract is no application-data mutation, not literally zero filesystem
writes. Tests verify uncheckpointed WAL visibility and unchanged main/WAL
bytes. Do not use `immutable` to ignore WAL or copy a bare main database.
Subsystem-table presence is checked against the diagnostic revision's
boot-created set (config-gated tables only while their block exists;
lazy tables unchecked), but their columns and row contents, plus
concurrent snapshot copying, are not claimed verified. Absent tables
warn as revision-scoped expectation drift — never a corruption or
store-loss claim without evidence. The expected-table list is a
validated argv contract of its own: a present-but-malformed list fails
the worker (open-or-query) rather than silently checking nothing; only
an absent list skips the check. Quick-check's error count and busy-timeout do not bound
query runtime; isolation supplies the deadline.

## Reports, failures and execution

A versioned Zod-validated report contains observation time, phase,
caller-home/diagnostic-checkout target and deterministically ordered
results. Each result has an ID, `pass | warn | fail | skip`, scope, duration,
safe evidence and optional manual next step. Warning/failure families
supply safe manual hints. Text derives summary counts from those results.

- Disabled checks skip with reasons; blocked dependents name their blocker.
- Configured, observed outages fail. Unknown coverage is explicit, not green.
- `0`: no failures. `1`: failures, or warnings with `--strict`.
- `2`: invalid invocation or inability to produce a report.

Text and JSON have identical exit semantics. Coverage warnings mean strict
mode can fail even when every measured dependency is available. Exit zero
is not an end-to-end guarantee that Goblin can answer.

JSON stdout is exactly one report; operational diagnostics belong on
stderr. This is a scoped exception to ordinary runtime stdout logging.
Do not import startup or attach runtime file sinks. Safe config-validation
errors retain their typed HTTP 422 contract; disk/I/O errors remain 500.

Never emit auth records/values, command strings, config/environment dumps,
credential-bearing URLs, raw external bodies, arbitrary subprocess output,
unsafe parser messages/causes or original validation payloads. Construct
errors from operation, errno/HTTP status and safe category; remedies contain
no secrets. Internal parsing is not permission to expose credential values
in agent context.

Subprocesses use argv, output caps and per-boundary deadlines. HTTP reads
are bounded/cancelled. The CLI has a 45-second outer watchdog; embedding
gets at most 15 seconds. Its worker and nested probes share a process group
owned by the outer collector. The collector cleans that group on timeout,
cancellation and normal completion, even after leader exit; cleanup does
not depend on a stalled worker's signal handler. Cancellation immediately
kills the worker group before an enclosing bash caller's kill grace expires.
Other process-helper and
direct library callers retain their original detached probe groups.

## Verification and deferred work

Boundary tests cover invalid permissions/parsers and synthetic secret
sentinels, effective/overridden auth records, stale/locked/missing snapshots,
digit-leading keys, clock skew, disk/inode thresholds, WAL integrity/schema,
asset/server URL parity, memory/relay association, stalled responses,
command cancellation and descendants surviving a blocked or exited worker.
Fresh reviewers reproduce group cleanup independently and protect caller/
foreign groups. Tests, typecheck and touched-file comment audit are required.
Source-pinned or synthetic interfaces do not prove real installation
readiness; keep unverified coverage explicit.

A nightly authorized program may invoke doctor, but cannot be the only
alarm when bot/model credentials themselves can fail. Independent scheduling
and notification delivery are deferred, with no standing timer/program
created. Doctor complements deployment gates; it does not prove updates
always work. Deployment integration must supply target identity and
startup-aware acceptance explicitly.

## Precedents

- Issue #52 in `bermudi/little-goblin` was implemented in v1, not declined;
  its old state/memory assumptions do not define current requirements.
- OpenClaw's read-only lint result/exit contract:
  `~/build/testing/openclaw/docs/cli/doctor/health-contract.md` and `lint.md`.
  Ordinary doctor may migrate without `--fix`; do not copy that behavior.
- Hermes's independent ordered checks and dedicated read-only SQLite path:
  `~/build/testing/hermes-agent/hermes_cli/doctor.py` and `doctor_state.py`.
  Do not copy paid default probes or exception-swallowing reports.
- Existing health/refresh owners remain: memory readiness healthcheck,
  embedding pin timer, memory-watch and key-refresh timer. Doctor observes
  their boundaries; it does not replace their actions.
