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

### Cascade cancel is the default

**Chosen:** `/cancel`, `/new`, `/archive` kill the main agent **and** all live subagents. `/cancel_subagent <id>` remains available for surgical cancel of a single subagent without killing the parent.

**Why:** User mental model for "cancel" is *stop everything*. Leaving subagents alive after the parent dies means orphan processes still consuming tokens and potentially writing to shared state (memory, events) — which is the actually surprising outcome. Cascade is a simple loop over the live subagent list via `SubagentRunner.list().filter(s => s.status === "running")`, not architectural complexity.

**Selective cancel is not in scope** but could be added later as `/cancel --main` if a use case emerges.

### Command parsing at bot layer

**Chosen:** Commands are detected and parsed in `src/bot.ts` `bot.on("message:text")` handler, replacing the existing `bot.command()` registrations from `src/commands/mod.ts`.

**Why:** Commands affect session state (archiving, new sessions) which the Telegram layer owns. Pi extensions require the agent to be running; these commands must work even when the agent is busy/crashed. grammy's `bot.command()` middleware fires before `bot.on("message:text")`, so keeping both would cause double-handling — the text handler would never see `/new` because `bot.command("new")` already consumed it.

**Migration:** Remove `/new` from `registerCommands()` in `src/commands/mod.ts`. The text handler in `bot.ts` becomes the single command router. `bot.command("ping")` and `bot.command("start")` remain in `mod.ts` since they have no interrupt semantics and don't conflict.

### Diagnostics in /debug

**Chosen:** `/debug` outputs: current model, active tools, loaded skills (if discoverable), events.jsonl path, session stats (context usage if available).

**Why:** When things feel slow or weird, users need visibility. This is a v1 debugging aid until we have better observability. Some fields (loaded skills, context token count) may not be easily exposed by pi's `AgentSession` API — these are included on a best-effort basis. Missing fields are shown as "unavailable" rather than omitted.

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

  > **Note:** the code below is illustrative, not normative. The implemented
  > shape diverges in a few places: `AgentRunner` exposes a public
  > `isStreaming` getter (and a sticky `markAbortTimedOut()`) because
  > `session` is private; the cascade is factored into
  > `interruptAndCascade()` in `src/interrupt.ts` with per-target
  > timeouts, transitive session scoping via `spawnedBy`, and a
  > structured `CascadeResult` driving the /cancel reply text; and the
  > archive/new error paths use an outer try/catch around the
  > `executeNew`/`executeArchive` helpers rather than per-closure
  > sentinel variables.

  ```typescript
  // In bot.on("message:text") handler, BEFORE session resolution, after locator
  const text = ctx.msg?.text;
  if (text?.startsWith('/')) {
    const command = text.split(' ')[0];
    
    // Interrupt semantics: cancel-capable commands abort first
    if (['/cancel', '/new', '/archive', '/debug'].includes(command)) {
      try {
        if (runner?.isStreaming) await runner.abort();
      } catch (err) {
        log.error("abort failed during interrupt", { error: String(err) });
        // continue — command still executes even if abort fails
      }
      // Cascade: abort all live subagents in this session's tree
      const live = subagentRunner.list().filter(s => s.status === "running");
      await Promise.all(live.map(s => subagentRunner.cancel(s.id).catch(() => {})));
    }
    
    switch (command) {
      case '/cancel':
        await ctx.reply(runner?.isStreaming ? 'Cancelled.' : 'Nothing to cancel.');
        return;
      case '/new': {
        const isSupergroup = ctx.chat?.type === "supergroup";
        // topic case: already has a session
        if (locator.topicId !== undefined) {
          await ctx.reply('This topic is already its own session. No need for /new here.');
          return;
        }
        const newSession = manager.createForChat(locator, { isSupergroup });
        runners.set(newSession.id, new AgentRunner({ cfg, sessionId: newSession.id, customTools: [], subagentRunner }));
        await ctx.reply(`Created new session \`${newSession.id}\``);
        return;
      }
      case '/archive':
        if (!session) { await ctx.reply('No active session to archive.'); return; }
        const sessionDir = path.join(cfg.goblinHome, 'sessions', session.id);
        if (!existsSync(sessionDir)) { await ctx.reply('Session already archived.'); return; }
        manager.archive(session.id);
        if (locator.topicId !== undefined) {
          await bot.api.setForumTopicName(locator.chatId, locator.topicId, `Archived: ${session.id}`);
        }
        await ctx.reply('Session archived.');
        return;
      case '/debug':
        if (!session) { await ctx.reply('No active session.'); return; }
        const diag = await generateDiagnostics(session, runner, subagentRunner);
        await ctx.reply(diag);
        return;
      case '/subagents':
        await ctx.reply('Not implemented');
        return;
      case '/cancel_subagent':
        await ctx.reply('Not implemented');
        return;
      case '/revive':
        await ctx.reply('Not implemented');
        return;
      case '/help':
        await ctx.reply('Commands: /cancel /new /archive /debug /subagents /cancel_subagent /revive /help');
        return;
      default:
        // Unknown /command — fall through to normal agent routing
        break;
    }
  }
  ```
  - Covers: all command routing, interrupt semantics, cascade cancel.
  - **Important:** This replaces the existing `bot.command("new")` registration in `src/commands/mod.ts`.

- **`src/commands/mod.ts`** — Remove `bot.command("new")` registration; `/new` is now handled in `bot.ts` text handler. Keep `ping` and `start` registrations.
- **`src/commands/new.ts`** — File can be deleted or left as dead code; handler is now inline in `bot.ts`.

### New files

- **`src/diagnostics.ts`** — Helper to gather debug info:
  - Current session state
  - Active runner state (model, tools)
  - Loaded skills list
  - Events.jsonl stats (line count, size)
  - Returns formatted string for `/debug`.

### Not touched

- `src/agent/` — no changes; `abort()` and `isStreaming` are already implemented.
- `src/subagents/` — no changes; `list()`, `cancel()` are already implemented.
- `src/sessions/manager.ts` — add `archive(sessionId)` method (see below).

### New methods on existing files

- **`src/sessions/manager.ts`** — Add `archive(sessionId: string): void`:
  - Move `sessions/<id>/` to `sessions/archive/<id>/` via `renameSync`.
  - Remove the binding for this session from the chat's `config.json`.
  - Throw if source directory doesn't exist (already archived or unknown session).
  - Detection: if `sessions/<id>/` doesn't exist, the caller replies "Session already archived."

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
┌───────────────────────┐
│ try { runner.abort() } │
│ catch { log + continue}│
└───────┬───────────────┘
        │
        ▼
┌───────────────────────────────────┐
│ Cascade: abort all live subagents  │
│ via SubagentRunner.cancel(id)      │
└───────┬───────────────────────────┘
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

Note: `runner.abort()` is wrapped in try/catch — if abort fails, the command still executes but the failure is logged. We rely on pi's `abort()` being reliable; no timeout fallback per non-goals.
