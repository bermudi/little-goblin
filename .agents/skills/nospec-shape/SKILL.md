---
name: nospec-shape
description: Use when work must be decomposed into bounded, observable outcomes; emit `.loop/<name>/QUEUE.md` only when execution needs a cross-session handoff or the batch runner.
license: MIT
metadata:
  author: bermudi
  version: "1.0.0"
---

# Shape

Decompose work into outcomes that can be checked independently. Interactive work can stay conversational; serialize a queue only when another session or the batch runner needs a durable handoff.

Plans and work specs—queues, handoffs, and scratch designs for the current change—are disposable coordination state. Regenerate a stale plan from current records instead of preserving it as a universal behavioral canon. Project-designated contracts such as API schemas, protocol definitions, compatibility policies, or contract tests remain durable. If no authoritative project context, accepted ruling, or established metadata convention designates one, ask rather than inferring authority from its filename.

## Choose a useful cut

- A **tracer bullet** crosses an uncertain path end to end so integration failures appear early instead of after broad implementation. It is waste when there is no uncertain path to prove.
- A **vertical slice** produces visible behavior across the necessary layers, exposing contract mismatches that layer-local work hides. A slice too thin to exercise the integration gives false confidence; one too broad delays the feedback it exists to obtain.
- **Horizontal breadth** applies a known contract efficiently across one layer or family of cases. Before that contract is proven, breadth multiplies the same wrong assumption everywhere and postpones integration feedback.

These are trade-offs, not required phases. Use the cut that produces the earliest relevant evidence.

## Shape one work unit

A unit is one observable outcome. It carries:

- `Read first:` — optional relevant records or code areas; context, not a list of files to edit.
- `Constraints:` — optional boundaries: what must remain true or is out of bounds.
- `Done means:` — required, nonempty acceptance criteria.
- `Verify:` — the required mechanically checkable subset of those criteria.

Omit optional fields when they carry no information; placeholder bullets are ceremony, not shape.

The worker owns the implementation path. Prescribing edits in `Read first:` or `Constraints:` turns an outcome into a brittle script.

## Test the verification

Verification must discriminate between success and a plausible failure, not merely be deterministic.

Ask:

> Can a believable bad implementation pass this command while violating the unit's central outcome?

If the answer is easily yes, strengthen the assertion, split the unit, or keep the work interactive. `nospec lint` rejects mechanically obvious non-verification such as `true`, `:`, and `exit 0`, but it cannot judge whether an otherwise valid command exercises the outcome. Put every mechanically checkable critical criterion in `Verify:`. What remains in `Done means:` is unverified judgment surface; review can inspect it, not convert it into deterministic proof.

Typical shapes:

- A bug fix needs a regression that fails before and passes after.
- A behavior-preserving refactor needs tests covering the preserved contract.
- An investigation can batch only when its evidence collection is mechanically observable; interpretation remains interactive judgment.

A unit whose core success condition remains judgmental is not AFK-ready. Do not use `--review` to disguise that weakness.

## Serialize only when warranted

Plan-then-leave work may use `.loop/<name>/QUEUE.md` as a cross-session handoff while the agent remains responsible for verification. Runner-backed batch adds a harder threshold: every unit must be safe to execute without human judgment.

Use the batch runner only when every unit:

- is bounded;
- has a deterministic runner-executable verify;
- does not require a new decision during execution.

Keep queues short enough to remain intelligible. If no credible verify exists, make establishing one an earlier outcome or stay interactive.

Run `nospec lint .loop/<name>/QUEUE.md` before unattended execution. The runner performs the same whole-queue preflight before changing status.

Write `.loop/<name>/DESIGN.md` only when a worker cannot recover important reasoning from the code and authoritative records. It is disposable too.

A proposal discovered while shaping is not an ADR. Ask the decision owner; after explicit acceptance or delegated authority, record it with `nospec-rule`.

## Queue format

````markdown
# Loop Queue: <short name>

Goal:
<desired end state>

## <observable outcome>

Agent: <optional shell command overriding LOOP_AGENT_CMD>

Read first:
- <records, rulings, or code areas>

Constraints:
- <what must remain true or is out of bounds>

Done means:
- <observable acceptance criterion>

Verify:
```bash
<command that exits 0 only when the mechanical criteria hold>
```

Status: pending
````

When the cycle finishes, delete its queue, handoff, review, and scratch specs. Keep `EVIDENCE.md` as the verification ledger.
