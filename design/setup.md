# Setup — approved first delivery

**First source delivery approved by bermudi and integrated on the feature branch.**
Implementation on feature branches is authorized. Credential provisioning,
production unit installation, client publication, restart, and deployment
remain separately approval-gated. The existing no-wizard boundary remains.
The audit below describes the original checkout, not the staged installer.

## Delivery status

Onboarding implements the fresh-only installer as a small shell entry point
and stdlib-only `scripts/install.ts` orchestration. Dependency-using helpers
run in new processes after frozen sync: `install-options.ts` reuses config/
auth schema validation without resolving values; `check-app-assets.ts`
consumes the shared synchronous `checkAppAssets(checkout)` API.
`check-startup.ts` owns bounded current-invocation boot/polling/loopback
acceptance; configured port 0 derives a positive port only from the same
invocation's ready event. A fixed configured port must match the event when
present. `scripts/doctor` is the home-symlink target, callable as `../doctor`
from the workspace; shared bootstrap wiring is integrated.

Shared safety/readiness commits were cherry-picked with explicit authority:
`2521229` → local `ab1841b`, safe HTTP validation follow-up `e4282f3` →
`42c9cc7`, and bound-port evidence `efc2e4e` → `748dd8f`.
Shared Health/Doctor commit `7d90fc3` is integrated as local `d00330d`.
Reviewed shared corrections `3be5386` → local `abac7f6` and `119720b` →
`d9a4820` are integrated. Launcher bootstrap is integrated with the shared
checks; source gates remain distinct from real-install acceptance.
No production install, client build/publication, or credential execution has
been performed.

Boundary tests use temporary homes/checkouts and fake external processes,
plus a real loopback fixture server for startup acceptance. Fake CLI routes
prove installer ordering/output/failure behavior, not the shared Doctor API
or real systemd/Telegram readiness. Real Doctor runs from copied source in
temporary checkouts/homes and asserts checkout identity; its metadata probe
is also exercised during cancellation. Real fresh-install startup remains
unverified without a separately approved installation.

## Findings first

1. The installer guards missing files and insecure auth permissions, but
   does not validate config or required auth references before starting a
   restart-on-failure service. A valid empty auth file passes its check.
2. Its auth check imports package dependencies **before** the frozen
   dependency install. Bun can resolve these from its runtime cache or
   auto-install them; this is not an unconditional failure, but it makes
   the first check depend on something other than the frozen install.
3. Fresh installation never builds `app/dist`. Telegram can work while
   `/app/` fails. The build is documented only in the update instructions.
4. Final service status is truncated and its failure ignored. A successful
   installer exit does not establish successful boot, polling, or HTTP.
5. Setup documentation understates prerequisites and optional capability
   setup, and has stale provider, state-layout, and prompt-refresh claims.
6. Read-only diagnostics must construct safe errors, not forward existing
   config/auth parser exceptions. Those exceptions include input-derived
   details; credentials must never reach the report. Fix unsafe parser
   errors at their shared origin first: today's install/check-auth path
   can already surface them, independent of future Doctor output.

Audited checkout: `c452064`. The audit is source-based unless an experiment
is explicitly listed below; no fresh service was installed or booted.

## Ownership and smallest shared seam

Agree with the **sibling-branch proposal**, not an already-landed design:
`feat-doctor/design/doctor.md`, currently at
`/home/daniel/.herdr/worktrees/little-goblin/feat-doctor/design/doctor.md`.
Also read the initial handoff `/tmp/goblin-doctor-onboarding-0Ejl1B.md`.

- **The coordinating doctor session is the integration owner:** proposed
  `src/health.ts`, `src/doctor.ts`, their tests, package script, shared safe
  CONFIG and AUTH parser errors in `src/config.ts` / `src/auth.ts`, and
  eventual core design ruling. It owns bounded independent checks, stable
  IDs, safe evidence, manual remedies, rendering, and exit semantics.
- **Onboarding owns actions:** prerequisite instructions, installation
  sequence (`scripts/install.sh` / tests), setup docs, first-boot scaffolding,
  workspace launcher actions, and post-install acceptance. Shared-helper
  edits are serialized and agreed; config launcher wiring is integrated
  through the coordinating doctor session. Onboarding consumes detection,
  not a second health implementation. Consumers are the operator, installer,
  and Goblin via its existing bash tool; deployment is only a later consumer.
