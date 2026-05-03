# scoped-memory — Consolidated Review Report

## Status / Readiness
- **Missing artifacts:** none (proposal/design/specs/tasks all present).
- **Verification:** **423 tests pass (0 failures)** and **typecheck is clean**.
- **Coverage of checklist tasks:** **Phase 1–5 checked**. **Phase 6–8 remain partially/fully unchecked**:
  - Phase 6: typecheck/test verification checkbox left unchecked (even though it passes).
  - Phase 7: manual smoke test left unchecked.
  - Phase 8: validation/archive ceremony tasks left unchecked.

Overall: **structurally sound and tests are strong**, but there are **a few spec/interface mismatches, several defensive hardening items, and outstanding checklist/test gaps before archive.**

---

## Phase 1: Adversarial Findings

### CRITICAL / High-risk (depends on runtime concurrency assumptions)
1. **Concurrent writes to the same scope file can clobber updates**
   - **Issue:** `MemoryStore.mutate()` is a read-modify-write flow (TOCTOU). Without a per-scope lock, overlapping writes can silently overwrite earlier changes.
   - Seen as: concurrent named subagent + main agent writes; and also concurrent writes to **named persona memory** (`agents/<name>/memory.md`).
   - **Recommendation:** add **per-scope (and per-agent) file locking** (or, if v1 is intentionally homelab/serialized, add a prominent comment + TODO documenting the assumption and future lock site).
   - (Common location noted across reviews: `src/memory/store.ts:mutate()`; persona paths driven by `src/subagents/runner.ts` / `src/subagents/execution.ts`.)

2. **`archiveOrphan` / rename behavior under contention**
   - **Potential race:** reviewers flagged that `archiveOrphan()` may move directories while a write’s temp file exists, which could misplace temp artifacts or break the final rename.
   - **But** another reviewer noted mitigation: if all relevant I/O in `mutate()` is synchronous, Node won’t interleave during that call (so the window may be narrower than feared).
   - **Also:** **rename destination already exists** can cause `renameSync` to throw; some reviewers note the caller swallows exceptions, potentially leaving orphans unarchived.
   - **Recommendation:** regardless of the exact interleaving risk, harden `archiveOrphan()`:
     - guard/cleanup destination before `renameSync`, and/or
     - reject archive when scope temp artifacts exist, and/or
     - move to locking for correctness under parallelism/multi-process.

---

### WARNING (spec alignment, correctness edges, robustness)
1. **`listIndex` / `memory_read_index` JSON shape vs spec scenario**
   - **Mismatch:** some spec wording expects `general` to appear inside the `topics` array; implementation returns `general` as a **separate field** (alongside `topics`, `agents`).
   - **Recommendation:** choose one:
     - update the spec scenario to match the implementation shape, **or**
     - change implementation to encode `general` into `topics` (with a sentinel entry), if the spec must be followed literally.

2. **`listIndex` may omit `general` when general scope is empty**
   - **Issue:** `general` is only populated when the general file has body/description content; empty general becomes “invisible” in the index.
   - **Recommendation:** always include `general` in the index response (even if empty), per the “SHALL appear” requirement.

3. **`formatSnapshot` / topic name best-effort handling**
   - **Gap A:** subagent snapshot formatting may not thread `getTopicName`, so subagents may show literal `topics/<chat>/<topic>` paths while main agent gets names.
   - **Gap B (robustness):** if a provided `getTopicName` callback throws, `Promise.all` can fail the whole snapshot formatting.
   - **Recommendation:** thread `getTopicName` into subagent snapshot deps, and wrap the callback in `try/catch` with a null fallback to preserve “best-effort” behavior.

4. **`memory_write.add` accepts empty string content**
   - **Issue:** empty string content creates degenerate `§\n` entries (phantom delimiters).
   - **Recommendation:** reject empty content in the `add` tool handler (`memory_write.add`).

5. **Path traversal risk via unsanitized agent names**
   - **Issue:** `memory_read` that accepts arbitrary `agent.name` can allow `../`-style traversal to resolve paths outside the intended discriminated union boundaries.
   - **Recommendation:** validate agent names using the same allowlist/pattern used for spawn (e.g. `VALID_NAME_RE`), rejecting `/`, `..`, etc.

6. **`childActiveScope` uses a `chatId: 0` sentinel**
   - **Issue:** when `activeScope` is missing, it defaults to a magic value that won’t match real topics, which can silently confuse debugging.
   - **Recommendation:** make `activeScope` required (or throw if missing for topic-scoped usage).

