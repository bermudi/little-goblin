## Architecture

Two entry points share a single Edge TTS utility:

```
                      ┌─────────────────────┐
                      │   src/voice.ts       │
                      │   edgeTts(text,      │
                      │     voice, outPath)  │
                      └──────┬──────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼────────┐  ┌──▼───────────┐
     │  /voice command  │  │ text_to_speech│
     │  (user shortcut) │  │  β-tool       │
     │                  │  │ (model-driven)│
     └────────┬─────────┘  └──┬───────────┘
              │               │
              │  returns audioPath
              │               │
              └───────┬───────┘
                      │ model chains with:
              ┌───────▼────────┐
              │   send_voice   │
              │   β-tool       │
              │ (already exists)│
              └────────────────┘
```

**`/voice` command flow** (user shortcut):
```
/voice → interrupt → readLastAssistantMessage(transcript.jsonl)
       → edgeTts(text, voice, tmpPath)
       → runner.prompt("Use send_voice to send audio at <tmpPath>...")
       → model calls send_voice → delivered
       → onAgentEnd → cleanup tmpPath
```

**`text_to_speech` tool flow** (model-driven):
```
model calls text_to_speech({ text: "..." })
       → edgeTts(text, voice, tmpPath)
       → returns { ok: true, audioPath: tmpPath }
model calls send_voice({ voiceFile: tmpPath, caption: "..." })
       → delivered
```

Both `/voice` and all command cases use the same `getOrCreateRunner` + MessageBuffer setup already in `bot.ts`. The `/voice` calls `runner.prompt()` directly (not text mutation) — see decisions.

## Decisions

### Edge TTS as subprocess, not ported to TypeScript

**Chosen:** Call `uvx edge-tts` CLI as a child process.

**Why:** The Python `edge-tts` package is the reference implementation (10k+ stars), handles DRM token generation, connection management, and text chunking. Porting the WebSocket protocol to TypeScript would be ~200-300 lines with ongoing maintenance risk when Microsoft updates the Edge Chromium version. `uvx` auto-installs the package on first use — zero project deps.

**Constraint:** Requires Python + uvx on the host. Already satisfied in this homelab environment.

### Shared edgeTts utility

**Chosen:** Extract `edgeTts(text: string, voice: string, outputPath: string): Promise<void>` into `src/voice.ts`, used by both the `/voice` command handler and the `text_to_speech` β-tool.

**Why:** Two callers, one codepath. Prevents drift between the command and tool implementations. Makes testing straightforward — mock the utility, test callers independently.

### Tool composability: text_to_speech + send_voice, not a combined tool

**Chosen:** `text_to_speech` generates the audio file and returns its path. The model must call `send_voice` separately to deliver it.

**Rejected alternative:** A single `voice_text` tool that does TTS + send in one call. This would bundle delivery logic into the TTS tool, preventing the model from captioning, choosing when to send, or generating multiple files before sending.

**Trade-off:** The model needs two tool calls per voice message. In practice this adds ~1 second of latency (tool round-trips are fast). The composability is worth it — the model can generate voice, decide on a caption, or batch-convert multiple texts before sending.

### Direct runner.prompt call over ctx.msg mutation

**Chosen:** `/voice` calls `runner.prompt(syntheticPrompt, buffer)` directly within the command's switch case, duplicating ~8 lines of buffer setup.

**Rejected alternative:** Mutating `ctx.msg.text` to the synthetic prompt and falling through to normal agent routing. This is fragile — it mutates a shared object and couples the command handler to the routing code's control flow assumptions.

**Trade-off:** ~8 lines of duplicated buffer setup (chatId, topicId, visibility, onTopicNotFound) in exchange for an explicit, self-contained handler. If buffer setup grows, extract a helper; today it's small enough to duplicate.

### Temp file cleanup via MessageBuffer onTurnEnd callback

**Chosen:** Add an optional `onTurnEnd?: () => void | Promise<void>` field to `MessageBufferOptions`. The `/voice` command passes a cleanup callback that deletes the temp MP3 file. `MessageBuffer.onAgentEnd()` calls this callback after its own finalization logic.

