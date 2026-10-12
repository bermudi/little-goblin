# Setup

Fresh-installation ruling. Detection, diagnosis output, safe errors and
exit semantics belong to `design/doctor.md`; this doc owns the installer's
product shape, action order, phase expectations, startup acceptance and
the opt-in capability boundary.

## Product shape

- **Fresh-only installer.** `scripts/install.sh` is a small shell entry;
  stdlib-only `scripts/install.ts` orchestrates. Dependency-using helpers
  run in new processes after the frozen sync: `install-options.ts` reuses
  config/auth schema validation without resolving values,
  `check-app-assets.ts` consumes the shared `checkAppAssets(checkout)`,
  `check-startup.ts` owns bounded current-invocation acceptance.
- **Two hand-edited inputs** — `goblin.json5` and `auth.jsonl` — plus a
  non-interactive installer. No wizard: a general wizard needs an explicit
  Product boundary ruling. (The memory installer's explicit model/cost
  prompts are a separately designed exception, not a precedent.)
- **Fresh targets only.** The installer refuses an existing installed
  Goblin target — especially production — before mutating units or
  publishing assets. Updates go through the approved `scripts/deploy.sh`;
  reinstall/repair is a separate explicit operator action. There is no
  general repair switch, and "idempotent" implies no permission. Fresh
  setup never stops or overwrites a healthy existing service.
- **Completion target is the full two-channel install**: Telegram plus the
  built client (`bun run app:build` — the PWA at `/app/` and the Telegram
  mini app at `/t/` are one build; design/telegram.md → Mini Apps).
  Optional integrations may stay disabled; configured ones must produce
  explicit readiness findings, not silent passes.
- **`scripts/doctor`** is the home-symlink launcher, `../doctor` from the
  workspace — bootstrap wiring, not a new native tool.

## Install order

Required sequence:

1. Cheap host/input/path checks and existing-installed-target refusal,
   before any dependency, asset or service mutation.
2. `bun install --frozen-lockfile`. Dependency-using validation runs only
   after this — never through incidental Bun cache/auto-install.
3. Confirm operator provisioning is already complete: the installer
   creates no credentials, performs no logins, and warms or unlocks
   nothing.
4. `doctor --phase preflight` from the checkout, with the target home and
   the **service** PATH.
5. `bun run app:build`, then the shared asset check via
   `check-app-assets.ts` — a post-build gate before units.
6. Validate rendered user units, then install/reload/enable them and
   start the approved target with linger established.
7. `check-startup.ts` startup acceptance (below).
8. `doctor --phase installed`, same home and service PATH.
9. The operator handshake — a real Telegram message and a working `/app/`
   conversation — is the end-to-end generation/delivery test.

Each completed mutation and failure gets a safe stderr signal; check JSON
stdout stays one report. Fresh setup never silently migrates keys, alters
a bank's embedding model, removes units, or rolls back by deleting
operator state.

Cancellation reclaims owned process groups on every completion: TERM, a
two-second grace for worker cleanup, then KILL, and later phases do not
run. Nested startup probes share the acceptance worker group; accepted
systemd jobs/services and already-written files are not rolled back.
Recovery is a separately authorized action, not another installer run.

## Phases

The contract is `doctor [--json] [--strict] [--phase preflight|installed]`,
default `installed` — one selector, no second setup CLI or persisted phase
state. `preflight` is start-ready inspection **after** frozen dependencies
and explicit provisioning: it skips expected boot-created layout/database,
not-yet-installed units and not-yet-built assets, and it is not a healthy
verdict for an untouched checkout. The installer supplies `GOBLIN_HOME`,
runs from an explicit checkout cwd, and consumes exit status or the typed
JSON report — it never scrapes human output. Detection observes facts and
the caller supplies phase; that split and the phase contract itself are
`design/doctor.md`'s.

## Phase-dependent expectations

Disabled, pending action, blocked inspection and broken are different
states; expected absence must never masquerade as a health pass.

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

There is no channel-disable knob: full two-channel assets are the default
install acceptance. Network-dependent features have separate readiness
results; a configured local reference does not prove its provider works.

## Startup acceptance

A bounded, invocation-specific action sequence owned by the installer —
not another Doctor phase and not a service repair loop:

1. Before the approved start, record the attempted-start boundary and the
   baseline invocation identity: invocation ID, start timestamp, restart
   count. Reject ambiguous target identity.
