> Audited 2026-10-23 18:42 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 19 — boot & config core (config, config-pins, durable, sqlite, log, proc, targets, index)

Read-and-report pass over the scoped files, static reading only (operator
override: no suite/typecheck runs; one scratch experiment run under /tmp,
documented below). Governing spec: DESIGN.md → "Config", "State layout",
"Module map"; AGENTS.md → Guardrails.

## 1. Findings (most severe first)

### P1-1. `http.port` is boot-bound and Settings-editable but absent from the boot-pin comparison — a settings save changes the file, applies nothing, and produces no warn and no restart hint

- **Where:** `src/config-pins.ts:9-17` (`BootPins` has no `http` field) and
  `src/config-pins.ts:22-31` (`bootPinnedDiffs` never compares it). Evidence
  chain: `src/index.ts:770` / `src/http/mod.ts:105` bind
  `configRef.current.http.port` exactly once at boot;
  `src/http/operator.ts:248` whitelists `http` in `CONFIG_POST_KEYS` and
  `src/http/operator.ts:323` (`{ ...normalized, ...body }`) persists a body
  port into goblin.json5; `app/src/SettingsView.tsx:2259-2265` is an editable
  "Http port" field; `src/index.ts:726-733` builds `BootPins` without it.
- **Rule violated:** the pin module's own contract, `src/config-pins.ts:1-4`:
  "Boot-pinned config keys: these blocks bind at boot — adapters, endpoints,
  auth refs and pool limits are one snapshot — so a mid-run change is a warn
  + restart, never a hot-apply. One comparison serves the config-write log
  warns and the status card's restart hints." `http.port` is exactly an
  endpoint that binds at boot, it is editable through the settings door, and
  the one comparison does not carry it. (`wireConfigWrite`'s header
  repeats: "hot-apply what's live, warn on what's boot-pinned" — for this key
  it does neither.) This is a module-contract violation, not a DESIGN.md
  section; DESIGN.md → "Config" ("Settings owns routine configuration …
  `goblin.json5` is its persisted state") is the context that makes the
  settings door the plausible path.
- **Trigger / observable:** in Settings → Access, change "Http port", save.
  The save succeeds ("config written via …" is logged), goblin.json5 now says
  the new port, the HTTP server keeps listening on the old one,
  `onConfigWritten` emits no warn line, and the status card's restart hints
  (`restartHints: () => bootPinnedDiffs(pins, configRef.current)`,
  config-pins.ts:104) stay empty. Mitigation found: the field's static
  caption says "Restart applies." (SettingsView.tsx:2265) — but the hints
  system exists precisely to track pending restart-required changes, and it
  never lists this one.
- **Test sketch:** extend the `bootPinnedDiffs` table test
  (config-pins.test.ts:75-85) with `["http", 'http:{port:9999}', "http"]`
  after adding `http` to `BootPins`/`pinsFor`; red today because the key
  cannot be reported.

### P3-1. `responsibilityTargetOf("resp:")` returns `""`, not null — an empty pseudo-address counts as a responsibility id

- **Where:** `src/targets.ts:60-62` — `target.startsWith("resp:") ?
  target.slice("resp:".length) : null`. `"resp:"` slices to `""`, and every
  consumer keys on `!== null`: `src/programs.ts:96-97`
  (`isProgramTarget = validTarget(target) || responsibilityTargetOf(target)
  !== null`) accepts `"resp:"` as a valid program target/row target.
- **Rule violated:** the function's own doc comment (targets.ts:51-56)
  frames the pseudo-address as "a canonical non-empty string"; an empty id
  is not an id. Invariant hygiene (AGENTS.md → Guardrails: validate at
  boundaries).
- **Reachability (why only P3):** model-supplied targets are gated by
  `validTarget` (`program-proposals.ts:265`), which refuses `resp:`; resp:
  rows are minted only by trusted code with real ids
  (`programs.ts:599`, `responsibilityTarget(realId)`). I found no input
  boundary that can mint `"resp:"` today — this is defense-in-depth hygiene
  on the parse side.
- **Test sketch:** `expect(responsibilityTargetOf("resp:")).toBeNull()`.

### P3-2. The app/telegram sink-routing rule is implemented twice — once in its owning module, once re-written in `index.ts` wiring

- **Where:** `src/index.ts:586-589`:
  `sinkFor: (conv) => channelOf(conv.id) === "app" || wakeDeps.delivery ===
  undefined ? wakeDeps.bell(conv) : wakeDeps.delivery(conv)` vs
  `src/wake.ts:136-141` (same channel branch with a refuse-instead-of-bell
  fallback).
- **Rule violated:** DESIGN.md → "Module map": "`index.ts` wires and never
  rules: a rule with no owning module gets one before it may live here."
  The rule ("app conversations take the bell; telegram/guest take
  delivery") HAS an owning module (wake.ts:122-142) — index.ts re-implements
  it with different fallback semantics (bell instead of refuse), so the two
  copies can drift silently. P3 because the divergence is deliberate for
  the detach case (index.ts:538-540 comment) — but the deliberate exception
  living only in the wiring copy is exactly the drift hazard the rule bans.
- **Fix direction (not applied):** wake.ts exposes a `sinkFor(deps, conv)`
  that owns both the branch and the documented detach fallback; index.ts
  passes `wakeDeps`.

### P3-3. The desktops SQLite handle is opened at boot and never closed — the only store handle shutdown forgets

- **Where:** opened at `src/index.ts:693` (`openDesktops(paths.db())` inside
  `makeDesktops`), `close` exists (`src/desktops.ts:244`) but has **zero
  callers anywhere** (grepped src/ and scripts/). Shutdown closes every
  sibling: `store.close()`, `programs.close()`, `outbox.close()`,
  `delegations?.close()` (index.ts:1145-1148), `subagentRuns.close()`
  (1143, budget-conditional); `subagents.close()` → `ownerClose`
  (subagents/mod.ts:711-723) does not touch desktops either. The returned
  `desktops` object (index.ts:1030) is not even destructured for shutdown.
- **Rule violated:** consistency of the shutdown close ritual; DESIGN.md →
  "State layout" (SQLite durability = WAL + transactions) makes close-time
  checkpointing the payoff. Impact is bounded — `process.exit(0)` follows,
  WAL recovers on next open — so P3 hygiene, not data loss.
- **Test sketch:** none worth a behavior test; a `desktops.close()` call in
  the shutdown sequence (budget-joined like subagentRuns) is the fix shape.

### P3-4. `sandboxConfigured`'s comment describes a `false` input the schema forbids — stale copy from tts

- **Where:** `src/config-pins.ts:41-43`: "Counts as configured only as an
  object — a bare `false` disables without counting." But the config union
  is `[sandboxConfigSchema, z.literal("")]` (config.ts:984-987) — `false`
  is rejected at load (fail loud), and `""` maps to `undefined`. Only
  `tts` accepts `false` (config.ts:883-892). Misleading-name/comment
  hygiene (P3 per report rules); the behavior itself is correct.

### P3-5. (lead) `emit()`'s `JSON.stringify` can throw into the log caller — cyclic or BigInt fields bypass the "sink must never take the process down" machinery

- **Where:** `src/log.ts:95-101` — `emit` stringifies
  `{ts, level, msg, ...fields}` with no guard; a caller passing a cyclic
  object or BigInt in `fields` makes `log.info(...)` throw
  TypeError into the caller's path. The file header (log.ts:1-4) and the
  careful cyclic-cause handling in `errFields` (log.ts:112-121 — "a cyclic
  cause object would throw inside the logger itself") show the design
  intent is that logger inputs must never crash the logger; `fields` is the
  unguarded sibling of the guarded `cause` path.
- **Labeled lead:** no written rule states `log.*` must never throw (the
  header covers the file sink); AGENTS.md's fail-loud could equally argue
  for throwing. Not verified at runtime (would need a scratch call with a
  cyclic field — considered too cheap a finding to spend the scratch run
  on; the stringify behavior is spec-certain).

### P3-6. (lead) `TRANSIENT_ERRNOS` omits `EDQUOT` — a quota-full disk permanently kills the file sink for the run

- **Where:** `src/log.ts:31` — transient set is
  `{ENOSPC, EIO, EAGAIN, ENFILE, EMFILE}`. EDQUOT (quota exceeded) is the
  same class as ENOSPC (clears after operator frees space, no restart
  needed), but it falls to the permanent path (log.ts:81-83): sink dead
  until the next process restart, exactly when "a full disk is exactly when
  the durable log matters most" (log.ts:3-4). Filesystem-dependent edge;
  no doc ruling on which errnos are transient, so P3 lead.

### P3-7. (lead) drain-cut `reader.cancel()` rejection is only logged — a rejected cancel may leave that collector's `read()` forever pending

- **Where:** `src/proc.ts:211-219` — the drain cut calls
  `void r.cancel().catch(...)`; if cancel() rejects asynchronously (the
  sync-throw case is handled at 216-218, the async case is only logged),
  the reader's pending `read()` (proc.ts:112) may never settle, hanging
  that collector's promise and thus `boundedRun` — the exact
  never-settles class the brief probes. Could not construct a stream whose
  cancel() rejects while a read is pending under Bun, so unverified; every
  other path was traced bounded (see §2).

**Counts: P0 0 · P1 1 · P2 0 · P3 7.**

## 2. Checked and found clean (later passes can skip)

- **durable.ts (all named probes):** mode preservation is exact — existing
  file's `statSync().mode & 0o777` re-applied with `fchmodSync` after open,
  so umask-stripped bits (0o664 under 022) survive (durable.ts:192-213,
  pinned by durable.test.ts:72-87, 161-175); fsync order is
  data→close→rename→directory-fsync (durable.ts:223-265), with the
  durability-unknown error wrapped loudly on dir-sync failure; tmp files
  live in `dirname(path)` so rename/link never cross devices
  (durable.ts:203-206, 234-244); short writes guarded (`n === 0` throws,
  durable.ts:219); every failure path discards the tmp; symlink leaves are
  resolved (managed links never replaced, dangling/cyclic fail loud,
  durable.ts:168-185, pinned by tests at 110-139); `exclusive` uses
  link(2) EEXIST semantics. New files deliberately keep umask semantics
  (documented at durable.ts:209-213) — not a bug.
- **proc.ts settle guarantee:** `exitP` is bounded on every branch — the
  race (`exited`/deadline/killP) is followed by `killAndReap`, itself
  bounded by 2×KILL_GRACE_MS; cap-overflow settles immediately (the
  collector breaks before the kill, proc.ts:114-119), the other collector
  ends by EOF-after-kill or the 250 ms drain cut; abort-before-start and
  listener cleanup are correct. **Scratch experiment (the one allowed,
  `/tmp/hunt19-proc-signal.ts`, `bun /tmp/hunt19-proc-signal.ts`):** Bun
  resolves `proc.exited` to `137`/`143` (numbers) for signal deaths, so the
  `typeof first === "number"` branch returns and a self-signal exit is NOT
  mislabeled `killed` — the suspicion that sandboxes.ts:480 would restart
  containers on OOM/segfault exits is disproven
  (`boundedRun` on `kill -9 $$` → `{"exitCode":137,"killed":false}`).
- **log.ts sink lifecycle:** permanent failure kills the sink after one
  stdout warn; ENOENT triggers mkdir+retry, and a transient on the retry
  degrades rather than dies (pinned by log.test.ts:110-129); degraded
  warns throttled to 1/min with recovery notice; stdout line always
  precedes the sink attempt; startup events bypass threshold and ordinary
  same-text info does not (pinned at log.test.ts:218-270); cyclic cause
  chains are seen-set- and depth-bounded.
- **config.ts (all named probes):** unknown keys rejected at every level
  (top-level and blocks `.strict()`, pinned at config.test.ts:743-763);
  `writeConfig` re-validates the incumbent before writing — malformed
  JSON5 and schema-invalid incumbents refuse with the file untouched
  (pinned at 765-779), and non-ENOENT read failures propagate; the save is
  a whole-file canonical rewrite (comments dropped, pinned at 685-705);
  ENOENT→null is the only special case in `loadConfig`; retired delegation
  keys are the one documented strip (load-time warn, config.ts:1104-1131);
  error text is scrubbed of input (only schema-owned field names + issue
  codes; JSON5 errors keep only a numeric line — pinned at 1365-1428);
  `superRefine` provider-ref checks include the disabled-telegram carve-out
  and the image/baseUrl rule; mode of a saved config is preserved
  (durableWriteFile, pinned at 801).
- **config-pins.ts comparisons:** `resolveAppAuth` is identity
  (http/app-auth.ts:13-23), so `pins.appToken` matches `cur.appToken`;
  `wireMemory` returns `config.memory` unchanged (memory/mod.ts:794-825),
  and all pinned blocks materialize defaults identically on every parse —
  no false-fire found on the normal path. Flip logging is once-per-flip,
  stranded-sandbox warn on removal only, `restartHints` live-reads
  (pinned by config-pins.test.ts).
- **targets.ts routing:** `parseAddress ∘ formatAddress` identity holds
  (conversation.ts:49-86, rolling-before-dm ordering correct, `dm:x:0` and
  leading-zero ordinals null); rolling DM rows deliberately pin
  `dm:<chat>` (header contract); guest rows project to the group chat
  address (delivery-equivalent); `telegramAddressOf` nulls rolling and
  guest ids; `appConversationOf`/`appIdOf` consistent; program-tool
  addresses never take threadId from model input (deps-supplied context
  only, program.ts:44-45,198-199), so no threadId-0 mis-parse is reachable
  from the tool door.
- **sqlite.ts:** `SQLITE_BUSY_TIMEOUT_MS` is applied by every opener of the
  shared state file (conversation.ts:601, programs.ts:383,
  mail-outbox.ts:136, sandboxes.ts:73, delegations.ts:184);
  WAL + `synchronous=FULL` (conversation.ts:590-594) meets the DESIGN.md →
  "State layout" NORMAL minimum.
- **index.ts boot order:** file sink attached before anything that can
  fail; unhandled-rejection/uncaught-exception handlers registered first;
  `ensureHomeLayout` before config load (all five repo skill templates
  exist under deploy/skills/); missing config → exit(1) loud; missing auth
  names warned at boot (existence only); `completeBoot` is single-fill with
  loud late-access errors; the telegram init task is sealed/detached on
  every exit path and joined by `stopTelegram` (pinned by boot.test.ts:
  degraded auth, 401 getMe, held getMe + SIGTERM seal, post-attach 401
  detach); shutdown joins all steps under the 10 s budget, closes stores
  in order, and logs rejected steps.
- **Out-of-scope pointers noted, not chased:** box-files.ts:222-224 writes
  through `/proc/self/fd/<n>` paths into durableWriteBytes* (resolveLeaf
  will realpath these — behavior worth a look in that file's own hunt);
  the settings If-Match freshness contract lives in http/operator.ts
  (hunt 7).

## 3. Couldn't verify / suspected without a written source

- **zod v4 object key-order normalization** — `bootPinnedDiffs`'s
  `JSON.stringify` equality (config-pins.ts:19-20) is key-order-sensitive
  for record-typed blocks (`delegation.machines`, `harnesses`,
  `providers`). If zod does not normalize record insertion order, an
  operator hand-edit that only reorders machine keys between boot and a
  settings save would produce a spurious "delegation config changed —
  restart to apply" warn (false-fire, never false-quiet). Not verified
  (would have spent the scratch run on a low-impact question); no written
  ruling either way.
- **proc.ts cancel-rejection hang (P3-7 above)** — cannot force a Bun pipe
  stream whose `cancel()` rejects while a read is pending; lead only.
- **log.ts P3-5** — the "logger must not throw on weird fields" rule is my
  inference from the file's own header and its guarded cause-path; no doc
  states it outright.
- **Bun stdout write behavior on a closed/broken stdout** (EPIPE during
  `process.stdout.write` in `emit`/`warnStdout`) — not probed; under
  systemd/journald the pipe stays open, so judged theoretical.
- No P0 found: address parsing (the named P0 probe) round-trips correctly
  and every mis-parse candidate (`resp:`, `dm:x:0`, threadId-0, guest
  collapse) either fails closed or is unreachable from an input boundary.

## 4. Simplifications & code smells (operator addition; P3-level, evidence-backed)

- **Three copies of the shim-refresh function** — `refreshMcpShim`
  (config.ts:198-219), `refreshGoblinMailShim` (config.ts:223-246),
  `refreshDoctorShim` (config.ts:248-271) are line-for-line identical
  except shim path and target (24 lines × 3). One
  `refreshShim(shim: string, target: string, label: string)` replaces all
  three; the "which shims exist" list becomes data.
- **`validTarget`'s `? true : false` ternary** — targets.ts:45-49 ends in
  `… ? true : false`; the predicate itself is the boolean. Also the
  excluded kinds (rolling, guest) are implicit in the enumeration — one
  comment line would prevent the next reader from "fixing" it.
- **`sinkFor` duplication** (finding P3-2) doubles as the highest-value
  simplification: deleting index.ts:586-589 in favor of a wake.ts-owned
  `sinkFor` removes a rule from the wiring file and closes the drift
  hazard in one move.
- **`configSchema.in.shape` reach-in** — config.ts:1192 digs
  `.in.shape` out of a transform+superRefine-wrapped schema to scrub error
  fields. Works (suite-green pins it), but it is coupled to zod's
  effects-introspection details; hoisting the bare `z.object(...).strict()`
  into a named `configShape` variable and deriving both the schema and the
  scrubber's key set from it would be refactor-proof.
- **`durableCopyFile` vs `durableWriteBuffer` near-duplication** — the
  tmp-write/fsync/rename/dir-sync ritual appears twice with subtly
  different fchmod policy (unconditional in the copy at durable.ts:84-88,
  existed-conditional in the write at durable.ts:213). Both policies are
  deliberate, but the shared ritual could be one helper taking a
  `preserveMode: "exact" | "ifExisted"` choice, removing the two copies of
  the short-write guard, discard-on-failure, and dir-fsync error wrap.
- **`telegramMailApproval`/`telegramProgramApproval` vs `mailApproval`/
  `programApproval` asymmetric optionals in shutdown** — index.ts:1085
  calls `mailApproval.stop()` unguarded while 1091 uses
  `programApproval?.stop()`; both are unconditionally assigned before boot
  returns (index.ts:453, 463). Harmless (typecheck-narrowed), but the
  asymmetry reads as a real optionality difference that does not exist.