**Why:** `runner.prompt()` resolves when the turn is dispatched, not when it completes. The `send_voice` tool runs later during the turn. By hooking into the `onTurnEnd` callback (called from `onAgentEnd`), cleanup fires after `send_voice` has read the file. This is a 3-line addition to MessageBufferOptions and avoids wrapper objects that delegate 5 methods.

If the turn never completes (e.g. error), the file remains in `/tmp` until OS reboot — acceptable for a homelab bot.

**For `text_to_speech` tool:** No automatic cleanup. The model generates audio, calls `send_voice`, and the file persists in `/tmp`. Since the tool is model-driven, the model may generate a file and never send it, or send it much later. OS tmp cleanup is sufficient; the files are small (tens of KB).

### VOICE_NAME via process.env, not config file

**Chosen:** Read `process.env.VOICE_NAME` directly, defaulting to `en-US-EmmaMultilingualNeural`.

**Why:** This is an operational concern (which Edge voice to use), not a project concern (which model, which API keys). Adding it to the config schema would bloat `goblin.json5` for a field changed once. Can be promoted to the config file later if per-session voice preference lands.

## File Changes

### `src/voice.ts` (new)

Shared Edge TTS utility. Exports:

- `edgeTts(text: string, voice: string, outputPath: string): Promise<void>` — writes text to a temp file via `writeFile` from `node:fs/promises`, spawns `uvx edge-tts --file <tmpTextPath> --voice <voice> --write-media <outputPath>` with a 30s timeout, deletes the temp text file via `unlink` (from `node:fs/promises`), throws on non-zero exit code (error includes stderr).
- `resolveVoiceName(): string` → single source of truth for the default voice: `process.env.VOICE_NAME ?? "en-US-EmmaMultilingualNeural"`
- `voiceTmpPath(): string` → `join(tmpdir(), "goblin-voice-" + randomUUID() + ".mp3")` using `randomUUID` from `node:crypto`
- `assertEdgeTtsAvailable(): Promise<void>` — runs `uvx edge-tts --version` with a 10s timeout. Throws if the command fails. Called once at startup from `src/index.ts`.

Used by both the /voice command and text_to_speech tool.

### `src/tg/tools.ts` (modified)

Add `createTextToSpeechTool(opts?: { voiceName?: string }): ToolDefinition` factory:

- Tool name: `"text_to_speech"`
- Parameters: `text` (string, optional) and `file` (string, optional) — at least one required, validated in handler. If both provided, `text` takes precedence.
- Handler validates inputs, reads file if `file` provided (and `text` absent) via `readFile` from `node:fs/promises`, calls `edgeTts()`, returns `{ ok: true, audioPath }` or `{ ok: false, error }`. On validation failure (neither param), returns `{ ok: false, error: "either text or file is required" }`.
- No Telegram context parameters (no chatId, topicId, messageId) — the tool has no Telegram side effects
- When `opts.voiceName` provided, it overrides `resolveVoiceName()` — used for testing

Also add `"text_to_speech"` to the `VISIBILITY_TOOLS.standard` array so it appears in the status line.

Implements spec requirements:
- **Text-to-speech tool generates voice from text**
- **Text-to-speech tool uses configurable voice**
- **Text-to-speech tool appears in the MessageBuffer status line**
- **Text-to-speech tool factory signature matches existing pattern**

### `src/tg/mod.ts` (modified)

Export `createTextToSpeechTool` from the tg barrel so `bot.ts` can import it.

### `src/bot.ts` (modified)

1. Add `"/voice"` and `"/v"` to `CANCEL_CAPABLE_COMMANDS` (line ~39)
2. Import `executeVoice` from `./commands/voice.ts` and `createTextToSpeechTool` from `./tg/mod.ts`
3. In `getBetaTools()`, add `createTextToSpeechTool()` to the returned array — this is the **single** registration point for the tool, alongside all other β-tools. It reaches the model via `AgentRunnerOptions.customTools` → `init()`.
4. Add switch cases for `/voice` and `/v` before `default:`:

