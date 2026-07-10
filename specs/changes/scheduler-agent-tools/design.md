# Design: scheduler-agent-tools

## Architecture

This change extends the shipped `scheduled-turns` substrate rather than introducing a parallel mechanism. The agent-originated path reuses every existing safety property — atomic store writes, claim-before-dispatch, per-session turn serialization, stale-runner guard — so an agent-created schedule dispatches identically to a user-created one. The only new runtime paths are:

1. A tool factory that adapts the existing `ScheduleStore` API into a pi `ToolDefinition`.
2. Three-hop wiring to thread `scheduleStore` from intake → dispatcher → runner → tool registry.
3. A two-tier file lookup in `resolveHeartbeatPrompt`.

```
AgentRunner.init()  ──►  schedule_turn tool  ──►  ScheduleStore (existing)
         ▲                                              │
         │ scheduleStore?                               │ listDue / claimDue (unchanged)
TurnDispatcher.createRunner                            ▼
         ▲                                        SchedulerLoop.tick()
         │ scheduleStore?                                │
createTelegramIntake                                    ▼
         ▲                                        TurnDispatcher.enqueueScheduledTurn()
         │                                        (same per-session queue as Telegram)
buildBot() constructs ONE ScheduleStore ───────────────┘
```

The cap and provenance live in `ScheduleStore`, not the tool, so the invariants hold regardless of caller (the `/schedule` path is exempt from the cap, but provenance is stamped by both paths through the same `create()` call).

### Data model change

`ScheduledTurn` gains one optional field:

```ts
source?: "user" | "agent";   // absent/old records read as "user"
```

Optional → backward compatible with `state/schedules.json` files written before this change. The cap counter treats absent as `"user"`, so pre-existing schedules never count toward the agent budget.

### State management

No new persistent state files. All schedule records continue to live in `$GOBLIN_HOME/state/schedules.json`. The per-session `HEARTBEAT.md` is a user-authored file read at dispatch time (like the global one); it is never written by the system.

## Decisions

### Decision: Provenance + per-session cap, not a global cap and not cap-free

**Chosen.** A `source` field plus a per-session cap of **8** counting enabled agent-source schedules.

**Why over alternatives.**
- *No cap (trust the goblin):* a single misbehaving turn — e.g. one that creates a recurring schedule every time it runs, or a tool-loop bug — can spawn unbounded self-sustaining work with no off-switch. On a single-user homelab this is low-probability but high-cost (the loop runs forever, accumulating turns). The cap is cheap insurance.
- *Global cap across all sessions:* would pit the user's `/schedule every …` usage against the agent's. The user's own schedules should never be blocked by goblin's self-scheduling.
- *Per-session cap on all sources:* same problem — the user is capped by goblin's behavior.

Provenance lets us cap *only* agent-source work, leaving the user path unrestricted. The per-session scope matches the ownership model the store already enforces (every mutation is session-scoped).

**Why 8.** Enough headroom for a handful of active reminders + one or two recurring checks + a heartbeat per topic. Small enough that a runaway loop is bounded. Configurable via a named constant (`MAX_AGENT_SCHEDULES`) so it can be tuned without touching logic.

**Constraints introduced.** `create()` must know its caller's provenance; the cap check must run before any write.

### Decision: Main-agent only — no subagent scheduling

**Chosen.** `schedule_turn` is registered in `AgentRunner.init()` and is absent from the subagent toolset (`src/subagents/execution.ts` builds its own tools and never receives a `scheduleStore`).

**Why.** Subagents already have a depth cap (`MAX_SUBAGENT_DEPTH = 3`). Letting a subagent schedule work that fires into a chat as a fresh main-agent turn would punch through that boundary asynchronously — a subagent could, in effect, continue acting after its own turn ended, by scheduling a future turn. Keeping scheduling main-agent-only preserves the depth-cap invariant: only the root agent initiates scheduled work.

**Implementation.** The tool's registration is gated on `this.scheduleStore` being present in `AgentRunnerOptions`. Subagent runners are never constructed with a `scheduleStore` (their construction in `src/subagents/execution.ts` does not thread one), so the gate is structural, not a runtime flag to forget.

### Decision: Per-session HEARTBEAT.md is session state, accessed via `src/sessions/paths.ts`

**Chosen.** The new helper `heartbeatMdPathForSession(home, sessionId)` lives in `src/sessions/paths.ts` and resolves to `state/sessions/<sessionId>/HEARTBEAT.md`.

