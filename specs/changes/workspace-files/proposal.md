# workspace-files

## Motivation

The `scheduled-turns` change shipped heartbeat with a hardcoded system-owned prompt constant: `[heartbeat] This is a scheduled self-check-in. No user message prompted this turn...`. The user cannot customize what goblin does during a heartbeat wake — they can enable/disable it and set the interval, but the prompt text is frozen in `src/scheduler/loop.ts`.

OpenClaw's workspace model includes `HEARTBEAT.md` as a user-editable file that the agent reads at heartbeat wake time. This lets the operator write per-deployment heartbeat instructions ("check the build status; if failed, notify me; otherwise stay quiet") without touching code. The heartbeat substrate (scheduler, schedule store, binding validation) already exists; this change adds the file-reading layer on top.

## Scope

This change adopts `HEARTBEAT.md` as a user-editable workspace file that sources the heartbeat prompt at dispatch time.

Affected capabilities:

- `sessions`: the heartbeat schedule's prompt is sourced from `$GOBLIN_HOME/workspace/HEARTBEAT.md` if present, falling back to the existing system-owned constant when the file is absent.
- `pi-host`: a new `heartbeatMdPath(home)` path helper is added alongside `soulMdPath` and `agentsMdPath`.

Behavior changes:

- At heartbeat dispatch time, the scheduler reads `$GOBLIN_HOME/workspace/HEARTBEAT.md`. If the file exists, its content replaces the body of the heartbeat prompt (the `[heartbeat]` prefix is still prepended). If the file is absent, the existing `HEARTBEAT_PROMPT` constant is used as-is.
- The heartbeat schedule record still stores no user prompt text. The prompt is sourced from the file at dispatch time, not captured at schedule creation time.

New functionality:

- `HEARTBEAT.md` is a user-authored workspace file, siblings with `SOUL.md` and `AGENTS.md`. It is optional — heartbeat works without it (constant fallback).
- `heartbeatMdPath(home)` path helper in `src/pi-host.ts`.

## Non-Goals

- No `MEMORY.md`, `USER.md`, `IDENTITY.md`, or `TOOLS.md` adoption — goblin's agent-curated `state/memory/` tree covers MEMORY.md's role; SOUL.md covers IDENTITY.md; `memory/user.md` covers USER.md; TOOLS.md is Codex-specific and goblin uses pi.
- No per-session HEARTBEAT.md — the file is global at `$GOBLIN_HOME/workspace/HEARTBEAT.md`. If the user wants per-session heartbeat behavior, they use scheduled turns with custom prompts.
- No change to the heartbeat substrate (scheduler loop, schedule store, binding validation, claim/advance semantics) — that is `scheduled-turns` and stays as-is.
- No change to the `[heartbeat]` prefix — it is still prepended to distinguish heartbeat prompts from user-authored text in transcripts and at the agent layer.
- No hot-reload — HEARTBEAT.md is read at each heartbeat dispatch, so edits take effect on the next heartbeat wake without restart.

## Existing Canon Context

This change builds on two established baselines:

- `Heartbeat schedule is explicit and session-scoped` (change `scheduled-turns`, capability `sessions`) — establishes the heartbeat schedule kind, the `[heartbeat]` prefix, and the system-owned prompt. This change modifies the prompt sourcing without changing the schedule semantics.
- `Pi-host exposes Goblin prompt file paths` (canon `pi-host`) — establishes `soulMdPath` and `agentsMdPath` as the pattern for workspace prompt file paths. This change adds `heartbeatMdPath` following the same pattern.

`dependsOn: [workspace-layout, scheduled-turns]` — `workspace-layout` provides the `workspace/` directory; `scheduled-turns` provides the heartbeat substrate.
