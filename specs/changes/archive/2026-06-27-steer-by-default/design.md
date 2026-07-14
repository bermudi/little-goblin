## Architecture

The change splits the bot's text-dispatch path into two branches based on runner state, and adds a new non-cancel-capable command that opts back into the old serialize-and-wait behavior.

```
non-command text message arrives
        │
        ▼
┌───────────────────────┐
│ resolve session +     │
│ getOrCreateRunner     │
└───────────┬───────────┘
            │
            ▼
      runner.isStreaming?
            │
   ┌────────┴────────┐
   │ true            │ false
   ▼                 ▼
┌─────────────┐  ┌──────────────────┐
│ runner.     │  │ schedulePrompt   │
│ followUp    │  │ (existing queue) │
│ (steer)     │  │ → runner.prompt  │
│ fire-and-   │  │   new buffer     │
│ forget      │  │   new snapshot   │
└─────────────┘  └──────────────────┘
```

`/queue <text>` bypasses the steer branch entirely: it is a command, so it routes through `handleCancelCapableCommand`, which returns a `queue-prompt` side effect. `bot.ts` processes that side effect by calling `schedulePrompt` with the supplied text — the same queue path idle messages take, but invoked explicitly even while the runner is streaming.

```
/queue <text> arrives
        │
        ▼
handleCancelCapableCommand (NOT in CANCEL_CAPABLE_COMMANDS → no cascade)
        │
        ▼
returns { kind: "replied", sideEffects: [{ kind: "queue-prompt", session, text }] }
        │
        ▼
bot.ts processes side effect:
  schedulePrompt(session, runner, () => runner.prompt(text, newBuffer))
  → waits behind any in-flight turn via promptQueues
```

Media messages (photo, document, voice) keep their existing `schedulePrompt` path unchanged — they never steer, regardless of streaming state. This is a non-goal: `followUp` is text-only in this change.

## Decisions

### Steer is fire-and-forget from the bot handler

**Chosen:** When `runner.isStreaming` is true, the bot calls `runner.followUp(text)` without awaiting it in the update handler and without routing it through `promptQueues`. The update handler resolves immediately after dispatching the call.

