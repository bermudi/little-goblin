## Architecture

The `/voice` command flows through the existing command dispatch in `bot.ts`'s `message:text` handler. It is added to `CANCEL_CAPABLE_COMMANDS` so `interruptAndCascade` runs before the handler, ensuring a clean transcript to read from.

Unlike most commands that reply with static text and `return`, `/voice` calls `runner.prompt(syntheticPrompt, wrappedBuffer)` directly within its switch case. This dispatches the voice-delivery instruction as a normal turn — the model sees the prompt, calls `send_voice`, and the MessageBuffer renders the result.

```
/voice received
  → parseCommand → "/voice"
  → CANCEL_CAPABLE → interruptAndCascade (if streaming)
  → switch case "/voice":
      → readLastAssistantMessage(sessionId) from transcript.jsonl
      → spawnSync("uvx", ["edge-tts", "--text", ..., "--write-media", tmpPath])
      → build wrapped MessageBuffer (onAgentEnd cleans up tmpPath)
      → runner.prompt("User requested voice output. Audio at <tmpPath>. Use send_voice...")
      → return
```

The model never sees or handles the Edge TTS call. It receives a resolved file path and the existing `send_voice` tool it already knows.

## Decisions

### Edge TTS as subprocess, not ported to TypeScript

**Chosen:** Call `uvx edge-tts` CLI as a child process.

**Why:** The Python `edge-tts` package is the reference implementation (10k+ stars), handles DRM token generation, connection management, and text chunking. Porting the WebSocket protocol to TypeScript would be ~200-300 lines with ongoing maintenance risk when Microsoft updates the Edge Chromium version. `uvx` auto-installs the package on first use — zero project deps.

**Constraint:** Requires Python + uvx on the host. Already satisfied in this homelab environment.

### Direct runner.prompt call over ctx.msg mutation

**Chosen:** `/voice` calls `runner.prompt(syntheticPrompt, buffer)` directly within the command's switch case, duplicating ~8 lines of buffer setup.

**Rejected alternative:** Mutating `ctx.msg.text` to the synthetic prompt and falling through to normal agent routing. This is fragile — it mutates a shared object and couples the command handler to the routing code's control flow assumptions.

**Trade-off:** ~8 lines of duplicated buffer setup (chatId, topicId, visibility, onTopicNotFound) in exchange for an explicit, self-contained handler. If buffer setup grows, extract a helper; today it's small enough to duplicate.

### Temp file cleanup via wrapped MessageBuffer

**Chosen:** Wrap the MessageBuffer passed to `runner.prompt` so `onAgentEnd` deletes the temp MP3 file. This hooks into the existing turn lifecycle without modifying `send_voice` or adding a scheduled cleanup.

**Why:** `runner.prompt()` resolves when the turn is dispatched, not when it completes. The `send_voice` tool runs later during the turn. By wrapping `onAgentEnd`, cleanup fires after `send_voice` has read the file. If the turn never completes (e.g. error), the file remains in `/tmp` until OS reboot — acceptable for a homelab bot.

### VOICE_NAME via process.env, not config file

**Chosen:** Read `process.env.VOICE_NAME` directly in the command handler, defaulting to `en-US-EmmaMultilingualNeural`.

**Why:** This is an operational concern (which Edge voice to use), not a project concern (which model, which API keys). Adding it to the config schema would bloat `goblin.json5` for a field changed once. Can be promoted to the config file later if per-session voice preference lands.

## File Changes

### `src/commands/voice.ts` (new)

New module exporting `readLastAssistantMessage(home: string, sessionId: string): string | null` and `executeVoice(opts): Promise<VoiceResult>`.

**`readLastAssistantMessage`:**
- Reads `$GOBLIN_HOME/sessions/<sessionId>/transcript.jsonl` backwards (line by line from end)
- Finds the most recent `role: "assistant"` entry
- Extracts text: if `content` is a string, returns it; if `content` is an array, concatenates `text`-typed blocks; skips non-text block types (thinking, toolCall, image)
- Returns `null` if no assistant message found or file doesn't exist

**`executeVoice`:**
- Accepts `{ home, sessionId, voiceName, runner, locator, ctx, msgCtx }` where `msgCtx` bundles `{ bot, memoryStore, cfg, getOrCreateRunner }` needed to set up the runner + buffer
- Calls `readLastAssistantMessage`, spawns `uvx edge-tts`, builds the synthetic prompt, wraps the buffer for cleanup, and calls `runner.prompt`
- Returns a result discriminated union: `{ kind: "sent" }`, `{ kind: "no-session" }`, `{ kind: "no-messages" }`, `{ kind: "tts-failed", error: string }`

Implements spec requirements:
- **Voice command converts last assistant message to speech** — core logic
- **Voice command uses configurable Edge TTS voice** — reads `process.env.VOICE_NAME`
- **Voice command cleans up temporary audio files** — wrapped buffer cleanup
- **Voice command dispatches synthetic prompt through normal agent routing** — calls `runner.prompt`

### `src/bot.ts` (modified)

1. Add `"/voice"` and `"/v"` to `CANCEL_CAPABLE_COMMANDS` (line ~39)
2. Add `import { executeVoice } from "./commands/voice.ts"` 
3. Add switch cases before `default:`:

```typescript
case "/voice":
case "/v": {
  let voiceResult;
  try {
    voiceResult = await executeVoice({
      home: cfg.goblinHome,
      sessionId: session?.id ?? null,
      voiceName: process.env.VOICE_NAME ?? "en-US-EmmaMultilingualNeural",
      locator,
      ctx,
      msgCtx: { bot, memoryStore, cfg, getOrCreateRunner },
    });
  } catch (err) {
    log.error("voice failed", { error: String(err), sessionId: session?.id });
    await ctx.reply("Voice generation failed.");
    return;
  }
  switch (voiceResult.kind) {
    case "no-session":
      await ctx.reply("No active session. Use /new to start one.");
      return;
    case "no-messages":
      await ctx.reply("No messages to voice yet.");
      return;
    case "tts-failed":
      await ctx.reply(`Voice generation failed: ${voiceResult.error}`);
      return;
    case "sent":
      // runner.prompt already dispatched; nothing to reply
      return;
  }
}
```

Implements spec requirements:
- **Cancel cascades to all live subagents** — `/voice` and `/v` already in CANCEL_CAPABLE_COMMANDS
- **Commands use interrupt semantics not queue** — same

### `src/commands/help.ts` (modified)

Add `/voice` to the `HELP_REPLY` constant's command list.

Implements spec requirement: **Help command lists available commands** (MODIFIED)

### No changes to

- `src/tg/tools.ts` — `send_voice` works as-is
- `src/agent/` — no new imports or dependencies
- `src/config.ts` — `VOICE_NAME` is read from `process.env`, not the config schema
- `specs/canon/beta-tools/` — send_voice unchanged
