> Audited 2026-10-23 17:50 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 11 — sandbox/podman/desktops/box-files/deploy-desktop

Read-and-report pass per /tmp/goblin-hunts/hunt-11.txt. Test override honored:
no suite, no typecheck, no live gates were run; everything below is static
reading of the scoped files (plus the direct dependencies needed to verify
their contracts: src/proc.ts, src/durable.ts, src/agent/tools/paths.ts,
src/sqlite.ts, src/config.ts schemas, src/index.ts wiring, and the tool
composition in src/agent/tools/sandbox.ts / desktop.ts read only as far as
needed to validate transfer-path validation).

Severity counts: **P0 0 · P1 0 · P2 2 · P3 5**.

---

## 1. Findings (most severe first)

### F1 — P2 — Gated integration test contradicts the pinned leaf-symlink export refusal; it fails the moment anyone runs it

- `src/sandbox.integration.test.ts:106-117` — "export reads the container's
  file content through a container symlink" creates `ln -sf /etc/passwd
  /work/pw-link`, exports it, and expects success
  (`expect(out.error).toBeUndefined()`).
- `src/sandboxes.ts:553-566` — `catFile`'s probe is
  `test -f "$1" && ! test -L "$1"`; a leaf symlink exits 1 and throws
  `` `${path} is not a regular file in the sandbox` ``.
- `src/sandboxes.test.ts:901-906` pins the exact opposite ("a leaf symlink is
  refused — test -L guards what -f follows"), and the fake engine documents
  it (`src/sandboxes.test.ts:25-26`: "In-guest symlink paths — catFile must
  refuse these").
- The tool passes `from` through verbatim (`src/agent/tools/sandbox.ts:116-122`),
  so nothing in between resolves the link.

Violated rule — design/sandbox.md → The tool → `export`: "regular container
files only … Non-regular files are refused outright — the safe subset ships"
(current-code reading, pinned by the unit test); regardless of which reading
of the doc wins, the repo contradicts itself and the designated
after-podman-upgrade verification path (`GOBLIN_TEST_PODMAN=1`) goes red on a
case that is not a wall drift — poisoning the signal the gate exists for.

Trigger / test sketch: `GOBLIN_TEST_PODMAN=1 bun test src/sandbox.integration.test.ts`
→ the symlink case fails at the probe with "not a regular file". Fix direction
is one of: update the integration case to expect refusal, or (if read-through
is the intended contract) change the probe and the unit pin together.

### F2 — P2 — `openDesktops` opens the shared state file without `busy_timeout` — the only store on that file that fails instantly on a foreign write lock

- `src/desktops.ts:159-161` — `openDesktops` sets only
  `PRAGMA journal_mode = WAL`; no `busy_timeout`.
- Every sibling store on the **same file** sets it: `src/sandboxes.ts:73`,
  `src/conversation.ts:601`, `src/delegations.ts:184`, `src/mail-outbox.ts:136`,
  `src/programs.ts:383`. All open `paths.db()` =
  `$GOBLIN_HOME/state/goblin.sqlite` (`src/index.ts:203` and `:693`,
  `src/config.ts:50`).
- Violated rule — the file's own module contract, `src/sqlite.ts:5-11`:
  "How long a write waits for a foreign write lock before SQLITE_BUSY.
  Without it bun:sqlite's default is zero and the first contended statement
  fails outright (the inbox insert that precedes a Telegram ack included).
  … contention is only another writer — an operator's sqlite3 session, a
  checkpoint." The repo's write scripts hit exactly that file
  (`scripts/backfill-skill-sources.ts:93`, `scripts/replay-v7-history.ts:13`).

Triggering path: an operator `sqlite3` session (or one of those scripts, or a
checkpoint) holds the write lock while any desktop row write lands — claim,
act's consume/renew `store.put`, screenshot's `mintObservation` — and it
throws `SQLITE_BUSY` immediately instead of waiting up to 2s like every other
store would.

Test sketch: two `Database` connections on one temp file; connection A
`BEGIN IMMEDIATE`; call the desktops store's `put` → observe immediate
SQLITE_BUSY, while the same probe against `openSandboxes` waits.

Out-of-scope pointer (not chased): `src/subagent-runs.ts:282` has the same
omission — hunt 9 territory, flagging the pattern.

### F3 — P3 — catFile's probe timeout is misreported as "not a regular file" (both modules)

- `src/sandboxes.ts:564-566`: `if (probe.exitCode !== 0) throw new
  SandboxError(\`${path} is not a regular file in the sandbox\`)` — a probe
  that *timed out* (30s, `exitCode: null`) or was engine-killed without an
  abort produces the same message.
- `src/desktops.ts:1509-1511` (same shape, `probe.timedOut ||
  probe.exitCode !== 0` → "is not a regular file on desktop").

The abort case is explicitly guarded and tested
(`src/sandboxes.test.ts:1281-1302`); the timeout case is not. Violated bar —
AGENTS.md "No `console.log`" logging rule: "a screenshot of weird behavior
plus the log file must fully reconstruct what the process did", and the
spirit of design/sandbox.md → Lifetime: "the result's note never
misrepresents what happened". A slow engine turns "engine timed out" into a
false statement about the file, sending the model down the wrong path.

Test sketch: fake `execRunner` returns
`{exitCode: null, timedOut: true, killed: true}` for the `sb-check` probe
with no abort → current code says "not a regular file"; expected: a timeout
diagnostic.

### F4 — P3 — Desktops' fail-closed network drop deletes the row — divergence from "the sandboxes.ts rule" the design cites (may be deliberate, no ruling found)

- `src/desktops.ts:461-481` — `drop()` does `store.delete(name)` after the rm:
  the row's image, `reserved` pin, `createdAt`, and `shotSeq` die with the
  container.
- Reached from a routine reconcile: `ensureLocked`'s recreate path
  (`src/desktops.ts:683-687`) → `createContainer` (`:530-569`) →
  `applyNetwork` (`:458`) — one failed post-create network verification
  (e.g. a lying disconnect) removes not just the container but the whole
  desktop identity; the name must be re-allocated and the reservation is
  lost.
- Violated rule (as cited by the desktop ruling) — design/subagents.md →
  Desktops → Allocate: "row-vs-engine reconcile on every call follows the
  sandboxes.ts rule", where design/sandbox.md → The tool → `network` says:
  "a sandbox whose network state can't be confirmed off when off is intended
  is removed, not used — **its row stays, carrying the image and intent the
  next call recreates from**."
- The code comments justify the divergence (`src/desktops.ts:455`: "Row out
  only after rm lands"; sandboxes keep the row for recreate intent), and
  desktop reap also deletes its row (`:762`), so it is internally consistent
  — but no design doc states the desktop row disposition, and the one doc
  pointer that exists points at the opposite behavior. Labeled a divergence,
  not a confirmed bug; the ruling should be written either way
  (repo Process: "If a design tension is real enough to argue about, write
  the ruling into the design docs").

### F5 — P3 (lead) — Foreign network attachments are never reconciled or reported on adoption

- Both fail-closed reconciles manage only their own network:
  `src/sandbox-lifecycle.ts:80-127` and `src/desktops.ts:458-528` —
  `has = before.networks.includes(networkName)`; connect/disconnect target
  `networkName` only.
- Adoption reads network truth the same way (`src/sandboxes.ts:273`,
  `src/desktops.ts:596`): a goblin-labelled container attached to some other
  bridge (only reachable by a manual operator `podman network connect`)
  would have live networking with `network` intent `false` — the adopted-row
  path returns and the tool contract reports network off.
- Bar in question — design/sandbox.md → Lifetime: "the model must never
  believe … isolation holds when they don't." No model-reachable path exists
  (nothing in the scoped code can attach a foreign network), so this is
  invariant hygiene against off-contract operator state, not an exploit.
  Unverified intent: may be consciously out of threat model.

### F6 — P3 (lead, unverified against real podman) — `podman cp` with a colon in the host-side staged filename

- `src/podman.ts:396-402`: `["cp", hostPath, \`${name}:${containerPath}\`]`.
- The sandbox tool stages imports under a mkdtemp using
  `basename(source.path)` (`src/agent/tools/sandbox.ts:101-108`); a
  workspace file legally named `weird:name.txt` yields a staged host path
  containing a colon, which podman cp may parse as `container:path`
  (docker-family cp semantics). Outcome is either a confusing "no such
  container" error or a correct copy — containment is not at risk (the
  destination side is always goblin's `name:path`), but colon-named
  workspace files would fail import with a misleading diagnostic.
- Cannot verify without running podman (forbidden by the rules of
  engagement); recorded as a lead. If real, the cheap fix is a
  colon-free staged basename (e.g. `imp-<uuid>`).

### F7 — P3 — `exportBytes`'s numbered-candidate loop has no bound when every candidate collides with an existing directory

- `src/box-files.ts:257-265`: `for (let i = 0; ; i++)` — iteration continues
  on `{error, exists: true}`; `durable.ts:234-244`'s create-only `linkSync`
  returns EEXIST for *any* existing entry at the target, including
  directories, which no candidate number can ever displace.
- Normal collisions are files (loop ends at the first free name — correct
  and tested). The pathological input is workspace state: directories
  pre-created at `report.txt`, `report.1.txt`, … `report.N.png` — reachable
  because subagent-workspace code (model-driven) can `mkdir` arbitrary
  names inside the workspace. With N such dirs, an export does N failed
  link attempts before finding a free name; N is chosen by the adversary,
  not by goblin. Fail-loud still holds (nothing silent), but the loop is
  unbounded by design where its inputs are not.
- Test sketch: pre-create dirs `out/shot.png`, `out/shot.1.png` …
  `out/shot.K.png`, then `exportBytes(ws, "out", "shot.png", bytes)`;
  assert it completes at `shot.(K+1).png` (current behavior — fine for
  small K) and note there is no cap on K. A `maxCandidates` bound (or
  refusing when a candidate is a directory) would close it.

---

## 2. Checked and found clean (later passes can skip)

- **podman adapter argv construction** (`src/podman.ts`): no shell anywhere
  (argv arrays only); `--pull=never` on every create; five-cap wall exact and
  `extraCaps` name-regex-gated before any call (`:256-263`, pinned by
  `podman.test.ts:96-111`); `--uidmap/--gidmap 0:40000:8192`,
  `no-new-privileges`, `--init` byte-pinned in tests; no prune anywhere —
  every lifecycle op addresses an exact name; `inspect` missing-vs-error
  parsing covers both `[]`-stdout and no-such-object-stderr shapes
  (`:312-321`); `networkEnsure` inspect→create→re-inspect convergence
  handles the peer race and refuses a non-strict network (tested).
- **Argument injection surfaces**: sandbox container names are
  sha256-derived (`sandboxes.ts:145-148`); desktop names match
  `NAME_RE` and are validated **before** `pruneShots` on every entry point
  (pinned by the 12-case traversal table, `desktops.test.ts:458-512`);
  image refs validated at the boundary (`config.ts:495-500`, starts
  alnum, cannot become a flag; `allocate` re-validates,
  `desktops.test.ts:1384-1394`); container-side paths always behind `--`
  (`cat --`, `mkdir -p --`, `cp --`, `rm -f --`); label values ride as
  single `--label k=v` argv elements; cua payloads are one JSON argv
  string; launch URLs double-gated (`desktops.ts:329-331` regex +
  in-image `case` backstop, `goblin-launch:64-79`), and the whitelists
  agree (`http(s)/file/about:blank`).
- **goblin-launch dispatch** (`deploy/desktop/goblin-launch`): root →
  `setpriv --reuid/--regid/--clear-groups/--reset-env` with a fixed env —
  never caller env; desk → direct; anyone else → exit 64; nothing steerable
  by environment (the test poisons DESK_USER/DISPLAY/HOME/DBUS and pins the
  constants). The initially suspicious `goblin-launch "$@"` after the inner
  `sh -ec` is only `$0` naming, not recursion — the detached command is the
  app argv itself (confirmed by `goblin-launch.test.ts:138-149` expecting
  `argv=--force-renderer-accessibility https://example.com/`).
  `GOBLIN_LAUNCH_LOG_DIR` is a test-only seam; goblin never sets it, desk
  gains nothing by steering it, and the root path is unreachable from
  model-controlled code.
- **goblin-desktop-session**: root drops to desk via setpriv before anything
  user-facing; fixed bus/display constants match `SESSION_ENV`
  (`desktops.ts:259-264`) and the launcher's pinned env; Xvfb wait loop
  fails loud (exit 1) rather than booting headless; cua-driver foreground as
  PID 1's exec.
- **Containerfile**: no `HEALTHCHECK` at all — the AGENTS.md quadlet
  HealthCmd metacharacter rule concerns quadlet-managed services; desktop
  containers are app-created (`podman create` from `desktops.ts`), so no
  CMD-SHELL re-quoting surface exists. cua-driver is sha256-pinned; desk is
  uid 1000; `SYS_CHROOT` is passed only by desktops (literal, never inferred
  from labels).
- **box-files containment** (`src/box-files.ts` + `durable.ts` +
  `paths.ts:writeThroughTarget`): import side — lexical-`..` refusal before
  fs access, realpath containment, then fd-pinned revalidation
  (`/proc/self/fd/<fd>`), regular-file + cap checks twice, growth race
  detected; export side — nearest-existing-ancestor realpath before mkdir,
  realpath-back-after, leaf write-through with dangling-symlink refusal,
  FD-pinned durable write through `/proc/self/fd/<fd>` with
  `O_NOFOLLOW|O_DIRECTORY` parent, mode preservation, EEXIST-as-verdict
  numbering. The durable write through the procfs fd path is sound
  (tmp/link/rename/fsync all resolve through the magic symlink into the
  pinned directory inode). Swap-race tests cover the hostile paths
  (`box-files.test.ts:97-117, 244-256`).
- **Sandboxes lifecycle** (`src/sandboxes.ts`, `sandbox-lifecycle.ts`):
  adoption notes honest about network-ON; recreate from the row's image and
  intent; all four fail-closed network triggers (lying disconnect, failed
  disconnect, failed confirm-inspect, failed initial inspect) remove the
  container and keep the row — pinned by tests; `reset` preflights image +
  network before the rm and rechecks the run lease after the preflight;
  abort contracts (never start a dispatched mutation; dispatched mutations
  reconcile to completion) tested across lane/preflight/inspect windows;
  generation/restart-epoch fencing correct for reset-mid-teardown, killed
  siblings sharing one restart, late aborts, and all three exec variants;
  sweep races (foreign sweep rechecks inside the victim's lane; beginOp
  touches before joining the global sweep chain) tested, and the remaining
  mid-rm window (first call after >idleHours silence landing exactly during
  a reap's rm) reconciles as an honest recreate — by-design semantics, not
  a leak; no boot/shutdown hooks anywhere; `warnIfStranded` naming every
  container with the manual `podman rm -f` line (tested).
- **Desktops lifecycle**: pool cap via synchronous check-and-add over rows ∪
  `pendingAllocs` (racing allocation and adoption counted — tested); lease
  claim/renew/release/handoff/expiry with holder-only semantics; observation
  consumption + identical-action-on-unchanged-frame refusal; boot-generation
  invalidation on stop, out-of-band restart, recreate, and destroy/re-allocate
  (clock-pinned test); shots retention pruning oldest-first with destroy
  freezing the trail (matches design/subagents.md:125-128); cpIn staging —
  root stages at a goblin-chosen path under the root-owned
  `/run/goblin-import`, `chmod 0644`, desk performs the destination write,
  pre/post regular-non-symlink checks, stage cleanup in `finally`
  (desktops.test.ts:1408-1457 pins the whole dance); reaping skips leased,
  reserved, fresh, and refuses unlabelled containers.
- **Lane fencing probe** (DESIGN.md → Non-goals): nothing in the scoped
  modules reaches operator state, app doors, memory, or fetch — no such
  imports exist; the fence itself lives in the turn/telegram and tool layers
  (hunts 9/10), noted as pointers, not chased.
- **Registry consistency across crashes**: desktops WAL + idempotent
  upsert, `boot_gen` migration guard with NULL-as-unknown fail-closed
  semantics, obs-id persistence across a store reopen (tested); sandboxes
  store same shape (plus the busy_timeout F2 doesn't have).

## 3. Couldn't verify / untraced rules

- **Nothing was executed.** Per the operator override the suite and
  typecheck were not run, so every finding above is static analysis; the
  orchestrator's green pass does not contradict any of them (F1 is
  env-gated, F2/F3/F7 have no covering test).
- **F6 (podman cp colon parsing)** needs a real podman to confirm — probes
  are forbidden here. Unverified lead, containment-safe either way.
- **F4's intent**: no written ruling found for the desktop fail-closed row
  disposition; the code comment asserts it deliberately. I did not invent a
  citation — the tension is quoted, the ruling is missing.
- **Live wall facts** (caps as `CapEff`, uid-map arithmetic landing
  container root at host 139999, network isolation): taken as measured in
  design/sandbox.md; the live gates (`podman.live.test.ts`,
  `desktops.live.test.ts`, `sandbox.integration.test.ts`) were left unrun
  per the rules. Their headers' store-safety rules (own names, drift labels,
  no prune) match the code.
- Residual edges I judged acceptable rather than findings: a killed exec
  whose recovery restart itself fails leaves a possibly-running orphan
  until the next lifecycle event (the failure is loud, engine-down
  context); `resolveExportDir`'s mkdir-vs-symlink-swap window can seed
  empty directories outside the workspace before the realpath refusal
  (writes stay FD-pinned; the narrowing is documented in the module
  header).

## 4. Simplifications & code smells (operator addition; P3, evidence-backed)

- **S1 — dead code: `Podman.listByLabel`.** Declared and implemented
  (`src/podman.ts:166`, `:429-440`) with zero callers across `src/` and
  `app/` (grep confirms only its own definition). Adoption became
  name-driven; the label-listing surface is unused. Delete it.
- **S2 — duplicated fail-closed `applyNetwork` (~95 lines, two copies).**
  `src/sandbox-lifecycle.ts:54-127` and `src/desktops.ts:458-528` are the
  same algorithm with exactly one real divergence (row kept vs row
  deleted — F4). That is the copy where the cited design rule silently
  forked; a shared module (or a shared test table) would have surfaced it.
  Highest-value simplification in this scope.
- **S3 — duplicated `catFile` probe/read.** `src/sandboxes.ts:542-591` vs
  `src/desktops.ts:1489-1540` — same probe, same cap, same error text; F3's
  misreport exists twice because of the copy. The probe-check condition
  already drifted once (`timedOut ||` present only in the desktop copy).
- **S4 — near-unreachable, misattributed reap-chain catch.**
  `src/desktops.ts:797-799`: the per-victim `try/catch` at `:784-793`
  already swallows reap failures, so the outer `run.catch` is practically
  dead — and when it does fire it logs `desktop: name` with the *enqueueing*
  desktop, not the victim. Debugging red herring; remove or attribute
  correctly.
- **S5 — `reset` runs `imageExists` twice per call.**
  `src/sandboxes.ts:637` (`requireImage`) then `:645`
  (`prepareContainer`, which repeats `imageExists`,
  `sandbox-lifecycle.ts:139`). The ordering rationale (image gate visible
  before the rm) doesn't need two podman round trips — calling
  `prepareContainer` alone before the rm preserves the ordering and the
  pull-line error.
- **S6 — misleading-by-omission `$0` in the launcher.**
  `deploy/desktop/goblin-launch:40-41,48`: `sh -ec '<script>' goblin-launch
  "$@"` uses `goblin-launch` as the inner shell's name; it reads exactly
  like recursive re-invocation (it fooled this reader into a false P1 until
  the test pins disproved it). One comment word ("`goblin-launch` is only
  the inner sh's $0 — `$@` is the app argv") would prevent the misread.
