# Review Report: scoped-memory

## Missing Artifacts

All required artifacts are present: `proposal.md`, `design.md`, `tasks.md`, and `specs/` (including `specs/memory/spec.md`, `specs/agent/spec.md`, `specs/subagents/spec.md`).

## Review Mode

**Implementation Review** (adversarial → compliance → scorecard).

- **Phases 1–5:** fully checked.
- **Phase 6:** `bun run typecheck + bun test` is not checked in the snapshot, but results are reported as passing (`tsc --noEmit` clean; **432 tests pass**).
- **Phase 7:** manual smoke test (topic delete → archive) unchecked.
- **Phase 8:** litespec validation/preview + housekeeping (glossary/backlog/decision verification + user `litespec archive`) entirely unchecked.

No `dependsOn` declared.

---

## Phase 1: Adversarial Findings

### Adversarial Scenarios Enumerated

**S1: `archiveOrphan` races `mutate()` on the same scope (residual TOCTOU)**
- **Why it’s adversarial:** `archiveOrphan` uses synchronous `renameSync` without taking the same scope lock as `mutate()`; if it runs between `mutate`’s “read” and “write” steps, `write` may recreate the directory, yielding a fresh scope alongside the archived one.
- **Mitigation observed:** an existing tmp-file guard in `archiveOrphan` scans for `.tmp` files and blocks archival during typical in-flight writes.
- **Residual risk:** the guard may still not cover all ordering windows (e.g., if `.tmp` hasn’t appeared yet when the guard runs).
- **Locations:**  
  - `src/memory/store.ts:286-317` (`archiveOrphan`)  
  - `src/memory/store.ts:228-242` (`mutate`)  
- **Assessment:** **WARNING** (very low likelihood; data separation rather than loss, but behavior can surprise).
- **Recommendation:** either make `archiveOrphan` acquire the scope lock before moving, or explicitly document this as a v1-known edge.

**S2: TOCTOU in subagent `revive` topic-scope existence check**
- **Why it’s adversarial:** `revive` checks with `existsSync` at revive time, but the first memory write happens later in async execution; the topic could be archived in the gap, and the subsequent write would recreate the topic directory while old content remains under `archive/`.
- **Location:** `src/subagents/runner.ts:220-229`
- **Assessment:** **WARNING**
- **Recommendation:** if it matters, re-validate inside `mutate()` after acquiring the lock (e.g., check `existsSync(sourceDir)` after lock).

**S3: `memory_read_index` `all_chats:true` leaks unreadable topology**
- **Why it’s adversarial:** `memory_read_index` can reveal `(chatId, topicId)` pairs across chats, while `memory_read` enforces a cross-chat guard that rejects reads for other chats—so callers may “see” scopes they cannot read.
- **Locations:**  
  - `src/memory/tool.ts:130-136` (resolver/index)  
  - `src/memory/tool.ts:153` (cross-chat guard: `scope.topic.chatId !== activeScope.chatId`)
- **Assessment:** **WARNING** (leaky abstraction; not necessarily loss, but surprising)
- **Recommendation:** document as a known limitation, or filter `all_chats` results to the active chat until cross-chat read gating is lifted.

**S4: `ScopeLock.acquire` retry loop lacks backoff under worker-thread concurrency**
- **Why it’s adversarial:** no backoff for spurious contention; fine under today’s single-threaded Node assumptions, but could starve under worker-thread concurrency if the lock is shared imperfectly across workers.
- **Assessment:** **SUGGESTION**
- **Recommendation:** consider backoff / stronger cross-worker guarantees if concurrency model changes.

**S5: `memory_read` with `target:"agent"` ignores the `scope` discriminator**
- **Why it’s adversarial:** if a subagent requests a different agent persona via `scope`, the implementation may still return `activeScope`’s persona because the `target=agent` branch ignores `input.scope`.
- **Location:** `src/memory/tool.ts:186-195` (`resolveReadScope`)
- **Assessment:** **WARNING** (behavioral ambiguity vs spec intent)
- **Recommendation:** either (a) honor `scope` for `target:"agent"` reads, or (b) explicitly document that `target:"agent"` is always “self persona” and the persona selection only works via the other `target`+`scope` combinations.