```typescript
case "/voice":
case "/v": {
  if (!session) {
    await ctx.reply("No active session. Use /new to start one.");
    return;
  }
  let voiceResult;
  try {
    voiceResult = await executeVoice({
      home: cfg.goblinHome,
      sessionId: session.id,
      locator,
      ctx,
      msgCtx: { bot, memoryStore, cfg, getOrCreateRunner },
    });
  } catch (err) {
    log.error("voice failed", { error: String(err), sessionId: session.id });
    await ctx.reply(`Voice generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  switch (voiceResult.kind) {
    case "no-messages":
      await ctx.reply("No messages to voice yet.");
      return;
    case "tts-failed":
      await ctx.reply(`Voice generation failed: ${voiceResult.error}`);
      log.warn("voice TTS failed", { error: voiceResult.error, sessionId: session.id });
      return;
    case "sent":
      return; // runner.prompt already dispatched
  }
}
```

Implements spec requirements:
- **Cancel cascades to all live subagents** — `/voice` and `/v` in CANCEL_CAPABLE_COMMANDS
- **Commands use interrupt semantics not queue** — same
- **AgentRunner includes text_to_speech in custom tools** — via getBetaTools

### `src/tg/buffer.ts` (modified)

Add optional `onTurnEnd?: () => void | Promise<void>` to `MessageBufferOptions`. In `MessageBuffer.onAgentEnd()`, call `this.onTurnEnd?.()` after the final status and response flushes but before returning.

This enables the `/voice` command to schedule temp-file cleanup without wrapping the entire MessageBuffer object.

### `src/commands/voice.ts` (new)

New module exporting `readLastAssistantMessage` and `executeVoice`.

**`readLastAssistantMessage(home: string, sessionId: string): string | null`:**
- Reads `$GOBLIN_HOME/sessions/<sessionId>/transcript.jsonl` backwards (line by line from end)
- Finds the most recent `role: "assistant"` entry
- Extracts text: if `content` is a string, returns it; if `content` is an array, concatenates `text`-typed blocks; skips non-text block types (thinking, toolCall, image)
- Returns `null` if no assistant message found or file doesn't exist

**`executeVoice(opts): Promise<VoiceResult>`:**
- Accepts `{ home, sessionId, locator, ctx, msgCtx }` where `msgCtx` bundles `{ bot, memoryStore, cfg, getOrCreateRunner }`
- Calls `readLastAssistantMessage`, then `edgeTts()` from `src/voice.ts`
- Builds the synthetic prompt: `"Audio for your last response is at \`<path>\`. Use send_voice to send it to the user. Do not repeat or describe the content — the audio IS the message."`
- Passes `onTurnEnd: () => unlink(tmpPath)` in MessageBufferOptions for cleanup after the turn completes
- Returns `{ kind: "sent" | "no-messages" | "tts-failed", error?: string }`

Implements spec requirements:
- **Voice command converts last assistant message to speech**
- **Voice command dispatches synthetic prompt through normal agent routing**
- **Voice command cleans up temporary audio files**

### `src/commands/help.ts` (modified)

Add `/voice` to the `HELP_REPLY` constant's command list.

Implements spec requirement: **Help command lists available commands** (MODIFIED)

### `src/index.ts` (modified)

Add `assertEdgeTtsAvailable()` call during startup, before `bot.start()`. If the check fails, log a warning (not fatal — the bot can still operate without voice). This surfaces misconfiguration early rather than failing silently on first `/voice`.

### No changes to

- `src/tg/tools.ts` `send_voice` — works as-is
- `src/tg/tools.ts` other β-tools — unchanged
- `src/config.ts` — `VOICE_NAME` is read from `process.env`, not the config schema
- `specs/canon/beta-tools/` send_voice spec — unchanged; text_to_speech is a new, separate tool