- No registry, setup state database, interactive questionnaire, repair
  mode, new native tool, or new standing timer is needed.

Actual installer needs warrant this small split, not a larger one.
Freeze one proposed selector:
`bun run doctor [--json] [--strict] [--phase preflight|installed]`,
default **installed**. No second setup CLI or general selection framework.
**Preflight** means configured, start-ready inspection **after** frozen
dependency sync and explicit operator provisioning. It skips expected
boot-created layout/DB, not-yet-installed units, and not-yet-built assets.
It is not a healthy verdict for an untouched checkout. The installer
supplies `GOBLIN_HOME` and runs from an explicit checkout cwd. Immediately
after building, it uses shared asset detection **before units/enable**;
this direct consumer does not require another CLI selector. The installer
uses exit status or the typed JSON report, never scrapes human output.

Detection observes facts; caller policy supplies the installation phase.
Do not persist a phase marker: fresh setup knows which actions it has
completed; ordinary doctor inspects the declared target. Report the
requested home, diagnostic checkout/revision, and installed service
checkout/revision separately. Never redirect inspection to production
because a user unit exists. Installed checkout identity comes from narrowly
read systemd `WorkingDirectory`; do not dump service environments to guess
the home. Unknown or differing identities leave installed compatibility
explicitly **unverified**.
A feature worktree lacking dependencies/assets is not evidence that prod
is broken.

Safe CONFIG and AUTH parser fixes at the shared origin precede all new
consumers. Reuse schema and auth-policy rules, but not unsafe loader side
effects or exceptions, including unsafe messages retained as error causes.
Never import `src/index.ts`, call `ensureHomeLayout`, open the
normal conversation store, resolve credentials, execute arbitrary auth
commands, or invoke the MCP/mail wrappers from a check. For auth, internal
parsing may examine records, but the returned surface contains only
validated names, line numbers, reference presence, mode, and bounded
command categories. Construct line/path/category errors without copying
the original JSON/parser message, command, value, or arbitrary stderr.
General auth commands remain explicitly **unverified**, not passed.

Check service PATH, not just interactive PATH. Snapshot metadata inspection
must be non-interactive and must not unlock, warm, or read a key value.
Its real `pass-keys status` interface needs pinning, as the Doctor proposal
notes. Linger and wallet unlock are independent.

“Read-only” means **no application-data mutation**, not guaranteed zero
filesystem writes: SQLite may create SHM while opening an existing WAL
database. Preserve main/WAL data and never checkpoint/migrate; disclose
incidental SQLite coordination files. Integrity scans need an isolated
process deadline, not merely a timeout around synchronous work.

SQLite compatibility means required structures under the **diagnostic code
revision**, not exact schema equality. Extra structures are not a failure.
With differing revisions, a missing required table/column fails compatibility
with the diagnostic revision; it does not prove installed corruption.
Installed compatibility remains unverified until target identity is known.
Schema inspection belongs only after boot has performed existing
initialization, never as a preflight requirement for a new table/column.

### Phase-dependent expectations

These are onboarding policy recommendations, not changes to Doctor's report
contract. Disabled, pending action, blocked inspection, and broken are
different states; expected absence must never masquerade as a health pass.

| Observation | `preflight` after dependencies/provisioning | `installed` / first-boot acceptance |
| --- | --- | --- |
| Config/auth absent | Fail start-ready preflight with copy/create instructions; untouched checkout is not this phase | Fail; do not enable/start |
| Config malformed, auth too open, missing `telegram` or configured auth ref, direct `pass-cli` | Fail before service mutations; blocked dependent checks skip with reason | Fail with safe location/category and manual remedy |
| Workspace, stubs, MCP seed, shims absent | Pending boot scaffolding; skip presence checks, inspect existing ancestors/type/permissions instead | Missing required boot outputs fail; distinguish optional note files per Doctor's agreed policy |
| SQLite absent | Expected before first boot; skip presence/schema checks, never create it to inspect | Fail first-boot acceptance; existing DB inspected read-only including WAL, required structures scoped to diagnostic revision |
| Unit missing / service stopped | Expected until installation; do not require running service | Fail installed-service acceptance; stop is an observation, never an instruction to auto-start |
| `app/dist` absent | Skip in preflight; shared asset check immediately after build must pass before units/enable | Fail full two-channel setup; verify actual loopback HTML and referenced local assets, not directory existence alone |
| Required Pass snapshot absent/locked | Fail when configured: explicit provisioning precedes preflight | Fail fresh-resolution readiness; do not infer the running process lost cached credentials |
| Usable old snapshot | Warn, not expired; no automatic warm | Same; age threshold belongs to Doctor/operator |
| Optional feature not configured | Skip, explain disabled | Same |
| Configured optional dependency unavailable | Fail start-ready preflight; provisioning precedes this phase | Fail feature readiness even if core Telegram remains alive |
| Whistle cache absent | Expected deferred first-use download on supported platform; configured override missing is a failure | Cache absence alone is not corruption; report cold/unverified until exercised, no diagnostic download |
| Storage/inspection permission or I/O error | Preserve operation/errno; never relabel as absence | Same; capacity does not prove future durable writes will succeed |

