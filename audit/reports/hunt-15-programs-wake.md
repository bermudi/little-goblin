> Audited 2026-10-23 18:07 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 15 — Programs & wake machinery

Scope: `src/programs.ts`, `src/program-approval.ts`, `src/program-hook.ts`,
`src/program-ops.ts`, `src/program-proposals.ts`, `src/scheduler.ts`,
`src/wake.ts`, `src/wake-store.ts`, `src/wake-dispatcher.ts`, plus colocated
tests. Governing spec: `design/programs.md`; file-header contracts on
`src/wake.ts` and `src/program-hook.ts`; AGENTS.md Guardrails.
Static read only; one scratch test written under `/tmp` (noted where used).
Test command per operator override: not run (orchestrator verified this
unchanged tree: typecheck clean, 4686 pass / 0 fail / 86 skip).

Severity tally: **P0: 0 · P1: 0 · P2: 1 · P3: 3** (plus 5 simplification
notes in the final section).

---

## 1. Findings

### P2-1 — One undecodable wake row wedges the entire wake pipeline, and the error line does not name the row

- **Where:** `src/wake-store.ts:572-573` — `reconcile()`'s classification
  loop runs `rowToRecord(row)` on every open wake with no per-row guard;
  `rowToRecord` (`wake-store.ts:323-343`) zod-parses the row
  (`wakeRowSchema.parse`) and throws on a mismatch. The consumer,
  `src/wake-dispatcher.ts:312-319`, wraps `reconcile()` in a try/catch that
  logs `"wake reconcile failed"` and **returns** — so the one bad row aborts
  classification of every open wake, every pump (boot, 15s ticker, run-end
  hook), forever.
- **Violated rule:** The exact hazard and ruling are written in this repo for
  the sibling table — `src/programs.ts:332-336` (`decodeScan`):
  "The two timer-driven scans decode row by row: one row the schema rejects
  (drift between versions, a hand edit) must cost that row an error line per
  tick, **not every other program its fire** — the scheduler scan is a
  synchronous interval callback, so a throw there is an uncaught exception
  and a restart loop on the same row." The wake pump is the same shape (a
  `setInterval` ticker, `wake-dispatcher.ts:416-419`) with strictly worse
  blast radius: not just fires but *all* wake delivery and settlement for
  every conversation stops. Additionally, the AGENTS.md logging bar — "a
  screenshot of weird behavior plus the log file must fully reconstruct what
  the process did… If explaining a symptom needs a REPL or a guess, the
  logging is insufficient" — is missed: the zod error names the failing
  *field*, never the `wake_id`, so the per-tick error line does not say which
  row is poisoned. (`design/programs.md` does not rule on wake rows
  specifically; the citation is the in-repo precedent plus the guardrail.)
- **Triggering input:** any `wake_deliveries` row the running schema rejects
  after it was committed by an earlier schema or a hand edit. The table's own
  CHECK only constrains `state`; SQLite's dynamic typing lets a TEXT land in
  an INTEGER column (e.g. `attempts = 'x'`), and a rollback deploy after a
  version that adds/renames a state or column leaves rows the old zod enum
  rejects. Concretely demonstrated (scratch test
  `/tmp/hunt15-scratch.test.ts`, case a): record two healthy developments in
  two conversations, corrupt one row via
  `UPDATE wake_deliveries SET attempts = 'x'`, then
  `wakes.reconcile(iso, () => null)` **throws** — the healthy wake in the
  other conversation never classifies, so `pump()` delivers nothing and
  settles nothing, every pass.
- **Test sketch:** exactly the scratch test above, plus an assertion that a
  dispatcher-level pump logs an error and returns with `toAppend` never
  reached; the fix pattern to test against is `decodeScan`-style per-row
  classification (error line carrying `wake_id`, row skipped).

### P3-2 — One corrupt proposal row breaks `list()`/`pending()` whole (read-time schema evolution defeats the "no committed row can fail its own reader" invariant)

