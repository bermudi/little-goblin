# goblin v2 — refactor plan 2 (2026-10-17)

Follow-up to REFACTOR-PLAN.md. The W3 turn decomposition landed and it
worked — `runTurn` is a 15-line driver over `src/turn/` phase modules —
but the god-function pattern it cured is reproducing faster than it is
being strangled.

## Verified state (numbers, re-derived today)

| # | Signal | Plan-time | Today |
|---|--------|-----------|-------|
| 1 | Largest function | `runTurn` ~1,100 lines | `openSubagents` ~2,018 — `src/subagents/mod.ts` is one function from line 279 to EOF. Born 2026-10-12, *after* the plan; already the largest product file (2,297 lines / 86KB, bigger than pre-refactor runtime.ts) |
| 2 | `boot()` | file 946 lines | file 1,351 (+43%); `boot()` itself ~1,140 lines, ~67 top-level consts, 527 lines at 3+ indent levels. W4 diet hasn't started; the file grew the opposite way |
| 3 | suite:product | 0.966 | **1.18** (69,025 vs 58,456 nonblank). DESIGN.md: "the suite stays smaller than src/". `subagents/mod.test.ts` alone is 158KB / 3,939 lines — the single largest file in the repo |
| 4 | design-doc pointers | 214 | 339 (+58%) |
| 5 | comment ratio | 20.4% | 16.1% — the one signal that moved the right way |

The test inversion is downstream of the god-function: a 2,000-line
closure object has no units to test below the whole, so the only tests
that fit are whole-object, implementation-pinning ones. Fix the shape,
the ratio follows — same reasoning the plan applied to W7.

## Goal

Strangle the two remaining god-functions — `openSubagents` and `boot()`
— with the proven `src/turn/` method, and **encode the size rule** so a
fourth one can't grow. That second half is what W3 skipped and why the
pattern recurred in five days.

## P0 — the meta-fix (first commit)

- Written rule in `AGENTS.md` guardrails + `DESIGN.md`: factory/owner
  functions carry a ~300-line bound; state clusters by lifetime into
  modules; a subsystem returns an interface assembled from units, never
  one scope of closures.
- `scripts/function-size-audit.ts`: babel-AST walk reporting functions
  over the bound — same posture as `comment-audit.ts` (signal, exits
  0). Promote to a gate when the product tree is clean.

**First run corrected the scope**: 22 functions over 300 lines, not 2 —
the `openX`/`makeX` closure-factory is the codebase's default idiom
(`makeDeliverySink` 1,283, `makeDesktops` 1,163, `openStore` 1,147,
`makeSandboxes` 617, plus 5 app components over 500). This plan strangles
the two top offenders (`openSubagents`, `boot`) to prove the pattern;
the audit output is the burn-down list for the rest, swept
opportunistically like the comment diet — never a flag day.

## P1 — `design/subagents.md` ruling (before touching code; mirrors W3.0)

An addendum to the existing doc, not a new file — the module owns one
doc. Must rule:

- **State ownership by lifetime** (the clusters exist unseparated today):
  - *harness-scoped*: credentials, models, specs/kinds, envs,
    `closing`/`resumed`/`harnessClosed`
  - *run-scoped maps*: lanes, inflight, retryAfter, admitAttempts,
    runMonitors, recoveryPending/recoveryAttempts,
    approvalWaiters/approvalDecisions
  - *scan-scoped*: draining, wantDrain, drainScheduled, ticker
