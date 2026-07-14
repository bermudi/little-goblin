# scheduler-agent-tools tasks

Invariants every phase must preserve (from the proposal/specs):
- Agent schedules are provenance-stamped (`source: "agent"`).
- The agent tool may only manage agent-owned schedules (authority by `source`); the `/schedule` command manages all.
- The agent cap (`MAX_AGENT_SCHEDULES`, default **8**) applies to every transition into `enabled` from the agent path — `create_*`, `resume`, `heartbeat on` — and is enforced at the store mutation boundary.
- Per-session HEARTBEAT.md precedence: session-scoped → global → constant.
- User-owned prompt bodies never enter agent model context (list redaction).

## Phase 1: Provenance type and session-scoped path helper

- [x] Add `source?: "user" | "agent"` to `ScheduledTurn` in `src/scheduler/types.ts`. At read time, absent/legacy records SHALL be treated as `"user"` (so existing `schedules.json` is cap-safe and authority-protected without a migration). Satisfies part of *Schedule records carry provenance*.
- [x] Add `MAX_AGENT_SCHEDULES` constant (default **8**) to `src/scheduler/types.ts`.
- [x] Add `heartbeatMdPathForSession(home, sessionId)` to `src/sessions/paths.ts`, defined in terms of `sessionDir(home, sessionId)`, resolving to `<home>/state/sessions/<sessionId>/HEARTBEAT.md`, with a hex-format guard that throws on path separators / `..`. If `sessionDir`/`statePath`/`transcriptPath` lack the guard, add it there too (single source). Satisfies *Session-scoped heartbeat prompt file path*.
- [x] Add/extend `src/sessions` paths tests: `heartbeatMdPathForSession` resolution + traversal-rejection scenario.
- [x] Run `bun test src/sessions` and `bun run typecheck`.

## Phase 2: Store provenance stamping and legacy default

- [x] Update `ScheduleStore.create()` in `src/scheduler/store.ts` to accept an optional `source` and stamp it on the record; default `"user"` when omitted. Satisfies *Schedule records carry provenance*.
- [x] Extend `src/scheduler/store.test.ts`: `create` stamps `user` by default and `agent` when passed; legacy records without `source` count as `user`; loaded records surface an effective `source` of `"user"` when absent.
- [x] Run `bun test src/scheduler/store.test.ts` and `bun run typecheck`.

## Phase 3: Cap and authority at the store mutation boundary

- [x] Add `ScheduleStore.countEnabledAgentSchedules(sessionId): number` counting records owned by the session with effective `source === "agent"` and `state === "enabled"`.
- [x] Enforce the cap inside the mutation path for agent-originated transitions into `enabled`: `create` (when `source === "agent"`), `resume` (when target effective `source === "agent"`), and `setHeartbeat(enabled:true)` (when the heartbeat is or will be agent-owned). Refuse and leave the store unchanged when the mutation would exceed `MAX_AGENT_SCHEDULES`. Keep `/schedule`-path mutations cap-exempt (the cap applies only when the record is/will be agent-source). Satisfies *Agent-originated schedules are bounded by a per-session cap*.
- [x] Enforce agent authority at the store mutation boundary: `remove`/`pause`/`resume` SHALL reject when the caller is the agent path and the target's effective `source` is `"user"`; `setHeartbeat` SHALL reject agent-path disable/overwrite of a user-owned heartbeat. Satisfies *Agent tool authority is scoped to agent-owned schedules*. (Implementation note: distinguish the caller via a cap/authority-aware parameter or a dedicated agent-facing mutation method, so `/schedule`'s full-authority path stays clean.)
- [x] Extend `src/scheduler/store.test.ts`: cap under/at/over on `create`; `resume` at cap fails; pause-frees-headroom; `heartbeat on` at cap fails; user-source mutations never capped; authority rejections (agent-path `remove`/`pause`/`resume`/`heartbeat off` on user-owned records fail and leave store unchanged); `/schedule`-path mutations on agent-owned records succeed.
- [x] Run `bun test src/scheduler/store.test.ts` and `bun run typecheck`.

## Phase 4: Per-session HEARTBEAT.md resolution

