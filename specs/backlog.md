# Goblin Backlog

Parked scope and open questions. Items graduate to litespec changes when implementation begins.

## Deferred

- **PDF/video native model ingestion — gated on a stack change (decision 0005).** PDFs and video cannot reach the model through the pi-routed stack: pi-ai's content union is closed at `TextContent | ImageContent`. Two changes were opened and found too costly: `multimodal-native-pdf` (pi-ai `bun patch` surgery — unmaintainable) and `migrate-to-ai-sdk` (complete 8-capability stack rewrite — nuclear). Reopen against a new foundation when **either** pi-ai ships native document support **or** goblin independently migrates off pi. Workaround until then: `pdftotext` extraction; images via existing `ImageContent` path. Original proposals retained in git history.
- v1.1: cascade cancel — abort child subagents when parent session is cancelled / disposed
- v1.1: approval-required tool mode (allowlist + inline-keyboard approvals)
- v1.1: user-facing named subagent invocation (slash command `/researcher` or topic-to-agent binding)
- v1.x: mixed-provider routing (`selectModel(task)`), per-subagent model override
- ~~v1.x: subagent memory access~~ — resolved by `scoped-memory` (anonymous subagents inherit parent active scope; named subagents get a three-tier model with persona memory).
- ~~v1.x: PII redaction in memory writes~~ — resolved by `robust-memory` (deterministic safety filter shared by explicit `memory_write` and the reflection pipeline; rejects secrets/identifiers, quarantines rejected candidates).
- v2.x: per-chat isolation for `general` memory — today `memory/general/memory.md` is shared across DMs and every supergroup-no-topic surface. If multi-chat usage stops being single-user, switch to `memory/general/<chatId>/memory.md`. Single consumer (`MemoryStore` scope resolver) so the change is local.
- v1.x: auto-archive / auto-prune daemons — the scheduler substrate (`ScheduleStore` + `SchedulerLoop` from `scheduled-turns`) now exists and could host an ambient archive/prune job as another `ScheduledTurn` kind, but the daemon itself (policy, what to prune, retention) remains unimplemented.
- v1.x: cron syntax and natural-language date parsing for `/schedule` — deferred from `scheduled-turns` v1, which ships only ISO-8601 `at`, `in <duration>`, and integer `m`/`h`/`d` durations.
- v2.x: distributed/multi-process scheduler — `scheduled-turns` v1 is single-process only; cross-process locking on `schedules.json` is a future concern if multiple Goblin processes ever share a home directory.
- v1.x: self-hosted Telegram Bot API server (`telegram-bot-api`) to lift file download limit from 20 MB → 2 GB. Needs `botApiUrl` config option and local infra (single Go binary). Blocked until a real >20 MB file arrives.
- v2: voice-note-first workflow (STT + TTS)
- v2: skills for common homelab services shipped in repo
- v2: live subagent cross-talk / swarms — `message_sibling`, `ask_sibling`, spawn_swarm DAG (ref: `~/build/pi-messenger-swarm`)
- v1.x: render `onStatusUpdate` events in the MessageBuffer status line (e.g. "🧠 Researcher analyzing…"). Hook is already implemented as a no-op stub in `src/tg/buffer.ts`; rendering deferred until subagents land. Split out of `message-buffer-streaming`.
- v1.x: end-to-end smoke test of `/cancel`, `/new`, `/archive`, `/debug`, `/help`, and subagent command stubs in both DM and forum-topic surfaces. Deferred from `session-commands-cancel` phase 8; unit tests cover helpers but the grammy ↔ SessionManager ↔ AgentRunner integration path still needs a manual walk-through.
- v1.x: rate limiting — beta tools operate in "YOLO mode". No client-side rate limiting; we rely on Telegram's server-side limits and return errors to the LLM.
- glossary: `memory_search`, `standing order`, `commitment` — deferred from `memory-retrieval` and `scheduled-turns` until wording stabilizes across both proposals.

## Open Questions

- **Dynamic Poe model resolution — shelved (using Poe less).** Replace static Poe model entries with dynamic resolution from Poe's `GET /v1/models` catalog: accurate `input` modalities (so non-vision models don't crash on image sends), `contextWindow`, `maxTokens`, and `cost`. Goblin already fetches the catalog at startup for validation and throws it away. Reopen when Poe becomes a primary provider again; until then the static registry is tolerable. Original proposal in git history.
- ~~Which pi-coding-agent release to pin?~~ Resolved: ^0.67.x caret is fine. ToolDefinition fields we use are stable; re-evaluate at ^0.68 or ^1.0 cutover.
- STT provider when v2 voice lands — Whisper local vs. Poe/OpenRouter audio endpoint.
- Named subagent user-facing invocation (v1.1 design): slash per agent (`/researcher`), generic dispatcher (`/agent researcher …`), or Telegram topic binding?
- `spawn_named` when no existing instance: always create new, or prompt goblin to pick between create / continue latest / continue specific?
