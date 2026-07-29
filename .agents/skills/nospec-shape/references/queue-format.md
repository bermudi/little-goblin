# Queue format

Read this when serializing work into `.loop/<name>/QUEUE.md`. The queue is disposable coordination state parsed mechanically by the loop.

Each top-level `##` heading is one required, nonempty outcome. `###` headings and heading-shaped text inside fences remain part of that unit.

Fields:

- `Agent:` and `Why:` — optional override and non-obvious rationale.
- `Read first:` and `Constraints:` — optional, unique, and nonempty when present; context and boundaries, never an edit list.
- `Done means:` — required, unique, and nonempty acceptance surface.
- `Verify:` — required unique fenced `bash` command covering the mechanical subset of acceptance.
- `Status:` — required and unique; starts as `pending`.

A verify must be deterministic, runner-executable, and fail for a plausible state where the outcome is absent. `nospec lint` rejects malformed structure, shell syntax errors, and obvious vacuity but cannot judge whether a valid command exercises the outcome.

````markdown
# Loop Queue: <short name>

Goal:
<desired end state>

## <observable outcome>

Read first:
- <only relevant context>

Constraints:
- <what must remain true or is out of bounds>

Done means:
- <observable acceptance criterion>

Verify:
```bash
<discriminating command>
```

Status: pending
````

Omit optional fields rather than writing placeholders. Use `.loop/<name>/DESIGN.md` only for reasoning a worker cannot recover from code or authoritative records. Run `nospec lint <queue>` before leaving. On clean completion, delete queue, handoff, review, and scratch designs; keep `EVIDENCE.md`.
