### Missing Artifacts
None. All expected artifacts (proposal.md, design.md, specs/, tasks.md) were present in `specs/changes/subagent-runtime/`.

### Review Mode
Implementation Review — compliance phase only. 46 of 50 tasks are checked (phases 1-9 complete; phase 10 validation/archive tasks remain open).

---

### Phase 2: Compliance Findings

#### CRITICAL

**C1: Goblin-spawned subagents do not propagate status updates to Telegram**
- **Severity:** CRITICAL
- **Description:** The spec requires subagent activity to appear in goblin’s status line via `onStatusUpdate` callbacks. `AgentRunner.init()` registers `spawn_subagent` without passing an `onStatusUpdate` callback (`src/agent/mod.ts:150-156`). When goblin spawns a subagent, `instance.onStatusUpdate` is therefore `undefined`, so all subagent events (`agent_start`, `tool_execution_start/end`) are silently dropped instead of being prefixed and forwarded to the active `MessageBuffer`. Nested subagents receive the callback via `toolFactory`, but the root spawner (goblin) does not, breaking the design’s callback-propagation chain.
- **Location:** `src/agent/mod.ts:150-156`
- **Recommendation:** Pass a delegating callback when creating the root `spawn_subagent` tool, e.g. `(msg) => this.callbacks?.onStatusUpdate(msg)`, or re-create the tool each turn so it closes over the active `MessageBuffer`.

#### WARNING

**W1: Generic subagent skill inheritance relies on pi defaults instead of explicit path**
- **Severity:** WARNING
- **Description:** The spec and design both require generic subagents to inherit parent skills from `~/goblin/skills/`. The implementation leaves `resourceLoader` unset for generic subagents (`src/subagents/mod.ts:246-248`), relying on pi’s default discovery with `cwd = workdirPath`. This does not explicitly point to `~/goblin/skills/`, creating a gap between the requirement and the code.
- **Location:** `src/subagents/mod.ts:246-248`
- **Recommendation:** Explicitly configure a `DefaultResourceLoader` for generic subagents with `additionalSkillPaths` pointing to `~/goblin/skills/`, mirroring the named-agent isolation pattern.

**W2: Spec/implementation mismatch on `customTools` for subagents**
- **Severity:** WARNING
- **Description:** The spec’s “No beta tools for subagents” requirement states that `customTools` passed to pi SHALL be empty. The implementation passes `spawn_subagent` via `toolFactory` to enable recursive spawning, as required by phase-8 tasks. The spec and code are in direct conflict.
- **Location:** `specs/changes/subagent-runtime/specs/subagents/spec.md` (Requirement: No beta tools for subagents) vs `src/subagents/mod.ts:260-263`
- **Recommendation:** Update the spec to allow the `spawn_subagent` custom tool (since it is α, not β), or rephrase the requirement to prohibit Telegram-native (β) tools only.

**W3: Cancel races with session creation**
- **Severity:** WARNING
- **Description:** `spawn()` adds the instance to `activeSubagents` before `runAgent()` creates the `AgentSession`. If `cancel()` is called in that window, `instance.session` is `null`, so `abort()` is skipped and `runAgent()` continues, eventually calling `sendUserMessage()` and starting a turn that should have been cancelled.
- **Location:** `src/subagents/mod.ts:179-180` (spawn) and `src/subagents/mod.ts:437-450` (cancel)
- **Recommendation:** After creating the session in `runAgent()`, check if `instance.status === 'cancelled'` and abort immediately before calling `sendUserMessage()`.

**W4: Cancel can overwrite terminal statuses**
- **Severity:** WARNING
- **Description:** `cancel()` does not guard against invoking it on an already-terminal subagent (`completed` or `error`). It will overwrite `meta.json` with `status: 'cancelled'` and a new `completedAt` timestamp.
- **Location:** `src/subagents/mod.ts:437`
- **Recommendation:** Add an early guard: if `instance.status` is not `'running'`, throw or no-op.

#### SUGGESTION

**S1: `revive()` should accept an `onStatusUpdate` callback**
- **Severity:** SUGGESTION
- **Description:** `revive()` hard-codes `onStatusUpdate: undefined` when reconstructing the `SubagentInstance`. This means revived subagents cannot stream status back to the caller, breaking the design’s callback-propagation path for revival flows.
- **Location:** `src/subagents/mod.ts:388-396`
- **Recommendation:** Add an optional `onStatusUpdate` parameter to `revive()` and pass it through to the reconstructed instance, consistent with `spawn()`.

**S2: `list()` is process-scoped and ignores persisted subagents on disk**
- **Severity:** SUGGESTION
- **Description:** `list()` only returns entries from the in-memory `activeSubagents` Map. After a process restart, persisted subagents on disk are invisible until explicitly revived.
- **Location:** `src/subagents/mod.ts:414-423`
- **Recommendation:** Either scan the generic and named-agent instance directories on startup to populate `activeSubagents`, or document that `list()` returns only the current process’s active instances.

**S3: Unused `idle` status in `SubagentStatus`**
- **Severity:** SUGGESTION
- **Description:** The `SubagentStatus` type includes `'idle'`, but no code path ever assigns it. The spec’s `list()` scenario expects statuses `running`, `completed`, or `cancelled`; the implementation also uses `error`.
- **Location:** `src/subagents/types.ts:5`
- **Recommendation:** Remove `'idle'` from `SubagentStatus` and update the spec to include `'error'` as a valid terminal state.

---

### Cross-Change Consistency
N/A — `.litespec.yaml` does not declare any `dependsOn`.

### Scorecard

| Dimension              | Pass | Fail | Not Evaluated |
|------------------------|------|------|---------------|
| Interaction Correctness| 0    | 1    | 0             |
| Test Adequacy          | 1    | 0    | 0             |
| Completeness           | 0    | 1    | 0             |
| Correctness            | 0    | 1    | 0             |
| Coherence              | 0    | 1    | 0             |
