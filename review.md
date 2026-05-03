# Review Report: scoped-memory

## Missing Artifacts

None. All artifacts present: `proposal.md`, `design.md`, `tasks.md`, and `specs/{memory,agent,subagents}/spec.md`.

## Review Mode

**Implementation Review**: Core scope-checking covered (phases 1–5 fully checked).  
- **Phase 6**: “Verify bun run typecheck + bun test pass” left **unchecked here**, but the run outcome is **passing** (typecheck clean, 446 tests pass).  
- **Phase 7**: Manual smoke test left **unchecked**.  
- **Phase 8**: Housekeeping/archival steps (**validation/preview**, **glossary**, **backlog updates**, **archive**) are **entirely unchecked**, so the change can’t be archived yet.

---

## Phase 1: Adversarial Findings

### Key adversarial scenarios & outcomes

- **Concurrent writes to the same topic scope (same topic, multiple named subagents)**  
  ✅ Handled by `ScopeLock` in `store.ts` (per-scope-key lock around read-modify-write).  
  Verified via `store.test.ts` concurrent safety tests.

- **`archiveOrphan()` racing with `mutate()` for the same topic scope (TOCTOU windows)**  
  ✅ Handled: both acquire the same `GLOBAL_SCOPE_LOCK` keyed by `scopeTag(scope)`.  
  ✅ Additionally, `archiveOrphanLocked` defends against in-flight `.tmp` artifacts by scanning/aborting if `.tmp` is present.

- **Crash between write temp creation and rename (stranded `.tmp`)**  
  ✅ Accepted/acknowledged as a known limitation. The code defends against archiving directories with in-flight `.tmp` via `archiveOrphanLocked`.

- **Cross-locking collision between agent persona scopes and topic memory scopes**  
  ✅ Not a real contention case: the lock key is derived from the normalized scope tag (`topics/<chat>/<topic>` vs `agents/<name>`), so “agent” writes do not contend with topic-scope locks.

- **Named subagent persona scope written concurrently from different parent topics**  
  ✅ Handled: same per-scope-key locking serializes writes to `agents/<name>` regardless of caller topic.

- **Write attempt after a topic has been archived**  
  ✅ Handled: `mutate()` checks existence after acquiring the lock and rejects with an “archived/no longer exists” style error. Covered by the TOCTOU protection tests in `store.test.ts`.

- **Revive of stale meta where the topic has since been archived**  
  ✅ Handled: `revive()` checks `existsSync(topicDir)` before accepting revival. If the topic becomes archived after revive, the `mutate()` TOCTOU guard covers it.

- **Concurrent archive causing index staleness between listing and returning topic list**  
  🟡 Low-risk acceptance: `listIndex` is filesystem-sync, so the returned snapshot may be stale under concurrency, but the next turn’s snapshot should pick up changes. Acceptable for v1 single-user.

- **Cross-chat read attempts**  
  ✅ Handled: `resolveReadScope` rejects reads where the requested topic `chatId` doesn’t match the active scope’s chat.

- **Anonymous subagents using `target: "agent"` for reads/writes**  
  ✅ Handled: `resolveWriteScope` / `resolveReadScope` reject `target="agent"` for anonymous subagents.

- **Subagent isolation (subagent should not receive agent lists via read-index)**  
  ✅ Handled: subagent execution passes `includeAgents: false`, making the agents array empty in `memory_read_index`.

- **Anonymous agent persona leakage via ambiguous scope**  
  🟡 Accepted as “spec allows / implementation honors”: the spec’s scope discriminator allows reads when `{agent: {name}}` is supplied; subagent leakage is mitigated by `memory_read_index` not including agents (`includeAgents: false`). Minor info leakage is considered acceptable for v1.

### Pattern Annotations

- **Concurrency correctness is dominated by `ScopeLock`**: per-scope-key serialization cleanly covers concurrent topic mutations and `archiveOrphan`/`mutate` races.
- **Filesystem/TOCTOU hazards are covered** by (1) lock acquisition, (2) existence checks after locking, and (3) `.tmp` defensive scanning in `archiveOrphanLocked`.

---

## Phase 2: Compliance Findings

### CRITICAL

**C1: `memory_read_index` ignores `all_chats` (spec/impl mismatch)**  
- **Severity**: CRITICAL  
- **Description**: The `createMemoryReadIndexTool` execute handler ignores the input `all_chats` and hardcodes the active chat scope (i.e., it does not enumerate topics across all `chatId`s under `topics/`). The spec requires that with `all_chats: true` the response **SHALL** include topic scopes from every `chatId` under `topics/`.  
- **Additionally**: the tool test asserts the current behavior (parameter ignored), so tests currently validate the mismatch.
- **Location**: `src/memory/tool.ts` (execute handler), `src/memory/tool.test.ts`.  
- **Recommendation**: Choose one canonical behavior and align the other:
  1) Implement real `all_chats: true` support (e.g., make `store.listIndex` operate across all chats when the flag is set), **and update tests/spec accordingly**, or  
  2) If the security decision to ignore `all_chats` is intentional, update the spec to remove/alter that requirement and adjust tests to match the revised contract.

