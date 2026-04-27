### Review Mode
Implementation Review — 46 of 50 tasks checked (phases 1-9 complete, phase 10 pending).

---

### Phase 1: Adversarial Findings

#### Adversarial Scenarios Enumerated

1. **S1: Depth cap enforcement** — Spawning at or beyond the depth boundary.
2. **S2: Cancel before session initialization** — Calling `cancel()` immediately after `spawn()` returns but before `runAgent()` has finished creating the `AgentSession`.
3. **S3: Revive while already active** — Calling `revive()` on a subagent that is still running in-memory from a prior `spawn()`.
4. **S4: Cancel a terminal subagent** — Calling `cancel()` on a subagent that has already completed or errored.
5. **S5: Failure during session creation** — `createAgentSession`, `resolveModel`, or `DefaultResourceLoader.reload()` throwing before the first turn starts.
6. **S6: Missing status callback wiring for goblin** — The root agent's `spawn_subagent` tool is created without an `onStatusUpdate` callback, so subagent activity never reaches Telegram.
7. **S7: I/O failure during lifecycle meta write** — A disk-full or permission error inside `writeMetaAtomic` while handling `agent_end` or `agent_error`.
8. **S8: Parent abort does not cascade** — `AgentRunner.abort()` kills the parent session but leaves any child subagents running.
9. **S9: Unbounded `activeSubagents` map** — Terminal instances are never removed from the in-memory map.
10. **S10: Stale meta fields across revival** — `errorMessage` and `completedAt` from a previous lifecycle persist into a revived run.
11. **S11: Generic subagent skill path reliance on pi defaults** — Generic subagents rely on pi's default resource loader from `workdir/` instead of explicitly wiring `~/goblin/skills/`.
12. **S12: Cross-session subagent access** — A single shared `SubagentRunner` lets any session `cancel` or `revive` another session's subagent.

---

#### CRITICAL

**S2: Cancel-before-init race leaves zombie subagents**
`cancel()` skips `session.abort()` when `instance.session === null` (`mod.ts:526`) and immediately writes `status: "cancelled"` to `meta.json`. However, `runAgent()` does not check `instance.status` before proceeding; it continues to call `createAgentSession()` and `session.sendUserMessage()`. When the subagent eventually completes, `markCompleted()` overwrites the cancelled state. The cancellation is silently undone and the subagent runs to completion.
- **Location**: `src/subagents/mod.ts:520-534` (cancel), `src/subagents/mod.ts:198` (spawn kicks off runAgent), `src/subagents/mod.ts:245-296` (runAgent ignores in-memory status).
- **Recommendation**: Gate `runAgent()` on `instance.status !== "cancelled"` before sending the initial prompt, or make `cancel()` set an atomic "cancelling" flag that `runAgent()` observes after acquiring the session.

**S3: Revive overwrites active in-memory instance without cleanup**
`revive()` inserts a new `SubagentInstance` into `activeSubagents` without checking whether the ID already exists (`mod.ts:478`). If the subagent is still running from a previous `spawn()`, the old instance is evicted from the map but its underlying `AgentSession` and event subscription remain alive. Two sessions may then write to the same `session.jsonl` file.
- **Location**: `src/subagents/mod.ts:427-478`.
- **Recommendation**: Reject revival if `this.activeSubagents.has(id)` and the existing instance's status is `"running"`.

**S5: Errors before the first turn leave meta.json stuck in `"running"`**
`runAgent()` only catches errors around `session.sendUserMessage()` (`mod.ts:293-296`). If `resolveModel()`, `createAgentSession()`, or `resourceLoader.reload()` throws earlier in the function, `runAgent()` rejects without calling `markErrored()`. The outer `.then()` in `spawn()` rejects `handle.result`, but `meta.json` retains `status: "running"` forever.
- **Location**: `src/subagents/mod.ts:245-296`.
- **Recommendation**: Wrap the entire body of `runAgent()` in a try/catch that calls `markErrored()` for any startup failure.

**S6: Root agent's `spawn_subagent` tool omits `onStatusUpdate`**
The spec requires *"Subagent activity SHALL be reported to goblin via `onStatusUpdate` callbacks"*. `AgentRunner.init()` registers the tool as `createSpawnSubagentTool(this.subagentRunner, 0, this.sessionId)` with no callback (`src/agent/mod.ts:114`). Because the tool passes `onStatusUpdate: undefined` to `runner.spawn()`, the subagent's `agent_start` and `tool_execution_*` events are dropped on the floor; they never reach the `MessageBuffer` or Telegram status line.
- **Location**: `src/agent/mod.ts:112-115`.
- **Recommendation**: Pass a callback that delegates to the current turn's `onStatusUpdate`, e.g. `createSpawnSubagentTool(..., (msg) => this.callbacks?.onStatusUpdate(msg))`.

