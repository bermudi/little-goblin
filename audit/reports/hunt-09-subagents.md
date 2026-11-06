> Audited 2026-10-23 17:35 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 09 — subagents, delegations, herdr, harness-trust

Read-and-report pass over: `src/subagents/` (admission, approval-gate, crash
(crash-child/crash.test), drain, env, errors, kill.driver, models, mod,
podman.test, recovery, row-access, run-doc, settle, testing, tools, transfer),
`src/subagent-runs.ts`, `src/subagent-prompts.ts`, `src/delegations.ts`,
`src/delegation-lifecycle.ts`, `src/spinoff.ts`, `src/herdr.ts`,
`src/harness-trust.ts`, plus their colocated tests. Static reading only (per
operator override: no suite, no typecheck run; the orchestrator's verification
pass — typecheck clean, 4686 pass / 0 fail / 86 skip — is taken as given).
Governing spec: `design/subagents.md`, `design/delegation.md`, AGENTS.md
Guardrails / Live services / Keys.

## 1. Findings

No P0, P1, or P2 findings. The two design docs are unusually well enforced:
nearly every ruling I probed has both a code mechanism and a colocated test
pinning it. What remains are P3-grade sharp edges and hygiene items, each with
evidence.

### P3-1 — Resume over-cap disables the owner; the error's "stop runs" remediation is unreachable while disabled
- **Where:** `src/subagents/mod.ts:592-597` (`ownerResume` throws when
  `running.length > config.maxRuns`), `src/subagents/mod.ts:317-349`
  (`openSubagentsGuarded` converts that throw into a null owner = feature
  disabled), `src/agent/tools/mod.ts:155` (`...(subagent ? { subagent:
  subagentTool(subagent) } : {})` — the tool mounts only when the owner
  opened).
