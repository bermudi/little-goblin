---
name: nospec-loop
description: Use when installing the optional runner, deciding whether shaped work is safe for AFK execution, or running a queue behind the external verify gate.
compatibility: Requires Bash and Python 3.10 or newer; baseline checks use Git, with explicit unversioned operation via `--accept-dirty-baseline`. Supports macOS and Linux.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Loop

Operate unattended execution behind external verification. Most work should remain interactive; use the runner only when a `.loop/<name>/QUEUE.md` is ready and the human intends to leave.

## Batch-worthiness

Every unit must be bounded, free of unresolved decisions, and carry a deterministic runner-executable verify that fails when its central outcome is plausibly absent. If an architecturally bad result can easily pass, strengthen the assertion, reshape the work, or stay interactive. Optional review inspects unverified acceptance surface; it cannot make subjective architecture mechanically proven.

## Mechanical guarantee

Before mutation, the runner preflights the whole queue and starting baseline. Per tick it invokes one worker, then runs that unit's `Verify:` outside the agent. It marks the unit done only when the command exits zero; the worker cannot self-certify.

This proves the command passed in that repository state—nothing beyond its scope. `EVIDENCE.md` records the baseline, resulting state, exact command, exit result, output, and conservative proof boundary.

## Use

```bash
# install the runner on PATH once
.agents/skills/nospec-loop/scripts/nospec install

# preflight, then run
nospec lint .loop/<name>/QUEUE.md
nospec run .loop/<name>/QUEUE.md
```

Read [`references/operations.md`](references/operations.md) when configuring a run, accepting a non-clean baseline, resuming, or interpreting its files and statuses. Read [`references/review-loop.md`](references/review-loop.md) only when using `--review`. The command's `--help` owns the complete flag interface.

The runner's prompts load `nospec-carve` for source work, `nospec-trial` for review, and `nospec-shape` for conversion of actionable findings into queue units. The runner itself owns only orchestration and mechanical signals.

Delete completed queue, handoff, review, and scratch files. Keep `EVIDENCE.md` as the verification ledger.