For `/app/`, an explicit operator choice could allow Telegram-only setup,
but no new channel-disable knob is proposed. Recommend full two-channel
assets as the default install acceptance. Network-dependent features have
separate readiness results; do not claim a provider works merely because
its local reference exists.

### Installer-owned startup acceptance

This is a bounded, invocation-specific action sequence, not another Doctor
phase and not a service repair loop:

1. Before the approved start, record the attempted-start boundary and
   baseline systemd start/restart identity. Capture the resulting invocation
   ID, start timestamp, and restart count; reject ambiguous target identity.
2. Within one overall deadline, require both boot-complete (`goblin up`)
   **and** `long polling started` evidence from that current invocation and
   after the attempted-start boundary. `Type=simple`, `is-active`, an old
   ready line, or an unrelated invocation cannot satisfy acceptance.
3. Inspect only allowlisted safe journal evidence: invocation ID, timestamp,
   recognized event name, and safe failure category. Never dump journal
   bodies, arbitrary messages, exception text, config, or environments.
   Readiness signals must be observable at configured log levels; absent
   evidence is unavailable coverage, not a pass.
4. Fetch actual loopback `/app/` HTML on the configured bound port and its
   referenced local assets, using bounded requests. Require the served HTML
   and local assets to succeed, not merely an existing dist directory or
   an arbitrary 200 response. Handle generated port identity explicitly if
   configured with port 0. This loopback proof is not public-proxy readiness.
5. Recheck invocation/start/restart identity through completion. Timeout,
   restart/invocation change, boot failure, polling failure, or HTTP bind/
   asset failure prevents a pass. Report the safe cause and return nonzero;
   do not retry into a different invocation and call the original start good.

The prerequisite source correction makes **just**
`goblin up` and `long polling started` observable independently of the normal
log threshold through the existing shared logging sink. In the original
audit both used `log.info` and disappeared at warn/error. The coordinating
doctor session implemented this correction in `src/log.ts`, `src/index.ts`, `src/tg/mod.ts`
and tests. Verify both events remain observable at warn/error while ordinary
chatter still respects the threshold. No new public health endpoint,
readiness state file, or requirement to keep `logLevel=info`.

Then run installed checks, including post-boot DB compatibility. Operator
message and app interaction remain the end-to-end generation/delivery test.
Neither local acceptance nor Doctor proves future polling or provider access.

Fresh installation must refuse an existing installed Goblin target,
especially production, before mutating units or publishing assets. Direct
normal updates to the approved `scripts/deploy.sh` path. Existing-target
reinstall/repair requires a separate explicit operator action; no general
repair switch or permission inferred from “idempotent.”

## Fresh-install audit, in execution order

Classification: **fatal** stops the installer or boot; **loud** reports an
error/warning but may leave the process running; **quiet** is not checked
or surfaced at that phase. A failure can be quiet at install and fatal at
boot. These classifications describe today's code, not desired policy.

