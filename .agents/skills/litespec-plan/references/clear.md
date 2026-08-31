Use when the idea is sharp and you need to nail the GH issue (+ spec if load-bearing). This is the clear mode of `plan`.

## What to write — GH issue is proposal + design + queue

Before writing, run `git status --porcelain`. If the output is not empty, stop and ask the user to commit, stash, or move that work. Do not create a queue issue from a dirty tree.

Record the output of `git rev-parse HEAD` as the base. Create and switch to `litespec/<change-name>` with `git switch -c`; stop if it already exists rather than reusing it. This branch belongs exclusively to this issue. Concurrent or unrelated work uses another branch or worktree.

1. **Proposal (why/what).** Create the issue with the `litespec` label. Top of issue body: what we're doing, why, what we're not doing. Then record both immutable ownership lines:
   ```
   Base: <sha>
   Branch: litespec/<change-name>
   ```
   `litespec-review` checks the branch and derives review scope from the base.
2. **Design (how).** Directory, lanes, key decisions — concise, not an essay.
3. **Queue — one `##` per unit.** Each unit:
   ```
   ## <one boundary or failure-policy outcome>
   Read first: <areas and rulings, not a file list — optional>
   Constraints: <what must stay true or is out of bounds — never what to edit — optional>
   Depends: <other unit heading>, <another unit heading>
   Boundary: <filesystem | process | network — when applicable>
   Done means:
   - [<clause-id>] <observable outcome>
   Scenarios:
   - [<clause-id>] <named test scenario>
   Risk cases:
   - timeout: [<clause-id>] or N/A — <reason>
   - cleanup: [<clause-id>] or N/A — <reason>
   - non-ENOENT errors: [<clause-id>] or N/A — <reason>
   - concurrency: [<clause-id>] or N/A — <reason>
   - optional configured dependencies: [<clause-id>] or N/A — <reason>
   Verify: `<command that fails without the outcome>`
   - [ ] pending
   ```
   Omit `Boundary:` and `Risk cases:` unless the unit crosses a filesystem, process, or network boundary. Every `Done means:` clause has a unique ID and maps through `Scenarios:` to at least one named test. Applicable risk entries map to one of those IDs or give a concrete N/A reason.
   `Verify:` must fail for a plausible state where the outcome is missing. A `go test` that doesn't check output is not a Verify.
   `Depends:` is optional, references `##` headings in the same issue, comma-separated. A unit is unblocked when all its `Depends:` units are checked `- [x]`.
   `Read first:` is optional, unique, nonempty when present. Context, not scope — prefer areas and rulings over long file lists. Omit rather than placeholder.
   `Constraints:` is optional, unique, nonempty when present. Boundaries: what must stay true or is out of bounds — never what to edit. Omit rather than placeholder. The worker owns the implementation path; don't smuggle in an edit script via Constraints.

4. **Spec if load-bearing.** If the feature is a promise that breaks things when wrong (CLI shape, API, file format), edit `specs/<feature>/spec.md` directly in the same change — not a delta. Keep to 3-5 SHALL requirements, each with a WHEN/THEN scenario.

## Rules

- One unit = one external boundary or one failure policy. Split broad demos across independent boundaries into separate units.
- Every outcome clause maps to a named test scenario; filesystem, process, and network units account for all five standard risks.
- One Verify per unit, and that Verify is the gate — `build` must satisfy it before claiming done.
- If building shows the spec is wrong, update the spec in the same PR. Don't force wrong code to match a stale spec.