- [x] Change `resolveHeartbeatPrompt(home)` → `resolveHeartbeatPrompt(home, sessionId)` in `src/scheduler/loop.ts` with first-non-empty-wins order: session-scoped (`heartbeatMdPathForSession`) → global (`heartbeatMdPath`) → `HEARTBEAT_PROMPT` constant, for the MODIFIED *Heartbeat schedule is explicit and session-scoped*.
- [x] Update `processOne` (and callers) to pass `schedule.sessionId` to `resolveHeartbeatPrompt`.
- [x] Update `src/scheduler/loop.test.ts`'s `resolveHeartbeatPrompt` suite: session-scoped takes precedence over global; falls back to global when session-scoped absent/whitespace-only; falls back to constant when both absent; non-ENOENT read error on either file propagates.
- [x] Run `bun test src/scheduler/loop.test.ts` and `bun run typecheck`.

## Phase 5: The schedule_turn agent tool (with authority, redaction, clock)

- [x] Create `src/scheduler/tool.ts` exporting `createScheduleTurnTool({ store, sessionId, locator, now })` returning a pi `ToolDefinition`, structured like `src/memory/tool.ts` (`defineTool` + typebox, `additionalProperties: false` where supported). Actions: `create_once` (exactly one of `in`/`at` + non-empty `prompt`), `create_recurring` (`every` + non-empty `prompt`), `list` (user-owned prompts **redacted**), `remove`/`pause`/`resume` (agent-authority-checked), `heartbeat` (`on [dur]`/`off`/`status`, agent-authority-checked). All delegate to `ScheduleStore` methods and reuse `parseDuration`/`parseAt`/`parseIn`; no new grammar. Uses the injected `now` provider. Creates stamp `source: "agent"`. Satisfies *Agent self-scheduling tool has parity with /schedule*, *Agent tool authority is scoped to agent-owned schedules*, *Agent tool list redacts user-owned prompts*.
- [x] Tool returns a machine-readable result (id, source, ISO `nextRunAt`) on create/mutate actions.
- [x] Create `src/scheduler/tool.test.ts`: every action; `create_once` both/neither `in`+`at` fails; invalid duration rejected by shared parser; authority rejections (remove/pause/resume/heartbeat-off on user-owned); list redaction (user prompt omitted/sentinel, agent prompt full); provenance stamping; deterministic-clock assertions on `nextRunAt`.
- [x] Export `createScheduleTurnTool` from `src/scheduler/mod.ts`.
- [x] Run `bun test src/scheduler/tool.test.ts` and `bun run typecheck`.

## Phase 6: Wire the tool into the main agent

- [x] Add `scheduleStore?: ScheduleStore` to `AgentRunnerOptions` and to `TurnDispatcherOptions` in `src/orchestration/dispatcher.ts`; thread `scheduleStore` from `createTelegramIntake` (which already receives it at `src/tg/intake.ts:82`) into `new TurnDispatcher({...})` at `:198`.
- [x] `TurnDispatcher.createRunner` passes `scheduleStore` into `AgentRunnerOptions`.
- [x] In `AgentRunner.init()` (`src/agent/mod.ts:212`), build `schedule_turn` via `createScheduleTurnTool` and push it into the `tools` array, gated on `this.scheduleStore` present, for *Tool is main-agent only* and *Tool absent when scheduleStore not wired*.
- [x] Verify subagent runners (built in `src/subagents/execution.ts`) do not receive a `scheduleStore`, so the tool is structurally absent for subagents — add/extend a test asserting the subagent toolset contains no `schedule_turn`.
- [x] Run `bun test src/orchestration src/tg/intake.test.ts src/subagents` and `bun run typecheck`.

## Phase 7: /schedule list annotation and finalize

- [x] In `src/commands/schedule.ts`, annotate agent-originated rows in the `list` output with an `[agent]` tag; user rows unchanged otherwise, for *List annotates agent schedules*.
- [x] Extend the `/schedule list` test to assert the `[agent]` tag appears only on agent-source rows and that user rows render unchanged.
- [x] Run the full test suite: `bun test`.
- [x] Run `bun run typecheck`.
- [x] Re-read each delta spec alongside the implemented code to confirm every requirement and scenario is satisfied; flag any gap.