| Step | Actual behavior and failure classification | Drift / consequence |
| --- | --- | --- |
| 1. Host prerequisites | `install.sh:1–23` requires Bash, Bun in PATH, regular config/auth files; GNU `stat` is used. Missing Bun/files is fatal with instructions. Bash/core utilities or writable unit directory failures terminate under `set -e`. No explicit Bun-version, systemd-user-manager, service PATH, disk/inode, or HTTP-port preflight: quiet until use. | `docs/setup.md:6–23` says Linux/Bun >=1.1 but does not explain systemd user service/bus, linger, core utilities, writable home/checkout, or dependency-download access. The declared Bun minimum is not a tested compatibility result. |
| 2. Create two inputs | Operator copies the example and creates auth by hand. File mode with **any** group/world bits fails install; owner-only modes other than 0600 are accepted (`install.sh:24–28`, `auth.ts:91–97`). No config parse here. | Preserve no-wizard. Recommend restrictive auth creation from the outset rather than writing broadly readable credentials then fixing mode. No credential template containing real values. |
| 3. Auth lint before dependencies | `install.sh:36–48` runs `check-auth.ts`, which imports `auth.ts` → config/Zod/JSON5 before `bun install --frozen-lockfile`. Direct `pass-cli` records cause fatal exit 2 from helper; malformed auth makes the check fatal. Empty auth passes; no required-name check. The gate scans every record, whereas runtime duplicate names are last-wins. | Cold offline behavior is unverified. Cached Bun resolution passed here; `--no-install` failed on missing Zod. Put dependency sync before dependency-using validation, after cheap shell prerequisites. Keep install's conservative direct-command policy unless explicitly changed. |
| 4. Dependency sync | Frozen install runs in repo; failure is fatal. No app build follows (`install.sh:48`, `package.json` scripts). | Package download/network/cache and writable checkout are actual install prerequisites. A partial dependency install is possible; installer is not transactional. |
| 5. Speech warning | Regex scans config text, not parsed defaults (`install.sh:50–55`). An omitted `tts` defaults to enabled in `config.ts:517–533` but can produce no installer warning. Quoted JSON keys also evade the text pattern; explicit off may produce a false warning. Boot probes ffmpeg and loudly disables TTS if absent (`index.ts:208–235`). | Documentation mostly describes boot correctly, not the incomplete install check. ASR is **not enabled by default**; absent transcription means no transcription. Whistle always needs ffmpeg; cloud kinds need it over the upload cap. |
| 6. Main unit generation | Shell substitutes committed paths and writes the final unit directly (`install.sh:63–71`). No rendering verification or temp/rename. No escaping for `sed` replacement metacharacters or systemd path/value syntax. | Ordinary paths appear supported by source; unusual paths are unverified. A chosen Bun binary can work in `ExecStart` while auth/MCP commands invoking bare `bun` cannot find it in the fixed service PATH. Validate/reject unsupported paths or render them safely; do not promise arbitrary-path support. |
| 7. Optional units | Presence of `herdr`, not delegation config, controls herdr installation/start. Missing binary warns even if delegation is disabled. Pass-keys textual detection happens **after unit writes**; missing pass-keys is fatal at that point (`install.sh:78–108`). Warmer always uses `goblin-dev` and `goblin-mcp-dev`, regardless of arbitrary profile names in command refs. | Optional readiness is not config-aware. Script comments still describe a tmpfs/cold-login cache; current auth design is persistent encrypted local snapshots and independent remote warm. Missing Pass prerequisite may leave partially updated units. MCP-only Pass needs are not detected from its separate config. |
| 8. Manager, linger, enable | `daemon-reload` and `enable --now` failures are fatal. Linger enable failure only warns; inspecting linger suppresses stderr (`install.sh:109–126`). Starting herdr/keys can occur before Goblin fails. Warm has no ordering barrier before Goblin, intentionally. | Re-run is repeatable, not side-effect-free: it overwrites units, reloads, enables/starts siblings, and may initiate warm. Enabling an already-active Goblin is not proof of a restart onto new code. Linger success cannot prove unattended credential access after reboot. |
| 9. First-boot scaffolding | `index.ts:81–109` attaches log target, then `ensureHomeLayout` runs **before config validation**. Missing directories/stubs are created; filesystem/template/durable-write failure is fatal. Existing seeded files are preserved. Shim real-file collisions log errors and continue; wrong symlink targets are refreshed (`config.ts:55–229`). | Failed config boot can already have written layout. Seeded browser/Pass/MCP/gws skills, mcporter config, and home shims are absent from setup's diagram. Optional caches/private wrapper state are created later, not all on first boot. |
| 10. Parse config, load auth, open stores | Missing/bad config or bad auth shape/mode is fatal boot; missing auth warns, then required Telegram resolution fails. Duplicate auth names warn; direct Pass commands are poisoned and fail when resolved. SQLite/schema state is created before Telegram initialization. Provider/auth validity is mostly lazy (`auth.ts:76–161`, `index.ts:95–132`). | Installer's “refuses half-configured service” claim overstates its file-existence guard. Schema validates active model/provider refs, not API credentials or model availability; favorites are not included in its ref refinement (`config.ts:614–642`). |
| 11. Optional runtime readiness | ffmpeg absence is loud degradation. Catalog fetch is nonfatal/conservative. Memory client construction does not prove API readiness (`index.ts:240–259`, `memory.ts:35–46`). Mail/delegation binaries, logins, and most auth refs are not fully checked on a fresh no-work boot. Missing client assets are not a boot gate. | Quiet until first relevant use, then feature errors/outage handling. Core installation does not install Podman/PostgreSQL/Hindsight/Ollama/relay, browser/Chromium, gws login, or harnesses. Do not equate “skill seeded” with “capability installed.” |
| 12. Telegram/HTTP/start acceptance | Telegram resolves `telegram`, then bounded `getMe` (`tg/mod.ts:888–895`); token/network/auth failure is fatal boot. Polling failure logs and exits. HTTP binds loopback; occupied port is fatal boot (`http/mod.ts:174–178`). `goblin up` is logged at `index.ts:872`. Installer sleeps one second and ignores final status failure (`install.sh:127–130`). | Quiet installer success can hide a logged restart loop. Wrong allowed user ID silently prevents authorized use despite otherwise successful boot. “Then message your bot” remains necessary end-to-end acceptance, not something a read-only local check proves. |

