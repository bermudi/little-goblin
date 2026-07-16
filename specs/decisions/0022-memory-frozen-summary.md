# Memory frozen system-prompt summary

## Status

accepted

## Context

The current memory system injects the full memory store as a per-turn aside. As memory grows, this becomes a fixed and growing token tax. A better approach is to inject a bounded summary once at session creation and compute prompt-specific relevant memory per turn.

## Decision

- A bounded frozen memory summary SHALL be appended to `_baseSystemPrompt` at session creation.
- The frozen summary SHALL be bounded to 1200 characters total and SHALL include the active scope description, a `user.md` summary, an active scope `memory.md` summary, and a cross-scope index.
- The summary SHALL begin with `[goblin memory summary (frozen at session start)]` and SHALL include the guardrail text `Memory may be stale or incomplete. Current user messages, recent tool results, and explicit instructions override memory.` when memory is non-empty.
- The frozen summary SHALL NOT be refreshed mid-session.
- A `## relevant memory` per-turn aside SHALL be computed via hybrid search with `corpus = "memory"` and bounded to 3 results by default, clamped to a maximum of 5.

## Consequences

- The per-turn memory token tax drops significantly because the frozen summary is sent once and prefix-cached.
- Mid-session memory writes are discoverable via `memory_search` but do not appear in the system prompt until the next session.
- Transcript entries never appear in the frozen summary or `## relevant memory` aside.
