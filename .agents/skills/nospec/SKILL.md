---
name: nospec
description: Use when installing Nospec, deciding whether work is safe for AFK execution, or intentionally running an already-shaped queue behind the external verify gate.
compatibility: Requires Bash and Python 3.10 or newer; safe baseline checks use Git, with explicit unversioned operation available via `--accept-dirty-baseline`. The runner supports macOS and Linux and is invoked as `scripts/nospec` from this skill directory (or via `nospec` on PATH after `nospec install`).
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Nospec batch runner

Most work should remain interactive while the human is present. Use the runner only when a `.loop/<name>/QUEUE.md` is ready and the human intends to leave.

## Batch-worthiness

Every unit must be bounded, mechanically verifiable, and free of unresolved decisions. A deterministic command is not enough: it should fail for a plausible repository state where the central outcome is absent. If an architecturally bad implementation can easily pass, strengthen the assertions, decompose again, or keep the unit interactive.

Optional review inspects unverified acceptance surface; it does not convert subjective architecture into deterministic proof.

## Mechanical guarantee

Before mutation, the runner requires each unit to have a nonempty outcome, `Done means:`, fenced Bash `Verify:`, and valid `Status:`. Optional `Read first:` and `Constraints:` fields must be unique and nonempty when present. Preflight also checks shell syntax and rejects obviously vacuous verifies (`true`, `:`, and `exit 0`). The cycle's first mutating run then requires a clean Git worktree outside `.loop/`; `--accept-dirty-baseline` explicitly accepts and records pre-existing changes or an unversioned target without protecting them. Per tick the runner invokes one worker, then executes `Verify:` outside the agent. It marks the unit done only when that command exits zero. The worker cannot self-certify.

This proves the verify command passed in that repository state—nothing beyond its scope. `EVIDENCE.md` records the cycle baseline, exact command, exit result, output, resulting worktree state, and a conservative proof boundary without interpreting shell syntax.

Run preflight directly with:

```bash
nospec lint .loop/<name>/QUEUE.md
```

## Install

After skills.sh installs this skill locally, put the bundled runner on PATH:

```bash
.agents/skills/nospec/scripts/nospec install
```

For a global skill install, use `~/.agents/skills/nospec/scripts/nospec install`. The install verb creates a symlink in a writable PATH directory; it does not alter the repository's documents or adopt Nospec metadata conventions.

## Run

```bash
nospec run .loop/<name>/QUEUE.md
```

`--dry-run` preflights the whole queue, reports baseline safety, and previews the next runnable unit. `--repo DIR` selects the target when the queue lives elsewhere; use it with a manually created Git worktree to separate AFK edits from the current checkout. A worktree is not a security sandbox.

`LOOP_AGENT_CMD` selects the worker. `LOOP_REVIEW_CMD` and `LOOP_FIX_CMD` may select separate review and fix agents; a unit's `Agent:` overrides the worker for that unit.

A worker reports a decision or dependency blocker by writing `blocked` plus its reason to `LOOP_RESULT_FILE`; the runner consumes that signal before verification. A non-zero worker exit is also blocking.

The first non-`done` unit owns queue order. Later pending work cannot bypass an `in_progress`, `verify_failed`, `no_progress`, or `blocked` unit. After addressing the cause, `nospec run ... --resume` explicitly resets that unit to `pending` and retries it.

The runner also stops on verify failure, repeated no-progress, tick limits, malformed fixer output, or unresolved actionable review. Non-clean exits write `HANDOFF.md`.

With `--review`, the runner invokes `nospec-trial` after the queue drains. Actionable findings go through `nospec-mend`, which appends new pending units; review rounds are bounded. The runner only orchestrates and reads the actionable count. Skills own judgment.

## Lifecycle

Delete completed `QUEUE.md`, `HANDOFF.md`, `REVIEW.md`, and scratch specs. Keep `EVIDENCE.md` as the verification ledger.
