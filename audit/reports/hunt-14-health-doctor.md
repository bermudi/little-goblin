> Audited 2026-10-23 18:07 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 14 — Doctor / health / startup acceptance

Scope: `src/doctor.ts`, `src/health.ts`, `src/health-sqlite.ts`, `scripts/doctor`,
`scripts/doctor.test.ts`, `scripts/check-startup.ts`, `scripts/check-startup.test.ts`,
`scripts/startup-categories.ts`. Governing spec: `design/doctor.md`, `DESIGN.md` →
"Setup and diagnosis". Static reading only (per operator override: no suite, no
typecheck); one code path additionally verified against the pinned pass-keys Go
source at `~/build/pass-keys`. No live services touched, no secrets read.

Severity: **P0 0 · P1 1 · P2 2 · P3 5** (plus simplifications, below).

---

## Findings (most severe first)

### F1 — P1 · Startup acceptance can never pass with Telegram disabled (legal config), breaking install and every deploy

- **Where:** `scripts/check-startup.ts:23,266-271` — acceptance requires
  `seen.has("goblin up") && seen.has("long polling started")` unconditionally.
- **Rule violated:** `design/doctor.md` → "Verification and deferred work":
  "Deployment integration must supply target identity and **startup-aware
  acceptance** explicitly." `DESIGN.md` → "Product boundary": two disjoint
  channels; Telegram is optional per config. The acceptance contract is not
  startup-aware of the channel config — it hardcodes Telegram long-polling
  evidence as a universal boot signal.