- **Module map** (P2's extraction list).
- **What must not change**: the `Subagents` interface, `resume()`'s
  ordering contract, `lane()` serialization semantics, approval-lease
  CAS + provenance stamps, crash-resume behavior.

## P2 — `subagents/` extraction (one seam per commit; tests move down-level)

Ordered by self-containedness, from the actual layout of the function:

1. **`approval-gate.ts`** (~450): `approvalHost`, `withApprovalGate`,
   `approvalQuestion`, `declaredApprovalResult`, waiters/decisions maps,
   `dropApprovalState`. Most self-contained — wraps tool registrations,
   talks only to the runs store.
2. **`drain.ts`** (~120): `runningIds`, `eligible`, `drain`,
   `scheduleDrain`, ticker. Smallest seam — proves the shape cheaply.
3. **`admission.ts`** (~300): `admit`, `readmitOutcome`,
   inflight/retryAfter/admitAttempts, the `lane()` serializer.
4. **`recovery.ts`** (~350): `recoveryNudge`, `recoverRun`,
   `recoverParked`, `exhaustRecovery` + its maps.
5. **`settle.ts`** (~300): `monitor`, `monitored`, `finalize`,
   `confirmPiIdle`, `lastAssistantStopReason`, `completeStop`,
   `releaseLeases`, notify cluster.
6. **Owner goes thin**: `start`/`send`/`stop`/`decide`/`scan`/`resume`/
   `close` = validate args + delegate — the `runTurn` driver shape.

Each landed seam moves its implementation-pinning cases into a colocated
unit test; `mod.test.ts` keeps the public-contract suite only.

## P3 — `boot()` diet (interleaves with P2)

`boot()` keeps **construction order and nothing else**. Business-rule
closures move to their owning modules: mail poller/sender → `mail.ts`;
delegation wiring (`delegateDeps`, targets, herdr) →
`delegation-lifecycle.ts`; memory wiring + `noteRecall` → `memory/`;
`transcribeFile`/`visionDepsFor`/`titleFor` → `agent/`. `completeBoot()`
stays as the late-wire seam.

**Target (revised 2026-10-17):** the structural criterion, not a line
count — **zero business-rule closures; every line is a binding, an
ordering comment, or a wire call.** The ~250 target was aspiration, not
derivation: ~20 subsystems cross `boot()` with real ordering constraints,
so pure assembly has a ~300–450 floor before bundling the spine itself
becomes boot-in-a-trenchcoat. The composition root either earns the 300-
line audit bound like `openSubagents` did or carries an explicit
exemption in `AGENTS.md` — decided when the closures are out and the
honest floor is visible.

Status 2026-10-18 (**done — `boot()` 1,114 → 560**, structural
criterion met: zero business-rule closures; every line is a binding,
an ordering comment, or a wire call): landed —
`transcribeFile`/`visionDepsFor`/`titleFor` → `makeTranscriber` /
`makeVisionDepsFor` / `makeTitleFor` in their `agent/` modules
(`ad930767`); the five boot-pinned block comparisons →
`bootPinnedDiffs` in `config-pins.ts`, shared by `onConfigWritten`
and `restartHints` (`42d8c6be`); reviewer/system1 gate construction,
threshold merge and live review-model resolution → `wireReviewer` in
`reviewer.ts` (`9ea1e1f3`); per-turn tool mount policy (~160 lines,
the biggest single closure) → `makeTurnTools` in
`agent/tools/turn-tools.ts` with lazy getters for the four values
that bind past Runtime construction (`3ffbd3f5`); delegation
fixtures + per-turn dep gate → `wireDelegation` in
`delegation-lifecycle.ts` (`7dbb70e2`); mail poller/sender live-read
getters → `wireMailAuthority` in `mail.ts` (`2ede2a2d`); model-step +
compaction policy → `makeStepBuilder` in `agent/step.ts`
(`5a59e510`); memory client/telemetry/surfaces consolidation →
`wireMemory` in `memory/mod.ts` (`d53ca1d1`); operator seam bundle →
`makeOperatorSeams` in `http/operator.ts` (`ea21e173`); the whole
post-write reconcile (flips, stranded sandbox, pin warns,
restartHints) → `wireConfigWrite` in `config-pins.ts` (`32aa8cac`);
the fail-open owner open + wedged-close join → `openSubagentsGuarded`
in `subagents/mod.ts` (`86297b98`); stranded-container report →
`warnIfStranded` in `sandboxes.ts` (`d56a73d5`); ffmpeg probe + wav
gate + ttsDown → `checkBootMedia` in `agent/transcribe.ts`
(`b19290a5`); resume sink routing + operator DM → `makeResumeSinks`
in `turn-resume.ts` (`a57b457b`); read-aloud gate → `makeSpeaker` in
`agent/tts.ts` (`01ec350b`).

**Bound decision**: at 560 lines the remaining spine is pure
assembly — 300 would require bundling the spine into bigger `wireX`
calls, which just hides the wiring. `boot()` carries the named
composition-root exemption in `AGENTS.md` (structural bound: no
business-rule closures, not a line count). The shutdown tail and
`completeBoot`/`late` machinery are already module-level / boot-order
primitives, not policy. Pattern established: `wireX`/`makeX`
factories in the owning module; late-bound values reach them as
call-time getters.

## P4 — ratio and pointers (outcome, rides along)

`mod.test.ts` 3,939 → ~1,500 as units earn colocated tests;
suite:product back under 1.0. Doc-pointer sweep on cold files via the
existing `comment-audit.ts` signal.

**Status (landed)**: every extracted unit now carries a colocated
boundary test on a real run store — `row-access.test.ts` (the shared
row vocabulary's refuse semantics), `approval-gate.test.ts` (the
crash-lease CAS: claim→decided→done ordering, declared results are
always error results, parked rows free their slot once),
`admission.test.ts` (the admit verdict taxonomy + the durable
requestId's idempotent resubmit + the bounded retry budget),
`drain.test.ts` (slot caps over running+inflight, lease/backoff/stop
eligibility, deferred-drain coalescing), `settle.test.ts` (the
finalize outcome matrix, stop/newer-input preemption, completeStop's
abort-confirm ordering, notice wake CAS), `recovery.test.ts`
(death-proof ordering, bounded attempts, the unconfirmed-cancel
ownership rule). `config-pins.test.ts` pins the reconcile unit on
real `loadConfig` fixtures; `openSubagentsGuarded`, `warnIfStranded`,
and `makeResumeSinks` carry boundary cases in their colocated files.
The pi-durable `ToolExecutionApi` is the fakeable edge — every one
of these drives the unit against real stores, never mocked module
internals.

**Remaining**: `mod.test.ts` (4,018) still holds the owner-level
integration coverage — the thin owner's wiring is exercised through
the real harness there, and thinning it means deciding which cases
are boundary (stay) vs implementation-pinning (move to the unit
files). suite:product is 1.16; getting under 1.0 needs that
slimming, not more tests. The doc-pointer sweep landed: the only
miss was `config writes` → corrected to `DESIGN.md → Config`.

## Acceptance (structural, not line-gates)

- `openSubagents` returns an assembled object; each subsystem
  unit-testable without constructing the owner.
- `boot()` sequences construction only — no business-rule closures; the
  line target is the structural outcome (~300–450 expected), not 250.
- Size audit reports zero src/ functions over bound; suite:product <
  1.0.
- Full suite green every commit; herdr/gws/harness-trust/podman live
  checks untouched. Behavior-preserving — the 3,939-line suite is the
  net until each module earns its own tests; useful coverage is never
  deleted to hit a number.

## Checkpoints

- **Reviews** (fresh context, per AGENTS.md): after the P1 ruling,
  after approval-gate (first seam proves the shape), after the owner
  goes thin.
- **Deploy**: once at the end — `systemctl --user restart goblin`
  needs bermudi's OK; `deploy.sh` is the only sanctioned path.

## Explicitly not doing

- No `Subagents` interface change (consumers: tg commands, agent tools,
  http operator).
- No touching `subagents/env.ts`, `tools.ts`, `testing.ts` — already
  separate modules.
- No behavior changes; no new features riding the extraction.
