## Phase 1: Voice command module

Create `src/commands/voice.ts` with `readLastAssistantMessage` and `executeVoice`. This phase delivers the command's core logic as an importable module, testable in isolation without Telegram or Edge TTS dependencies.

- [ ] Create `src/commands/voice.ts` exporting `readLastAssistantMessage(home: string, sessionId: string): string | null`
  - Read `$GOBLIN_HOME/sessions/<sessionId>/transcript.jsonl` line-by-line from end
  - Find most recent `role: "assistant"` entry
  - Extract text: string content passes through; array-of-blocks concatenates `type: "text"` entries; non-text blocks (thinking, toolCall, image) are skipped
  - Return `null` if no assistant entry or file missing (ENOENT → null)
  - Implements: **Voice command converts last assistant message to speech** (read/extract portion)
- [ ] Create `src/commands/voice.test.ts`
  - Test with transcript.jsonl containing one assistant message → returns text
  - Test with multiple messages → returns most recent assistant, skips user/toolResult
  - Test with array-of-blocks content → concatenates text blocks, skips non-text
  - Test with no file → returns null
  - Test with no assistant entries → returns null
- [ ] Export `executeVoice` function accepting `{ home, sessionId, voiceName, locator, ctx, msgCtx }` returning `{ kind, error? }`
  - Delegates text extraction to `readLastAssistantMessage`
  - Spawns `uvx edge-tts --text <content> --voice <voiceName> --write-media <tmpPath>` with 30s timeout
  - On failure: returns `{ kind: "tts-failed", error: "<reason>" }`
  - On success: constructs synthetic prompt, wraps MessageBuffer for cleanup, calls `runner.prompt`
  - Implements: **Voice command converts last assistant message to speech** (full flow), **Voice command uses configurable Edge TTS voice**, **Voice command cleans up temporary audio files**, **Voice command dispatches synthetic prompt through normal agent routing**
- [ ] Verify: `bun test src/commands/voice.test.ts` passes

## Phase 2: Wire /voice and /v into command dispatch

Register `/voice` and `/v` as cancel-capable commands in `bot.ts` and update the help text. The command routes to `executeVoice` from Phase 1.

- [ ] In `src/bot.ts`, add `"/voice"` and `"/v"` to `CANCEL_CAPABLE_COMMANDS`
  - Implements: **Cancel cascades to all live subagents** (voice in the set), **Commands use interrupt semantics not queue** (voice in the set)
- [ ] In `src/bot.ts`, add `import { executeVoice } from "./commands/voice.ts"`
- [ ] In `src/bot.ts`, add switch cases for `/voice` and `/v` before `default:`:
  - Null session → reply "No active session. Use /new to start one." and return
  - Call `executeVoice` with session id, voice name, locator, ctx, msgCtx
  - Handle result kinds: `no-messages`, `tts-failed`, `sent`
  - On `sent`, return (runner.prompt already dispatched the turn)
  - Implements: **Voice command converts last assistant message to speech** (wiring), **Shorthand /v alias**
- [ ] In `src/commands/help.ts`, add `/voice` to the HELP_REPLY command list
  - Implements: **Help command lists available commands** (voice added)
- [ ] Run existing integration test: `bun test src/commands/integration.test.ts` — ensure no regressions from new CANCEL_CAPABLE_COMMANDS entries
- [ ] Verify: `bun run src/index.ts` starts without import errors

## Phase 3: Edge TTS end-to-end verification

Smoke test the full flow with real Edge TTS subprocess. This phase doesn't add new source code — it verifies Phase 1–2 behavior against the real `edge-tts` binary.

- [ ] Verify `uvx edge-tts` is callable from the bot's environment
- [ ] Manual test: send `/voice` in a chat with an active session that has at least one completed assistant response
  - Edge TTS generates MP3 at expected bitrate (48kbps, 24kHz, mono)
  - `send_voice` delivers the file to the chat
  - Temp file is gone after `onAgentEnd`
- [ ] Manual test: send `/voice` in a session with no assistant messages → "No messages to voice yet."
- [ ] Manual test: send `/v` (alias) → behaves identically to `/voice`
- [ ] Manual test: send `/voice` while agent is streaming → stream aborted, last completed message voiced
- [ ] Manual test: set `VOICE_NAME=en-US-AndrewMultilingualNeural` → male voice used for synthesis
