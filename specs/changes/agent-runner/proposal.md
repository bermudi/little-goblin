# Agent Runner

## Motivation

Goblin's brain is `pi-coding-agent`, embedded as a library. Today `src/agent/mod.ts` is an empty stub. We need a runner that:

- Embeds pi's `AgentSession` and keeps it alive across Telegram turns within a Goblin session.
- Points pi's shared services (`AuthStorage`, `ModelRegistry`, `SettingsManager`) at `$GOBLIN_HOME/pi-agent/` so auth and model config survive restarts and are shared by every session (goblin is one entity).
- Maps pi's event stream to a callback interface the Telegram layer can consume without pi events leaking into `src/tg/`.
- Writes a complete, unfiltered event log to `sessions/<id>/events.jsonl` for audit and replay.
- Runs all sessions from goblin's single shared workspace `$GOBLIN_HOME/workdir/`, never per-session dirs.
- Accepts session-bound custom tools (β tools from `src/tg/`) without importing grammy itself.

Until this lands, `bot.ts` has nothing to hand messages to and the project is a scaffold with no agent.

## Scope

### In scope
- `AgentRunner` class in `src/agent/mod.ts`, one instance per Telegram session (`sessionId`).
- Construction-time dependencies: `Config`, `customTools: ToolDefinition[]` (β tools pre-bound by the caller), and a `TurnCallbacks` implementation.
- Lazy creation of pi's `AgentSession` on first prompt; reuse on subsequent prompts within the same Telegram session.
- Cwd fixed to `$GOBLIN_HOME/workdir/` for every runner (Model A: single shared workspace).
- Shared services wired to `$GOBLIN_HOME/pi-agent/` (`auth.json`, `settings.json`, model registry).
- Pi's `SessionManager` in `inMemory()` mode for Goblin's main sessions — conversation history is ephemeral to the process; audit trail lives in `events.jsonl`.
- Event-to-callback mapping: subscribe to `AgentSession` events, translate to `TurnCallbacks` (`onTextDelta`, `onToolStart`, `onToolEnd`, `onStatusUpdate`, `onAgentEnd`).
- Every tool call fires `onToolStart`/`onToolEnd` — filtering by visibility level is the Telegram layer's job, not the runner's.
- Complete event log written to `events.jsonl` in append-only JSONL with atomic line writes.
- `AGENTS.md` at `$GOBLIN_HOME/AGENTS.md` loaded as part of the system prompt on each runner creation.
- Goblin's user-authored skills at `$GOBLIN_HOME/skills/` discoverable by pi via its default `ResourceLoader` (cwd-based discovery from `$GOBLIN_HOME/workdir/`).
- `abort()` method that cancels the current turn and waits for pi to become idle.
- Concurrency within a session: rapid user messages during streaming use pi's `followUp` semantics (built-in; no custom queueing).

### Out of scope
- β tool implementations (separate `beta-tools` change).
- Subagent spawning and lifecycle (separate `subagent-runtime` change).
- `MessageBuffer`, rate limiting, status line synthesis, tool visibility config (separate `message-buffer-streaming` change; the runner only emits uniform callbacks).
- `/cancel`, `/new`, `/archive`, `/debug` command wiring and their abort semantics (separate `session-commands-cancel` change).
- `transcript.jsonl` writing — transcripts are a higher-level artifact; v1 can derive them from `events.jsonl` or defer.
- Multi-workspace or per-session cwd.
- Any cross-session coordination or parallelism.

## Non-Goals

- **No pi subprocess.** pi runs in-process as a library. If we ever need to run user-provided code in isolation, that's a v2 sandbox decision, not this change.
- **No event filtering in the runner.** The runner is a faithful translator. Visibility rules belong in the Telegram layer.
- **No telegram awareness.** `src/agent/` never imports grammy or anything telegram-shaped. β tools arrive as opaque `ToolDefinition[]` with all context baked into their closures.
- **No persistent pi sessions in v1 for the main goblin.** Pi's `inMemory()` session is sufficient; audit lives in `events.jsonl`. Subagents will use persisted pi sessions (that change lives elsewhere).
- **No concurrency primitives beyond what pi provides.** Pi's `steer`/`followUp` queue handles rapid messages. The runner does not invent its own queue.
- **No retry/compaction UI.** Those pi events are logged to `events.jsonl`; surfacing them is the Telegram layer's call.