- **Trigger/path:** `"long polling started"` is emitted only in
  `startPolling` (`src/tg/mod.ts:1247`), which is called only inside the
  `telegramInit = telegramEnabled ? …` task (`src/index.ts:902,957`). With
  `telegram: { enabled: false }` (legal, boot-pinned channel switch —
  `src/config.ts:933-934`), a perfectly healthy boot (goblin up, HTTP door,
  served assets, active unit) never emits the event, so `acceptStartup` and
  `watchStartup` spin to budget expiry ("startup deadline expired").
  Consequences: `scripts/install.ts:398-402` ("start and accept current
  invocation") fails on fresh app-only installs, and `scripts/deploy.sh:280`
  fails **every** sanctioned deploy after restart ("goblin failed startup
  acceptance after restart") on such a config. `check-startup.ts` never reads
  `goblin.json5` — it cannot distinguish "polling never started" from
  "polling not configured".
- **Test sketch:** fixture config with `telegram: { enabled: false }`; a boot
  that logs only `{"msg":"goblin up","port":N}` and serves `/app/`; assert
  `acceptStartup`/`watchStartup` reject — today they time out; the
  expectation set should be config-aware (or the event set should mark
  telegram-polling evidence conditional).
- **Severity note:** borderline P1/P2 — the config is supported and designed
  (not the operator's current prod state), but the failure is a hard,
  permanent break of the only sanctioned deploy path for that installation.

### F2 — P2 · `expectedTables` unconditionally expects Telegram-gated tables — permanent spurious warning on telegram-disabled installs

- **Where:** `src/health.ts:555-557` — `tg_inbox`, `tg_inbox_archives`,
  `guest_dedup` are in the unconditional boot expectation.
- **Rule violated:** `design/doctor.md` → "Checks and coverage": "Subsystem-table
  presence is checked against the diagnostic revision's **boot-created set
  (config-gated tables only while their block exists; lazy tables unchecked)**."
  These three tables are channel-gated, not boot-created: they are created only
  inside `startBot` (`src/tg/mod.ts:1042,1057`), which runs only under
  `telegramInit = telegramEnabled ? …` (`src/index.ts:902`). (`tg_pings` at
  `health.ts:554` is fine — `openPings` runs unconditionally at
  `src/index.ts:527`.)
- **Trigger/path:** `telegram: { enabled: false }` + a store created by such a
  boot: `sqlite.subsystems` warns on **every** doctor run listing
  `tg_inbox, tg_inbox_archives, guest_dedup` — a healthy installation
  misreported as expectation drift; with `--strict` that warning is exit 1
  (design: "`1`: failures, or warnings with `--strict`"), so strict gates
  (e.g. validation before an approved restart) fail.
- **Test sketch:** extend the existing "missing boot-created subsystem tables
  warn by name" fixture (`src/health.test.ts:644`): boot the fixture store
  without `openTelegramInbox`/`openGuestStore` **and** with
  `telegram:{enabled:false}` in the fixture config — assert `sqlite.subsystems`
  passes; today it warns naming the three tables.

### F3 — P2 · Runtime stdout logging can leak into the doctor report stream (worker stdout is not guaranteed to be exactly one report)

- **Where:** `src/doctor.ts:128-141` (worker writes the JSON report to stdout)
  and `src/health.ts:216-271` (`command()` → `boundedRun`); root cause in
  out-of-scope `src/proc.ts:214,222` — `log.warn("process pipe cancel
  failed"|"process pipe drain failed")` — which writes JSONL to
  `process.stdout` (`src/log.ts:102`).
- **Rule violated:** `design/doctor.md` → "Reports, failures and execution":
  "**JSON stdout is exactly one report; operational diagnostics belong on
  stderr — a scoped exception to ordinary runtime stdout logging.**"
- **Trigger/path:** the doctor worker and the collector both run `boundedRun`
  (worker for every probe; collector for the worker itself). If a bounded
  run's post-exit drain cut fires and a pipe `reader.cancel()` rejects
  (`src/proc.ts:206-219`), `log.warn` emits a JSONL line onto that process's
  stdout. In the worker that line lands before/around
  `JSON.stringify(report)` (`src/doctor.ts:139`), so the collector's
  `JSON.parse(result.stdout)` (`src/doctor.ts:103`) fails → "diagnostic
  worker returned an invalid report" → exit 2. In the collector
  (`--json` mode) the line precedes the report on stdout, breaking
  stdout-is-one-report for the human/JSON consumer too. Fails loud, never
  silently — but a diagnosable situation becomes "no report".
- **Label:** verified static (the log-to-stdout path and the import chain are
  certain); the *trigger* is a racy pipe-cancel failure I could not reproduce
  deterministically under read-only rules — treat reproduction as a lead.
  `log.debug` at `proc.ts:217` is below the default `info` threshold; no
  other module in the worker's import closure logs on the doctor path
  (`parseAuthFile` is log-free; the logging in `loadAuthFile`/`config.ts` is
  on paths doctor never calls; `setLogFile` is never called, so no
  `goblin.log` writes either).
- **Test sketch:** unit-level: stub a bounded subprocess whose stream reader
  `cancel()` rejects after exit; run `collectDoctorReport`'s worker command
  against it; assert the report still parses (or that the diagnostic went to
  stderr).

### F4 — P3 · `expectedTables` under-covers the actual boot-created set

- **Where:** `src/health.ts:538-570` (list), comment claims it is the
  "boot-created set".
- **Rule violated:** `design/doctor.md` → "Checks and coverage": "Subsystem-table
  presence is checked against the diagnostic revision's **boot-created set**."
  Ten unconditionally boot-created tables are absent from the expectation, so
  their absence is never surfaced:
  `conversation_epoch_hwm` (`src/conversation.ts:662`, created in `openStore`),
  `responsibilities`, `attachments`, `prompt_operations`
  (`src/responsibilities.ts:451,468,488` via `ensureResponsibilitiesSchema`,
  called from `openStore` at `src/conversation.ts:626`),
  `wake_events`, `wake_deliveries`, `work_events` (`src/wake-store.ts:172` via
  `ensureWakeSchema`, `openStore` line 627), `skill_sources`
  (`src/skill-provenance.ts:64`, wired at `src/index.ts:186`),
  `subagent_runs` (`src/subagent-runs.ts:284`, `src/index.ts:198` — its own
  comment says "additive and unconditional", mirroring `sandboxes` which *is*
  listed), and `cache_pruning_suspensions` (`src/cache-observation.ts:171`,
  created by the same `openCacheObservation` call at `src/index.ts:155` that
  creates the listed `model_cache_calls`).
- **Impact:** advisory-only (the check is warn-tier) — a store missing these
  tables is not flagged. The asymmetries (same-opener `model_cache_calls`
  listed / `cache_pruning_suspensions` not; `sandboxes` listed /
  `subagent_runs` not) read as drift-by-omission rather than deliberate
  "subsystem" scoping; no written source defines a narrower subsystem scope
  (see "couldn't verify").
- **Test sketch:** assert `expectedTables(undefined)` equals the set of tables
  created by a real `openStore`+boot wiring against a fresh DB (introspect
  `sqlite_master`), or extend `bootSchema` in `src/health.test.ts` and pin
  the expected list to it.

### F5 — P3 · More than 8 referenced pass-keys profiles is reported as a `fail`, not a bounded skip

- **Where:** `src/health.ts:434-437` — `if (profiles.size > 8) { profiles.clear();
  throw new ProbeError("too-many-required-profiles"); }` → `auth.metadata`
  **fails**.
- **Rule violated:** `design/doctor.md` → "Reports, failures and execution":
  "**Configured, observed outages fail.**" A large-but-legal config is not an
  outage; and "Disabled checks skip with reasons" — the snapshot probes are
  what is bounded, and a bound should degrade to a skip-with-reason, not fail
  the parent metadata check (which also cascades `auth.coverage` to
  "Blocked by auth.metadata").
- **Trigger/path:** `authReferences` (`src/config.ts:1241-1266`) collects auth
  names from an unbounded provider record plus feature blocks; a config
  referencing 9 distinct `!pass-keys get <profile> <KEY>` profiles is
  schema-valid, and every snapshot could be perfectly READY — doctor still
  reports `auth.metadata` fail: "Inspect auth.jsonl: too-many-required-profiles".
- **Test sketch:** fixture auth.jsonl + config referencing 9 profiles (all
  mocked READY via the status stub); assert the profile checks skip with a
  bounded-probe reason rather than `auth.metadata` failing.

### F6 — P3 · `keys.snapshots` skip reason does not name its blocker when `auth.metadata` failed

- **Where:** `src/health.ts:837-845` — any empty `profiles` map (including the
  one returned from `authCheck`'s catch at `src/health.ts:461-468` after a
  parse/mode/poison failure) yields skip "No recognized referenced pass-keys
  profiles; other credential mechanisms unverified".
- **Rule violated:** `design/doctor.md` → "Reports, failures and execution":
  "**Disabled checks skip with reasons; blocked dependents name their
  blocker.**" `auth.coverage` names its blocker ("Blocked by
  auth.metadata"); `keys.snapshots` — equally blocked when the auth file
  could not be parsed/inspected — instead asserts "No recognized referenced
  pass-keys profiles", which is not what was measured (nothing was
  recognized *because inspection failed*, and the operator is steered toward
  "other credential mechanisms" instead of the actual blocker).
- **Test sketch:** fixture auth.jsonl with insecure mode (or a poison record)
  plus a config referencing a `!pass-keys get` record; assert the
  `keys.snapshots` detail contains "Blocked by auth.metadata".

### F7 — P3 · Dead startup category: `"startup clock unavailable"` is never thrown

- **Where:** `scripts/startup-categories.ts:7` — listed in the allowlist;
  repo-wide grep finds no throw site (only this list entry).
- **Rule context:** the brief's drift probe ("check-startup categories
  drifting from `scripts/startup-categories.ts`"). The dangerous drift
  direction — a thrown message with **no** allowlist entry (which would
  escape the private-subprocess boundary only as the generic
  "startup inspection failed" — actually safe, but lossy) — was checked clean:
  I enumerated every `throw new Error(...)` in `check-startup.ts` and each
  message maps to an entry or composes from the four allowed
  `${label}: …` labels. The dead entry is the residue of a removed clock
  check: pure dead code in a security-relevant allowlist (each entry asserts
  "this local category may cross the subprocess boundary" — an entry that
  can never be produced weakens the list's auditability).
- **Fix sketch:** delete the entry (grep first for external re-users of
  `startupCategories`, none found outside `check-startup.ts:480` and the
  list itself).

### F8 — P3 · Profile ordering uses `localeCompare` — report ordering can vary with the environment's collation

- **Where:** `src/health.ts:848` — `[...profiles].sort(([a], [b]) =>
  a.localeCompare(b))` assigns `keys.snapshot.1..N` ids.
- **Rule violated:** `design/doctor.md` → "Reports, failures and execution":
  "The versioned report keeps results **deterministically ordered** even when
  probes run concurrently." Profile names are `[a-z0-9_-]`; ICU collation can
  order `-`/`_` differently from codepoint order (e.g. `goblin-dev` vs
  `goblindev`), so which profile gets which `keys.snapshot.N` index (and the
  result order) can differ between environments/locales for the same input.
  Deterministic per machine, not cross-environment.
- **Fix sketch:** codepoint comparison (`a < b ? -1 : a > b ? 1 : 0`), which
  is what every other ordering in the report effectively relies on.

---

## What I checked and found clean (later passes can skip)

- **No mutating calls in the doctor path** (brief's P0 probe): `readBounded`
  opens `O_RDONLY|O_NONBLOCK` only; all subprocess argv are read-only
  (`systemctl --user show`, `pass-keys status` — never `get`/`warm`,
  `podman inspect|pod inspect|volume inspect|info|image exists` — no
  create/pull/exec); the only HTTP POST is the one sanctioned synthetic
  embedding request (`design/doctor.md` → "Purpose and authority");
  `goblinHome()` is a pure env read (`src/config.ts:29-31`);
  `ensureHomeLayout`/`appendAuthRecord`/`loadAuthFile` are not in the doctor
  call graph; the log file sink is never attached (`setLogFile` never called
  on this path — no `goblin.log` writes); the worker writes only the report
  line to stdout.
- **health-sqlite read-only contract** (brief's probe): `readonly: true` +
  `PRAGMA query_only=ON` + `busy_timeout=200`; no checkpoint, no migrate, no
  `immutable`, no bare-DB copy; `SQLITE_BUSY/LOCKED` classified as `busy`;
  table names interpolated only from fixed constants or the argv-validated
  `^[a-z][a-z0-9_]{0,63}$` vocabulary; a present-but-malformed expected-list
  fails the probe, matching the design's argv contract; missing required
  structures fail `structure` without claiming corruption (wording matches
  "Schema inspection requires structures… not exact schema equality").
- **pass-keys status grammar pinned to source** (verified against
  `~/build/pass-keys/internal/resolve/local.go:70-133`): line format
  `%s: %s  age=%s  keys=%d` + optional `  names=%s`; unavailable states emit
  `age=none keys=0` plus extra diagnostic lines and a nonzero exit —
  `command()`'s tolerance regex (`health.ts:261`) is prefix-anchored without
  `$` so trailing diagnostics don't break it, and `snapshotLine` consumes
  only the first line; digit-leading key names match (pass-keys itself pins
  key names to `^[A-Z][A-Z0-9_]*$` — `internal/profile/profile.go:131,183`);
  signed (negative) durations parse and produce the clock-skew warn; old
  snapshots warn, future ones warn, per the design.
- **Green-lie audit:** every `pass` requires a real measured probe; every
  under-verified claim is phrased as unverified in the detail
  (memory `/health/ready` disclaims bank/auth access; cache contracts
  disclaim warmth/expiry; `herdr` disclaims pane contents and wire;
  `service.goblin` disclaims process-loaded config/revision; app assets
  disclaim runtime serving). `auth.metadata`/`auth.coverage` semantics match
  the design's record-recognition grammar (single direct `!pass-keys get`
  = profile reference; the poison lint scans every *effective* record —
  referenced or not — folding last-wins like the runtime loader).
- **Budgets/unbounded-hang audit:** every probe command has a 2-5s deadline
  with SIGKILL fallback; HTTP reads are deadline'd and capped at 64KB;
  sqlite worker capped at 5s; the collector bounds the worker with a 45s
  process-boundary watchdog (which also bounds synchronous FS/SQLite stalls
  — the stated reason for the process boundary) and a 1MB output cap;
  `readBounded` caps files (256KB/128KB/64KB) and uses `O_NONBLOCK` so FIFOs
  cannot hang pre-fstat; worker wall-clock worst case (~30s, memory chain)
  stays under the 45s watchdog.
- **Exit-code / signal contract:** `0` no failures; `1` failures or
  `--strict` warnings; `2` invalid invocation (arg parse failure → usage on
  stderr), worker failure/timeout/truncation/invalid report, and
  cancellation — all per `design/doctor.md` → "Reports, failures and
  execution"; the top-level catch allowlists only locally constructed
  messages; worker stderr is captured and never forwarded; report stdout
  carries no control characters in text mode (`printable()`).
- **Kill/group semantics:** worker spawned in a new process group; probes
  inherit the worker's group (`processGroup: "inherit"`), never signal the
  caller's group; collector abort SIGKILLs the worker group immediately and
  the `finally` kill owns cleanup after leader exit — matches the design's
  cancellation ruling.
- **check-startup mechanics:** floor validation (hex-32 id, integer
  monotonic, NaN budget rejected); accept refuses a non-inactive baseline;
  unfloored watch refuses missing/non-clean invocations; NRestarts and
  invocation-id/monotonic change detection; journal cursor resumption with
  full re-read degradation; `--brief` projection (systemd lines verbatim
  ≤240 chars, goblin lines projected to lifecycle names, everything else
  counted, `FIXTURE_SECRET` never printed); stdout/stderr split (brief lines
  stdout, diagnostics stderr; deploy.sh redirects both to stderr); all four
  lifecycle event names verified to exist in the runtime
  (`src/index.ts:1038,1161`, `src/tg/mod.ts:1247,1249`); startup categories
  cover every thrown message (see F7).
- **`scripts/doctor` launcher:** resolves the owning checkout via
  `readlink -f`, defaults `GOBLIN_HOME`, preserves explicit home and CLI
  args — pinned by `scripts/doctor.test.ts` (fake `bun` on PATH).
- **expectedTables positive + gated entries verified against real wiring:**
  all unconditional entries are created unconditionally at boot
  (openStore inline + `ensure{Projects,Notes,Responsibilities,Wake,Window}Schema`
  + constructors; `programs`/`program_proposals` via `openPrograms`
  `index.ts:188`; `mail_outbox` `index.ts:192`; `sandboxes` `index.ts:203`;
  `model_cache_calls` `index.ts:155`; `tg_pings` `index.ts:527`;
  `turn_runs`/`turn_tool_calls` `index.ts:162`;
  `event_projections`/`app_push_*` inline in `openStore`); `delegations`
  gated by `config.delegation` (`delegation-lifecycle.ts:182` — matches
  `health.ts:567`) and `memory_outage` gated by the memory block
  (`index.ts:485-488` — matches `health.ts:568`).
- **memory local-association chain** matches the design's ruling (config
  validated against the running local installation and allowlisted
  provider/baseURL/model fields before any relay probe; unsupported/remote
  associations skip instead of probing local Ollama; volume capacity
  evidence preserved when mount-identity inspection fails; no external
  metadata paths or env values emitted — the fail-detail sanitizer at
  `health.ts:1251-1252` strips the statfs path).
- **422/500 boundary:** nothing in the scoped files classifies the app's own
  HTTP responses; that boundary is the HTTP surface (hunt 7 pointer, not
  chased).

## What I couldn't verify

- **F3's trigger:** no deterministic reproduction of the pipe-cancel
  `log.warn` under read-only rules; the static chain (proc.ts → log.ts →
  stdout, imported by the doctor worker) is verified, the race is not.
- **F4's intent:** whether the `expectedTables` omissions are deliberate
  "subsystem" scoping — no written source defines which tables count as
  subsystem tables; `design/doctor.md` only says "boot-created set". I
  suspect drift-by-omission from the same-opener/same-wiring asymmetries,
  but cannot prove intent.
- **`narrowEnv` vs the real env-file consumer (lead, not counted):**
  `src/health.ts:1002-1016` compares env values raw (no quote handling). If
  `hindsight.env` ever uses quoted values (systemd/podman `EnvironmentFile`
  quoting semantics — I did not verify which parser the memory pod actually
  uses), `HINDSIGHT_API_EMBEDDINGS_PROVIDER !== "openai"` misfires and the
  report claims "Installed embedding provider is not the supported local
  OpenAI-to-Ollama relay" — a false statement about the installation (a
  labeled skip, not a green lie). Unverified premise; flagged as a lead.
- **pass-keys exit code value** for the unavailable-status path (assumed
  nonzero from the Go `return fmt.Errorf`; either way both branches are
  handled by `command()`).
- **Real prod state:** per rules of engagement I never touched the live
  `GOBLIN_HOME`, systemd, podman, or the real DB — all sqlite/telegram/boot
  conclusions are from source and the checked-in fixtures.

## Simplifications & code smells (P3-level, evidence-backed)

1. **Dead category entry** — `scripts/startup-categories.ts:7`
   `"startup clock unavailable"`: no throw site exists (see F7). Delete it.
2. **Dead default** — `src/health.ts:1022`
   `config.memory?.baseUrl ?? "https://invalid.invalid"`: `memoryConfigSchema`
   requires `baseUrl` (`src/config.ts:343`, `src/memory/hindsight.ts:39-40`)
   and `memory: ""` transforms to `undefined` (`src/config.ts:974-977`), so
   whenever `config.memory` exists, `baseUrl` is a valid URL string. The
   `??` branch is unreachable.
3. **Dead branch** — `src/health.ts:1251-1252`
   `checked.detail.startsWith("Available") ? checked.detail : "filesystem
   inspection unavailable"`: this only runs when `checked.status === "fail"`,
   and a `capacity` failure detail always starts with `` `statfs ${path}` ``
   (`health.ts:530`) — never "Available". The true branch is unreachable;
   the sanitizer can unconditionally emit the fixed string.
4. **Duplicated schema** — `src/health.ts:646-659` defines `unitStateSchema`
   (LoadState/ActiveState/SubState), then `installation()` at
   `health.ts:757-773` re-declares the same three enums inline plus
   `WorkingDirectory` instead of extending/reusing the named schema. Two
   copies of the systemd enum vocabulary to keep in sync.
5. **Misleading comment** — `src/health.ts:534-537`: the comment presents the
   list as the boot-created set with only config-gated and lazy exceptions;
   it is neither exhaustive (F4) nor fully unconditional (F2). The comment
   overstates the invariant the code maintains.
6. **`localeCompare` where codepoint order is the invariant** —
   `src/health.ts:848` (see F8); every other ordering in the report path is
   insertion/array order.
7. **Vacuous-pass semantics for an absent expected-list** —
   `src/health-sqlite.ts:139-141`: an absent argv[3] becomes `expected = []`
   and the probe reports `pass`/`compatible` with a vacuous check, while the
   design says "only an absent list skips the check". Unreachable from
   `health.ts` (which always passes the list), so harmless today — but the
   worker's "pass" then asserts compatibility it did not check. A distinct
   skip signal would be honest; dead-in-practice either way.
