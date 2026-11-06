> Audited 2026-10-23 18:37 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 20 — ops/deploy scripts (read-and-report)

Scope per brief: scripts/{deploy.sh, deploy.test.ts, publish-app.sh, install.sh,
install.test.ts, install-options.ts, install-options.test.ts, check-app-assets.ts,
check-cache-contracts.ts, check-cache-contracts.test.ts, cache-report.ts,
cache-report.test.ts, comment-audit.ts, function-size-audit.ts, loop-calibrate.ts,
reviewer-stats.ts, replay-v7-history.ts, backup-state.sh}, deploy/{goblin.service,
goblin-herdr.service, goblin-keys.service.in, goblin-keys.timer}.
Governing spec: docs/operations.md, design/setup.md, AGENTS.md → Live services.
Static reading only (operator test override honored: no suite, no typecheck);
no mutating script executed; no live service touched; no secret read.

---

## 1. Findings (most severe first)

### F1 — P1: deploy.sh's client-rebuild trigger misses `src/tags.ts`, so a backend-only deploy ships a stale client

- **Where:** `scripts/deploy.sh:223-230`, regex at line 224:
  `grep -qE '^(app/|package\.json$|bun\.lock$|src/agent/tools/ui-schema\.ts$)'`
  vs `app/src/markdown.tsx:10`: `import { isMachineryText } from "../../src/tags.ts";`
- **Violated rule:** docs/operations.md → Deploying: "the client is served from
  disk, so client and backend restart as one rollout" — the served bundle must
  correspond to the deployed revision. The script's own comment
  (deploy.sh:226-227) states the invariant it intends to keep: "The bundle
  inlines dependencies and the shared UI schema, not just app/." — the shared
  inlined surface is enumerated incompletely.
- **Evidence the bundle inlines it:** `src/tags.ts:22` exports
  `isMachineryText` (runtime value, not a type); the published slot
  `app/dist.b/assets/index-B8Lm_6vx.js` contains the `[program: ` /
  `[delegation: ` literals of its body (verified by grep). An exhaustive scan
  of non-test `app/src` found exactly two runtime value imports crossing into
  `src/`: `app/src/ui/UiPart.tsx:8-12` (ui-schema — covered by the regex) and
  `app/src/markdown.tsx:10` (tags — not covered). Everything else is
  `import type` (erased at build).
- **Triggering path:** any commit touching only `src/tags.ts` — highly
  plausible: it is shared machinery-text classification imported by six
  backend modules (`src/conversation.ts`, `src/turn-resume.ts`,
  `src/scheduler.ts`, `src/delegation-lifecycle.ts`, `src/memory/mod.ts`, …),
  so tuning it is a routine backend change. deploy.sh restarts the backend on
  the new logic, skips `bun run app:build`/publish (no `app/`, manifest, or
  ui-schema path in the diff), and writes the new marker — the served client
  keeps rendering machinery text with the old rules until the next
  app-touching deploy. No crash; silently stale behavior — the marker and the
  served bundle disagree about what was deployed.
- **Test sketch (deploy.test.ts fixture):** `runDeploy(["src/tags.ts"])` —
  assert `result.calls` does *not* contain `"bun run app:build"` (it won't —
  that documents the bug), then fix the regex to include
  `|src/tags\.ts$` and flip the assertion. Same shape as the existing
  `"src/agent/tools/ui-schema.ts rebuilds the inlined client"` test.

### F2 — P1: replay-v7-history.ts raw-copies the live DB + `-wal` + `-shm` — the exact operation docs/operations.md forbids while the bot runs

- **Where:** `scripts/replay-v7-history.ts:13-24`:
  `cpSync(live + suffix, …)` for suffixes `""`, `"-wal"`, `"-shm"`, while the
  header (lines 1-4) advertises live-safety: "Works on a COPY of the live DB;
  never opens the service's own file."
- **Violated rule:** docs/operations.md → Backups: "Never `cp` `goblin.sqlite`
  or its `-wal`/`-shm` sidecars while the bot runs — a raw copy can split a
  WAL commit mid-flight and restore nothing." The script never checks whether
  the service is running, and nothing in it or the docs says to stop the bot
  first; its "never opens the service's own file" wording reads as
  live-safe.