2. Within one overall deadline, require both `goblin up` **and**
   `long polling started` from that current invocation, after the
   attempted-start boundary. `Type=simple`, `is-active`, an old ready
   line, or an unrelated invocation cannot satisfy acceptance.
3. Inspect only allowlisted safe journal evidence: invocation ID,
   timestamp, recognized event name, safe failure category. Never dump
   journal bodies, arbitrary messages, exception text, config or
   environments. Readiness signals must be observable at the configured
   log level; absent evidence is unavailable coverage, not a pass.
4. Fetch actual loopback `/app/` HTML on the bound port and its
   referenced local assets — not dist-directory existence or an arbitrary
   200. A configured port 0 derives its positive port only from the same
   invocation's ready event; a fixed configured port must match it.
   Loopback proof is not public-proxy readiness.
5. Recheck invocation/start/restart identity through completion. Timeout,
   restart or invocation change, and boot, polling, HTTP-bind or asset
   failure all prevent a pass: report the safe cause, return nonzero, and
   do not retry into a different invocation and call the original start
   good.

Attempted-start wallclock uses journal realtime; monotonic comparisons
stay within systemd/journal timestamps, never Linux uptime.

Both lifecycle events reach the shared log sink at warn/error via the
startup-event threshold correction; ordinary chatter still respects the
configured level. No public health endpoint, readiness state file, or
`logLevel: "info"` requirement exists for this.

After acceptance, run installed-phase checks including post-boot DB
compatibility. Neither local acceptance nor Doctor proves future polling
or provider access — the operator handshake does.

## Installer rules

- The frozen dependency sync precedes every dependency-using validation;
  the direct-`pass-cli` lint policy stays conservative unless explicitly
  changed.
- Warm has no ordering barrier before Goblin — intentional.
- Linger enable failure is a warn, not fatal; linger is not wallet unlock.
- The chosen Bun binary must work in the service PATH: an `ExecStart`
  absolute path does not put `bun` where auth/MCP commands look. Unsupported
  paths are rejected, not promised.
- `ensureHomeLayout` runs before config validation — layout writes can
  precede a failed boot, accepted. Boot seeds missing files without
  overwriting operator/agent edits (skills, `mcporter.json`, home shims);
  real-file collisions are reported, not overwritten. Optional caches and
  wrapper state appear on first use, not all at boot.
- Final service status is never the acceptance signal.
- `http/app-dist.ts` reports missing dist as fail-loud 500 + log; a present
  directory missing index/assets yields 404, and its broad stat catch
  masks non-ENOENT errors — a known defect shared checks must not copy.
- Service PATH, not interactive PATH, is what every prerequisite check
  means. Snapshot metadata inspection is non-interactive: it never
  unlocks, warms, or reads a key value.

## Opt-in dependencies

A seeded skill is not a provisioned capability. The installer documents
these boundaries; it does not silently install them.

| Capability | Operator prerequisites / readiness boundary |
| --- | --- |
| Speech | `ffmpeg` in service PATH (TTS default-on; ASR only when configured). Whistle's digest-pinned engine/weights download on first use — platform, network, exec and cache permitting; cloud kinds need `ffmpeg` over the upload cap. |
| Pass refs | `pass-keys`, scoped agent/grants, both profile snapshots when using the shipped warmer/MCP lane, an available unlocked persistent wallet, commands in service PATH. Provision and warm are explicit operator actions, never diagnostics. |
| Memory | An existing endpoint or the separately approved installer. Local stack: rootless Podman, user units, subuid/subgid; local embeddings add Ollama/model/relay. Its explicit model/cost prompts are a designed exception, not wizard permission. Environment-dump commands are never health checks. |
| Delegation | herdr plus the operator-configured harnesses on each target. No live pane probes or agent launches during diagnostics. |
| Browser | Separate `agent-browser`/Chromium install; the seeded skill documents recovery. The installer supplies no executable. |
| Mail / Workspace | gws install and scoped login, send refs, optional System One refs. MCP needs its pinned local executable, isolated config and snapshot. |
| Remote access | Loopback HTTP is not a public HTTPS door. Reverse proxy/tailnet and `publicUrl` are operator-owned. Trust mode merely warns; public exposure requires bearer auth by policy, not enforced `publicUrl` detection. |

## Verification boundary

Boundary tests use temporary homes/checkouts, fake external processes and
a real loopback fixture. Fakes prove installer ordering, output and
failure behavior — not Doctor's API, real systemd, Telegram or provider
readiness. Real fresh-install startup acceptance remains **unverified**
without a separately approved installation; source-pinned behavior is not
installation proof.