**Why.** The file is session data — it lives under `state/sessions/<id>/` alongside `state.json` and `transcript.jsonl`. AGENTS.md's filesystem rule permits code-tree access to `$GOBLIN_HOME` state only through sanctioned path modules (`src/sessions/paths.ts` for session state). This is explicitly *not* a `workspace/` prompt file, so decision `0009-workspace-prompt-file-reads` (which governs read-only access to `workspace/` prompt files like `SOUL.md`, `AGENTS.md`, the global `HEARTBEAT.md`) does not apply. Putting the helper in `src/sessions/paths.ts` keeps it next to `statePath` and `transcriptPath`, which already read from the same directory.

**Why first-non-empty-wins, not merge.** A user who writes a per-session file almost certainly wants it to *replace* the global behavior for that session, not concatenate with it. Merge would produce confusing double-content. First-non-empty is also what the global→constant fallback already does, so it's a consistent extension.

### Decision: Provenance is an authority boundary, not just a label

**Chosen.** The agent tool's mutating actions (`remove`, `pause`, `resume`) and heartbeat mutation operate **only** on schedules whose `source` is `"agent"`. The agent cannot remove, pause, resume, disable, or overwrite a user-owned schedule, and cannot turn off or overwrite a user-owned heartbeat. The tool's `list` action redacts user-owned prompt bodies out of model context. The `/schedule` human command retains authority over all sources.

**Why.** Without this, an autonomous/scheduled agent turn could pause or delete the user's own reminders, or an agent turn's `list` could leak the prompt text of user-authored schedules (which may contain private content) into model context. "Full parity" then means *action names*, not *authority scope* — the agent gets the same verbs but over a scoped object set. This is the single most important property for autonomous turns, which is why authority gets its own requirement and is enforced by `source`, independent of the session-ownership check `ScheduleStore` already does.

**How enforced.** Authority is checked at the store mutation boundary alongside session ownership, so the two checks cannot drift apart. A schedule's effective source is `"user"` when absent (legacy records), so pre-existing schedules are protected from the start.

### Decision: Cap enforced at the store mutation boundary, covering all enable-paths

**Chosen.** The invariant — *"a session may not have more than `MAX_AGENT_SCHEDULES` enabled `source:"agent"` schedules after any store mutation"* — is enforced inside the store mutation path for every transition into `enabled`: `create_once`, `create_recurring`, `resume` (disabled→enabled), and `heartbeat on`. The `/schedule` command path is exempt.

**Why over tool-level count→create.** My original plan had the tool count, then call `create`. Reviewer flagged the TOCTOU gap: between count and create the record list could change. In this codebase the store mutations are synchronous fs read-modify-writes (no `await` between count and create within a single tool call), so a count→create race within one turn is unlikely — but the reviewer's instinct is still correct: the invariant belongs where the authoritative record list is already in hand (inside `create`/`resume`/`setHeartbeat`), not split across a caller. It also means the invariant cannot be bypassed by a future caller that forgets to count. The cost is a cap-aware parameter on the store mutation methods (e.g. an `enforceAgentCap` flag, or a dedicated `createAsAgent` path), distinguishing the cap-exempt `/schedule` caller from the capped agent caller.

**Reverses my earlier draft** which placed enforcement in the tool layer. Reviewer was right; I checked the store mutation flow (`store.ts` read-modify-write per call) and the invariant is cleanest co-located with the mutation.

### Decision: Provenance is retained even if the cap is dropped

**Chosen.** `source` is structural and stays regardless of cap policy. It drives authority (above), list redaction, `/schedule list` `[agent]` annotation, and audit/debugging.

**Why.** The cap is optional policy that could be relaxed later; provenance is not optional because authority and prompt-leak prevention depend on it. Decoupling the two means "no cap" remains a safe future option without reopening the authority question.

### Decision: Tool mirrors `/schedule` grammar exactly — no new time forms, no invented cap

**Chosen.** The tool uses the existing `parseDuration` / `parseAt` / `parseIn`. No cron, no natural-language dates. The prompt is validated non-empty, matching `/schedule`'s only check (`src/commands/schedule.ts` rejects empty prompts). No character-length cap is added — verified the command path enforces none, so there is nothing to mirror.

**Why.** Reversing the deliberate "bounded grammar" decision of `scheduled-turns` is a separate concern and a much larger change (cron parser + next-fire computation + `claimDue` changes). Keeping this change grammar-neutral means the tool's only job is *access surface* — letting the agent reach the same store the command reaches. Inventing a prompt-length cap the command doesn't have would introduce an undocumented divergence.

### Decision: Clock injection for deterministic tests

**Chosen.** `createScheduleTurnTool({ store, sessionId, locator, now })` takes a `now: () => number` provider instead of calling `Date.now()` directly.

**Why.** The `/schedule` command path already does this (`deps.now`, `src/commands/schedule.ts:313`) specifically for deterministic tests. The agent tool should follow the same idiom rather than hardcode the clock, so cap/nextRunAt tests can be exact.

## File Changes

### Created