**S7: Meta write failure hangs the result promise forever**
If `writeMetaAtomic()` throws (e.g., disk full), the exception propagates out of `handleEvent()` and is caught by the `session.subscribe()` try/catch (`mod.ts:268-286`). The error is logged, but neither `resolved_text()` nor `rejected_err()` is invoked. The `completion` promise returned by `runAgent()` remains pending, which means `spawn()`'s `handle.result` also hangs indefinitely. The parent agent's tool call is blocked forever.
- **Location**: `src/subagents/mod.ts:267-288`, `src/subagents/mod.ts:647-651`.
- **Recommendation**: In the subscribe callback's catch block, explicitly call `rejected_err(err)` to tear down the promise chain so the failure is observable.

---

#### WARNING

**S4: Cancel does not guard against terminal states**
`cancel()` does not inspect `instance.status`. If invoked on a completed or errored subagent, it calls `session.abort()` (if the session reference is still present) and overwrites `meta.json` with `status: "cancelled"`, destroying the terminal audit trail.
- **Location**: `src/subagents/mod.ts:520-534`.
- **Recommendation**: Return early (or throw) if `instance.status` is already `"completed"`, `"error"`, or `"cancelled"`.

**S9: `activeSubagents` map is a monotone accumulator**
Completed, errored, and cancelled instances are never removed from `activeSubagents`. Over a long-running process this leaks memory and makes `list()` increasingly noisy.
- **Location**: `src/subagents/mod.ts:184`, `src/subagents/mod.ts:478`.
- **Recommendation**: Evict terminal instances from the map after a bounded retention period, or provide an explicit `prune`/`dispose` path.

**S10: Stale fields survive revival**
`persistMeta()` merges patches without clearing stale keys. A subagent that previously errored will retain `errorMessage` in `meta.json` even after a successful revival and completion. Likewise, `completedAt` from a prior run lingers until the next terminal event.
- **Location**: `src/subagents/mod.ts:380-395`.
- **Recommendation**: Explicitly delete `errorMessage` when transitioning to `completed`, and delete `completedAt` when transitioning to `running` on revive.

**S11: Generic subagent skill inheritance is implicit and unverified**
The spec states generic subagents *"SHALL discover skills from the parent's `~/goblin/skills/` directory"*. The implementation leaves `resourceLoader` undefined for generic spawns (`mod.ts:257-260`) and relies on pi's default discovery from `cwd = ~/goblin/workdir`. There is no evidence that pi's default loader reaches `~/goblin/skills/` from that cwd.
- **Location**: `src/subagents/mod.ts:257-260`.
- **Recommendation**: Explicitly construct a `DefaultResourceLoader` for generic subagents with `additionalSkillPaths: [join(cfg.goblinHome, "skills")]`.

**S12: No session ownership on shared runner**
`SubagentRunner` is instantiated once in `bot.ts` and shared across all Telegram sessions. Any session that knows (or guesses) a subagent ID can `cancel()` or `revive()` it. While UUIDs provide unpredictability, the architecture lacks an ownership boundary.
- **Location**: `src/bot.ts:29`, `src/subagents/mod.ts:520`.
- **Recommendation**: Scope `activeSubagents` by spawner session, or record `spawnedBy` and validate it on mutate operations.

---

#### SUGGESTION

**S8: Cascade cancel is deferred to v1.1**
Per the proposal, *"Cascade cancel (killing subagents when parent cancels) — v1.1"* is explicitly out of scope. This is noted here for backlog tracking only; no action required for this change.
- **Backlog**: Ensure the v1.1 backlog entry references the `SubagentRunner` → `AgentRunner` lifecycle hook needed to propagate `abort()`.

---

#### Test Adequacy

| Scenario | Verdict |
|----------|---------|
| **S1** | **Covered** — boundary and overflow tests exist (`mod.test.ts`). |
| **S2** | **Missing** — tests always `await flush()` before cancel, masking the init race. No negative test for cancel-before-session. |
| **S3** | **Missing** — revival tests only operate on completed subagents. No test attempts revival while the subagent is still `running`. |
| **S4** | **Missing** — no test exercises `cancel()` on a completed or errored instance. |
| **S5** | **Missing** — the module mock for `createAgentSession` never throws; there is no failure-injection test for startup errors. |
| **S6** | **Missing** — `agent/mod.test.ts` verifies tool registration but does not assert that status events propagate to the parent callback. No integration test for goblin → subagent → status line. |
| **S7** | **Missing** — no test forces `writeMetaAtomic` or `markCompleted` to throw. |
| **S8** | **N/A (deferred)** — no tests expected in this scope. |
| **S9** | **Missing** — no test asserts map size or eviction after terminal transitions. |
| **S10** | **Missing** — revival tests do not inspect `meta.json` for stale `errorMessage` or `completedAt`. |
| **S11** | **Missing** — tests verify `resourceLoader` is undefined for generic spawns, but do not verify that skills are actually discoverable. |
| **S12** | **Missing** — no multi-session runner tests exist. |