7. **Frontmatter fallback may hide corruption**
   - **Issue:** malformed frontmatter can fall back to “body-only,” potentially masking a broken description header.
   - **Recommendation:** log/track when fallback occurs, or validate on write to prevent malformed files from ever being produced.

8. **Orphan lifecycle edge cases**
   - **Silent orphans:** `onTopicNotFound` triggers only when the system attempts an operation; if a deleted topic never gets touched again, it can remain orphaned indefinitely.
   - **Revival with stale active scope:** subagents resurrected from `meta.json` can point at a topic scope that was archived since last run.
   - **Recommendation:** consider (a) periodic orphan scanning or (b) explicitly documenting the trade-off; and validate/repair/abort revival when topic directories no longer exist.

9. **Delim-boundary edge case in `removeEnclosingEntry`**
   - **Issue:** delimiter-boundary cases (needle containing `§\n`) may not be fully covered.
   - **Recommendation:** add a regression test for the boundary behavior.

---

### SUGGESTIONS / Hygiene & Cleanup (often low-risk, but worth doing)
1. **Legacy/dead compatibility code should be removed**
   - `formatSnapshot(store: MemoryStore)` legacy overload / `formatLegacySnapshot` is likely dead code and should be removed to avoid accidental spec regressions.
2. **Backward-compat shim `memoryFilePath` should be deprecated/renamed**
   - It maps “memory” to the **general** scope path, which is semantically confusing relative to “memory file” expectations.
3. **Trim description whitespace**
   - `setDescription` stores raw strings; trimming would prevent whitespace drift in persisted descriptions.
4. **ListIndex directory handling / symlink assumptions (homelab risk)**
   - Some reviews raised symlink/unexpected structure concerns for `readdirSync`-based traversal. If inputs are fully controlled, this may be acceptable; otherwise guard/resolve defensively.

---

## Phase 2: Compliance Findings

### Spec / contract alignment issues
- **Index response shape:** `general` placement (`general` field vs `topics[]` entry) is the main “spec scenario vs implementation” discrepancy.
- **Index presence of empty `general`:** ensure `general` is always included even when empty.
- **Type/spec clarity (not clearly functional breakages, but flagged):**
  - `scopeTag` vs `MemoryScope` union handling of `"user"`.
  - `ActiveScope` containing `chatId` while it’s not part of the scope union (binding-context clarity).

### Checklist/task gaps (blocking readiness gates)
- **Phase 6:** “Verify bun run typecheck + bun test pass” checkbox remains unchecked (even though results are known-good).
- **Phase 7:** “Manual smoke test” remains unchecked.
- **Phase 8:** all validation/archive ceremony tasks remain unchecked.

### Test coverage gaps (actionable)
- **Snapshot behavior:** test that `general` appears in `## other scopes` when the active scope is a topic.
- **Tool behavior:**
  - cross-chat `memory_read` rejection test (`chatId` mismatch).
  - success-path tests for `createMemoryWriteTool.execute` for `action: "remove"` and `action: "rewrite"`.
- **End-to-end orphan archival:** current coverage may split between buffer callback firing vs actual `archiveOrphan` disk movement; if you rely on manual smoke, keep that explicit.

---

## Backlog / Non-goals to defer
Defer/keep in backlog as non-goals, consistent with the proposal:
- v1.x **PII redaction** in memory writes (post-v1)
- v1.x **automatic defragmentation**
- v2 **multi-agent write coordination** / concurrency safety for named subagents

---

## Next steps before archive
1. **Complete Phase 6–8 checklist items** (especially manual smoke for orphan archival + Phase 8 validation/archive tasks).
2. Decide on concurrency stance:
   - either implement per-scope/per-agent locking, **or** explicitly document the serialized-homelab assumption with a clear TODO.
3. **Align `listIndex` with the spec story**:
   - fix missing empty `general`, and resolve the `general` placement mismatch (code vs spec scenario).
4. Apply the key hardening items if you want safer behavior under adversarial inputs:
   - reject empty `memory_write.add` content,
   - validate/sanitize agent names for traversal resistance,
   - require/validate `activeScope` instead of using `chatId: 0`.
5. Fill the most important test gaps (general-in-other-scopes; cross-chat rejection; remove/rewrite success paths; orphan archival e2e if not covered by smoke).

If you want, tell me what format you need for the PR (e.g., “short summary + bullets” vs “full review markdown”), and I’ll compress this into that exact template.