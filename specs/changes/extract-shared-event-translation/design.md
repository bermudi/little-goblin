## Architecture

This is a pure extraction refactor — no new classes, no new modules, no behavioral changes. The change moves the duplicated event-to-callback translation out of two inline `switch` statements and into a single free function in the existing `src/agent/events.ts` module.

```
Before:
  AgentRunner.handleEvent(event)
    → appendEvent(event)
    → switch (event.type) { … inline callback dispatch … }

  SubagentRunner.handleEvent(instance, event, hooks)
    → switch (event.type) { … inline callback dispatch … }

After:
  AgentRunner.handleEvent(event)
    → appendEvent(event)
    → dispatchAgentEvent(event, this.callbacks)

  SubagentRunner.handleEvent(instance, event, hooks)
    → dispatchAgentEvent(event, adapter)  // adapter maps TurnCallbacks → hooks + onStatusUpdate

  dispatchAgentEvent(event, callbacks: TurnCallbacks)
    → switch (event.type) { … invokes typed callbacks … }
```

The `TurnCallbacks` interface moves from `src/agent/mod.ts` to `src/agent/events.ts` and is re-exported from `mod.ts` so `src/tg/buffer.ts` compiles without changes. The function has zero dependencies on Telegram, sessions, subagents, or memory — it is pure event → callback translation.

## Decisions

### 1. Function lives in `src/agent/events.ts`, not a new module

**Chosen:** Add `dispatchAgentEvent` and move `TurnCallbacks` into the existing `src/agent/events.ts`.

**Why:** `events.ts` already handles AgentSession event concerns (it exports `appendEvent` for event logging). Adding event dispatch is a natural co-location. A new module like `event-adapter.ts` would add a file for a single ~30-line function. Both reviews independently named `events.ts` as the right home.

**Constraint:** `src/agent/events.ts` currently imports only `node:fs` and `node:path`. It will gain imports for `AgentSessionEvent` from `@mariozechner/pi-coding-agent` and `TurnCallbacks` (now self-defined).

### 2. SubagentRunner constructs a local adapter, not a class

**Chosen:** `SubagentRunner.handleEvent()` builds a plain `TurnCallbacks` object literal per-event and passes it to `dispatchAgentEvent`.

**Why:** A one-shot adapter object is simpler than extracting a class or function. The adapter has no retained state; it's a pure mapping from typed callbacks to the subagent's `hooks` and `instance.onStatusUpdate`. Creating it fresh per-event is allocation-cheap (5 function closures) and avoids lifetime concerns.

**Alternative considered:** Extracting the adapter as a `createSubagentCallbacks(hooks, onStatusUpdate)` helper function. Rejected as over-engineering for 5 one-line mappings. The plain object literal is self-documenting at the call site.

### 3. AgentRunner's `accumulatedText` stays in `handleEvent`, not in `dispatchAgentEvent`

**Chosen:** AgentRunner's text accumulation (`this.accumulatedText += delta`) remains in `handleEvent`, separate from the `dispatchAgentEvent` call.

**Why:** `accumulatedText` is AgentRunner-specific state. `dispatchAgentEvent` is a pure function with no side effects beyond callback invocations. Pulling accumulation into the shared function would require a mutable accumulator parameter, breaking the function's purity for one consumer's convenience. The text_delta check is duplicated (once for accumulation, once for dispatch), but each check serves a different purpose and the duplication is two lines.

### 4. TurnCallbacks re-exported from `mod.ts`, not eagerly migrated

**Chosen:** `TurnCallbacks` is defined in `events.ts` and re-exported via `export { TurnCallbacks } from "./events.ts"` in `mod.ts`.

**Why:** `src/tg/buffer.ts` imports `TurnCallbacks` from `../agent/mod.ts`. A re-export avoids a coordinated change across the agent and Telegram modules. The re-export can be removed in a follow-up cleanup once all importers have been updated. This also minimizes the diff — `tg/buffer.ts` is untouched.

## File Changes

| Path | Change | Rationale |
|---|---|---|
| `src/agent/events.ts` | **Add** `TurnCallbacks` interface definition. **Add** `dispatchAgentEvent(event, callbacks)` function with the switch on event types. New imports: `type AgentSessionEvent` from pi. | Satisfies "Shared event dispatch function" and "TurnCallbacks interface defined in agent/events.ts" requirements. |
| `src/agent/mod.ts` | **Remove** `TurnCallbacks` interface definition (line 27–32). **Add** `import { TurnCallbacks, dispatchAgentEvent } from "./events.ts"`. **Add** `export { TurnCallbacks } from "./events.ts"`. **Replace** the inline `switch` body in `handleEvent` (lines 160–187) with a call to `dispatchAgentEvent(event, this.callbacks)`. The `appendEvent` call and the `if (!this.callbacks) return` guard stay above dispatch. Text accumulation (`this.accumulatedText += delta`) remains in `handleEvent` before the dispatch call. | Satisfies MODIFIED "AgentRunner exposes a TurnCallbacks interface" requirement. |
| `src/subagents/mod.ts` | **Add** `import { dispatchAgentEvent } from "../agent/events.ts"` and `import type { TurnCallbacks } from "../agent/events.ts"`. **Replace** the inline `switch` body in `handleEvent` (lines 381–408) with a local `TurnCallbacks` adapter object and a call to `dispatchAgentEvent(event, adapter)`. | Satisfies ADDED "SubagentRunner dispatches events through shared dispatchAgentEvent" requirement. |
| `src/tg/buffer.ts` | **No changes.** Continues to import `TurnCallbacks` from `../agent/mod.ts` via the re-export. | Import path update deferred; re-export handles backward compat. |

### handleEvent after extraction

**AgentRunner:**
```ts
private handleEvent(event: AgentSessionEvent): void {
  appendEvent(this.sessionId, this.cfg.goblinHome, event);
  if (!this.callbacks) return;

  // AgentRunner-specific text accumulation (not part of dispatch)
  if (event.type === "message_update") {
    const ame = event.assistantMessageEvent;
    if (ame.type === "text_delta") {
      this.accumulatedText += ame.delta;
    }
  }

  dispatchAgentEvent(event, this.callbacks);
}
```

**SubagentRunner:**
```ts
private handleEvent(
  instance: SubagentInstance,
  event: AgentSessionEvent,
  hooks: { onText, onEnd, onError },
): void {
  const adapter: TurnCallbacks = {
    onTextDelta: (delta) => hooks.onText(delta),
    onToolStart: (name) => instance.onStatusUpdate?.(`tool: ${name}`),
    onToolEnd: (name, isError) => instance.onStatusUpdate?.(
      isError ? `tool error: ${name}` : `tool ok: ${name}`
    ),
    onStatusUpdate: (msg) => instance.onStatusUpdate?.(msg),
    onAgentEnd: () => hooks.onEnd(),
  };
  dispatchAgentEvent(event, adapter);
}
```

### Test impact

No test changes required. The existing test suites for `agent/mod.test.ts`, `subagents/mod.test.ts`, and `tg/buffer.test.ts` assert callback invocation behavior, not the internal dispatch mechanism. The dispatch refactor preserves identical callback timing and arguments.
