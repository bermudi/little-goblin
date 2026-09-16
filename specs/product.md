# Product

Little Goblin is one Telegram-native personal AI assistant for one operator, running as one Bun process on a homelab. Telegram is the product surface, not merely a transport wrapper: conversations, topics, reactions, voice, and files are part of the interaction model.

## Product boundary

- One human operator and one deployed process.
- Telegram long polling; no generic multi-channel gateway.
- Filesystem-backed persistence, except the canonical SQLite memory store.
- pi-coding-agent is the main model runtime.
- Project mode, subagents, external agents, memory, and automation are capabilities of the same assistant rather than separate products.
- Telegram is the UI, including Telegram Mini Apps. No standalone web UI,
  plugin SDK, multi-agent gateway, Kubernetes, or distributed coordination.

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
3. The operator can delegate bounded work to pi subagents through Goblin's host-owned delegated-run records, including durable lifetime with completion-wake delivery, exact-Surface pending claim/re-arm, and owner cancellation (see `specs/delegated-work/spec.md`). The capability-scoped ACP external-agent host, delegated external-agent tool, and continuation path plus external delegated-run records are implemented and tested but not production-wired: the main-runtime capability manifest and tool assembly omit `external_agent` and `agent/mod.test` pins its absence. Legacy provider adapters and `scratch/external-agents/` storage were removed with no migration.
4. Scheduled turns capture a Surface and dispatch through its current Conversation runtime. Light-sleep private reflection runs through the inner-life lifecycle/scheduler host; REM/deep sleep and transcript sync keep their existing scheduling. The Surface-free internal runtime seam is removed: reserved identities are rejected at the session path boundary and only Surface-backed generations remain. Broader inner-life wakes/effects beyond private reflection remain TARGET.
5. Repository changes use either the small-fix lane or a dedicated Litespec issue branch with bounded units, red-green evidence, and adversarial review.