### App assets and optional actions

The settings mini app is the React app — the same built client as the PWA
(ruling 2026-10-10, design/telegram.md → Mini Apps), so both need
`bun run app:build`. `http/app-dist.ts:47–83` reports missing dist with
500/log, but a present directory lacking index/assets yields 404; its
broad stat catch also hides non-ENOENT inspection errors as 404. That
last behavior is a separate existing error-reporting defect; shared
checks must not copy it.

Onboarding should give a short opt-in dependency table, not silently install
every capability:

- Speech: ffmpeg; transcription selection is operator-owned. Whistle
  downloads digest-pinned engine/weights on first use, subject to platform,
  network, executable and cache permissions (`design/asr.md:121–164`).
- Pass refs: scoped agent/grants, both profile snapshots if using the
  shipped warmer/MCP, unlocked persistent wallet, and service PATH.
  Provision/warm remains an explicit operator action, not diagnostics.
- Memory: choose existing endpoint or the separate approved installer.
  Rootless Podman/user units/subuid/subgid are local-stack prerequisites;
  local embeddings additionally need Ollama/model/relay as configured.
  The memory installer's explicit model/cost prompts are an already
  separately designed exception, not permission for a general wizard
  (`design/memory.md:177–248`, `deploy/memory/install.py:466–487`).
  Never reuse environment-dump commands as safe health checks.
- Delegation: herdr plus the operator-configured harnesses on each target;
  no live pane probes or agent launches during diagnostics.
- Browser: separate agent-browser/Chromium installation. Seeded skill
  documents recovery; core installer does not supply the executable.
- Mail/Workspace: gws login and scoped permissions are separate actions;
  send refs and optional System One refs are additional credential needs.
  MCP needs its pinned local executable, isolated config and snapshot.
- Remote app/mini-app access: loopback HTTP is not a public HTTPS door.
  Reverse proxy/tailnet setup and exposure choice remain operator-owned.
  Trust mode merely warns; public exposure requires bearer by policy,
  not an enforced publicUrl detection (`design/app.md`, `app-channel.ts:116–125`).

## Documentation drift to correct after approval

1. `docs/setup.md:43` and `docs/configuration.md:55–62` say three provider
   kinds. Schema has four, including `responses` (`config.ts:235–258`);
   the shipped example already uses Responses. Do not select or replace
   the operator's provider/model while fixing docs.
2. Editing only root `model` in the copied example does not change its
   explicit `telegram.model`. Explain independent channel defaults.
3. Setup's input examples cover Telegram/provider only, not optional
   auth refs. Distinguish Codex login from auth.jsonl records.
4. Example's `!pass show ...` is a legacy password-store command, not
   the current scoped Pass snapshot mechanism. It is not forbidden by
   the direct-`pass-cli` lint, but needs an undocumented dependency.
5. Fresh app build is missing from installation; update's
   install → build → restart sequence can start the backend first.
6. “All bot memory” in SQLite (`setup.md:126`) is wrong for optional
   Hindsight; distinguish durable conversation state and long-term memory.
