# Session Commands & Cancel — Design

## Architecture

Commands are handled in `src/bot.ts` message handler, before routing to `AgentRunner`. Interrupt semantics mean: cancel first, then execute command logic.

```
Telegram message received
        │
        ▼
┌─────────────────┐
│ Command parser  │
│ (starts with /) │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────┐
│ Interrupt check:              │
│ If /cancel /new /archive    │
│ /debug: call runner.abort() │
│ (await idle)                │
└────────┬────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Execute command logic         │
│ • /cancel: reply "Cancelled"│
│ • /new: SessionManager.create │
│ • /archive: move to archive │
│ • /debug: dump diagnostics  │
│ • /subagents: list          │
│ • /cancel_subagent: abort   │
│ • /revive: load + prompt    │
└────────┬────────────────────┘
         │
         ▼
    Reply to user
```

## Decisions

### Interrupt semantics (cancel-then-act)

**Chosen:** `/new`, `/archive`, `/debug` immediately abort any active stream before executing.

**Why:** User intent is clear — if I say "/new", I want a fresh session NOW, not after goblin finishes a 30-second bash script. This is simpler than a command queue and matches user expectations.

**Alternative rejected:** Queue commands until idle. Would frustrate users who want immediate control.

### Separate cancel for subagents

**Chosen:** `/cancel` affects main goblin only. Subagents have `/cancel_subagent <id>`.

**Why:** Main agent and subagents are independent processes. Killing subagents when the user just wants to stop goblin's current response would be surprising. Explicit control over each entity is clearer.

**Cascade cancel deferred:** v1.1 will add a flag or separate command to kill goblin + all its subagents.

### Command parsing at bot layer

**Chosen:** Commands are detected and parsed in `src/bot.ts`, not in `AgentRunner` or as pi extension commands.

**Why:** Commands affect session state (archiving, new sessions) which the Telegram layer owns. Pi extensions require the agent to be running; these commands must work even when the agent is busy/crashed.

### Diagnostics in /debug

**Chosen:** `/debug` outputs: current model, active tools, loaded skills, events.jsonl path, session stats (context usage if available), recent tool calls.

**Why:** When things feel slow or weird, users need visibility. This is a v1 debugging aid until we have better observability.

**Format:** Plain text, human-readable, not structured. Example:
```
Session: abc123
Model: claude-sonnet-4-20250514
Tools: bash, read, write, edit, send_voice
Skills loaded: 3 (homelab, git, web)
Events: ~/goblin/sessions/abc123/events.jsonl
Context: ~12k tokens used
```

### Subagent commands are surface-only in v1

**Chosen:** `/subagents`, `/cancel_subagent`, `/revive` are command handlers that delegate to `SubagentRunner` (implemented in `subagent-runtime` change).

**Why:** This change defines the command surface; implementation comes later. Keeps dependencies clean.

## File Changes

### Modified files

- **`src/bot.ts`** — Add command parsing and interrupt handling:
  ```typescript
  // In message handler, after session resolution
  if (ctx.message.text.startsWith('/')) {
    const command = ctx.message.text.split(' ')[0];
    
    // Interrupt semantics
    if (['/cancel', '/new', '/archive', '/debug'].includes(command)) {
      if (runner?.isStreaming) await runner.abort();
    }
    
    switch (command) {
      case '/cancel':
        await ctx.reply('Cancelled');
        return;
      case '/new':
        session = sessionManager.createForChat(locator);
        await ctx.reply(`New session: ${session.id}`);
        return;
      case '/archive':
        sessionManager.archive(session.id);
        await ctx.reply('Session archived');
        return;
      case '/debug':
        const diag = await generateDiagnostics(session, runner);
        await ctx.reply(diag);
        return;
      case '/subagents':
        // stub - implementation in subagent-runtime
        await ctx.reply('Not implemented');
        return;
      case '/cancel_subagent':
        // parse ID, delegate
        await ctx.reply('Not implemented'); // placeholder
        return;
      case '/revive':
        // parse ID, delegate
        await ctx.reply('Not implemented'); // placeholder
        return;
    }
  }
  ```
  - Covers: all command routing and interrupt semantics.

- **`src/commands/*.ts`** — May add formal command handlers in `src/commands/cancel.ts`, `new.ts`, etc., registered in `mod.ts`.
  - Alternative: keep inline in `bot.ts` for v1 simplicity.

### New files

- **`src/diagnostics.ts`** — Helper to gather debug info:
  - Current session state
  - Active runner state (model, tools)
  - Loaded skills list
  - Events.jsonl stats (line count, size)
  - Returns formatted string for `/debug`.

### Not touched

- `src/agent/` — no changes; abort is already implemented.
- `src/sessions/` — archive method exists (verify); no new behavior.

## State diagram

```
User sends /new while streaming
        │
        ▼
┌───────────────┐
│ Detect /new   │
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ runner.abort()│
│ await idle    │
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ createForChat │
│ (new session) │
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ Reply "New..."│
└───────────────┘
```

Note: We rely on pi's abort() being reliable. No timeout fallback per non-goals.
