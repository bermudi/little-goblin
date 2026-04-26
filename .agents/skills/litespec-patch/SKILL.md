---
name: litespec-patch
description: Create a patch-mode change for small, single-capability deltas. Use when the user wants a quick fix, minor flag addition, or small behavioral tweak, or says "patch".
---

Create a patch-mode change for small, single-capability deltas.

---

## When to Use Patch

Use the patch lane when:

- The change touches **one capability** with a small, clear delta
- You already know exactly what needs to change — no design discussion needed
- Examples: adding a CLI flag, tweaking output format, fixing a small behavioral bug

Do NOT use patch when:

- The change touches **multiple capabilities**
- You need to REMOVE requirements (REMOVED deltas need careful review — use propose)
- The change needs design discussion, architecture decisions, or phased tasks
- You need research on external APIs or libraries

**Rule of thumb:** If you can describe the change in one sentence and it doesn't need a design doc, use patch. Otherwise, use `litespec new` and the propose workflow.

---

## Workflow

```
patch → implement → archive
```

1. **Create the change:** `litespec patch <name> <capability>`
   - Creates `specs/changes/<name>/specs/<capability>/spec.md` with a stub
   - Writes `.litespec.yaml` with `mode: patch`
   - No proposal.md, design.md, or tasks.md

2. **Write the delta:** Edit the spec.md to describe your ADDED or MODIFIED requirements with scenarios

3. **Implement:** Make the code changes directly

4. **Validate:** `litespec validate <name>` to check your delta

5. **Archive:** `litespec archive <name>` to merge deltas into canonical specs

---

## Behavioral Guardrails

- **One capability per patch** — if you need to touch multiple, use propose instead
- **No planning artifacts** — patch mode omits proposal, design, and tasks. The delta IS the contract.
- **Validate before archive** — always run `litespec validate` to catch spec errors
- **Commit after archive** — archive updates canon; commit the result