7. SOUL edits do not inject into the prompt on the next message in an
   existing conversation (`setup.md:132–133`). They take effect at prompt
   snapshot boundaries; read tools can see disk edits immediately.
8. “Idempotent — re-run any time” needs an approval/side-effect caveat,
   especially for prod. Seed-preservation, unit refresh, service restart,
   asset publication, and key provisioning are different actions.
9. Root AGENTS' issue-label advice is stale: verified issue
   [#52](https://github.com/bermudi/little-goblin/issues/52) is the closed
   v1 doctor implementation, not a declined-ideas ledger.
   [#47](https://github.com/bermudi/little-goblin/issues/47) is the closed
   scheduled-turn queue-fence bug, not onboarding/doctor scope.
   #52 has implementation/test evidence in comments and commit
   `cfa3a7cb0b5fab8508f19311fe3f4632e246db4c`
   (`feat: add doctor CLI for local system health checks`).
   Its old memory/state assumptions are not v2 requirements.

## Ranked proposed changes and files

First-delivery source changes below are approved and staged on feature
branches. Production actions remain separately gated. Shared integration
files are owned by the coordinating doctor session as specified above.

| Rank | Change | Proposed files / owner | Verification |
| --- | --- | --- | --- |
| P0 | Fix input-leaking CONFIG and AUTH parser errors at the shared origin before consumers, then keep diagnostic boundaries safe; never resolve a value | Coordinating doctor session: `src/auth.ts`, `src/config.ts`, existing parser/helper tests, `src/health.ts` and tests | Malformed synthetic secret sentinels absent from thrown messages/causes, install-helper stderr, stdout/text/JSON; missing/permission errors distinct; no spawned auth command |
| P1 | Make only the two safe startup lifecycle events threshold-independent before installer dependency | Coordinating doctor session: `src/log.ts`, `src/index.ts`, `src/tg/mod.ts` and tests | At warn/error, both events still reach the existing shared sink; ordinary info chatter remains suppressed; no new endpoint/state file or logLevel restriction |
| P1 | Honest start-ready preflight before units/enable; fix dependency-check order and service-PATH checks | Onboarding `scripts/install.sh`, new `scripts/install.test.ts`; Doctor's shared checks/CLI | Fresh empty checkout, cached/offline dependency cases, empty auth, invalid config, missing refs/binaries: no service mutation before gate |
| P1 | Shared asset check immediately after build before units/enable; invocation-specific startup acceptance | Onboarding installer/tests/docs, Doctor-owned asset detection | Old invocation/logs, info-level signal suppression, timeout/restart, failed polling/bind, missing served HTML/local assets prevent pass; no real production build during verification |
| P1 | Accurate no-wizard runbook, phases and capability matrix | `docs/setup.md`, `docs/configuration.md`, example comments, `docs/operations.md` as needed | Walk instructions against new isolated fixtures; validate example config; account for both channel model selections |
| P2 | Safe unit rendering and config-aware optional prerequisites; explain fixed shipped profile assumptions | Installer, unit sources only as agreed | Service environment different from shell; unusual paths; partial-failure/re-run behavior; no unintended sibling activation |
| P2 | Workspace-accessible doctor launcher follows existing shim mechanism | Onboarding `scripts/doctor` actions (name provisional), layout docs; config launcher wiring integrated via coordinating doctor session | Seed iff absent, refresh only symlink targets, loud real-file collision, works from workspace without runtime boot |

Approved source implementation order: safe shared CONFIG/AUTH
parser fixes → shared checks/CLI and two observable startup lifecycle events
→ installer consumer. Proposed fresh-install
action order: cheap host/input and existing-target refusal checks → frozen
dependency sync → explicit operator provisioning → `doctor --phase preflight`
→ build assets → shared asset check immediately after build → validate
rendered units → approved unit installation/enable → bounded current-invocation
startup acceptance → installed checks → operator message/app acceptance.
Never stop or overwrite a healthy existing service as an effect of fresh setup.
Do not silently migrate keys, alter a bank's embedding model, remove units,
or roll back by deleting operator state. Each completed mutation and failure
needs a safe stderr signal; check JSON stdout stays one report.

## First-delivery decisions and remaining authority boundaries

- **Wizard?** No. Keep two hand-edited inputs plus a non-interactive
  installer; any general wizard needs an explicit Product boundary ruling.
- **Default completion target?** Full two-channel installation, build
  assets before start. Optional integrations may remain disabled; configured
  ones must have explicit readiness findings, not silently pass.
- **Phase interface — approved:** one
  `--phase preflight|installed`, default installed; preflight follows frozen
  dependencies/provisioning. Shared direct asset detection after build;
  no general selection framework, second CLI, or persisted setup state.
- **Configured outages versus degraded core?** Agree with Doctor:
  configured dependency failure fails readiness; separately state whether
  Telegram core can boot. Stale usable snapshots warn.
- **Installation versus update?** Keep prod updates on approved
  `scripts/deploy.sh`; fresh installer refuses an existing installed target.
  Reinstall/repair requires separate explicit operator authority.
  Do not add deploy hooks or schedule doctor in this patch.
- **Credentials in diagnostics?** Metadata only. Arbitrary command refs
  and external model access remain unverified; actual operator message is
  the generation test. No provider/model choice made by onboarding.
- **Timeouts/capacity/network probes?** Reuse the approved Doctor contract,
  including its configured synthetic embedding probe and deadlines, not a
  second onboarding set. Threshold changes, scheduling and deployment hooks
  remain separate decisions. No app build, artifact fetch,
  wallet unlock, warm, or paid probe inside diagnosis.

## Evidence, borrowing, and verification performed

Onboarding source commits: `09db193` (startup acceptance/launcher) and
`c8e4654` (fresh installer/shared-check gates), followed by reviewed fixes
`e1005c9` (group completion/cancellation, Pass paths, real-checkout proof).
After shared-engine corrections, all three typecheck programs passed and
**57 onboarding tests passed / 0 failed** across four files. They include
real Doctor preflight success/missing refs in temporary targets; other
installer process edges remain faked. Tests cover port 0, missing/wrong bound
port, stale evidence, restart during HTTP, stalled commands/header/body,
oversized bodies, redirects, HTML assets, and unexpected origins.

Independent review requested safe failure remedies/categories, actual Pass
token recognition rather than substring matching, and source-versus-prod
safety wording; these fixes and regressions are implemented. Later reviews
caught ordinary-completion descendants, multi-directory Pass paths, and
SIGINT/SIGTERM bypassing cleanup. Owned groups are now reclaimed on every
completion. Cancellation forwards TERM, permits two seconds for Doctor's
separate worker cleanup, then escalates to KILL and prevents later phases.
Fresh cancellation review **passed** with no concrete owned blocker;
23 installer tests and all typecheck programs passed independently.
Review logs: `/tmp/goblin-review-install-{tests,typecheck}.log`.
Nested startup probes share the acceptance worker group. Already accepted
systemd jobs/services remain outside that group and are not rolled back.
Journal time semantics were checked against installed
`systemd.journal-fields(7)`; attempted-start wallclock uses journal realtime,
and monotonic comparisons stay within systemd/journal timestamps (Linux
uptime is not used as that clock).

Earlier implementation full suite: **1979 pass / 0 fail**, 117 files;
earlier typecheck failed only because Health had not landed. Logs:
`/tmp/goblin-onboarding-implementation-gates-Nh7Zdd/`.
Final local gates: typecheck **exit 0**, full suite **2047 pass / 0 fail**
across 119 files, focused **57 pass / 0 fail**, comment audit and shell
syntax **exit 0**, whitespace clean.
Logs: `/tmp/goblin-onboarding-release-gates-DHH9Kd/`.
Comment audit covers `src`/`app/src`; owned script comment ratios were also
inspected separately (`/tmp/goblin-onboarding-script-comment-ratios.log`).
The coordinator reports independent shared-source review passed and actual
read-only launcher exercise exit 0 (17 pass / 6 coverage/accounting/identity
warnings); those are attributed results, not local installation proof.
Combined bootstrap integration/gates and production acceptance remain
separate; no deployment/installation approval is implied.
Real systemd/Telegram first-start acceptance remains unverified until a
separately approved installation.

Implementation verification (before shared Health/Doctor integration):
`bun test` **exit 0**, 1979 pass / 0 fail across 117 files;
focused onboarding tests **36 pass / 0 fail** across four files.
`bun run typecheck` **exit 2**, solely the missing `src/health.ts` import in
the post-build asset bridge; later client programs did not run. Do not call
this an integrated typecheck pass. Comment audit **exit 0**, shell syntax
checks passed, and whitespace inspection was clean. Bulk logs:
`/tmp/goblin-onboarding-implementation-gates-Nh7Zdd/`.
At that earlier checkpoint independent review was pending; current review
and integration results are recorded above.

Read local `AGENTS.md`, `DESIGN.md`, setup/configuration/operations docs,
auth design, and relevant app/ASR/memory/delegation/mail/web area sections.
Inspected actual installer, boot, config/layout/auth, units, wrappers,
provider resolution, app serving, and optional memory prerequisites.
No production credentials, env values, live auth/config files, or services
were inspected. No client build, install script, deployment, or unit action
was executed.

Borrow only OpenClaw's separation of read-only detection from repair and
stable finding IDs/manual hints:
`~/build/testing/openclaw/docs/cli/doctor/health-contract.md` and `lint.md`.
Read installed root and docs `AGENTS.md` before borrowing. Do **not** import
its plugin registry, mutation modes, or advisory JSON exit semantics.
The seed-if-absent/symlink-refresh launcher recommendation comes from
Goblin's existing `config.ts`, not a new reference-project bootstrap system.
Hermes borrowing in the sibling Doctor draft belongs to that draft; no
additional Hermes mechanism is proposed here.

Initial checks before dependencies were installed in this onboarding worktree:

- `bash -n scripts/install.sh`: **passed**.
- `bun run typecheck`: **exit 2**, missing Bun type definitions; later
  TypeScript programs did not run.
- `bun test`: **exit 1**, 208 pass / 92 fail / 92 errors, 300 tests across
  112 files; errors are missing-package/module imports, not established
  source regressions. Logs:
  `/tmp/goblin-onboarding-gates-1O4Qt7/{typecheck,test}.log`.
- Isolated empty auth fixture: normal `bun scripts/check-auth.ts` **exit 0**,
  resolved dependencies from Bun cache; `bun --no-install` **exit 1** on
  missing Zod. Logs in `/tmp/goblin-onboarding-auth-import-EFU80d/`.
  This confirms that required references are not checked, and qualifies
  the pre-install dependency concern. Cold network behavior was not tested.
- Coordinator's synthetic-only parser experiment:
  `parseAuthFile('{"name":"provider","value":DOCTOR_TEST_SECRET_SENTINEL}')`
  echoed the unquoted fake marker in Bun's native parse error. Current
  `auth.ts:43–46` forwards that message; `check-auth.ts` leaves the exception
  uncaught. This is a present secret-disclosure risk, not merely a future
  diagnostic concern. No real auth file or secret was used in that experiment.
- Coordinator's SQLite experiment: read-only access saw live WAL rows with
  unchanged main/WAL hashes, but created SHM for a static DB+WAL fixture
  without it. These are sibling experiments, not runs by this session.
- GitHub issue metadata, comments and implementation commit were fetched
  read-only to `/tmp/goblin-onboarding-issue*`; historical correction verified.

Successful local verification after the coordinator explicitly authorized
frozen dependency setup in **feat-onboarding**:

- `bun install --frozen-lockfile`: **exit 0**, 132 packages installed into
  ignored `node_modules`; no tracked manifest/lockfile/source changes.
- `bun run typecheck`: **exit 0**, all three TypeScript programs completed.
- `bun test`: **exit 0**, **1909 pass / 0 fail**, 7129 expectations,
  112 files, 46.80 seconds.
- Logs: `/tmp/goblin-onboarding-installed-checks-ZL7LRE/`
  (`install.log`, `typecheck.log`, `test.log`).
- After those gates, git status was only `?? design/setup.md`, with no tracked
  diff; draft, package.json, and bun.lock hashes matched their pre-run values.
  No client build, real credential execution, install.sh, or unit action ran.

Coordinator reports dependency-installed gates in **feat-doctor** passed:
typecheck exit 0; 1909 tests pass / 0 fail across 112 files, logs under
`/tmp/goblin-doctor-plan-checks-17oPiw/*-installed.log`. These sibling results
are separately attributed; this worktree's successful run is recorded above.

Future implementation acceptance needs hermetic installer boundaries
(fake service manager/binaries, temporary home/checkout), read-only
before/after state checks, and separately authorized real first-install
proof. Fakes prove ordering/output/no-mutation contracts, not real wallet,
systemd, Telegram, provider, or Hindsight readiness.