**S6: Concurrent `memory_write` calls to the same scope losing entries**
- **Assessment:** **HANDLED** — expected races are mitigated by `ScopeLock` serialization for `mutate()` (and concurrent-safety tests are reported as passing).

**S7: `listIndex` (`readdirSync`) vs `archiveOrphan` (`renameSync`) interleaving**
- **Assessment:** **WARNING / NOTE** — because both operations are synchronous, mid-call interleaving can’t happen in a single JS thread; however, the safety relies on staying with sync filesystem operations (and scan→later-act windows still matter elsewhere).
- **Location:** relates to `listIndex` and `archiveOrphan` usage in `src/memory/store.ts` / `src/memory/tool.ts`.

**S8: Snapshot formatter scan→name lookup window (`listIndex` then async `getTopicName`)**
- **Assessment:** **SUGGESTION** — archival between index scan and name lookup could yield a snapshot that references a topic that has just been archived; next turn should reflect corrected state.
- **Recommendation:** accept for v1, or tighten ordering if snapshot correctness becomes critical.

**S9: `resolveActiveScope` handling of empty-string `namedAgent`**
- **Assessment:** **HANDLED** — falsy handling plus explicit test coverage for empty string.

**S10: Concurrent writes to different scopes + single git repo**
- **Assessment:** **HANDLED** — distinct scope keys avoid blocking; git operations serialize at the process level via `spawnSync` (no data loss reported).

#### CRITICAL
None.

#### WARNING (consolidated)
- **S1:** residual `archiveOrphan` ↔ `mutate()` TOCTOU despite tmp-file guard  
- **S2:** revive-time `existsSync` TOCTOU  
- **S3:** `all_chats:true` leaks topology for unreadable scopes  
- **S5:** `target:"agent"` ignores requested `scope` discriminator  
- **S7:** scan/index safety relies on sync FS (note-worthy if refactors introduce async)

#### SUGGESTION (consolidated)
- **S4:** add backoff / harden for worker-thread concurrency assumptions  
- **S8:** consider ordering if snapshot correctness needs stronger guarantees  
- (and the “HANDLED” items above are not actionable unless future refactors change the model)

### Pattern Annotations

Across both drafts, the common theme is **scan→later-act windows** around scope/tagging and **lock-free archival** that relies on **tmp-file guards + synchronous filesystem behavior**. Residual edge cases remain where guards don’t fully cover ordering between async boundaries and subsequent sync steps.

---

## Phase 2: Compliance Findings

### CRITICAL
None.

### WARNING

**W1: `memory_read_index` missing best-effort Telegram topic names (spec gap)**
- **Spec requirement (scenario):** response SHALL include topic id, best-effort name, and description (or null).
- **Observed behavior:** `listIndex` returns `{chatId, topicId, description}`; topic names require a Telegram API call (but tool factory has no `getTopicName` callback).
- **Locations:**  
  - `src/memory/tool.ts:119-131` (index tool calls `store.listIndex()`)  
  - `src/memory/store.ts:158-178` (`listIndex`)
- **Assessment:** **WARNING** (spec→code compliance gap)
- **Recommendation:** add optional `getTopicName` wiring to `createMemoryReadIndexTool` args, or defer as a follow-up.

**W2: `FormatSnapshotArgs` signature drift from `design.md`**
- **Description:** design: `formatSnapshot({store, activeScope, includePersona?, getTopicName?})`; implementation adds required `includeAgents: boolean`.
- **Location:** `src/memory/snapshot.ts:24`
- **Recommendation:** document the decision in the design/decision log.

**W3: `memory_read_index` includes `general` field not mentioned in the spec scenario**
- **Description:** `listIndex` returns `{general: {description?}, topics: [...], agents: [...]}`; spec scenario omits `general`.
- **Locations:**  
  - `src/memory/store.ts:46-50` (`MemoryIndex` type)  
  - `src/memory/store.ts:130-131` (`listIndex` return)
- **Recommendation:** update the spec scenario to include `general` (or clarify it’s always included).

**W4: `resolveActiveScope` doc/design shape mismatch for topic scopes**
- **Description:** design says topic scopes include `{chatId, topicId}`; implementation uses `{topicId}` and keeps `chatId` as sibling field on `ActiveScope`.
- **Location:** `src/memory/scope.ts:8-12` vs `design.md`
- **Recommendation:** update `design.md` to match the implemented shape.

