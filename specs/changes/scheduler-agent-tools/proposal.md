# scheduler-agent-tools

## Motivation

Goblin's scheduler substrate (the `scheduled-turns` change) lets the *user* schedule future work via `/schedule`, and lets the system run an autonomous heartbeat. But goblin itself has no way to schedule work on its own initiative. Today it can only *suggest* reminders — the memory reflector detects reminder-like language in transcripts (`src/memory/reflector.ts`) and persists it as a memory, but never actually schedules anything. When a user says "remind me tomorrow," the goblin must either act immediately or do nothing; it cannot defer.

Independently, the heartbeat prompt is global. Every session whose heartbeat is on shares a single `$GOBLIN_HOME/workspace/HEARTBEAT.md` body. There is no way to give one topic a different self-check-in cadence or content than another. The `workspace-files` change explicitly deferred per-session heartbeat behavior to the backlog.

This change closes both gaps by extending the existing substrate rather than introducing a new one:

1. **Agent self-scheduling tool.** Give the agent a `schedule_turn` tool with full parity to `/schedule` — create one-shot and recurring schedules, manage heartbeats, list/remove/pause/resume its own schedules — backed by the same `ScheduleStore`. The store, loop, claim-before-dispatch, per-session serialization, and stale-runner guard are already general enough to consume agent-originated schedules unchanged.
2. **Per-session HEARTBEAT.md.** Layer a session-scoped heartbeat prompt body (`state/sessions/<id>/HEARTBEAT.md`) above the existing global body, first-non-empty-wins.

## Scope

Two capabilities are affected: **orchestration** (agent scheduling tool, authority, cap, provenance) and **sessions** (session-scoped heartbeat path + resolution order). The `workspace` capability is **not** changed: the per-session heartbeat file is session state under `state/sessions/<id>/`, not a `workspace/` prompt file, so decision `0009` does not apply and the existing global `heartbeatMdPath` helper is reused unchanged as the second-tier fallback.

### Behavior changes

- **New agent tool `schedule_turn`** in a new `src/scheduler/tool.ts`, built with `defineTool` + typebox (mirrors `src/memory/tool.ts`). Actions mirror `/schedule` subcommands:
  - `create_once` — exactly one of `in` (duration `30m`/`2h`/`1d`) or `at` (ISO-8601), plus a non-empty `prompt`
  - `create_recurring` — `every` (duration), plus a non-empty `prompt`
  - `list` — list this session's schedules, with user-owned prompts **redacted** out of model context
  - `remove` / `pause` / `resume` — mutate a schedule by id, **scoped to agent-owned schedules only**
  - `heartbeat` — `on [dur]` | `off` | `status`, **scoped: the agent cannot turn off or overwrite a user-owned heartbeat**
  - The tool reuses the existing `ScheduleStore` methods and the existing `parseDuration`/`parseAt`/`parseIn` grammar. `now` comes from an injected clock provider (not a direct `Date.now()` call), mirroring how `/schedule` receives `deps.now`. No new time grammar.
- **Provenance as an authority boundary** (`source?: "user" | "agent"` on `ScheduledTurn`, `src/scheduler/types.ts`). Optional → backward compatible; absent/old records read as `user`. The agent tool may create/list/remove/pause/resume and manage heartbeats for **agent-owned schedules only** — it cannot touch user-owned schedules or surface their prompt bodies. The `/schedule` human command retains authority over all schedules regardless of source. Provenance is structural (authority, list redaction, display) and SHALL be kept even if the cap policy is later relaxed.
- **Per-session agent-schedule cap.** A `MAX_AGENT_SCHEDULES` constant (default **8**) bounds enabled agent-source schedules per session. The invariant — "a session may not have more than `MAX_AGENT_SCHEDULES` enabled `source:"agent"` schedules after any store mutation" — is enforced **at the store mutation boundary** for every transition into `enabled`: `create_once`, `create_recurring`, `resume`, and `heartbeat on`. The `/schedule` command path is exempt. User-originated schedules are never counted.
- **Per-session HEARTBEAT.md resolution.** `resolveHeartbeatPrompt(home, sessionId)` resolves in order: session-scoped `state/sessions/<id>/HEARTBEAT.md` → global `$GOBLIN_HOME/workspace/HEARTBEAT.md` → system `HEARTBEAT_PROMPT` constant. First non-empty wins. The new path helper `heartbeatMdPathForSession(home, sessionId)` lives in `src/sessions/paths.ts` (session state, sanctioned accessor per AGENTS.md).

### Wiring (additive)

`scheduleStore` already reaches `createTelegramIntake` (`src/tg/intake.ts`); it currently feeds only the `/schedule` command path. Threading it to the agent is a three-hop additive change:

1. `TurnDispatcherOptions` gains `scheduleStore?: ScheduleStore` (`src/orchestration/dispatcher.ts`); constructed in `createTelegramIntake`.
2. `TurnDispatcher.createRunner` passes it into `AgentRunnerOptions.scheduleStore?`.
3. `AgentRunner.init()` builds `schedule_turn` (gated on `scheduleStore` present) alongside the memory tools.

When `scheduleStore` is absent (tests, subagents), the tool is not registered — so subagents, which build their own toolset in `src/subagents/execution.ts`, never get it. This keeps the subagent depth-cap story clean: only the main agent can schedule.

## Non-Goals

- **No cron syntax.** The bounded time grammar (`in`, `at` ISO-8601, integer `m`/`h`/`d` durations) stays. Reversing the deliberate "bounded grammar" decision of `scheduled-turns` remains a separate backlog item.
- **No natural-language date parsing.** Same reasoning; deferred.
- **No agent tool for time forms beyond `/schedule`.** The agent tool uses the same grammar as the command.
- **No prompt-length cap on the agent tool.** Verified: the `/schedule` command enforces only that the prompt is non-empty (`src/commands/schedule.ts`); there is no character cap to mirror. The agent tool enforces non-empty and reuses shared parsers; it does not invent a length limit.
- **No subagent scheduling.** `schedule_turn` is main-agent only. A spawned subagent cannot create schedules.
- **No distributed or multi-process scheduling.** Single-process only, as in `scheduled-turns` v1.
- **No guaranteed exact-time execution.** Due work runs on the scheduler's 60s polling cadence, unchanged.
- **No auto-prune or auto-archive of agent schedules.** The cap bounds growth; cleanup is the agent's or user's job via `remove`/`pause`.
- **No new agent self-scheduling for the heartbeat prompt *body* authoring.** Per-session `HEARTBEAT.md` is a file the user authors; the agent does not write it through this change (it already has `memory_write` for its own notes, which is a separate channel).
