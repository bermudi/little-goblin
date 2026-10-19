# Doctor

## Purpose and authority

One bounded diagnostic pass that catches decay before a task encounters it:
onboarding asks what is missing before first boot, doctor what has broken
since; the two share detection, not actions. See `design/setup.md` for
installation and startup acceptance.

Diagnosis does not initialize application state, resolve arbitrary auth
commands, repair configuration, migrate/checkpoint databases, download,
warm/unlock wallets, start/restart services or retain memory; it calls no
paid model providers or MCP. A synthetic request to the associated,
operator-configured local embedding model is allowed: like any embedding
request it may load or refresh model caches, but makes no embedding
`keep_alive` override or durable fact write.

The source implementation is approved; deployment, unit installation,
client publication and service restarts require separate approval; a
successful diagnosis grants no repair or deployment authority.

## Consumers and structure

- Operator: text or machine-readable JSON.
- Resident: existing bash tool through `$GOBLIN_HOME/doctor`, reached as
  `../doctor` from its workspace. Its static tool description advertises
  the command and diagnosis-only authority. Bootstrap refreshes this
  symlink with the same collision policy as the MCP/mail launchers; doctor
  never creates it.
- Installer: explicit preflight/installed phases and shared asset checks.
  It never parses human doctor output.

There is no check registry, plugin framework, health daemon, wizard or
repair mode. Shared helper changes have one integration owner;
setup-specific scripts belong to onboarding.

## Target and phase policy

The target home is explicitly the caller's `GOBLIN_HOME`, otherwise
`~/goblin`; the diagnostic checkout is the one executing doctor. Never
silently substitute production's home; every finding labels its scope.

Systemd `WorkingDirectory` supplies a separate installed-checkout scope:
check client assets there when known. A differing or missing checkout
identity is a warning, not proof that the installation is broken. Do not
dump service `Environment` to guess its home. Git revision identity and
running-process readiness remain explicitly unverified.

`preflight` runs after frozen dependencies and operator provisioning; it
skips expected first-boot layout/database, not-yet-installed units and
not-yet-built assets, not a pristine checkout's all-green mode. Fresh
setup refuses existing installations and updates use the separately
approved deploy path.

Schema inspection requires structures for the diagnostic code revision, not
exact schema equality: missing structures fail that compatibility check,
not an inferred claim of installed corruption, and differing revisions
leave installed compatibility unverified. Preflight does not demand a
migration before boot has performed existing initialization.

## Checks and coverage

Optional subsystem checks run only when configured; every check is
read-only: no provider construction, catalog refresh or generation, no
credential resolution, no state write; sandbox inspection never creates,
pulls or executes; the sole synthetic action is one bounded embedding
request against an associated host-local relay, vectors omitted. Cache
contracts verify published mode/lifetime metadata only and never claim
warmth or expiry; the manual bounded re-check is
`scripts/check-cache-contracts.ts` (`design/model.md` → Cache contracts).
No finding claims more than measured: memory `/health/ready` 2xx is not
bank or auth access — credentials, bank permissions and running queues stay
unverified — and unit/asset findings are not proof of successful boot or
frontend execution; delegation panes and herdr wire stay unverified, and
the delegation host fails only while delegation is configured.

Record recognition shares the installer's grammar (`src/auth.ts`): only a
single direct `!pass-keys get <profile> <KEY>` record counts as a profile
reference, and a strict prohibited-command lint scans all records; every
other command form stays a general, unverified command. Status parsing is
pinned to the local pass-keys Go source, including vault keys beginning
with digits and signed durations. No `get`, `warm`, owner-session command
or arbitrary auth thunk is executed. Only verified status metadata supplies
profile labels; malformed outputs/errors are not forwarded.
Locked/missing/broken snapshots fail fresh-resolution readiness, without
claiming the running bot already lost memoized credentials. Old usable
snapshots warn rather than expire; future timestamps warn for clock skew.
OAuth, generic auth commands and upstream validity are not verified by
metadata availability.

Relay-file presence alone is not association: validate the configured API
against the running local installation and allowlisted provider/base
URL/model fields before probing its relay. Unsupported or remote
associations warn/skip instead of testing unrelated local Ollama. Installed
settings do not establish the running process's loaded settings; readiness,
embedding and application authorization are separate results.

Keep measured capacity evidence when later mount-identity inspection fails.
Missing inode accounting warns rather than inventing a healthy percentage;
capacity findings are not a write/fsync guarantee.

SQLite may create/update shared-memory coordination sidecars: the accepted
contract is no application-data mutation, not literally zero filesystem
writes. Do not use `immutable` to ignore WAL or copy a bare main database.
Subsystem-table presence is checked against the diagnostic revision's
boot-created set (config-gated tables only while their block exists; lazy
tables unchecked); columns, row contents and concurrent snapshot copying
are not claimed verified. Absent tables warn as revision-scoped expectation
drift — never a corruption or store-loss claim without evidence. The
expected-table list is a validated argv contract of its own: a
present-but-malformed list fails the worker rather than silently checking
nothing, and only an absent list skips the check.

## Reports, failures and execution

The versioned report keeps results deterministically ordered even when
probes run concurrently.

- Disabled checks skip with reasons; blocked dependents name their blocker.
- Configured, observed outages fail. Unknown coverage is explicit, not green.
- `0`: no failures. `1`: failures, or warnings with `--strict`.
- `2`: invalid invocation or inability to produce a report.

Text and JSON share exit semantics: coverage warnings mean strict mode can
fail even when every measured dependency is available, and exit zero is not
an end-to-end guarantee that Goblin can answer.

JSON stdout is exactly one report; operational diagnostics belong on
stderr — a scoped exception to ordinary runtime stdout logging. Do not
import startup or attach runtime file sinks. Safe config-validation errors
retain their typed HTTP 422 contract; disk/I/O errors remain 500.

Never emit auth records/values, command strings, config/environment dumps,
credential-bearing URLs, raw external bodies, arbitrary subprocess output,
unsafe parser messages/causes or original validation payloads. Construct
errors from operation, errno/HTTP status and safe category; remedies contain
no secrets. Internal parsing is not permission to expose credential values
in agent context.

Subprocesses use argv with bounded output and per-boundary deadlines; HTTP
reads are bounded and cancelled. Cancellation immediately kills the worker
process group before an enclosing bash caller's kill grace expires, and
cleanup is owned by the outer collector even after leader exit — never by a
stalled worker's signal handler.

## Verification and deferred work

Tests, typecheck and a touched-file comment audit are required; fresh
reviewers reproduce group cleanup independently and protect caller/foreign
groups. Source-pinned or synthetic interfaces do not prove real installation
readiness; keep unverified coverage explicit.

A nightly authorized program may invoke doctor but cannot be the only alarm
when bot/model credentials themselves can fail; independent scheduling and
notification delivery are deferred, with no standing timer/program created.
Doctor complements deployment gates; it does not prove updates always work.
Deployment integration must supply target identity and startup-aware
acceptance explicitly.

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
