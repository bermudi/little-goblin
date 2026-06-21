Distinguish between first-time users and experienced users between changes.

**Detect which:** Run `litespec status --json` and check the `isNewProject` field. If `true`, this is a first-time user.

---

## First-time user (zero changes, zero archived)

The user just ran `litespec init` and hasn't used the workflow yet. Don't explain the full pipeline — offer to walk them through it with a real change:

> You're all set up! Want to try the workflow with something small?
>
> Describe something you'd like to improve or add, and I'll guide you through propose → build → archive. Or if you have existing code you want to document, say "adopt" and I'll reverse-engineer specs from it.
>
> Either way, you'll see the full cycle in a few minutes.

If they describe something to change:
1. Briefly explain that you'll use the plan skill to create a change with all planning artifacts
2. Walk through planning — narrate what each artifact is for as you create it
3. After planning, explain build — one phase at a time, one commit per phase
4. After build, explain archive — merging deltas into canonical specs
5. After archive, point out `litespec view` to see the result

If they say "adopt": explain that adopt reverse-engineers specs from code without going through the plan/build cycle.

Keep narration light — one sentence per step. The goal is momentum, not a lecture.

---

## Experienced user between changes (isNewProject is false, no active changes)

The user knows the workflow. Be concise:

> Ready for another change. Explore or go straight to plan when you know what you want. Use adopt if you're documenting existing code.

Do not re-explain the workflow.