- **Triggering path / failure mode:** run the script as documented while
  goblin is live (the normal state). If SQLite auto-checkpoints between the
  `cpSync` of the main DB and of the `-wal` (checkpoint writes frames into
  the main DB, then resets the WAL), the copy mixes pre-/post-checkpoint main
  DB pages with a reset WAL — either an internally inconsistent copy that
  replays wrong (false `[strict]`/`[convert]` failures → the operator
  concludes the v7 migration broke history when it didn't) or an uncaught
  SQLITE corruption error. Copying `-shm` is also pointless (recovered from
  the WAL on open). The doc's sanctioned alternative is sqlite3 `.backup`
  (what backup-state.sh uses, quoting-free by running it relative in the
  target dir).
- **Test sketch:** a test that runs the copy phase against a fixture DB with
  a seeded WAL, then checkpoints the source between the two copies (or simply
  asserts the script shells out to `sqlite3 … .backup` / refuses when
  `systemctl --user is-active goblin` says active).

### F3 — P3: publish-app.sh `ln -s` (no `-f`): a leftover `app/.dist.tmp` wedges every later publish

- **Where:** `scripts/publish-app.sh:41-42`: `ln -s "$nxt" .dist.tmp || fail …`
  followed by `mv -Tf .dist.tmp dist …`.
- **Rule context:** AGENTS.md → Live services frames publishing as the atomic
  coordinated rollout step; a wedged publish blocks every client-touching
  deploy (deploy.sh:229 `bash scripts/publish-app.sh` fails → deploy FAILED →
  rollback recipe printed) until an operator hand-removes the file.
- **Triggering path:** crash/kill/power-loss precisely between `ln -s` and
  `mv` leaves `app/.dist.tmp` behind. Next publish: `ln -s` fails with "File
  exists" → `fail "cannot create swap link"` — every time, until hand-removed.
  Also not covered by `.gitignore`'s `app/dist*` (dotfile), so it lingers as
  an untracked file deploy.sh merely names. `ln -sfn` (or `rm -f .dist.tmp`
  first) removes the wedge with no behavior change. Failure is loud; window
  is tiny — hence P3.

### F4 — P3: deploy.sh GOBLIN_HOME parsing truncates on a value containing a space

- **Where:** `scripts/deploy.sh:266-267`:
  `grep -o 'GOBLIN_HOME=[^ ]*' | head -1 | cut -d= -f2-`.
- **Rule context:** brief's "path substitution quoting (spaces, empty vars)"
  probe. `systemctl show --property=Environment --value` quotes values that
  contain spaces (`"GOBLIN_HOME=/home/my goblin"`); `[^ ]*` stops at the first
  space, the path resolves wrong, and the deploy continues with
  "goblin.log not resolvable" — deploy annotations (the
  "deploy restarting goblin" / "restart accepted" lines that
  docs/operations.md → Deploying requires for distinguishing deploy restarts
  from incidents) are silently absent. Empty/unset is handled
  (`${goblin_home:-unset}`); today's value `/home/daniel/goblin` has no
  spaces, so this is an edge, not a live failure.

### F5 — P3: backup-state.sh rejects `08`-style keep counts with bash's octal error instead of the usage message

- **Where:** `scripts/backup-state.sh:14`: `[[ $keep =~ ^[0-9]+$ ]] && ((keep >= 1))`.
- **Rule context:** docs/operations.md → Backups documents
  `backup-state.sh 30`; an operator passing a zero-padded number (`08`) gets
  bash's `08: value too great for base (error token is "08")` on stderr plus
  the usage line — the guard works (exits 2) but the error path is confusing
  noise. Any argument `0[0-9]+` hits it. `10#`-forcing the arithmetic
  (`(( 10#$keep >= 1 ))`) makes the guard mean what it appears to say.

### F6 — P3: check-cache-contracts.ts top-level catch discards all failure context

- **Where:** `scripts/check-cache-contracts.ts:156-164`: `catch {
  process.stderr.write("check-cache-contracts: failed\n"); process.exitCode = 2; }`.
- **Rule context:** AGENTS.md → Execution discipline: "Fail loud. Never
  swallow exceptions; every failure surfaces with enough context to debug
  it." An unexpected throw (e.g. from `cacheContractFresh` or the report
  serialization) collapses to a context-free one-liner; the per-source
  diagnostics on stderr do not cover it. Printing the error message (these
  are public-docs fetches; no secrets ride this path) costs nothing.