- **Where:** `src/program-proposals.ts:549-554` — `list()` and `pending()`
  map every row through `rowToProposal`, which throws on a payload or
  snapshot the schemas reject (`:295-314`). One bad row fails every caller:
  the `program` tool's `list` verb (design: "`list` also surfaces pending
  proposals"), `review`'s lane scoping (`src/agent/tools/program.ts:358`
  reads `proposals.get`, same throw), and `program-approval.pending()`
  (`src/program-approval.ts:101-103`) which the app/http surfaces render.
- **Violated rule:** `design/programs.md` → Programs → Authority ruling:
  "the stored payload is validated inside the staging transaction **so no
  committed row can fail its own reader**." That holds at staging time only:
  `draftSchema`/`patchSchema` re-impose *input* limits at read
  (`PROPOSAL_CHARTER_MAX` at `program-proposals.ts:219-248`), so a later
  schema tightening (a lowered cap, a new bound) makes previously committed
  rows fail their own reader — the exact drift class `programs.ts:decodeScan`
  documents and guards for the programs table. The module already
  acknowledges the asymmetry for snapshots (`baseSnapshotSchema`
  deliberately carries no input caps, `:275-286`) but not for payloads.
- **Triggering input / proof:** scratch test `/tmp/hunt15-scratch.test.ts`,
  case b — stage a valid create proposal, then
  `UPDATE program_proposals SET payload = '{"name": 1}'`; both `list()` and
  `pending()` throw (verified). Realistic vector: schema tightening across a
  version boundary, or a hand edit.
