# Curated Memory v1

## Motivation

Goblin has no persistent memory between turns beyond pi's in-memory transcript. Conversation history is captured in `events.jsonl`, but there is no curated, agent-controlled "what I should always know about you and this homelab" surface.

Sessions live for days or weeks (a Telegram topic might receive a few messages a day for a month). Without a memory layer:

- Facts established in week 1 are not pinned for week 4 — they fall out of context as the transcript compacts.
- The user has no way to say "remember this" and have it stick across sessions.
- Per-session context (homelab inventory, projects, preferences, recurring people) has to be re-established constantly.

The skill `agent-memory-management` and the hermes-agent reference both validate the same shape: a small, file-backed, agent-curated memory injected into the prompt. We adopt that pattern, adapted for goblin's single-user / single-process / Telegram-native constraints.

This materializes backlog item v1.5 (`remember()` tool writing to `memory/`).

## Scope

- A new memory store at `$GOBLIN_HOME/memory/` with two files:
  - `memory.md` — agent's notes about the homelab, projects, conventions, decisions (cap: 4000 chars)
  - `user.md` — preferences, communication style, recurring people/places (cap: 2000 chars)
- Entries within each file are separated by `\n§\n` delimiters.
- A new `memory` custom tool exposing `add | replace | remove` operations against `target ∈ {memory, user}`.
  - `replace` and `remove` use a substring match on `old_text` (must be unique within the target file).
  - Overflow returns an error to the agent telling it to consolidate before retrying. The agent does its own defragmentation.
- Memory is injected into every turn as a per-turn "aside" via pi's `AgentSession.sendCustomMessage(..., { deliverAs: "nextTurn" })`. The system prompt remains frozen for the AgentRunner's lifetime so the provider prefix cache is preserved.
- `$GOBLIN_HOME/memory/` is initialized as a git repository on first use. Every successful `memory.*` write commits with a message describing the change. Provides audit, rollback, and concurrent-write safety if it ever becomes relevant.

This change scopes only to `AgentRunner` (the primary, top-level agent driving Telegram sessions). The in-flight `subagent-runtime` change introduces a separate `SubagentRunner` class with its own `customTools: []` policy. Wiring memory read/write access into subagents is explicitly deferred to a follow-up change once both are in canon.

## Non-Goals

- **No inferred memory.** No background reflector, no LLM-driven extraction from events, no dialectic loops. Every write is an explicit tool call. Honcho-style automatic user modeling is deferred to backlog.
- **No `MemoryProvider` abstraction.** Two functions and one tool, hard-coded to the file backend. The seam can be extracted later if a second backend ever lands.
- **No progressive / on-demand tier.** No `memory_search`, no `memory/reference/*.md` loaded by description. Cap-enforced consolidation keeps the corpus small enough to always inject in full.
- **No vector index, no FTS.** Plain Markdown on disk.
- **No PII redaction or prompt-injection scanning beyond size caps.** Single-user threat model; the only writer is bermudi or the LLM acting on bermudi's messages.
- **No mid-session system prompt mutation.** AGENTS.md stays cached; memory rides as an aside.
- **No subagent integration.** `SubagentRunner` (owned by the in-flight `subagent-runtime` change) is untouched here. Subagent memory access — read, write, or none — is decided in a follow-up change once both architectures are settled.
- **No cross-session memory differentiation.** One shared memory store across all sessions, topics, and DMs.
