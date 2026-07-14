# Subagent Runtime

## Motivation

Goblin is one persistent entity, but it spawns workers for focused tasks. Subagents keep goblin's context clean while delegating work:
- **Generic subagents:** Ad-hoc, system prompt set at spawn, inherit goblin's skills.
- **Named subagents:** Specialists (Researcher, Reviewer) with own `AGENTS.md` and isolated skills.

All subagent conversations are persisted pi sessions, revivable like `pi -c`. This lets goblin or the user return to a subagent later with new context.

## Scope

### In scope
- `SubagentRunner` class in `src/subagents/mod.ts`.
- `spawn_subagent` tool available to goblin (and recursively to subagents, depth ≤ 3).
- Generic subagent spawning: prompt + inherit parent skills.
- Named subagent spawning: load `~/goblin/agents/<name>/AGENTS.md`, isolated `~/goblin/agents/<name>/skills/`.
- Subagent persistence: each spawn creates `~/goblin/subagents/<id>/session.jsonl` via pi's `SessionManager.create()`.
- Subagent revival: `revive_subagent(id, newPrompt)` loads persisted session, continues conversation.
- Depth cap: recursion limit of 3 to prevent runaway spawning.
- Status reporting: subagent activity appears in goblin's status line (via `onStatusUpdate` callback).

### Out of scope
- **Cross-talk between live subagents** (concurrent subagents coordinating) — deferred to v2, reference `pi-messenger-swarm`.
- **Cascade cancel** (killing subagents when parent cancels) — v1.1.
- **Subagent-to-subagent direct communication** — v2.
- **Resource quotas** (CPU/memory limits per subagent) — v2.

## Non-Goals
- **No shared state between subagents.** Each has its own pi session and optionally isolated workdir.
- **No automatic subagent cleanup.** Sessions persist forever; `/prune_subagents` is manual.
- **No subagent UI in Telegram.** Subagents have no β tools, no direct Telegram surface. All interaction is via goblin orchestration.
- **No dynamic skill reloading.** Skills are loaded at spawn; changes require respawn.