- **Test sketch:** corrupt one payload row, assert `list()` skips it with an
  error line naming the proposal id and still returns the rest (mirroring
  `programs.test.ts` "due() and withMailFilter() skip an undecodable row and
  keep the rest").

### P3-3 — `create()` mints a `"resp:null"` row from a runtime-null `responsibilityId` (destination-union guard checks `undefined`, not null)

- **Where:** `src/programs.ts:591-601` — the union guard
  `(address !== undefined) === (responsibilityId !== undefined)` passes when
  `responsibilityId` is `null` and no address is given (`null !== undefined`
  is true, `false === true` is false → no throw);
  `responsibilityTarget(responsibilityId!)` then builds `` `resp:${null}` ``
  = `"resp:null"`, which `isProgramTarget` accepts
  (`responsibilityTargetOf("resp:null")` returns the non-empty string
  `"null"`), and the insert stores `responsibility_id = NULL`
  (`responsibilityId ?? null`).
- **Consequence:** the row reads as a *conversation*-destination program
  (`responsibilityId === null`), but its target `"resp:null"` projects to
  null on both channels — `telegramAddressOf`/`appConversationOf` both null —
  so every due fire hits `wakeTarget`'s `"program wake dropped — invalid
  target"` (`src/wake.ts:118`) and the occurrence is consumed
  attempt-once: a due-every-minute dead program logging an error per tick.
  Also reachable with `responsibilityId: ""` (target `"resp:"`,
  `responsibilityTargetOf("")` returns `""` ≠ null → accepted).
- **Violated rule:** AGENTS.md → Type safety ("Validate external input at
  boundaries") and the module's own header invariant "a program always has
  at least one trigger" family — the store boundary trusts the TS type for
  this field. Severity is P3 because every in-tree caller is TS-checked and
  passes a real string id or `undefined` (proposals never pass
  `responsibilityId`; the responsibilities service mints ids); the hole is
  open only to JS callers and future code.
- **Proof:** scratch test `/tmp/hunt15-scratch.test.ts`, case c —
  `programs.create({ name, charter, cron: "* * * * *", responsibilityId: null })`
  (cast around the TS type) yields a row with `target === "resp:null"`,
  `responsibilityId === null`, `chatId === 0`, and it appears in
  `due()`. The triggering test sketch is that scratch case plus one
  `fireScheduled` round showing the invalid-target error line and the cursor
  advancing.

### P3-4 — `markRan` / `advancePastDue` / `setHook` do read-then-write with no transaction, against the module's own second-connection discipline

- **Where:** `src/programs.ts:661-672` (`markRan`: `qGet` → `nextFire` on the
  read cron → unconditional `qMark`), `:673-681` (`advancePastDue`), and
  `:685-692` (`setHook`: `qGet` → `requireTrigger` on the read row →
  `qHook`). Compare `update()` (`:498-549`) and `setMailFilter`
  (`:550-560`), which wrap the identical read-then-write shape in
  `db.transaction` with the comment: "Reserve the writer before reading a
  row. A deferred transaction can read a stale WAL snapshot and fail on
  write; **without a transaction a second connection can replace the
  filter/cursor between these steps**."
- **Consequence if a second writer existed:** a cron edit landing between
  `markRan`'s read and write has its `next_run` clobbered by a value computed
  from the stale expression; a race around `setHook(id, null)` could strand a
  trigger-less row (violating "a program always has at least one trigger",
  `src/programs.ts:297-309`). In production there is exactly one programs
  connection (`src/index.ts:188`, one `openPrograms` call) and one JS thread,
  so this is hygiene, not a live bug — hence P3, same class the module's own
  comment names.
- **Test sketch:** two connections to one db file; connection B applies a
  cron patch between A's `get` and `markRan` (needs a seam or
  `SQLITE_HOOK`-style injection — the current signature has none, which is
  the finding).

---

## 2. Checked and found clean (skip in later passes)

- **Hook-token hygiene (the P0 probe): clean.** The raw token exists only in
  `program-hook.ts` helpers, `program-approval.decide` (mint → hash to the
  store, URL to the authenticated caller; `program-approval.ts:83-99`), and
  `program-ops.hook` rotate (mint → hash via `setHook`, URL in the op result;
  `program-ops.ts:179-185`). No `log` call in any scoped file carries the
  token or URL; every store column/param holds the sha256 (`hook_hash`,
  `setHook`, `approveTxn`'s `hookHash`). The route hashes before lookup
  (`src/http/mod.ts:76`), logs program id/name only, and returns 404
  identically for unknown and disabled tokens (no existence oracle,
  `:78`, `:82`).
- **wake.ts header contract (sink release on submit throw):** all three
  submit paths (`wake`, `wakeApp`, `wakeConversation`) construct the sink and
  release it via `sink.onDone({kind:"error"})` in the catch; the
  `!admitted` path needs no release because the runtime itself notifies
  fenced on a closed intake (`runtime.ts:389-392`), and `notifyDone` catches
  sink throws (`runtime.ts:615-625`). Covered by
  `wake.test.ts` ("a throwing submit is released and returns false").
  `void deps.markRoll(...)` is safe: the adapter catches its own errors
  (`tg/notify.ts:21-33`) and a global `unhandledRejection` logger exists
  (`index.ts:98-100`).
- **Epoch fencing for wakes:** `commit` stamps `claim_epoch` from the live
  conversation row inside the claim UPDATE (`wake-store.ts:295-297`);
  `reconcile` fails unlinked claims whose epoch drifted (`:610-611`) — a
  stale wake never lands on a new epoch's turn; pending wakes re-claim
  fresh. Tested ("unlinked claims survive a crash, but not a durable
  authority fence").
- **Exactly-once trigger append / crash recovery:** `commit` is one
  transaction (append + verify-by-message-id + CAS claim), a non-pending
  wake is returned unchanged, and `wake-store.crash.test.ts` SIGKILLs both
  real boundaries (post-record, post-append) — recovery appends once,
  resubmits without re-appending.
- **Cron boundary validation:** exactly-5-fields check before parse
  (seconds-field trap), invalid cron never becomes a row (`create`,
  `update`, `validateCreate`/`validateUpdate`, `program-ops.invalidCron`);
  legacy jobs with unparsable cron archive verbatim, never copy.
- **DST / catch-up sequencing:** `latestFireAtOrBefore`'s prev-candidate
  verification (forward-step reproduction + overshoot) with the capped
  forward walk; scheduler and programs tests cover spring-forward,
  fall-back, sparse-annual, and the two-year every-minute probe-decline in
  America/New_York; truncation degrades toward over-measured lateness
  (skip), never a stale fire.
- **Restart ordering (missed vs doubled fires):** `due()` is
  `next_run <= now` (boot catch-up is the same query); `markRan` advances
  from the scan time (coalesce-to-latest), grace skip uses
  `advancePastDue`, re-enable recomputes from now (skipped-not-owed),
  disable keeps the cursor harmlessly; the `pendingCursorWrites` fence
  retries the write with the original fire time and is dropped exactly when
  the row moved (deleted/disabled/rescheduled — tested for all three).
- **Trigger-owned post-submit accounting:** cron attempt-once (cursor
  advances on failed submit); webhook stamps `last_run` only on landed and
  leaves throttle/stamp open on failure (route owns retry; 503 when the
  runtime stopped accepting); mail holds the checkpoint on failed fire with
  `mail_revision` CAS winning mid-poll, mid-gate, and mid-fire races (all
  three tested); a responsibility-destination `recordDevelopment` throw
  leaves the occurrence due while a landed record precedes the cursor
  (enqueue-before-cursor, replay dedupe by occurrence key — tested including
  the crash-window correction replay).
- **Telegram-unattached hold:** `fireScheduled` holds (no fire, no
  `last_run`, no retry burn) before lateness/grace evaluation for
  Telegram-targeted rows; app and `resp:` rows unaffected; guest addresses
  cannot be program targets at all (`validTarget` rejects them). Tested.
- **Retry ladder:** retries only transient + `modelCalls === 0` + no sink
  output; unknown flags read not-retryable; timers keyed per
  program+occurrence; `stop()` fences late `onDone`s; a restarted owner gets
  a fresh ladder; disable/delete drops rungs; `markRan` never re-run by a
  rung. All covered by `scheduler.test.ts`.
- **Approval atomicity and the grant boundary:** `approve`/`reject` are
  single immediate transactions re-checking pending state inside; the
  fingerprint excludes run/cursor accounting and includes triggers/enabled
  (a mid-flight hook rotation stales a proposal — "any real configuration
  change does", per design); repeated taps cannot activate twice (tested);
  `base_snapshot` renders the immutable candidate with a stale warning, and
  a drifted legacy row names the coming refusal; the hook is minted only at
  approval and only with `publicUrl` (`needs-public-url` refuses pending);
  any approval-required component stages the whole patch. `requiresApproval`
  (`program-ops.ts:203-213`) matches the design's direct/staged split
  field-for-field, including identical-charter free writes, reschedule
  directness, last-trigger refusal, and the addressless no-destination
  refusal for grant-shaped ops (review's lane scoping lives in the tool,
  `agent/tools/program.ts:349-368` — verified present, out of scope).
- **Wake dispatcher ownership/settlement:** fail-closed `failUnlinked` with
  the process-local fence and per-pump retry; `preRunFailure` closes
  unlinked members; overflow hold bounded by admission+epoch; resume-chain
  following and retargeting; seq-scoped `claimedForEvents` (reused client
  ids cannot steal or suppress a wake) — all covered by
  `wake-dispatcher.test.ts`.
- **`record()` dedupe/replay:** source-key unique, identity =
  conversation+kind (drift throws loudly, per design), `replay: true`
  reuses the recorded occurrence across drifted text, coalescing into one
  pending wake per conversation.
- **Legacy purge and `rePinDmTopics`:** copy-only-when-creating /
  archive-when-existing, all in one transaction (failure aborts, tested);
  re-pin selects `chat_id > 0` (private chats only — Telegram id convention,
  `rolling.ts:19-21`), idempotent.
- **Guardrails sweep:** no `console.*`, no `any` in the scoped files; error
  paths log rather than swallow (scan-level try/catches all emit error
  lines); zod at the store boundaries for rows, drafts, patches, snapshots.

## 3. Couldn't verify / leads not chased

- **cron-parser's prev/next disagreement model** (the foundation of the
  `latestFireAtOrBefore` verification shortcut): verified via the passing
  DST tests for the three ruled scenarios in America/New_York, but not
  independently fuzzed over other transition shapes (30-minute DST zones
  like Lord Howe, historical rule changes). Risk is bounded by construction:
  a missed decline falls back to the capped forward walk, which
  over-measures lateness — degrades toward skip, never toward a stale fire.
  Labeled assumption, not verified.
- **The SIGKILL window between `commit`'s claim and the runtime's
  `runOwnership.begin`:** the crash tests kill at record-commit and
  append-commit only. By code ordering, `begin` fires "after the run row
  exists and before the stream can reach a tool" (`runtime.ts:160-165`), so
  a process death in that window resubmits a trigger whose run produced no
  side effects — reasoned sound, not proven against a real kill at that
  boundary. The wedged-`failUnlinked`-write crash window (fence is
  process-local) is likewise only in-process-tested.
- **Single-writer assumption behind P3-4:** verified `index.ts` opens one
  `openPrograms` connection; other possible openers (doctor, operator
  sqlite3 sessions) were not audited file-by-file.
- **Mail watcher's read-time CAS half** (`programs.ts:158-159` says
  mail-watcher "enforces at read time — this is its write-time half"):
  `src/mail.ts` is out of scope (hunt 12); pointer only.
- **Out-of-scope pointers per the brief:** Telegram approval adapters
  (hunt 1) own the tap handler where the hook URL's plaintext "exists only
  inside the tap handler"; the program agent tool (hunt 10) owns arg zod
  validation (name/charter bounds on the direct lane are tool-side — the
  store trusts trusted callers) and review lane scoping; turn admission of
  woken turns (hunt 2) owns epoch fencing at the runtime.

## 4. Simplifications & code smells (P3-level, evidence-backed)

1. **`hookTokenHash` duplicated as a private `hookHash`** —
   `src/program-ops.ts:259-261` re-implements byte-for-byte the exported
   `hookTokenHash` (`src/program-hook.ts:10-12`) — the very module it
   already imports `hookUrl`/`newHookToken` from (line 8). The program-hook
   header says these call paths are where the token lives; two hash
   implementations is one too many for a credential path. Import it.
2. **`pump()`'s unlinked-resubmit branch re-implements `closeUnlinked`** —
   `src/wake-dispatcher.ts:348-371` repeats the `failUnlinked` CAS + fence
   bookkeeping + stale-fence cleanup of `closeUnlinked` (`:250-270`) inline,
   with different log lines. One helper covers both callers; the divergence
   is already visible (the pump branch logs `warn`, `closeUnlinked` logs
   `error`, for the same condition).
3. **`programAddressTarget` vs `proposalTarget`** — identical functions in
   `src/programs.ts:90-92` and `src/program-proposals.ts:254-256` (both
   normalize `ProgramAddress` to a `ConversationTarget`). The proposals
   module already imports from `programs.ts`; one should call the other.
4. **`wake.ts` triplicates the submit-or-release block** — `wake`
   (:64-79), `wakeApp` (:93-108), and `wakeConversation` (:142-157) carry
   the same construct-sink → `runtime.submit` → `!admitted` warn →
   catch-release-log-return-false shape; only the refused/conv-missing
   preambles differ. A shared `submitOrRelease(deps, conv, text, tags)`
   would keep the header contract ("a constructed sink must be released if
   submission throws") in one place instead of three that must stay in
   lockstep.
5. **`fireScheduled`'s double bookkeeping around the `finally`** —
   `src/scheduler.ts:251-299` captures `fireErr`, then the markRan-catch
   path can replace it with the cursor error (`:294`), making the terminal
   `if (fireFailed) throw fireErr` (`:299`) reachable only when the cursor
   write succeeded. Behavior is correct and tested (including the
   double-fault ordering), but the control flow reads as if `fireErr` were
   always the thrown error; a comment or a single exit path would remove
   the trap. (Borderline smell — flagging for readability, not behavior.)

---

*Scratch evidence: `/tmp/hunt15-scratch.test.ts` (3 tests, all passing —
run via `bun test /tmp/hunt15-scratch.test.ts` from the repo root; creates
only tmpdir sqlite files it removes itself).*