- **`src/scheduler/tool.ts`** — the `schedule_turn` tool factory `createScheduleTurnTool({ store, sessionId, locator, now })`, built with `defineTool` + typebox (mirrors `src/memory/tool.ts` structure). Implements all six actions by delegating to `ScheduleStore` methods. Stamps `source: "agent"` on creates. Enforces **agent authority** on `remove`/`pause`/`resume`/`heartbeat` (rejects if target `source !== "agent"`). Redacts user-owned prompt bodies in `list`. Uses the injected `now` provider for deterministic tests. Satisfies: *Agent self-scheduling tool has parity with /schedule*, *Agent tool authority is scoped to agent-owned schedules*, *Agent tool list redacts user-owned prompts*. (Cap enforcement lives in the store, not here — see below.)
- **`src/scheduler/tool.test.ts`** — colocated tests for every action; authority rejections (remove/pause/resume/heartbeat-off on user-owned); list redaction; provenance stamping; the cross-session ownership guard; deterministic-clock assertions. Satisfies the scenarios under those requirements.

### Modified

- **`src/scheduler/types.ts`** — add `source?: "user" | "agent"` to `ScheduledTurn`. Add `MAX_AGENT_SCHEDULES` constant (default **8**). Satisfies: *Schedule records carry provenance*.
- **`src/scheduler/store.ts`** — the core change. (a) `create()` accepts optional `source`; stamp it on the record. (b) The `source` field defaults to `"user"` when absent in loaded records (at read time, so legacy files are cap-safe and authority-protected). (c) **Cap enforced at the mutation boundary**: `create`, `resume`, and `setHeartbeat(enabled:true)` SHALL refuse when the result would exceed `MAX_AGENT_SCHEDULES` enabled agent-source schedules for the session — implemented by a cap-aware code path distinct from the cap-exempt `/schedule` caller (e.g. an `enforceAgentCap` parameter or a dedicated agent-facing mutation method). (d) **Authority checks** on `remove`/`pause`/`resume`/`setHeartbeat` reject when the target record's effective `source` is `"user"` and the caller is the agent path. Satisfies: *Schedule records carry provenance*, *Agent-originated schedules are bounded by a per-session cap*, *Agent tool authority is scoped to agent-owned schedules*.
- **`src/scheduler/loop.ts`** — `resolveHeartbeatPrompt(home, sessionId)` signature; two-tier lookup (session-scoped → global → constant) calling `heartbeatMdPathForSession` then `heartbeatMdPath`. `processOne` passes `schedule.sessionId`. Satisfies the MODIFIED sessions requirement *Heartbeat schedule is explicit and session-scoped*.
- **`src/sessions/paths.ts`** — add `heartbeatMdPathForSession(home, sessionId)` defined in terms of `sessionDir`. SHALL validate `sessionId` against the goblin-generated id format (hex, matching `makeSessionId`) before joining, as defense-in-depth against path traversal (session ids are goblin-generated and never user input, so this is belt-and-suspenders). Satisfies: *Session-scoped heartbeat prompt file path*.
- **`src/orchestration/dispatcher.ts`** — `TurnDispatcherOptions` gains `scheduleStore?: ScheduleStore`; `createRunner` passes it into `AgentRunnerOptions.scheduleStore`. Constructed in `createTelegramIntake` (`src/tg/intake.ts:198`) which already receives `scheduleStore` in its options. Satisfies wiring for the tool registration requirement.
- **`src/agent/mod.ts`** — `AgentRunnerOptions` gains `scheduleStore?: ScheduleStore`; `init()` calls `createScheduleTurnTool` (gated on presence) and pushes it into the `tools` array alongside the memory tools (`mod.ts:212`). Satisfies: *Tool is main-agent only* (subagent runners never receive a store).
- **`src/commands/schedule.ts`** — `list` output annotates agent-originated rows with `[agent]`; user rows unchanged otherwise. Satisfies: *List annotates agent schedules*.
- **`src/tg/intake.ts`** — pass `scheduleStore` into the `new TurnDispatcher({...})` options at `:198`. (Already receives it at `:82,400`; this is the missing hop.)

### Tests updated

- **`src/scheduler/store.test.ts`** — cover `source` param, default-on-absent, `countEnabledAgentSchedules`.
- **`src/scheduler/loop.test.ts`** — extend the `resolveHeartbeatPrompt` suite for the session-scoped→global→constant order and the pass-through cases.

### Not changed (and why)

- **`src/scheduler/time.ts`** — the grammar is reused as-is; no new parse functions.
- **`src/subagents/execution.ts`** — no edit; the tool's absence there is by construction (no `scheduleStore` is threaded into subagent runner construction).
- **`src/bot.ts`** — no edit; it already constructs the single shared `ScheduleStore` and threads it to intake.