**W5: `normalizeScope("memory")` maps to `"general"`**
- **Description:** store-level `"memory"` alias normalizes to `"general"`. This may be semantically confusing vs “active scope,” but is apparently internal and resolved by the tool layer into concrete `MemoryScope` before reaching the store.
- **Location:** `src/memory/store.ts:37-38`
- **Recommendation:** document/rename the alias for clarity (or tighten the conceptual mapping).

**W6: `createMemoryReadIndexTool` takes `activeChatId: number` instead of deriving from `ActiveScope`**
- **Description:** minor pattern/design drift; works but bypasses a single “scope resolution” pathway.
- **Locations:**  
  - `src/memory/tool.ts:96-100`  
  - `src/agent/mod.ts:120-124`
- **Recommendation:** accept `activeScope` instead (optional; no functional issue implied).

### SUGGESTIONS

**S1: No test for `getTopicName` cache hit behavior in `AgentRunner`**
- **Location:** `src/agent/mod.ts:120-127` (`cachedTopicName`)

**S2: `_baseSystemPrompt` invariance between turns not asserted directly**
- **Description:** spec requires `agent.state.systemPrompt` to remain equal to `_baseSystemPrompt` from session creation; current tests apparently don’t assert it.
- **Location:** `specs/changes/scoped-memory/specs/agent/spec.md` (Scenario: System prompt unchanged across turns)

**S3: `scopeTag` test covers valid inputs only**
- **Description:** malformed discriminants would fall through to `undefined`, but types prevent reaching it.
- **Location:** `src/memory/scope.ts:26-32`

**S4: Snapshot “General (DM/supergroup-no-topic)” label length**
- **Location:** `src/memory/snapshot.ts:68`
- **Recommendation:** optional aesthetic tweak.

**S5: `includeAgents:false` for subagents may surprise named subagents**
- **Description:** named subagents may not discover peer persona scopes via index when they’re not the main goblin agent.
- **Location:** `src/subagents/execution.ts:99`

**S6: Tests use `store.read("memory")` alias instead of `"general"`**
- **Location:** `src/memory/store.test.ts`
- **Recommendation:** use `"general"` for clarity; keep alias limited to tool-layer input.

**S7: Optional hardening: treat `namedAgent` falsy values explicitly**
- **Location:** `src/memory/scope.ts:20`
- **Recommendation:** `namedAgent !== undefined && namedAgent.length > 0` style check (optional; current typing excludes most invalid values, but not all falsy cases).

---

## Cross-Change Consistency

No `dependsOn`.

---

## Unchecked Tasks Summary

| Phase | Task | Status |
|------|------|--------|
| 6 | Verify `bun run typecheck` + `bun test` pass | `- [ ]` (reported as passing: `tsc --noEmit` clean; 432 tests pass) |
| 7 | Manual smoke test (topic delete → archive) | `- [ ]` |
| 8 | `litespec validate scoped-memory --strict` | `- [ ]` |
| 8 | `litespec preview scoped-memory` | `- [ ]` |
| 8 | Verify decision 0002 referenced by design | `- [ ]` |
| 8 | Update glossary entries | `- [ ]` |
| 8 | Update backlog (strike old, add PII redaction) | `- [ ]` |
| 8 | User runs `litespec archive` | `- [ ]` |

---

## Summary (folded)

- **No CRITICAL issues** reported.
- **One confirmed spec→code gap:** `memory_read_index` does not currently include best-effort **topic names** in its response (`W1`).
- **Key adversarial edge cases to consider documenting or hardening:**
  - residual `archiveOrphan` ↔ `mutate()` TOCTOU despite tmp-file guard (`S1`)
  - `revive` existence-check TOCTOU (`S2`)
  - `all_chats:true` topology leak for unreadable scopes (`S3`)
  - behavioral ambiguity around `memory_read({target:"agent", scope: ...})` (`S5`)
- **Overall test health:** 432 tests reported passing; remaining gaps are mostly around missing-topic-names wiring and a few behavioral invariants/caching assertions (`S1`, `S2`).

If you want, I can also produce a shorter “TL;DR” version of this merged report for dropping into a PR review.


































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