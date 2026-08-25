# Product

Little Goblin is one Telegram-native personal AI assistant for one operator, running as one Bun process on a homelab. Telegram is the product surface, not merely a transport wrapper: conversations, topics, reactions, voice, and files are part of the interaction model.

## Product boundary

- One human operator and one deployed process.
- Telegram long polling; no generic multi-channel gateway.
- Filesystem-backed persistence, except the canonical SQLite memory store.
- pi-coding-agent is the main model runtime.
- Project mode, subagents, external agents, memory, and automation are capabilities of the same assistant rather than separate products.
- No web UI, plugin SDK, multi-agent gateway, Kubernetes, or distributed coordination.

## Authority

- Code and tests own implemented behavior.
- Explicitly designated contract records own their stated external promises.
- `ARCHITECTURE.md` maps CURRENT, TARGET, and OPEN architecture.
- `specs/decisions/` owns accepted architectural rulings.
- `specs/glossary.md` owns canonical domain language.
- `AGENTS.md` owns repository practice and engineering guardrails.
- Open GitHub issues labeled `litespec` own active delivery work.
- `PARKED.md` contains unshaped candidates and historical context; it is not a queue.

The nested legacy trees documented in `specs/README.md` are historical input only. They do not become current contracts merely because they remain under `specs/`.

## Core flows

1. A Telegram update resolves a Surface and its current Conversation binding, then enters the conversation runtime under machine-held admission authority.
2. A conversation runtime prepares the model session, frozen memory context, tools, skills, and Telegram delivery for one Conversation and immutable Execution Environment.
3. The operator can delegate bounded work to pi subagents or the legacy external-agent runner. Pi subagents use Goblin's host-owned delegated-run records today; the shared external-agent execution host and record integration remain TARGET work for a future ACP issue.
4. Scheduled wakes and memory dreaming run through explicit internal runtime authority rather than borrowing whichever Telegram conversation happens to be active.
5. Repository changes use either the small-fix lane or a dedicated Litespec issue branch with bounded units, red-green evidence, and adversarial review.
