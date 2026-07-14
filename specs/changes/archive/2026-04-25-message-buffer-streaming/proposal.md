# Message Buffer & Streaming

## Motivation

The `AgentRunner` emits events via `TurnCallbacks`, but the Telegram layer needs to render these into a coherent UI. Raw pi events (100ms deltas, tool start/end bursts) would flood Telegram with edits and hit rate limits.

We need a `MessageBuffer` that:
- Coalesces tool activity into a single status line message (🧠/🔧/✍️/✅/❌) edited ~1/sec.
- Streams response text via edits on a separate message, rolling to new messages at 4096 chars.
- Escapes big output (>~20KB) to file attachments with summaries.
- Implements user-configurable tool visibility (none/minimal/standard/verbose/debug) by filtering `onToolStart`/`onToolEnd` events.
- Never crashes the bot — drops edits rather than throws.

Without this, `bot.ts` would spam Telegram API and get rate-limited or banned.

## Scope

### In scope
- `MessageBuffer` class in `src/tg/buffer.ts` implementing `TurnCallbacks`.
- Status line synthesis: tool activity → single edited message with emoji state machine.
- Response streaming: text accumulation → edit → 4096 rollover → new message.
- Big output detection: threshold → `reply.md` file + short summary text.
- Tool visibility filtering: config level → which tools appear in status.
- `chat_action` refresh every ~4s while active (typing/uploading/etc).
- Rate limit coalescing: drop intermediate edits if we can't keep up.

### Out of scope
- β tool implementations (separate `beta-tools` change).
- Subagent status display (goblin's status shows subagent activity, not raw events — see `subagent-runtime`).
- Transcript generation from events (can derive from `events.jsonl` later).
- Persistent message state across restarts (if goblin restarts, new messages start).

## Non-Goals
- **No exact 1-second timer.** Throttle is approximate; urgency is avoiding flood, not precision.
- **No message recovery.** If an edit fails (message deleted, network error), we log and continue; no retry storm.
- **No speculative pre-rendering.** We don't try to predict what the LLM will say; we accumulate and emit.
- **No inline keyboard state management.** v1.x deferred.
