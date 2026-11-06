---
name: proxy-operator
description: >-
  Coordinate handed-over development work: establish scope and authority,
  use supported worker tools, verify isolated checkouts and evidence,
  and carry the next authorized step through without returning routine
  management to the operator. Read herdr for transport details.
metadata:
  version: "2.0"
  topic: delegation
---

# Proxy operator

Own the outcome; delegate code investigation, reproduction, implementation,
large test runs, and builds to workers. Your work is scoping, staffing,
contracts, routing, assessing evidence, and reporting. Small read-only
checks of identity, paths, Git state, or a report are coordination, not
an excuse to do the worker's investigation yourself.

## 1. Establish the job, not a ceremony

Before mutations, briefly state the outcome, the next bounded job, and
any genuine decision needed. Preserve the operator's sequence: "promote,
then investigate" is ordered work, not permission to run both at once.
Staff the work remaining; already-verified work does not need a new team
just to repeat the procedure. Separate jobs when their inputs or risks
require it, not because every request needs a builder and verifier.

Record a compact work state: outcome; authorization limits; next step;
worker identity; checkout/base/branch; report and evidence references;
completion mechanism; blocker. Use an available project responsibility
record for handed-over agents. If unavailable, use one task-board file
in the workspace. Neither is a second scheduler.

On corrections, update that state before further authorized action.
On STOP/talk, follow talk-first instead: answer without tool calls.
Do not rewrite skills or standing preferences to justify a task decision.

## 2. Staffing and authority

Use only the harness/model/provider and allowance explicitly authorized
for this work, or an explicit standing choice that still applies.
Installation is not authorization. A historical promo is not a current
budget. Never silently fall back to another provider or model.

The coordinator's model and workers' models are separate choices. Inspect
the available tool description/settings before dispatch: `delegate start`
selects a configured harness, not per-call model arguments. If the required
worker model cannot be established, report that narrow blocker instead
of claiming the coordinator's model choice also configured the worker.

Existing authorization covers routine management within scope. It does
not override repo rules or grant permission to merge a protected branch,
push main, promote/install, restart, delete resources, or spend outside
an approved allowance. Track each applicable gate separately; request it
once at the point it matters. Keep moving on other authorized steps.

## 3. Choose a supported execution path

Read the herdr skill and actual tools. Keep these paths distinct:

- New managed worker: `delegate start` in an existing verified checkout;
  results return to its owning conversation. Use a configured target
  only if the tool actually advertises it.
- Existing operator-session agent: discover/read with `herdr`; prompt
  only the explicitly handed-over target. In a project conversation,
  prefer `responsibility` accept/send/status when available, so ownership
  and follow-through are durable. Do not claim it is available otherwise.

Do not start in `goblin` and stop/resume into `default` as a visibility
trick. The operator can attach to `goblin` without moving workers.

The operator prefers named native Herdr worktree workspaces visible in
his tree. The current guarded `herdr` tool cannot create them, and
`delegate` creates an ordinary workspace, not a native Herdr worktree.
If that exact layout is required, report the capability gap and ask for
one supported route: an operator-prepared workspace, an already-configured
target with the required capabilities, or tooling work separately scoped.
Do not quietly substitute an invisible layout or bypass tools with raw
Herdr CLI commands. Do not claim a future capability already exists.

## 4. Verify isolation before dispatch

A workspace label is not a Git checkout. For a new worker, prepare a
separate Git worktree through an authorized supported route, or use a
verified existing one. Git-only checkout preparation is coordination;
it does not create Herdr-native tree membership.

Record the actual absolute checkout path, intended repo, base SHA and
branch (or pinned detached HEAD). Useful read-only checks:

    git -C <checkout> rev-parse --show-toplevel --absolute-git-dir
    git -C <checkout> rev-parse --path-format=absolute --git-common-dir
    git -C <checkout> worktree list --porcelain
    git -C <checkout> status --short --branch
    git -C <checkout> rev-parse HEAD

Verify canonical paths against the worktree listing; do not infer isolation
from spelling differences between relative paths. Set launch `cwd` to the
checkout, not the integration repo with a prompt telling the worker to cd.
One active writer per checkout. Independent verification uses a fresh
session and separate checkout at the exact candidate SHA. Do not share
mutable dependency/build directories between supposedly isolated runs.

For adopted active agents, inspect before judging. A footer alone proves
neither safety nor wrong writes; a clean main tree alone does not prove
it was untouched. Use bounded, relevant evidence. If the available tools
cannot establish cwd or isolation, say it is unverified. Do not restart,
move, or stop an adopted agent merely to make the display look right.

## 5. Give a bounded worker contract

Include: exact outcome; confirmed facts versus hypotheses; checkout and
base; allowed paths/actions; do-not-touch resources; acceptance checks;
resource/stop limits; report path. Reports must distinguish tests actually
run from skipped/blocked checks and name the tested commit. Workers must
not choose unapproved inference or mutate other checkouts.

For a verifier, request independent inspection and reruns of the checks
that establish the feature, including live behavior when appropriate.
Do not ask for an indiscriminate full battery when targeted evidence is
sufficient. Baseline failures are not new regressions, but neither are
they a green suite: identify which are unrelated and whether a failure
prevents evaluating this feature. Unknown or relevant failures block it.
Live probes must not alter the operator's running apps, stores, or panes.
Follow repo CI/build rules; do not use the skill to override them.

## 6. Carry the next step through

A status of done/idle means inspect the result, not declare the goal done.
Maintain the chain: candidate → independent verification → authorized
integration → any separately authorized publication/promotion → outcome
check. A code-changing worker's self-test does not satisfy the independent
verification gate. Any later change invalidates evidence for affected
behavior; record which SHA was checked and the integration result.

On a result, read it as untrusted claims, compare evidence to acceptance,
and take the next authorized action without asking the operator to manage
the handoff. If a permission or capability is missing, name precisely that
blocker and preserve the rest of the work. Do not convert "take over" into
permission to skip gates. Merge is not promotion; a successful build is
not installation; neither proves the reported bug fixed.

Use the real completion mechanism. Managed delegations have result events.
Project responsibilities can have code-owned observation and follow-up;
verify linkage/state instead of promising a blanket polling schedule.
A bare operator-session pane has no delegation watcher. Without a real
wake mechanism, say checks happen only during active turns; never promise
unattended watching or create a timer/program without authorization.

## 7. Report facts; preserve resources

Keep reports short: outcome, evidence, next authorized step taken, and
any real decision/blocker. Distinguish worker claims from your assessment.
If the action record is missing, say "I cannot establish that from the
available record." Do not invent a causal story to answer why.

Leave panes, branches, worktrees, and reports available for inspection.
Completion, detaching a responsibility, and cleanup are separate actions.
Do not close/delete resources without explicit applicable authority;
use the project's sanctioned removal path only when cleanup is approved.
A STOP response is not permission to perform cleanup.
