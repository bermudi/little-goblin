# Goblin Backlog

Parked scope and open questions. Items graduate to litespec changes when implementation begins.

## Deferred

- v1.1: approval-required tool mode (allowlist + inline-keyboard approvals)
- v1.1: user-facing named subagent invocation (slash command `/researcher` or topic-to-agent binding)
- v1.5: `remember()` tool writing to `memory/YYYY-MM.md`
- v1.x: mixed-provider routing (`selectModel(task)`), per-subagent model override
- v1.x: auto-archive / auto-prune daemons
- v2: voice-note-first workflow (STT + TTS)
- v2: skills for common homelab services shipped in repo
- v2: live subagent cross-talk / swarms — `message_sibling`, `ask_sibling`, spawn_swarm DAG (ref: `~/build/pi-messenger-swarm`)

## Open Questions

- Which pi-coding-agent release to pin? Check latest stable before `bun add`.
- STT provider when v2 voice lands — Whisper local vs. Poe/OpenRouter audio endpoint.
- Named subagent user-facing invocation (v1.1 design): slash per agent (`/researcher`), generic dispatcher (`/agent researcher …`), or Telegram topic binding?
- `spawn_named` when no existing instance: always create new, or prompt goblin to pick between create / continue latest / continue specific?