**Why:** `session.followUp` is pi's own queue — it injects the text into the running turn's context. Awaiting it would block the update handler until the entire turn completes, defeating the "don't block grammy" requirement. Routing it through `promptQueues` would serialize it behind the running turn (which is what we're explicitly removing). Pi serializes multiple `followUp` calls internally into the same turn.

**Constraint:** Two race conditions must be handled in the `.catch`:
1. **Turn ends mid-steer** — `isStreaming` was true at the check, but the turn completes before `followUp` runs. `followUp` throws "not streaming". The bot MUST fall back to `schedulePrompt` + `runner.prompt()` with a fresh `MessageBuffer` so the message lands as a new turn instead of being silently dropped.
2. **Runner disposed mid-steer** — a `/new` or `/archive` arrives between the check and the call. `this.session` is null, `followUp` throws. The disposing command already won; the steer is irrelevant. Log and swallow.

The `.catch` distinguishes these by error message: "not streaming" → race fallback; anything else → log and swallow. This is the same best-effort posture as the existing `schedulePrompt` error handler, with the added guarantee that a raced steer never drops the user's message.

**Rejected alternative:** Await `followUp` and route through `promptQueues`. This recreates the queue we're removing.

### `followUp` does not reset turn state or inject memory snapshot

**Chosen:** `AgentRunner.followUp(content)` calls `session.followUp(...)` directly. It does NOT touch `this.callbacks`, `this.accumulatedText`, and does NOT call `sendCustomMessage` for the memory snapshot.

**Why:** The running turn owns its `MessageBuffer` (via `this.callbacks`) and is mid-stream. Resetting callbacks would orphan the in-flight buffer. The memory snapshot is per-turn — the running turn already received its snapshot at `prompt()` time. Injecting another `nextTurn` custom message during a steer would either queue for a future turn (wrong) or interfere with the running turn's context (wrong).

**Constraint:** This means a steered message does not see memory writes that happened during the running turn. That's correct — the running turn's snapshot was fixed at its start. The next idle `prompt()` will pick up any writes. This matches the existing per-turn snapshot semantics.

### `/queue` returns a side effect, not a direct schedule

**Chosen:** `handleCancelCapableCommand` handles `/queue` in its switch and returns a new side effect kind `{ kind: "queue-prompt"; session: SessionState; text: string }`. `bot.ts` processes this side effect (after the reply is sent) by calling `schedulePrompt` with the supplied text and a fresh `MessageBuffer`.

**Why:** The dispatch function doesn't have access to `promptQueues`, `getOrCreateRunner`, or `createMessageBuffer` — those are bot-local closures. Extending `SideEffect` keeps `/queue` in the canonical command dispatch location (consistent with all other commands) while letting `bot.ts` own the actual scheduling, mirroring how `runner-created` and `runner-disposed` side effects already work.

**Rejected alternative:** Intercept `/queue` in `bot.ts` before calling `handleCancelCapableCommand`. This would special-case one command outside the dispatch switch, breaking the pattern that all commands route through dispatch.

### `/queue` is not cancel-capable

**Chosen:** `/queue` is NOT in `CANCEL_CAPABLE_COMMANDS`. The dispatch switch handles it without running the interrupt cascade.

**Why:** `/queue` appends to the running turn, it does not interrupt it. If it aborted the turn first, it would defeat its own purpose (the user wants the current turn to finish, then run this). The "not cancel-capable" property is spec'd explicitly so a future reader doesn't add it to the set by analogy with other commands.

### Steer is text-only; media still queues

**Chosen:** Only the `message:text` handler checks `isStreaming` and steers. The `message:photo`, `message:document`, and `message:voice` handlers keep their existing `schedulePrompt` path unconditionally.

**Why:** `AgentSession.followUp` injects text (and optionally images) into the running turn. Mid-turn multimodal injection is a separate concern with its own edge cases (download latency, model capability checks, buffer sealing). Text-only steer covers the primary use case (redirecting/refining a running turn) and keeps the change focused. Media sent while busy queues and runs after the turn settles — acceptable, and the user can `/cancel` first if they want it sooner.

### No queue introspection commands

**Chosen:** No `/queued`, `/clear-queue`, or queue-listing command.

**Why:** With steer as the default, the queue is only populated by explicit `/queue` calls. In practice it's at most a few items deep. If it grows, the user can `/cancel` to clear the running turn (queued items then run in order) or `/new` to dispose everything. Adding management commands is scope creep for a homelab bot.

## File Changes

### `src/agent/mod.ts` (modified)

Add the `followUp` method to `AgentRunner`. It mirrors `prompt`'s content normalization but skips all turn-state reset and snapshot injection:

```typescript
async followUp(content: string | (TextContent | ImageContent)[]): Promise<void> {
  if (!this.session) {
    throw new Error("Cannot steer: session not initialized. Call prompt() first.");
  }
  if (!this.session.isStreaming) {
    throw new Error("Cannot steer: session is not streaming.");
  }
  const contentForModel = this.normalizeContentForModel(content);
  if (typeof contentForModel === "string") {
    await this.session.followUp(contentForModel);
  } else {
    const texts = contentForModel
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text);
    const images = contentForModel.filter((c): c is ImageContent => c.type === "image");
    await this.session.followUp(texts.join("\n"), images.length > 0 ? images : undefined);
  }
}
```

The existing `isStreaming` branch inside `prompt()` (lines 329-339) is REMOVED — `prompt()` is now only called when the runner is idle, so the branch is dead. `prompt()` becomes: guard (throw if `isStreaming`) → reset state → inject snapshot → `sendUserMessage`. The guard makes the steer-vs-new-turn contract explicit: if the bot layer accidentally calls `prompt()` on a streaming runner, it throws instead of silently clobbering the in-flight turn's `this.callbacks` and `this.accumulatedText`. This satisfies the MODIFIED agent spec requirement "In-flight prompts use pi's followUp queueing" which now describes two distinct methods.

**`prompt()` call site audit:** Every production call to `runner.prompt()` goes through `schedulePrompt` in `bot.ts`, which serializes per-session via `promptQueues`. By the time the queue reaches a work item, the prior turn has settled and `isStreaming` is false. The call sites are:
- `bot.ts:449` — text handler idle path (after the steer branch)
- `bot.ts:300,302` — `runPrompt` helper, used by photo/document/voice handlers via `turn.schedule`
- `/queue` side-effect processing (Phase 3) — also via `schedulePrompt`

No command handler calls `runner.prompt()` directly (verified: `grep -rn '\.prompt(' src/commands/` returns zero matches). The steer race fallback (Phase 2) calls `runner.prompt()` via `schedulePrompt` after `followUp` throws "not streaming" — at that point the turn has ended, so `isStreaming` is false and the guard passes. Subagents do not share `AgentRunner` (non-goal). The guard is safe across all paths.

Implements spec requirement: **In-flight prompts use pi's followUp queueing** (MODIFIED, agent capability).

### `src/bot.ts` (modified)

**1. Text handler steer branch (lines 433-454):** Replace the unconditional `schedulePrompt` with a streaming check:

```typescript
const runner = getOrCreateRunner(session, locator, ctx);
const text = ctx.msg?.text;
if (!text) return;

if (runner.isStreaming) {
  // Steer: inject into the running turn without resetting its buffer.
  // If the turn ends between the isStreaming check and the followUp call
  // (a race), followUp throws "not streaming" — fall back to scheduling a
  // fresh turn so the message is not silently dropped.
  void runner.followUp(prepareUserContent(ctx, text)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not streaming")) {
      // Race: turn ended mid-steer. Land the message as a fresh turn.
      const buffer = createMessageBuffer(locator);
      schedulePrompt(session, runner, async (isCurrent) => {
        if (!isCurrent()) return;
        await runner.prompt(prepareUserContent(ctx, text), buffer);
      }, (err) => {
        log.error("runner prompt failed (steer race fallback)", { error: String(err), sessionId: session.id });
      });
    } else {
      log.warn("steer failed", { error: msg, sessionId: session.id });
    }
  });
  return;
}

const buffer = createMessageBuffer(locator);
schedulePrompt(session, runner, async (isCurrent) => {
  if (!isCurrent()) return;
  await runner.prompt(prepareUserContent(ctx, text), buffer);
}, (err) => {
  log.error("runner prompt failed", { error: String(err), sessionId: session.id });
});
```

**2. Process `queue-prompt` side effect (after line 416):** In the side-effect loop, add:

```typescript
} else if (effect.kind === "queue-prompt") {
  const queueRunner = getOrCreateRunner(effect.session, locator, ctx);
  const queueBuffer = createMessageBuffer(locator);
  schedulePrompt(effect.session, queueRunner, async (isCurrent) => {
    if (!isCurrent()) return;
    await queueRunner.prompt(prepareUserContent(ctx, effect.text), queueBuffer);
  }, (err) => {
    log.error("queued prompt failed", { error: String(err), sessionId: effect.session.id });
  });
}
```

Implements spec requirements:
- **Agent turns do not block unrelated updates** (MODIFIED, orchestration) — steer branch
- **Queue command enqueues text for the next idle turn** (ADDED, commands) — side-effect processing

### `src/commands/dispatch.ts` (modified)

**1. Extend `SideEffect` type:**

```typescript
export type SideEffect =
  | { kind: "runner-created"; session: SessionState; locator: ChatLocator }
  | { kind: "runner-disposed"; sessionId: string }
  | { kind: "queue-prompt"; session: SessionState; text: string }
  | { kind: "noop" };
```

**2. Add `/queue` case to the switch** (before `default:`):

```typescript
case "/queue": {
  if (!session) return replied("No active session.");
  const arg = rawText.slice("/queue".length).trim();
  if (arg.length === 0) return replied("Usage: /queue <text>");
  // If the runner is idle, the queue is empty — work starts now.
  // We still return a side effect so bot.ts schedules it through promptQueues,
  // which is a no-op wait when idle but keeps the path uniform.
  sideEffects.push({ kind: "queue-prompt", session, text: arg });
  const existingRunner = opts.existingRunner;
  const ack = existingRunner?.isStreaming ? "Queued. Will run after the current turn." : "Running.";
  return replied(ack, sideEffects);
}
```

`/queue` is NOT added to `CANCEL_CAPABLE_COMMANDS` (line 32) — it must not trigger the cascade.

Implements spec requirements:
- **Queue command enqueues text for the next idle turn** (ADDED, commands)
- **Queue command is not cancel-capable** (ADDED, commands)

### `src/commands/help.ts` (modified)

Add `/queue <text>` to the `HELP_REPLY` command list.

Implements spec requirement: **Help command lists queue** (ADDED, commands).

### `src/agent/mod.test.ts` (modified)

- Update existing tests for the "In-flight prompts use pi's followUp queueing" requirement: the `isStreaming` branch is no longer in `prompt()`. Tests that called `prompt()` twice rapidly expecting `followUp` on the second call now need to call `runner.followUp()` directly.
- Add tests for `followUp()`: steers while streaming, throws when not streaming, throws when session uninitialized, handles multimodal, throws `ModelNotCapableError` for image-incapable models.

### `src/bot.test.ts` (modified)

- Add tests for the steer branch: a text message while `runner.isStreaming === true` calls `runner.followUp` (not `prompt`), does not create a new `MessageBuffer`, and the update handler resolves without awaiting the turn.
- Add tests for the `/queue` side-effect path: `/queue <text>` while streaming enqueues via `schedulePrompt` and does not abort; `/queue` when idle runs immediately; `/queue` with no arg replies usage; `/queue` with no session replies "No active session."
- Update the existing "Same-session work remains ordered" test (line 310 area) — the scenario changes from "second waits for first" to "second steers into first."

### No changes to

- `src/interrupt.ts` — cascade logic unchanged; `/queue` doesn't use it.
- `src/tg/buffer.ts` — `MessageBuffer` is unchanged; steer reuses the in-flight buffer.
- `src/commands/parse.ts` — `/queue` is parsed by the existing `parseCommand`, which is allowlist-free (parses any `/word` token). No registration needed.
- Media handlers (`message:photo`, `message:document`, `message:voice`) — keep `schedulePrompt` unconditionally.
- `src/subagents/` — main-agent-only change.
