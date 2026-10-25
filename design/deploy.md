# Deployment

## Purpose and authority

How a commit becomes the running service on g7. The implementation is
`scripts/release.ts`; this file is the ruling behind its shape.

Running the rollout command **is** the operator's authorization to restart
the service — the same rule the in-place `scripts/deploy.sh` carried, moved
with the mechanism. Nothing here grants authority to install or reload
units, publish a client, deploy the memory stack, or push Git refs.
Diagnosis (`bun run doctor`) confers no deployment authority either.

## The model

```
/home/daniel/goblin-releases/
  <full-sha>/                 one complete release: tracked tree at that
                              commit + its own node_modules + its own app/dist
  <full-sha>/
  live -> <full-sha>          symlink, swapped with one rename(2)
```

`goblin.service` runs with `WorkingDirectory=/home/daniel/goblin-releases/live`
and `ExecStart=/usr/bin/bun run src/index.ts`. The symlink is resolved when
the process starts and never re-read by a running process, so what is
serving a request is exactly one immutable release.

Deploying is: build the release if it is not already complete → flip `live`
by rename → restart → verify. Rolling back is the same without the build,
because the previous release is untouched and complete on disk.

## Invariants

- **A release directory that exists is complete.** A build assembles under
  `.staging.<sha>.<pid>.<rand>` and is renamed into place only after the
  typecheck, the client build and `check-app-assets.ts` pass and
  `.release-complete` is durably written. A failure leaves the staging
  directory for inspection and never becomes addressable. `--rollback <rev>`
  can therefore never find half a release.
- **The unit is the only source of truth for where and with what.** The
  script reads `WorkingDirectory` and `ExecStart` from the installed unit. It
  builds with the bun the unit runs (`/usr/bin/bun`), not whichever bun is
  first on the operator's PATH — a build and a runtime on different bun
  versions is a class of bug worth making impossible. It also takes
  `GOBLIN_HOME` from the unit, so the acceptance probe verifies the
  deployment the unit describes, not one a shell variable named.
- **Nothing at runtime reads the checkout.** Sources, dependency tree and
  client live inside the release; state lives in `$GOBLIN_HOME`. The release
  has no `.git`, so `release.ts` refuses to run from one instead of resolving
  a parent repository.
- **A release is a commit, and only a commit.** `git archive <rev>` ships
  tracked files; uncommitted edits and untracked files in the development
  tree cannot be deployed even by accident. This replaces the dirty-tree
  refusal: the old gate existed because the process ran in a writable tree,
  and that tree is no longer what runs.
- **`live` and the running process can disagree for exactly one step.** A
  flip without a restart leaves the old process serving. `--status` reads
  `/proc/<pid>/cwd` and reports `(restart pending)` rather than hiding it.
  This is the only inconsistency the layout can hold, and it is visible.
- **No release is ever deleted by tooling.** Retention is the operator's
  `trash`. A rollout prints what it replaced; `--status` lists what is kept.

## Why this replaces the in-place deploy

The server is TypeScript run in place, so the live artifact used to be a
working tree. Everything the old script carried beyond "restart and verify"
existed to defend that tree against itself: refuse modified tracked files,
force reinstall and rebuild after an interrupted attempt, track the deployed
revision in `.git/GOBLIN_DEPLOYED_REV`, re-check that HEAD had not moved
between the gate and the restart, decide from a diff which dependencies and
client inputs had to be refreshed, and roll back with `git reset --hard` in
the operator's own working tree. All of that is bookkeeping about a mutable
artifact: a release directory makes each failure mode unrepresentable rather
than merely guarded.

The client swap deserves a note, because it is what motivated the old
slots. `publish-app.sh` flipped `app/dist` independently of the process,
which made "publish the client" a second deployable thing and skew between
client and backend a rule to remember ("both halves, one approval"). In the
release layout the client is inside the release, so skew cannot be
expressed: a client change *is* a release, and a release *is* a restart. The
slots and their rollback flip are gone, not deprecated.

The cost, stated plainly: iterating on the client no longer skips a restart.
`bun run app:dev` (Vite HMR against the live backend) remains the development
loop, and a restart fences an in-flight turn — the chat shows it as
superseded, the message is already in history, and delegation survives in its
own unit. The trade is accepted deliberately: the machinery it deletes was
larger and harder to reason about than the restart it costs.

## What the gate still buys

The rollout gates on `bun run typecheck` **inside the release**, against the
release's own dependency tree, before anything is flipped. The suite gates
merges in CI, not deploys. After the restart it requires startup acceptance
from the invocation that restart created (`scripts/check-startup.ts --watch`,
the installer's grammar: both lifecycle events, loopback `/app/` HTML and its
local assets, no crash-restart within the budget), scans the fresh journal
for error lines, and probes the memory API when the stack is installed.

It never rolls back automatically. A failed acceptance leaves the flip in
place and exits non-zero: whether to roll back is the operator's decision,
and silence plus an automated revert would hide which revision is live.

## Cutover (one time, per box)

A box that still runs the in-place layout is refused by a normal rollout with
the reason and the remedy. `--adopt-unit` performs the transition: build the
release, point `live` at it, rewrite the single `WorkingDirectory=` line of
the installed unit, `daemon-reload`, restart, verify. Only that line changes;
a hand-edited unit is reported, never replaced with a rendered copy, and a
unit reached through a symlink is refused because write-temp-then-rename
through a link forks the config it points at.

The tracked `deploy/goblin.service` keeps its checkout-shaped
`WorkingDirectory`: it is the fresh-install truth for a new box, which
installs from a checkout and adopts the release layout on its first approved
rollout.

## Operations

```sh
bun scripts/release.ts --status          # live, running, kept, unit match
bun scripts/release.ts --build-only      # build + gate a release, touch nothing live
bun scripts/release.ts                   # build HEAD if needed, flip, restart, verify
bun scripts/release.ts --rev <rev>       # deploy a specific commit
bun scripts/release.ts --rollback <rev>  # flip back to a kept release, restart, verify
```

Rollouts take a `mkdir`-based lock in the releases root, so two sessions
cannot interleave flips; a lock whose recorded pid is gone is reported with
the path to `trash`, never cleared automatically. Diagnostics go to stderr
and the result to stdout (`deployed <sha>`, plus the rollback command); two
`deploy …` annotations are appended to `goblin.log` so a deploy-initiated
restart stays distinguishable from a spontaneous one.
