# goblin v2 — refactor plan (2026-10-07, rev 2)

Rev 2 folds in the side-review corrections: numbers demoted to signals,
F3 fixed red→green *before* extraction, TurnState lifetime ruling,
data-aware migration gating, errFields cause-chain fix, named review
checkpoints.

Addresses two inputs as one universe of work: **bug-hunt.md** (17 verified
findings, hunt-only) and the **nine structural items** from the 2026-10-06
maintainability review. The review's numbers were stale; every claim was
re-verified against today's tree (7d6a93d) — fresh numbers below.

Baseline at plan time: `bun test` 1401 pass / 0 fail (88 files), all three
tsc programs pass. **The tree is dirty** with a parallel session's in-flight
work (`delegate.ts` + `app-channel.ts` + their tests — the delegate `on`
wire-schema fix and app-channel changes); this plan does not touch those
files until that work lands.

## Verified state (replaces the review's numbers)

| # | Claim | Today |
|---|-------|-------|
| 1 | ~700-line runTurn | `runTurn` spans runtime.ts:946–2045 — **~1,100 lines**, recursive (self-call at :2045). runtime.ts: 2,198 lines, **68 commits**. runtime.test.ts: **3,264 lines** |
| 2 | ~4,300 comment lines, 150 doc pointers | **5,974** comment lines / 29,313 product lines (20.4%); hot files: runtime.ts 695/2198 (**32%**), index.ts 302/946 (**32%**), delegation-lifecycle.ts 374/1252 (30%). **214** design-doc pointers (146 → DESIGN.md) |
| 3 | 855-line startup, 70 commits | index.ts: **946 lines, 85 commits** — growing faster than runtime. `makeTools` takes 10 positional optional slots, most `undefined`; two late-wire nullables (`delegationLifecycle`, retention `worker`) with "not wired" throws |
| 4 | stringly identity | canonical build conversation.ts:42; hand-rolled parse tg/notify.ts:19; hand builds in mail-approval.ts:331, navigation.ts:105, rolling.ts:111, scheduler.ts:203, conversation.ts:276/854; tag prefixes `[program: `/`[delegation: `/`[scheduled: ` matched at runtime.ts:2142–44; `compact-` id prefix in 3 files |
| 5 | quiet failures | `errFields` (message+stack) wired **only** into `log.error` (log.ts:124–130); `log.warn` takes raw fields — 178 warn sites hand-roll `{error: String(err)}` and lose the stack; 338 catch blocks total |
| 6 | hidden globals | reviewer.ts: `reviewQueue`, `inFlight`, `cancellingAll`, `fallbackStreak`, `pendingGates` + `resetReviewerState()` test back door; delivery.ts:26 `recentReplies`; bell.ts:46 `pingedResponses`; prompt.ts:29 `lastSeen`; speak-button.ts:28 `inFlight`. (codex/auth.ts `refreshInflight` is a defensible singleton — single-flight dedup is its job) |
| 7 | legacy shims | programs.ts:12–13/183/219/400–420 jobs-table copy; runtime.ts:2144 `[scheduled: ` recognition; conversation.ts:315 pre-envelope bare rows still read; config.ts:687+ `legacyDelegationMachine` translation |
| 8 | no formatter | no format tooling in package.json; **17 product files mix tab/space leading indentation** (runtime.ts itself is now clean — claim drifted; the codebase isn't) |
| 9 | tests ≈ product | 26,925 test vs 27,873 product non-blank lines (**0.966**, was 0.992 — trending right, still ~1:1; DESIGN.md's rule says smaller) |

Also open and in scope for sequencing: issues **#75–87** (5×P1, 8×P2 from
the memory/app hunt — none overlap bug-hunt.md's findings).

## Shape of the plan

Strangler, not rewrite. Bugs before structure on files not being
restructured immediately; runtime-internal bugs ride the decomposition.
Every step lands green: `bun test` + `bun run typecheck` before each commit.
Deploy checkpoints (service restarts) need bermudi's OK per AGENTS.md.

---

## W0 — preflight (day 1; makes every later diff clean and debuggable)

**W0.1 Formatter (item 8 — cheapest fix, do first).** Add Biome in
format-only mode (no lint rules — style stays ours), tabs, line width 100
to minimize churn; `bun run format` + `format:check` scripts. One
whole-tree whitespace-only commit, nothing else in it. (Prettier is the
boring alternative if Biome fights anything; either is fine — the point is
one tool, one config, zero thought.)

**W0.2 log.warn error parity (mechanical half of item 5).** Give `warn`
the same treatment `error` already has: `warn(msg, err?, fields?)` with
`errFields` — then sweep the warn sites that pass `{error: String(err)}`
or `{err.message}` to pass the error object itself. While touching
`errFields`, fix what it actually preserves: today it drops the **cause
chain** (`{error, stack}` only) even though the codebase throws with
`{cause}` at several boundaries (tg/inbox.ts, tg/mod.ts,
provider-errors.ts — which carries its own bounded chain-walker to
borrow). Walk `cause` to a small depth in `errFields`, so `warn` and
`error` both keep message + stack + causes. (The judgment half — which
of the ~45 warn-and-continue handlers should fail loud — is a per-site
audit folded into W1 and the file diets; each catch gets an explicit
outcome — **retry, degraded, uncertain delivery, or failure** — with
enough context to explain it, not a blanket throw.)

## W1 — bugs first (parallel track, first week)

- The five open **P1s** (#75, #76, #77, #85, #86) and the eight **P2s**
  (#78–84, #87): live correctness, land before any restructure touches
  their files.
- **File bug-hunt.md's 16 open findings as issues** (F2 already fixed;
  F1/F4/F12 re-verified present today). Same shape as the memory hunt's
  issues: `[P2]`/`[P3]` title prefix, body points at the bug-hunt.md
  section. Fix in the hunt's suggested order.
- Exception: findings living *inside* `runTurn` (F3 — overflow-recovery
  join replay; anything else that lands there) get a **failing
  regression test on the current shape, fixed now** (red → green), and
  the test is *carried* through the W3 extraction — otherwise
  "behavior-preserving" quietly preserves the defect.

## W2 — identity codec + legacy purge (days 2–3; small, independent)

**W2.1 One address codec (item 4).** conversation.ts becomes the only
place that parses or builds conversation ids: export
`parseAddress`/`formatAddress`/`channelOf` (types exist; the sites don't
route through them). Message tags (`[program: `, `[delegation: `, the
`compact-` id prefix) get typed constructors/predicates in one module.
Round-trip tests pin the codec; every hand-rolled site
(notify/mail-approval/navigation/rolling/scheduler) is swept to it. A typo
then fails one schema, not memory silently.

**W2.2 Legacy purge (item 7 — needs one deploy).** One box, one user:
migrate once, delete the readers — but gate it properly, because the
legacy lives in **data**, not just code:

1. **Backup first** (file copy of goblin.sqlite + config) — that backup
   *is* the rollback path; restoring it undoes the migration.
2. **Inspect every legacy surface**: the jobs table, pre-envelope bare
   rows, the `legacyDelegationMachine` config block, **and stored event
   text** — runtime.ts's own comment says `[scheduled: `-prefixed user
   bursts (queued before the jobs→programs cutover) can still sit
   unanswered in tails; deleting that reader without checking rewires
   retention on old data silently.
3. Run the one-shot hard migration (copy-and-mark, idempotent — a
   re-run is a no-op; old-prefix texts are rewritten to `[program: `).
4. Delete all four readers. Restart (bermudi's OK), watch goblin.log
   for a day.

## W3 — the runtime decomposition (the centerpiece; items 1 + 9)

**W3.0 Design note first** — `design/runtime-turn.md`, per the AGENTS.md
rule that arguable tensions get written into the design docs. Rulings it
must contain:

- The turn's phase list: recovery-restore → admission (epoch, claim,
  history snapshot, anchor) → recall → prompt/view assembly → stream setup
  → streaming callbacks → finish/persist/review → overflow resume.
- **State ownership, by lifetime** — the rule that keeps TurnState from
  being the giant function in an object costume:
  - *conversation-scoped* (epoch, lastTurns, admission state) — owned
    by the Runtime, survives turns;
  - *recovery-carried* — exactly what `TurnRecovery` serializes today
    (detector, watchdog ring/strikes, warnings, cutKind, forcedKind,
    live wire, memory, partial): the exhaustive whitelist; anything not
    listed **dies with the attempt**;
  - *attempt-scoped* — everything else, owned by the TurnState object
    with narrow methods. Callbacks call methods, never rebind locals.
    The admission snapshot is immutable input, not state.
- **Recursion → driven loop**: the overflow self-call returns a resume
  decision to a small loop in `run()`; `TurnRecovery` stays the wire
  format between attempts.
- What does *not* change: the authority rule, cache stability invariants
  (prompt assembly stays byte-stable), admission semantics.

**W3.1+ Incremental extraction**, one seam per commit, tests moving down
a level as each unit appears:

1. Loop machinery (detector/ring/warnings/cursor/cutKind — restore and
   inherit semantics are already half-isolated).
2. Admission + snapshot + anchor.
3. The recall/view builder (pure function over history + memory +
   partial).
4. The stream-callback driver fed by TurnState (kills shared-variable
   mutation; the join-replay fix from F3 lands here).
5. Overflow classify + compact-and-resume packaging.
6. onFinish: persist, review submission, forced landings.

**Acceptance (structural, not line-count gates — numbers are reported
signals, and gaming them proves nothing):** every extracted phase is
unit-testable in isolation; no callback rebinds a shared local (state
changes go through TurnState methods); the overflow self-call is gone
(resume is a returned decision consumed by a loop); the F3 regression
test and the whole pre-existing suite stay green throughout. Signals
reported at the end: `runTurn` orchestration size (target ~150 lines),
runtime.ts size, runtime.test.ts size (target ~1,200 as tests move
down-level), suite-to-product ratio (DESIGN.md's own smell test —
falling under 0.85, toward smaller-than-src). Behavior-preserving
throughout — the 3,264-line suite is the net until each module earns
its own tests; useful coverage is never deleted to hit a number.

## W4 — startup diet (item 3; `makeTools` options-object is independent
of W3 and can land any time; the rest after W3 unblocks the seams)

- `makeTools`: ten positional optionals → one options object (internal
  break, one call site).
- Move the business rules that live in index.ts into their owning
  modules: delegation result routing and the bell/wake wiring →
  wake.ts/spinoff.ts/delegation-lifecycle.ts; the policy line stays in
  DESIGN.md's module map — **index.ts wires, it never rules**.
- Late-wire nullables: construct in dependency order; where the cycle is
  real (bot ↔ runtime), one explicit typed `completeBoot()` registration
  instead of scattered `!== null` guards.

## W5 — reviewer object + global purge (item 6; opportunistically —
note it touches runtime.ts's free-function import sites, so before-W3
means a small second pass over the file)

- The reviewer becomes an instance owning `reviewQueue`/`inFlight`/
  `cancellingAll`/`fallbackStreak`/`pendingGates` as fields, constructed
  in index.ts, injected through the existing `setReviewer` seam.
  `resetReviewerState()` dies; tests build fresh instances.
- Triage the rest: `recentReplies`, `pingedResponses`, `lastSeen`,
  speak-button `inFlight` become owned state on their modules' instances
  or deps-injected values. `codex/auth.ts` refresh single-flight stays a
  module singleton — documented why.

## W6 — comment diet (item 2; rides along + standalone sweeps)

- Policy ruling into the project AGENTS.md: comments carry the **local
  why** — invariants, non-obvious trade-offs, sharp edges. No doc
  retelling (at most one pointer where coupling is subtle), no incident
  dates (git and bug-hunt.md own history), no narrated walkthroughs of
  the next 30 lines. The count targets are signals for the audit
  script, not gates to game by deleting useful explanation.
- runtime.ts / index.ts / delegation-lifecycle.ts lose their essays as
  part of W3/W4 rewrites (the prose mostly describes machinery being
  moved). Cold files (config.ts 27%, tg/mod.ts 22%, conversation.ts 21%)
  get standalone sweeps.
- `scripts/comment-audit.ts`: per-file comment-ratio report, run when
  touching a file — the twice-learned-lesson rule as a script. Target:
  average under ~10%, hot files under ~20%, DESIGN.md pointers 214 → ~60.

## W7 — test posture (item 9 — the outcome metric, not a workstream)

DESIGN.md already rules: tests guard boundaries and invariants, suite
smaller than src/. W3+W4 are the remedy; W7 is the number that proves
they worked. While decomposing, delete implementation-pinning cases as
modules gain boundary tests; add nothing new below the line.

---

## Sequencing

```
W0 (day 1) ──► W2 (days 2–3) ──► W3 (≈1–2 weeks) ──► W4 ──► W5
                  │                                      │
W1 (bugs, parallel, first week; runs into W3 for         ▼
    runtime-internal findings)                     W6 rides along
                                           + standalone comment sweeps
```

Deploy checkpoints: W2.2 (migration + shims deleted), end of W3, end of
W5 — each needs `systemctl --user restart goblin` (bermudi's OK) and a
goblin.log review after a day of live traffic.

**Review checkpoints** (AGENTS.md already rules the implementing agent
never reviews its own work; these name the mandatory ones): after the
W3.0 design note, after the recursion → loop conversion, and after the
W2.2 migration. Green tests are necessary but not sufficient there —
the reviewer checks the authority rule and cache-stability invariants
specifically, which a behavior-preserving refactor can break while
every test still passes.

## Explicitly not doing

- No rewrite-from-scratch; strangler only, tests green at every step.
- No scope additions — the non-goals list stands.
- No touching the parallel session's dirty files until they land.
