# Goblin Backlog

Parked scope and open questions. Items graduate to litespec changes when implementation begins.

## Deferred

- v1.1: cascade cancel — abort child subagents when parent session is cancelled / disposed
- v1.1: approval-required tool mode (allowlist + inline-keyboard approvals)
- v1.1: user-facing named subagent invocation (slash command `/researcher` or topic-to-agent binding)
- v1.x: mixed-provider routing (`selectModel(task)`), per-subagent model override
- v1.x: subagent memory access — wire memory read (and decide on write) into SubagentRunner once curated-memory and subagent-runtime are both in canon.
- v1.x: auto-archive / auto-prune daemons
- v2: voice-note-first workflow (STT + TTS)
- v2: skills for common homelab services shipped in repo
- v2: live subagent cross-talk / swarms — `message_sibling`, `ask_sibling`, spawn_swarm DAG (ref: `~/build/pi-messenger-swarm`)
- v1.x: render `onStatusUpdate` events in the MessageBuffer status line (e.g. "🧠 Researcher analyzing…"). Hook is already implemented as a no-op stub in `src/tg/buffer.ts`; rendering deferred until subagents land. Split out of `message-buffer-streaming`.
- v1.x: end-to-end smoke test of `/cancel`, `/new`, `/archive`, `/debug`, `/help`, and subagent command stubs in both DM and forum-topic surfaces. Deferred from `session-commands-cancel` phase 8; unit tests cover helpers but the grammy ↔ SessionManager ↔ AgentRunner integration path still needs a manual walk-through.

## Open Questions

- ~~Which pi-coding-agent release to pin?~~ Resolved: ^0.67.x caret is fine. ToolDefinition fields we use are stable; re-evaluate at ^0.68 or ^1.0 cutover.
- STT provider when v2 voice lands — Whisper local vs. Poe/OpenRouter audio endpoint.
- Named subagent user-facing invocation (v1.1 design): slash per agent (`/researcher`), generic dispatcher (`/agent researcher …`), or Telegram topic binding?
- `spawn_named` when no existing instance: always create new, or prompt goblin to pick between create / continue latest / continue specific?
