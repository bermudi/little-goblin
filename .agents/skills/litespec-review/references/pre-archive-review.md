Use this mode when all tasks are checked. The change appears complete. Run both adversarial and compliance review first, then additionally check:

---

## Archive Readiness

- Are all delta specs well-formed? Do ADDED/MODIFIED/REMOVED markers reference valid targets?
- Will the merge produce a consistent canon?

---

## Cross-Artifact Alignment

- Do the final artifacts accurately describe what was actually implemented?
- Flag any drift between specs, design, and code.

---

## Build Verification

Can the project build? Run the build command (e.g., `go build ./...`, `npm run build`). A broken build is a **CRITICAL** issue for pre-archive review. This is the one place where running a command is appropriate — the build must actually succeed, not just appear to.

---

## Scorecard

| Dimension              | Pass | Fail | Not Evaluated |
|------------------------|------|------|---------------|
| Interaction Correctness| N    | N    | N             |
| Test Adequacy          | N    | N    | N             |
| Completeness           | N    | N    | N             |
| Consistency            | N    | N    | N             |
| Readiness              | N    | N    | N             |
| Correctness            | N    | N    | N             |
| Coherence              | N    | N    | N             |
| Archive Ready          | N    | N    | N             |