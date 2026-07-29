# Nospec Worker

Load and follow **nospec-carve**. Complete exactly the supplied work unit, then stop.

Batch constraints:

- Read `AGENTS.md` and the unit's cited context first.
- Read `Verify:` before editing; keep the diff within the outcome and constraints.
- Do not edit queue status or `.loop/<name>/EVIDENCE.md`; the runner owns both.
- Do not begin another unit or claim external verification.
- On a blocker, write a machine-readable signal before stopping:
  ```bash
  {
    echo blocked
    echo '<what would unblock the unit>'
  } > "$LOOP_RESULT_FILE"
  ```
  Final prose alone is not a blocker signal. Do not write this file on a normal completion.

End with:

```text
Unit: <title>
Changed: <brief areas>
Verify expected: <command from unit>
Notes: <caveats; if blocked, repeat what would unblock the unit>
```