### WARNING

**W1: `memory_read_index` return shape diverges from spec wording**  
- **Severity**: WARNING  
- **Description**: Spec says `topics` entries include `id` and other fields, but implementation returns `{chatId, topicId, name?, description?}`—i.e., `topicId` replaces spec’s `id`.  
- **Location**: `src/memory/store.ts` (`MemoryIndex` type) and `src/memory/spec.md`  
- **Recommendation**: Reconcile spec to match the effective shape (either rename `id` → `topicId` in spec, or clarify spec language if “id” is meant abstractly).

**W2: Snapshot `## other scopes` general visibility conflicts with spec language**  
- **Severity**: WARNING  
- **Description**: `formatOtherScopes` intentionally omits the `general` scope from the “other scopes” section when the active scope *is* general (by design to avoid repeating the active scope). The spec’s wording suggests `general` should appear in every snapshot regardless of caller/active scope.  
- **Location**: `src/memory/snapshot.ts:formatOtherScopes`  
- **Recommendation**: Clarify spec wording to reflect the design intent (e.g., “general appears in snapshots/index responses when general is not the active scope”).

**W3: Snapshot `## other scopes` can render an empty `general` entry**  
- **Severity**: WARNING  
- **Description**: When not in the general scope, `formatOtherScopes` appends a `- general — (no description)` entry even if `general/memory.md` doesn’t exist or has no content. The spec says the `## other scopes` section SHALL be omitted when no other scopes exist (i.e., only the active scope is on disk).  
- **Location**: `src/memory/snapshot.ts:formatOtherScopes` (general entry rendering)  
- **Recommendation**: Gate the `general` entry on whether `general/memory.md` exists and has content; otherwise omit `## other scopes` (or omit the general bullet) to match the spec’s “only active scope” behavior.

### SUGGESTIONS

- **S1: `ScopeLock.acquire` tight-loop comment is stale/confusing**  
  The `setImmediate` yield comment mentions worker-thread concurrency, but the mutex is designed for single-threaded Node event-loop usage. Consider simplifying the code/comment.

- **S2: `VALID_NAME_RE` duplicated**  
  Regex `/^[a-zA-Z0-9_-]+$/` defined both in `src/memory/tool.ts` and `src/subagents/named-agents.ts`. Consider importing from one canonical location.

- **S3: Tool test readability (`as never` for `NULL_CTX`)**  
  `NULL_CTX` is typed in a way that isn’t explained. Replace with a named constant/comment or the type the library expects directly.

- **S4: “memory” alias overlap risk (store vs tool-layer semantics)**  
  `StoreScope` normalizes `"memory"` → `"general"` internally, while tool-layer `target: "memory"` has different meaning (“active scope”). This is currently documented, but the string overlap can confuse maintainers. Consider renaming/removing the alias or clarifying aggressively.

- **S5: Phase 8 housekeeping remains**  
  Validation/preview/glossary/backlog/archival tasks are not complete; the change cannot be archived until these are done.

---

## Cross-Change Consistency

No `dependsOn` in `.litespec.yaml` — skipped.

---

## Scorecard

| Dimension              | Pass | Fail | Not Evaluated |
|------------------------|------|------|---------------|
| Interaction Correctness| 6    | 0    | 0             |
| Test Adequacy          | 5    | 1    | 0             |
| Completeness           | 5    | 1    | 0             |
| Correctness            | 5    | 1    | 0             |
| Coherence              | 4    | 0    | 1             |

**Scorecard notes:**
- **Test Adequacy — 1 fail**: `all_chats: true` test asserts the current (spec-contradicting) behavior rather than the specified contract.
- **Completeness — 1 fail**: Phase 8 housekeeping tasks remain unchecked.
- **Correctness — 1 fail**: `all_chats` is ignored, contradicting the spec requirement.
- **Coherence — 1 not evaluated**: glossary impact can’t be assessed until glossary entries are updated.

---

## Summary

Overall, the implementation is strong and concurrency-safe:

- **446 tests pass (0 fails) and typecheck is clean**.
- **Adversarial concurrent scenarios** (topic mutations vs orphan archival, revival-after-archive, atomic temp/rename handling) are handled via **`ScopeLock` + TOCTOU guards** + `.tmp` defensive checks.
- **Cross-chat access control** and **subagent isolation** are enforced.

The key remaining issue is **spec/implementation mismatch**:

- **`memory_read_index(all_chats: true)`** is ignored by the tool handler, despite the spec requiring cross-chat topic discovery. The current test suite enforces the mismatch. This must be resolved by either implementing `all_chats` or updating the spec (and then aligning tests).

Secondary findings are mostly **spec wording/format alignment** (return shape “id” vs `topicId`, snapshot `general` rendering rules). Finally, **Phase 8 housekeeping** remains unfinished, so archival is blocked until those tasks are completed.