Counts: **P0 0 · P1 2 · P2 0 · P3 4**.

---

## 2. Checked and found clean (later passes can skip)

- **deploy.sh gate ordering:** the typecheck gate (deploy.sh:219-220) is
  unconditional; deps sync (212-214) precedes it so the gate reads new_rev's
  tree; the post-gate HEAD re-verify (247-248) plus tracked-tree re-check
  with `--untracked-files=no` (249-252) closes the sibling-commit/edited-
  during-gate hole; untracked files are named and deployed per
  docs/operations.md → Deploying. No path reaches the restart without the
  gate passing.
- **deploy.sh preflight:** service WorkingDirectory identity check incl.
  symlink canonicalization and linked worktrees; marker shape/validation
  (40/64-hex, object type via `cat-file --batch-check` with diagnostics so a
  corrupt object can't masquerade as "missing" — and a test proving it);
  attempt-marker shape checks (symlink/directory/unreadable/unwritable all
  fail loud); marker-dir writability; deploy lock (`flock` fd 9, 15 m
  bounded wait) blocks marker-regression and stale-artifact races.
- **deploy.sh partial-failure states:** attempt marker published
  durably (tmp+fsync+rename+dir-fsync) before any mutation, never cleared by
  the trap, removed only after full verification; every nonzero exit after
  publication prints either the automated rollback recipe (only when the old
  rev is known and resolvable) or the manual recovery steps — matching
  docs/operations.md → Deploying, including "never rolls back
  automatically"; successful marker written with the same durability
  discipline the repo mandates.
- **deploy.sh never pushes/fetches/pulls** (no such invocations; deploy.test.ts
  proves via call log); `deploy/memory/` changes print the manual runbook and
  are never auto-applied (test-covered); the memory probe distinguishes
  podman-absent (skip), container-absent+unit-not-found (skip),
  container-absent+unit-loaded (fail), inspect failure, and unhealthy (fail)
  — the `else`-branch `status=$?` correctly captures `podman container
  exists`'s exit code, matching docs/operations.md's "distinguishes missing
  Podman or an absent container from a failed probe".
- **deploy.sh rollback recipe** matches docs/operations.md → Deploying
  verbatim (`git reset --hard <old> && bun install --frozen-lockfile &&
  bun run app:build && bash scripts/publish-app.sh && systemctl --user
  restart goblin && echo <old> > marker && sync`), `%q`-quoted marker path;
  deploy.test.ts asserts it byte-for-byte on success and failure.
- **publish-app.sh atomicity:** the served path flips via
  `ln -s <slot> .dist.tmp && mv -Tf .dist.tmp dist` — a rename(2) over the
  symlink, atomic per request; `rm -rf "$nxt"` only ever targets the
  non-served slot; unexpected `dist` types are refused; staged build must
  carry `index.html`; the one-time legacy real-dir→slot migration gap
  (move before flip) is documented in the header as one-time, inside the
  deploy gate.
- **install.sh:** thin exec wrapper (bun resolution + `--no-install`); the
  fresh-only refusal itself lives in install.ts (out of scope) —
  install.test.ts proves refusal happens before dependency sync/unit
  mutation for: existing unit, dangling unit symlink, LoadState=loaded,
  manager query failure, insecure auth mode, and spawn failure
  (design/setup.md → Product shape, "Fresh targets only").
- **install-options.ts:** last-record-wins fold matches loadAuth semantics;
  warm profiles are config-referenced records only; no credential command is
  ever executed (tests prove with a boundary probe); malformed/unsupported
  records fail safely without echoing values.
- **backup-state.sh restorability:** sqlite3 `.backup` output is a complete
  standalone database (no WAL sidecars needed — docs/operations.md →
  Backups); `quick_check(1)` gates the result; same-second rerun refuses to
  overwrite; the dot-command target is stamp-shaped and run relative inside
  the backup dir so an apostrophe in GOBLIN_HOME can't break sqlite's
  tokenizer; pruning touches only stamp-shaped files and pairs the `.json5`
  sidecar; trash-put preferred over rm when present.
- **check-app-assets.ts:** exits nonzero on any non-pass (typed detail
  printed); no skip path that could exit 0.
- **check-cache-contracts.ts:** exit codes match the doc (1 on
  changed/unavailable/overdue, 2 unexpected); "unknown" (no pinned
  fragments) stays ok per docs/operations.md → Cache telemetry; https-only
  and no-credentials enforced across the whole redirect chain (≤5 fetches,
  shared 15 s budget, 1 MiB cap, Accept: text/markdown); the JSON report
  carries ids/urls/statuses only — never page content (tests use a sentinel
  body).
- **cache-report.ts:** the count selects the most recent parseable receipts,
  not lines (per doc); duplicate callIds rejected; per-row sanity
  (cacheRead > input invalid, 0 ≠ null); curve buckets admit only
  append/same prefix relations; 64 MiB input cap.
- **replay/audit read-only claims:** reviewer-stats.ts only reads the log and
  `statSync`s the workspace; loop-calibrate.ts opens the DB
  `{readonly: true}` (its live system1 calls are its documented purpose, not
  a hidden mutation); replay-v7-history.ts writes nothing outside its tmp
  copy (the copy itself is F2).
- **systemd units:** no quadlets in scope, so no HealthCmd metacharacter
  exposure; `StartLimitIntervalSec=0` correctly in `[Unit]` (both services,
  with the comment explaining why); `Restart=on-failure`/`RestartSec=5`
  matches docs/operations.md → The service ("5-second delay, never gives
  up"); goblin-keys.service.in is `Type=oneshot` + `Restart=on-failure` +
  `RestartSec=60` (legal, matches "retrying failures every 60 s"); the
  `.in` guard and `@WARM_AUTH_PROFILES@` placeholder are documented, and
  install.test.ts proves the rendered unit rewrites the pinned MCP line to
  the resolved executable (the hardcoded `/home/daniel/...` path in the
  template does not survive rendering); goblin-keys.timer's 06:30/18:30
  `Persistent=true` matches the doc; weak deps (`Wants=` without ordering
  for keys; `Wants=`+`After=` for herdr and the podman network stub) match
  the documented degrade-not-fail intent; service PATH env covers the auth
  tool locations per the unit comments.
- **Test files (deploy/install/install-options/check-cache-contracts/
  cache-report):** fixtures fake only external boundaries (PATH-restricted
  stubs, real git in a scratch repo), assert ordering (deps sync before
  gate; identity floor before restart; restart before watcher), assert no
  secret echo (FIXTURE_SECRET sentinels), and cover the A→B→C interrupted
  sequence proving the attempt marker — not the diff — forces refresh. No
  incorrect expectations found; the suite is green per the operator's run.

---

## 3. Could not verify (and scope note)

- **scripts/install.ts is not in this hunt's file list** even though
  install.sh is a 10-line exec into it — every installer behavior of
  substance (existing-target refusal logic, unit rendering/substitution,
  PATH resolution, cancellation groups, startup acceptance invocation)
  lives there. I verified it only through install.test.ts's contract. If no
  other hunt owns install.ts, it is an uncovered gap.
- **scripts/check-startup.ts** (invoked by deploy.sh with the watch-floor
  args) is out of scope; deploy.sh's side of that contract (floor read
  before restart, 75 s budget, allowlisted brief on failure) is taken from
  the script text and its test fixtures, not from check-startup.ts itself.
- **Live-system behaviors** (systemctl show output shapes, `mv -T`
  atomicity on the real fs, podman exit-code contract, journalctl
  availability of `--since @epoch`) were verified only against the shipped
  test fixtures and standard semantics, per the rules of engagement.
- **F1 exhaustiveness:** the "exactly two runtime value imports from src/"
  claim is from an exhaustive `rg` over non-test `app/src` for both
  single-line and multi-line `import {…} from "…../src/…"` — a dynamic
  import or an intermediary module inside `src/` that itself value-imports
  further `src/` files into the bundle chain (e.g. ui-schema.ts importing
  other src modules at runtime) would widen the gap beyond `src/tags.ts`;
  I did not chase the transitive value-import closure of ui-schema.ts.
  The finding stands on tags.ts alone; the transitive check is a lead.
- **backup-state.sh prune order** uses mtime (`ls -1t`), not stamp order —
  a stamp-shaped file with a touched mtime could outrank a newer stamp. I
  found no written rule saying which ordering "newest" means
  (docs/operations.md → Backups says only "prunes only its own stamp-shaped
  files to the newest keep"), so I am not filing it as a violation; noted
  here as an ambiguity, not a citation-backed finding.

---

## 4. Simplifications & code smells (P3-level, evidence-backed)

1. **deploy.sh:147-148 — fake filenames as a control-flow encoding.** The
   first-deploy "refresh everything" path synthesizes
   `changed_paths=$'bun.lock\npackage.json\napp/src/x.ts\ndeploy/memory/env'`
   — `app/src/x.ts` and `deploy/memory/env` are phantom files that exist
   only to trip the three downstream regexes (212, 224, 231). A reader must
   reverse-engineer which regex each phantom arms, and the trick silently
   breaks if a regex is reworded (e.g. `app/src/x.ts` no longer matching
   `^app/`). Two explicit booleans checked at the three sites would say
   what it means. (The deploy.test.ts assertions on the memory note for
   first deploys depend on this coupling too.)
2. **deploy.sh:22-43 — annotate_log duplicates the jq invocation.** The
   `was` and no-`was` branches differ by one `--arg` and one object key;
   the whole function could be one `jq -cn` building `was` conditionally
   (`--arg was "${2-}"` + `({rev:$rev} + (if $was=="" then {} else {was:$was} end))`).
   Eight lines of near-copy for zero behavioral difference.
3. **deploy.sh:267 — grep|head|cut pipeline for one field.** The
   GOBLIN_HOME extraction is a three-stage pipeline where one parameter
   expansion on the first env word would do (`w="${unit_env%% *}"; …`), and
   the pipeline is the same code that breaks on spaces (F4). Misleading
   robustness: it looks careful, it isn't.
4. **console.log vs process.stdout.write inconsistency across sibling
   scripts.** reviewer-stats.ts:3-5 documents the convention ("Prints via
   process.stdout.write — a CLI, not a goblin process"), and
   comment-audit.ts / cache-report.ts / check-cache-contracts.ts follow it;
   function-size-audit.ts:129-137 and replay-v7-history.ts:40-56 use
   `console.log`/`console.error` instead. No behavioral difference today;
   the documented convention is simply not held repo-wide.
5. **replay-v7-history.ts:14 — mkdtemp dir never cleaned up.** Every manual
   run leaves `/tmp/goblin-replay-*/` with a full DB copy behind. One-shot
   tool, so it's hygiene only — but the copy contains conversation state,
   which the docs are careful to keep out of stray locations
   (docs/operations.md → Logs: "Keep raw logs private").
6. **comment-audit.ts:41 vs 46 — ratio logic written twice.** The sort
   comparator inlines `b.comments / (b.total || 1)` (and `a.…`) while
   `ratio()` four lines below implements the identical total===0→0 rule;
   the comparator predates the helper it duplicates. Use `ratio(a) - ratio(b)`.
7. **publish-app.sh:41 — `ln -s` where `ln -sfn` expresses the intent**
   (cross-referenced with F3): the flagless form is only "simpler" until a
   stale `.dist.tmp` exists, at which point it is a wedge.