- **What:** a restart after `maxRuns` was lowered below the count of
  `running` rows fails `resume()`, closes the owner, and disables the entire
  subagent surface. The thrown message says "raise the cap **or stop runs**" —
  but with the owner disabled there is no `subagent stop` (the tool is
  unmounted; the rows' Pi conversations are left unresumed). Only "raise the
  cap + restart" is actionable through goblin.
- **Rule context:** design/subagents.md → Scope rules says "At most `maxRuns`
  running at once… beyond it `start` queues the run and says so" — queuing is
  the documented mechanism for over-cap; a boot-time hard disable with a
  half-impossible remediation is an extension the doc does not rule on. The
  fail-loud part is fine; the misleading remediation is the finding.
- **Triggering path:** config lowers `subagents.maxRuns` while N > cap rows
  are `running`; `systemctl --user restart goblin` (approved deploy);
  `ownerResume` throws; operator reads the message and tries to stop runs.
- **Fix sketch:** either the message should say only "raise the cap and
  restart" (one-line), or over-cap rows should be paused-and-queued rather
  than refusing resume.

### P3-2 — `send()` leaks `TargetGoneError` uncaught while the same condition 40 lines later is a shaped `prompt failed` outcome
- **Where:** `src/delegation-lifecycle.ts:744`
  (`if (machineRootFor(deps, d.target) === null)` — the archive guard — runs
  *before* the prompt try/catch; `machineRootFor` at
  `delegation-lifecycle.ts:365-371` throws `TargetGoneError` when the label
  left config) vs `delegation-lifecycle.ts:778-840` (the identical vanished
  target reaching `herdrFor(deps, d.target).prompt(...)` **is** caught and
  returned as `{ kind: "prompt failed", error }`).
- **What:** for a delegation row whose target label left config (rows
  survive restarts by design), `send()` sometimes throws a raw
  `TargetGoneError` out of the lifecycle (archive path) and sometimes returns
  the documented `SendOutcome` "prompt failed" variant (prompt path). The
  module's own contract (`delegation-lifecycle.ts:88-93`) declares prompt
  failures an outcome, not an exception; whatever caller handling exists for
  outcomes will not see the throw.
- **Rule context:** design/delegation.md → "a row whose target label left
  config stops by verdict" governs stop; for send the doc is silent, but the
  SendOutcome union is the module's declared failure surface. Inconsistent
  failure shape on a plausible path (operator edits `delegation.machines`,
  rows survive, model calls `delegate send`).
- **Test sketch:** row with `target: "gone"`, targets map without it; call
  `send()`; assert the result is `{kind: "prompt failed"}` (or a new
  `refused: "target gone"`), not a thrown `TargetGoneError`.

### P3-3 — Halt classification by error-message string match
- **Where:** `src/subagents/admission.ts:255`
  (`if (msg === "stopped" || msg === "owner closing" || msg === "run row vanished")`)
- **What:** `admit()`'s catch classifies halts by comparing `err.message` to
  three literals instead of a typed check. All three literals currently
  originate in `row-access.ts:62-67 throwIfHalted`, so behavior is correct
  today, but any future `SubagentError` (or provider error) whose message
  collides is silently misrouted to `{kind: "halted"}` — the outcome that
  skips retry bookkeeping and can terminalize a run
  (`admission.ts:302-313`). Invariant hygiene; a `halted` sentinel type (or
  checking `err instanceof SubagentError` plus a `code` field) would make the
  classification structural.
- **Test sketch:** unit — throw a foreign error whose message is `"stopped"`
  from a stubbed harness call inside admit; assert the row is **not** treated
  as halted (today it would be).

### P3-4 — Approval-lease doc version never consulted; drift degrades to anonymous tool errors
- **Where:** `src/subagents/approval-gate.ts:65-70` (doc declared
  `version: 1`) and `approval-gate.ts:72-87` (`readApprovalLease` — any
  safeParse failure throws `corrupt approval lease: <zod message>` out of the
  gated tool's execute).
- **What:** the lease doc carries a version field, but `readApprovalLease`
  never reads it; a snapshot written by an older/newer doc shape (schema
  evolution, or a future `version: 2`) surfaces as an anonymous tool error on
  every replay of that call — the model sees a zod error, the run is not
  parked for `decide`, and nothing names "doc version mismatch" as the
  cause. Fail-loud, but at the wrong altitude: a named refusal (or a version
  check with a loud, specific error) would make the post-mortem trivial.
  **Lead, labeled as such:** I could not verify how pi-durable persists doc
  versions across package upgrades (vendor internals; see §3), so the
  triggering scenario is an upgrade-with-old-snapshots, not an observed
  repro.

### P3-5 — `SandboxEnv.exists()` conflates script error with absence
- **Where:** `src/subagents/env.ts:777-785` — `exists()` guards only
  `timedOut || exitCode === null`, then returns `ok(exitCode === 0)`.
- **What:** the fixed probe script `test -e "$1" || test -L "$1"` can in
  principle exit 2 (`test` error), which would be reported as "path does not
  exist" rather than an error. With the current constant script this is
  unreachable (single-operand `test` exits 0/1 only), so it is hygiene: the
  classification silently turns any future script error into a wrong
  negative. Every other classifier in the file (`check`, `runOut`)
  distinguishes error from verdict; `exists()` is the one that does not.

### P3-6 — `delegations.create()` seeds `baseline_seq = 0`, contradicting the column's documented NULL-pending semantics
- **Where:** `src/delegations.ts:238-240` (`qInsert` hard-codes `0` into
  `baseline_seq`) vs the field's own documentation
  (`delegations.ts:36-39`: "null while pending") and the NOT-NULL→nullable
  rebuild migration whose whole point was making NULL the pending posture
  (`delegations.ts:206-230`).
- **What:** every `starting` row begins life with `baseline_seq = 0` — a
  pre-prompt-looking number the migration explicitly retired. It is always
  overwritten by `markRunning`/`markParked` before the watcher compares, so
  there is no live bug, but the sentinel contradicts the documented
  invariant, and any future code path that reads a `starting` row's baseline
  (e.g. an extended `recoverStart`) would compare against a bogus 0 — exactly
  the failure mode the design doc calls out ("a stale comparison the next
  poll could turn into a spurious done", delegations.ts:208-210). Insert NULL
  instead; the column allows it post-migration.

Severity recap: **P0 0 · P1 0 · P2 0 · P3 6**.

## 2. Checked and found clean

Later passes can skip these; each was traced end-to-end against the cited
ruling.

**Vendor boundary.** Only `src/subagents/` imports
`@earendil-works/{pi-durable,pi-ai,chord}`; the only other `earendil-works`
imports are `pi-codemode` in `src/agent/tools/script*.ts` (a different
package, deliberately outside the enforced set) and a comment in
`src/config.ts:518`. `src/module-boundaries.test.ts:17,62` enforces the
enforced set. design/subagents.md → "Only src/subagents/ knows Pi
Durable / pi-ai / chord" — clean.

**Purpose-typing / no host bash / no recursion.** Tool sets are fixed in code
(`tools.ts:237-375`): worker = read/write/edit/bash/finish/ask (pi-durable
coding tools over `SandboxEnv`); computer = screenshot/inspect/act/launch/
finish/ask. No generic spawn; no tool reaches the host; worker bash execs
only through `sandboxes.execArgv` (`env.ts:1042-1136`). Models pinned:
`models.ts:8-11,90-106` enforces worker `glm-5.3` / computer
`glm-5.3-flash`, thinking low|high, catalog from the pinned package;
explicit-profile seam requires thinking "off" and matching modalities
(`models.ts:58-89`). Matches design/subagents.md → Models + Scope rules.

**maxRuns / queue eligibility / leases.** `drain.ts:26-59`: global slots
count `running` + inflight (admission-in-progress can't over-admit);
`needs_input` frees the global slot; worker sandbox lease via
`workerLease` (the furthest-along row — `subagent-runs.ts:353-361` —
correctly preferring running/needs_input/intent-carrying/approval-parked
rows over a plain queued second worker); computer rows wait on a running
sibling or an externally held unexpired desktop lease, with the run's own
lease and expired leases claimable. `drain.test.ts` pins each case.
Matches design/subagents.md → Phase 3 as built → Queue eligibility.

**needs_input lease asymmetry.** `settle.ts:122-131 releaseLeases` releases
only computer desktop leases: worker `needs_input` (ask *and* approval park)
retains its sandbox lease (no-op for workers, and `workerLease`'s status set
still contains needs_input rows — `subagent-runs.ts:356`); computer
`needs_input` releases the desktop so the operator can act
(`approval-gate.ts:271`, `settle.ts:274`). Matches Phase 3 → "A needs_input
run frees its global slot but retains its worker sandbox lease…".

**Crash-approval gate.** `approval-gate.ts` end to end: claim-before-dispatch
/ result-after (`:434,459,474`); crash between → lease claimed → park with
crash-resolution ask (`:226-279`); park failure fences the run (stop intent →
abort → direct failed mark, `:239-270`) so the model can never retry a
possibly-landed side effect; record-result/abandon are `isError` results with
the `crash_resolution_unverified` warning (`:306-336,410-433`); authorize-retry
falls through to exactly one further claim+dispatch (`:403-434`); a `done`
lease replays with zero dispatch (`:365-381`); the decision commits to the
lease before acting and a crash mid-decision re-asks (decided row survives,
`queued + decision` rows resolve via stored decision or waiter —
`admission.ts:147-193` + `approval-gate.ts:186-224`); `finish`/`ask_operator`/
screenshot/inspect stay ungated (`tools.ts:237-252,566-580`). Gate sits
*outside* `withRunGuards` so a parked (needs_input) row's replay passes the
fence — order verified at `tools.ts:241-249,572-577`. Matches Phase 3 →
crash-approval-gate rulings and "Goblin owns crash resolution".
`decidedBy`/`outcome` are owner-stamped in `ownerDecide`
(`mod.ts:518-522`) and caller-supplied copies are stripped by the input
schema (which omits those keys; zod drops unknowns).

**Crash/row invariants.** "A claimed conversation never rolls back":
`admission.ts:267-283` keeps any row with a recorded `piConversationId`
running and recovery-owned on admission failure; no path returns it to
`queued`. "Cancellation failure is never permission to release":
`recovery.ts:89-108 confirmPiIdle` returns false on any failure;
`exhaustRecovery` (`recovery.ts:202-266`) keeps the row owned unless the
abort is confirmed, and a stop landing meanwhile wins (`:217-243` checks
stopRequested again after the cancel join). No double-settle: every terminal
write is lane-serialized per row (`mod.ts:118-130 lane`), `finalize`
no-ops on terminal status (`settle.ts:205`) and on newer inputs
(`settle.ts:207`), `recordOutcome` never replaces a recorded outcome
(`row-access.ts:42-47`), and `bindConsumedInput` clears only outcomes whose
rev ≠ the consumed rev (`tools.ts:431-437`). Recovery budgets bounded
(`ADMIT_MAX_ATTEMPTS = 5`, `RECOVERY_MAX_ATTEMPTS = 10`, halt intents never
retried — `stopRequested` checks at every boundary). "Plain prose is not
completion": `settle.ts:286-310`. Matches Phase 3 → Idempotent dual-store /
A claimed conversation never rolls back / No timeout-and-revive.

**Row access scoping.** `ownerStatus/ownerSend/ownerStop/ownerDecide` all
refuse rows whose `conversationId` doesn't match (`mod.ts:410-412,427-429,
491-493,524-527`); `list` is scoped; the gate resolves rows only through
`byPiConversation`. Clean.

**Env construction / secrets.** The model key resolves in-process into
`InMemoryCredentialStore` at open (`mod.ts:88-108`) — never env/argv/disk/
log; the only env the worker child sees is argv-delimited `K=V` pairs from
the model's own tool options with names validated by `ENV_NAME_RE`
(`env.ts:55,1053-1090`), all inside the origin sandbox. Nothing in scope
injects host secrets anywhere; the sanctioned pass-keys lane is untouched by
these modules. Matches design/subagents.md → Models / Live check.

**Truncated-screenshot rule.** `settle.ts:230-255`: final screenshot errors
— only `DesktopError | SandboxError | PodmanError` become `exportErrors`;
anything else throws and leaves the row running for recovery
(`settle.ts` monitor catch → `recoveryPending`, `settle.ts:352-361`); export
refusals (`box-files {error}`) become persisted `exportErrors` with
per-file durable progress so restarts never recopy or fabricate
(`transfer.ts:80-129`, `subagent-runs.ts:449-456`). (The screenshot *mint*
truncation check itself lives in `desktops.ts` — hunt 11 — noted, not
chased.) Matches Phase 3 → Only expected refusals / truncated-frame ruling
as far as it lives in settle/transfer.

**Shutdown fencing.** `settle.notify` refuses to deliver once closing
(`settle.ts:102`) and unadmitted notices stay `noticePending` for the next
boot; `ownerClose` joins lanes and monitors (`mod.ts:711-723`);
`ackNotice` is CAS'd on `noticeRev` (`subagent-runs.ts:370-372,446-448`).
Matches Phase 3 → Shutdown never delivers a retryable notice.

**Boot resume.** `ownerResume` Phase A ordering (all row decisions before
any scheduler-enabling call), unknown/terminal live conversations cancelled
with abort-confirmation refusal, lease-failed computer rows failed with
notice, parked-approval rows re-attached before resume
(`mod.ts:587-709`) — matches the crash-resume rulings; the
`running > maxRuns` guard is P3-1 above, everything else in it is sound.

**Delegations store + watcher.** CAS writes hold: `transitionIf` and
`captureBaseline` compare status+promptedAt (delegations.ts:253-260);
`markRunning`/`markParked` guard `status != 'stopped'` so a raced stop wins;
notices land before transitions everywhere except `recoverStart`, whose
finally-transition is the documented exception (delegation-lifecycle.ts:1088-
1104). Baseline-pending posture (#95): failed post-prompt/park/send reads
leave `baseline_seq` NULL and the next scan captures under CAS — never a
pre-prompt stand-in (launch `:698-707`, send `:842-850`,
deliverPendingPrompt `:1126-1134`, check `:1188-1244`). Folded-completion
attribution (#119): fresh local report → done, else park needs_input
(`:1226-1241`). Stall rule 90 s (`:1283-1288`); blocked notifies exactly
once via seq re-baseline (`:1262-1267`); unreachable target = cannot-observe
(row stays watched, `:1163-1176`); explicit stop on a vanished target stops
by verdict with the host-side warning (`:887-901`); stop marks stopped only
when closed/unbound/agent-gone, else "still running" (`:909-942`); the
machine-link probe is one forwarded `agent get` for a nonexistent name,
`agent_not_found` = answered, no fallback (`:558-568`); `agent_not_ready`
parks with the task owed and `agent_blocked` on prompt is relayed with the
answer hint (`:651-678`, `:784-787`). All match design/delegation.md →
State is rows / Watcher writes / machine-target rulings.

**Delegated output fencing.** `notify` fences `</event` (case-insensitive)
and never interpolates screen output into error prose — screen text rides
the fence or a `(screen unreadable: …)` placeholder (`:1033-1044`,
`readScreenTail`); read outcomes hand raw text to the caller for fencing
(`:945-958`). Matches design/delegation.md → "Delegated output is untrusted
data".

**herdr adapter.** Wire parsing: nonzero exits prefer the JSON stderr
envelope, else a capped raw excerpt that never quotes read-verb stdout
(herdr.ts:44-50,222-233); success logs only after validation (`:198-243`);
`agent get` maps `agent_not_found` → null and nothing else (`:297-308`);
unexpected-but-valid extra fields are stripped, missing required fields throw
(agentSchema, `:95-111`). Operator surface: topology → `agent get` →
pane/kind/identity checks → send, every preflight failure is a HerdrRefusal
("nothing was sent" class), send-time failures are HerdrErrors (uncertain
delivery), no post-send reads, prompt text never logged, list labels ride as
untrusted metadata (`:591-780`) — all pinned by herdr.test.ts. Matches
design/delegation.md → the 2026-10-14 herdr-tool rulings.

**Harness trust.** Write-if-absent only — explicit `false` (claude) and
`trust_level` incl. "untrusted" (codex) stand (harness-trust.ts:72-79,136-
137); symlinked settings write through to the realpath
(`managedPath:40-57`); dangling links refuse loudly by name; codex TOML is
edited as text (no reformat), dotted-key and inline-table edge cases refuse
(`:156-210`); unknown kinds seed nothing and write nothing (`:23-32`) — the
first-run dialog then parks via the watcher's stall rule, which is the
documented backstop, not a silent skip. Remote seeding rides the root pane
with an executed-output-only marker and `-e || -L` absence tests
(delegation-lifecycle.ts:454-499). Matches design/delegation.md → the
2026-10-03/04 trust rulings.

**Spin-off pin/rollback.** Fork precedes launch settle; the pin's discard
deletes the fork only when `lastSeq` still equals the fork watermark, so a
conversation the operator wrote into survives a failed launch
(spinoff.ts:47-59); `setMeta` (the async retitle's only write) does not touch
event seqs (verified in conversation.ts:1463 → `applyPatch`), so retitle
cannot defeat the watermark; app conversations pin to themselves; only
rolling private DMs fork; everything else keeps its Telegram address
(`:63-81`). Matches the file header's stated contract and delegation.md →
Spin-off.

**`lane()` semantics** (`mod.ts:118-130`): a rejected lane predecessor still
runs the next op (`prev.then(fn, fn)`), tails self-clean idempotently —
correct.

**crash tests / drivers.** `crash.test.ts` (real SIGKILLs against
`crash-child.ts` + fake model) pins park-on-reopen, authorize-retry
single redispatch, record-result zero redispatch, abandon termination, and
re-park-after-kill-while-parked; `kill.driver.ts` / `podman.test.ts` /
`live.test.ts` are gated (`GOBLIN_SUBAGENTS_PODMAN_LIVE` /
`GOBLIN_SUBAGENTS_LIVE`) and were not run, per the rules.

## 3. Couldn't verify

- **Live herdr wire behavior** (`src/herdr.live.test.ts`,
  `GOBLIN_HERDR_LIVE=1`) and **harness-trust key pins vs installed
  binaries** (`src/harness-trust.live.test.ts`,
  `GOBLIN_HARNESS_TRUST_LIVE=1`): never run per the rules. Everything I say
  about the adapter is against the fake-runner suite and the pinned schemas;
  upstream drift is by construction invisible here.
- **pi-durable/pi-ai/chord internals**, statically assumed from the tests
  that pin them: `awaitWithContext` settling parked approval waits on
  conversation abort (completeStop's `waitForIdle` would hang otherwise —
  "stop wins over a late settlement" passes, which exercises it);
  `submissionByRequest` dedupe making the lost-ack resubmit a no-op
  ("a lost ack on the initial submit…" pins it); `replay: "safe"`
  re-execution boundaries; doc-version persistence across package upgrades
  (feeds P3-4's lead status).
- **`desktops.ts` claim/lease-expiry and observation-binding internals, and
  `sandboxes.ts` reconcile semantics** — hunt 11; the subagent modules'
  correctness around them was checked only as far as the interfaces these
  files exercise.
- **The delegate/herdr/subagent tool wrappers** (who calls `launchPin`'s
  `discard`, the answer-key whitelist, the `subagent` tool's surfaces) —
  hunt 10; P3-1's tool-unmounting claim was verified in
  `src/agent/tools/mod.ts:155` and `src/agent/turn-tools.ts:235` only as far
  as needed.
- **Rules I suspected but could not trace to a written source** (not scored
  as findings): (a) that a *second* needs_input notice per keypress is
  acceptable (check()'s blocked-after-running-transition path can notify
  once per seq advance — honest content, but no doc ruling on notice
  frequency); (b) that `answer()` may send a key to a needs_input row that
  is not currently blocked (the whitelist is the tool layer's, delegation.md
  only says "the explicitly whitelisted key reaches a blocked agent").

## 4. Simplifications & code smells (P3-level, evidence-backed)

1. **The `</event` fence ritual is implemented three independent times** —
   `src/subagent-prompts.ts:72`, `src/delegation-lifecycle.ts:1037`, and
   `src/scheduler.ts:488` (out of scope, cited for the drift risk). Same
   regex, same replacement, three owners; a future fence change (attribute
   filtering, nesting) must find all three or the channels silently diverge
   in how much authority untrusted output gets. One shared `fenceEvent`
   helper should own it.
2. **Three copies of the same fake `Desktops`/`Sandboxes` test doubles** —
   `src/subagents/kill.driver.ts:37-83`, `src/subagents/crash-child.ts:34-83`
   (byte-identical stub bodies, minus the driver's marker logic), and
   `src/subagents/testing.ts:952-1049` (a richer variant). A kill/crash
   change to the stub shape (a new `Desktops` method) must be edited in
   three places or the drivers' typecheck lies. Extract into `testing.ts`.
3. **`workerLease`/`noteLifecycle` parse every matching row to use one** —
   `src/subagent-runs.ts:439-441` (`qLease.all(conv).map(toRun)[0]`) and
   `:457-458` run full zod `toRun` parses over all of a conversation's
   worker rows only to read `{id, status}` of the first. `drain.eligible`
   calls `workerLease` per queued candidate on every pass and the scan ticks
   every 30 s. `LIMIT 1` plus a slim projection (or at least `.all()[0]`
   before parsing) would do.
4. **`OwnerBindings` threads the same objects twice** —
   `src/subagents/mod.ts:285-302,351-368`: `b.deps`, `b.config`
   (= `deps.config`), and `b.runs` (= `deps.runs`) are three handles on two
   objects; consumers mix and match (`b.deps.desktops` vs `b.config.maxRuns`
   vs `b.runs.listFor`). Dropping `config`/`runs` in favor of `deps.*`
   would remove the aliasing without changing the decomposition ruling.
5. **Duplicate imports from one module** — `src/subagents/admission.ts:4`
   (`import type { Desktops }`) and `:13` (`import { DesktopLeaseError }`)
   both from `../desktops.ts`; merge.
6. **`rowForConversation` is a zero-behavior passthrough** —
   `src/subagents/row-access.ts:20-25` forwards to `runs.byPiConversation`;
   its entire content is a comment about close-joining. As a seam it names
   nothing the direct call wouldn't; either give it the close-join check it
   documents or let callers use the store.
7. **`crashDecisionNotice` serializes the entire decision history into
   every notice for the run's remaining life** —
   `src/subagent-runs.ts:77-80`: full `JSON.stringify(records)` including
   tool `args` (whole bash commands) appended to each settle notice body.
   Bounded and fenced, but the payload grows with every decision and
   repeats verbatim on retries; a count + latest-decision summary (full
   history already lives on the row) would carry the same warning.
8. **`delegations.create()`'s `baseline_seq = 0` sentinel** — see P3-6;
   listed here too because the fix is a simplification: insert NULL, delete
   the sentinel.
9. **`reportPathFor(deps, d)` recomputed three times inside `send()`'s
   archive block** — `src/delegation-lifecycle.ts:745,767` and again in the
   restore path; one local const (it is computed once at `:745` but then
   re-derived at `:767` for the log line) would keep the paths visibly
   identical. Trivial.
