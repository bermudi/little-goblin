The user wants to know where they are in the litespec workflow and what to do next.

**The workflow is unidirectional:**

```
explore → grill → propose → apply → review → archive
                                    │
                                adopt (separate path)

patch → archive  (lightweight lane for small, single-capability changes)
```

Detect the user's current state:

```bash
litespec status --json
```

The JSON includes `suggestedNextStep` ("plan", "build", or "review") and per-change `reviewMode`. Use these directly instead of deriving them.

**Interpreting litespec status --json:**
- `isNewProject`: true = user needs `litespec init` or has just initialized
- `changes[].suggestedNextStep`: what to do next for each change
- `changes[].reviewMode`: "artifact" / "implementation" / "pre-archive"
- `changes[].isComplete`: true = ready to archive

**No project exists** — the user needs `litespec init`.

**`isNewProject` is true** — read `references/onboarding.md` to distinguish first-time users from experienced users.

**Changes exist** — find the most relevant change and use its `suggestedNextStep`:
- **plan**: write planning artifacts
- **build**: implement the current phase
- **review**: run review, then the user runs `litespec archive <name>`

**Key gotchas:**
- explore and grill are ephemeral — no artifacts. To save thinking, move to propose.
- propose is the commit point — once artifacts exist, the plan is committed.
- Phase tracking comes from tasks.md checkboxes — the first unchecked block is the current phase.
- Archive is a human decision — the agent never runs `litespec archive`.

When the user asks "what do I do next?", use this response template:

> **Current state:** [X active changes, Y ready to archive]
> **Most relevant:** [change-name] at [N/M tasks]
> **Next step:** [specific skill]
> **Why:** [brief reason]

Common questions — read `references/faq.md` when the user asks workflow questions.
