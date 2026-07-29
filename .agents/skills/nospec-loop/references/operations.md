# Loop operations

Read this when configuring or recovering an AFK run. Use `nospec run --help` for the complete flag interface.

## Baseline

The first mutating run records Git root, HEAD, and worktree state, then refuses staged, unstaged, or untracked paths outside `.loop/`. `--accept-dirty-baseline` explicitly accepts and records that risk, including an unversioned target; it does not protect existing files.

Prefer a separate worktree when the current checkout contains unrelated work:

```bash
git worktree add ../project-nospec -b nospec/<cycle>
nospec run .loop/<cycle>/QUEUE.md --repo ../project-nospec
```

A worktree separates edits but is not a security sandbox.

## Invocation

`LOOP_AGENT_CMD` selects the worker; `LOOP_REVIEW_CMD` and `LOOP_FIX_CMD` may select review and fixer agents. A unit's `Agent:` overrides only that worker. Commands run through `bash -lc` in the target repository with `LOOP_PROMPT_FILE` pointing to the generated prompt.

```bash
LOOP_AGENT_CMD='pi -p --no-session --approve "$(cat "$LOOP_PROMPT_FILE")"' \
  nospec run .loop/<name>/QUEUE.md
```

Workers also receive phase, queue, evidence, and review paths. A build worker can stop before verify by writing `blocked` on the first line of `LOOP_RESULT_FILE` and its reason below.

## Order and recovery

The first non-`done` unit owns queue order. `pending` may run; `in_progress`, `verify_failed`, `no_progress`, or `blocked` stops the cycle until its cause is addressed and `--resume` explicitly resets it. Later units never bypass it.

Each tick marks the unit in progress, invokes the worker, consumes blocker or process failure, executes verify, records evidence, and either marks done or stops. Repeated verify failures without repository progress become `no_progress`. Tick bounds and non-clean exits produce a handoff.

## Files

- `EVIDENCE.md` — append-only baseline, worker/verify results, resulting state, proof boundary, and opted-in Markdown pins. Keep it.
- `HANDOFF.md` — current non-clean stop and next action; removed when build and review state are clean.
- `REVIEW.md` — structured review state when `--review` is used. A nonzero actionable count remains blocking.

`nospec view` summarizes cycles. Pin alerts route to review and coherence inspection; they are not coherence failures by themselves.
