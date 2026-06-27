## Phase 1: Shared Edge TTS utility

Create `src/voice.ts` with the shared `edgeTts()` function. This phase delivers the TTS plumbing that both the command and tool will use. No Telegram or agent integration yet.

- [x] Create `src/voice.ts` exporting:
  - `resolveVoiceName(): string` → single source of truth: `process.env.VOICE_NAME ?? "en-US-EmmaMultilingualNeural"`
  - `voiceTmpPath(): string` → `join(os.tmpdir(), "goblin-voice-" + crypto.randomUUID() + ".mp3")`
  - `edgeTts(text: string, voice: string, outputPath: string): Promise<void>` — writes text to a temp file via `writeFile` from `node:fs/promises`, spawns `uvx edge-tts --file <tmpTextPath> --voice <voice> --write-media <outputPath>` with 30s timeout, deletes temp text file via `unlink` from `node:fs/promises`, throws on non-zero exit. Uses `--file` (not `--text`) to avoid shell escaping and argument-length issues.
  - `assertEdgeTtsAvailable(): Promise<void>` — runs `uvx edge-tts --version` with 10s timeout, throws on failure
- [x] Create `src/voice.test.ts`
  - Unit test: `resolveVoiceName` with and without `VOICE_NAME` set
  - Unit test: `voiceTmpPath` produces unique paths in tmpdir
  - Integration test: `edgeTts` with real `uvx edge-tts` call → produces valid MP3 at outputPath
  - Integration test: `edgeTts` with invalid voice → throws, error includes stderr
  - Unit test: `assertEdgeTtsAvailable` → resolves (assumes edge-tts installed)
  - Unit test: `assertEdgeTtsAvailable` with mocked failed spawn → throws
- [x] Verify: `bun test src/voice.test.ts` passes

## Phase 2: text_to_speech β-tool

Create the `text_to_speech` tool factory. The tool is wired into `bot.ts` in Phase 4 via `getBetaTools()`. This phase builds and tests the tool factory in isolation.

- [x] In `src/tg/tools.ts`, add `createTextToSpeechTool(opts?: { voiceName?: string }): ToolDefinition` factory:
  - Tool name: `"text_to_speech"`, label: `"Text to Speech"`
  - Description: `"Convert text to speech using Microsoft Edge TTS. Returns the path to the generated MP3 file. Chain with send_voice to deliver."`
  - Parameters: `text` (Type.Optional(Type.String())) and `file` (Type.Optional(Type.String())) — at least one required, validated in handler. If both provided, `text` takes precedence.
  - Handler: if neither provided → `{ ok: false, error: "either text or file is required" }`; if `file` provided (and `text` absent), read file contents via `readFile` from `node:fs/promises`; call `edgeTts()` from `src/voice.ts`; return `{ ok: true, audioPath }` or `{ ok: false, error }`
  - Uses `resolveVoiceName()` and `voiceTmpPath()` from `src/voice.ts`; if `opts.voiceName` provided, uses it instead of `resolveVoiceName()`
- [x] In `src/tg/tools.ts`, add `"text_to_speech"` to `VISIBILITY_TOOLS.standard` array
- [x] In `src/tg/mod.ts`, re-export `createTextToSpeechTool`
- [x] Create `src/tg/tools.test.ts` (or add to existing):
  - Test: tool called with `{ text: "hello" }` → returns `{ ok: true, audioPath }`
  - Test: tool called with `{ file: "/valid/path" }` → reads file, returns audioPath
  - Test: tool called with `{ file: "/nonexistent" }` → returns `{ ok: false, error }`
  - Test: tool called with `{}` → returns `{ ok: false, error: "either text or file is required" }`
  - Test: tool called with both `text` and `file` → `text` wins (precedence)
  - Test: tool created with `{ voiceName: "test-voice" }` → uses override
- [x] Verify: `bun test src/tg/tools.test.ts` passes

Implements spec requirements:
- **Text-to-speech tool generates voice from text**
- **Text-to-speech tool uses configurable voice**
- **Text-to-speech tool appears in the MessageBuffer status line**
- **Text-to-speech tool factory signature matches existing pattern**

## Phase 3: /voice command module

Create `src/commands/voice.ts` with `readLastAssistantMessage` and `executeVoice`. The `/voice` command uses the shared `edgeTts()` utility from Phase 1.

- [x] Create `src/commands/voice.ts` exporting:
  - `readLastAssistantMessage(home: string, sessionId: string): string | null` — reads transcript.jsonl backwards, finds last assistant entry, extracts text from string or array-of-blocks (skipping non-text types; returns null if all blocks are non-text)
  - `executeVoice(opts): Promise<VoiceResult>` — orchestrates read → `edgeTts()` → `runner.prompt(syntheticPrompt, buffer)` with `onTurnEnd` cleanup
- [x] Create `src/commands/voice.test.ts`
  - Test `readLastAssistantMessage`: one assistant message → returns text
  - Test `readLastAssistantMessage`: multiple messages → most recent assistant, skips user/toolResult
  - Test `readLastAssistantMessage`: array-of-blocks content → concatenates text blocks, skips thinking/toolCall/image
  - Test `readLastAssistantMessage`: all blocks are non-text → returns null
  - Test `readLastAssistantMessage`: no file → returns null
  - Test `readLastAssistantMessage`: no assistant entries → returns null
- [x] Verify: `bun test src/commands/voice.test.ts` passes

Implements spec requirements:
- **Voice command converts last assistant message to speech** (read/extract portion)

## Phase 4: Wire everything into the bot

Register commands, wire the β-tool, add `onTurnEnd` to MessageBuffer, add startup check, and update help text.

- [x] In `src/tg/buffer.ts`, add optional `onTurnEnd?: () => void | Promise<void>` to `MessageBufferOptions`. In `MessageBuffer.onAgentEnd()`, call `this.onTurnEnd?.()` after final status and response flushes.
- [x] In `src/index.ts`, call `assertEdgeTtsAvailable()` before `bot.start()`. On failure, log via `log.warn` (not fatal — bot still works without voice).
- [x] In `src/bot.ts`, add `createTextToSpeechTool()` to `getBetaTools()` returned array — this is the single registration point, alongside all other β-tools
- [x] In `src/bot.ts`, import `{ executeVoice }` from `"./commands/voice.ts"` and `createTextToSpeechTool` from `"./tg/mod.ts"`
- [x] In `src/bot.ts`, add `"/voice"` and `"/v"` to `CANCEL_CAPABLE_COMMANDS`
- [x] In `src/bot.ts`, add switch cases for `/voice` and `/v` before `default:`:
  - Null session → reply and return
  - Call `executeVoice`, handle result kinds (`no-messages`, `tts-failed`, `sent`)
  - On `tts-failed`, log via `log.warn` and reply with `"Voice generation failed: <error>"`
- [x] In `src/commands/help.ts`, add `/voice` to `HELP_REPLY` command list
- [x] Run `bun test src/commands/integration.test.ts` — no regressions from new CANCEL_CAPABLE_COMMANDS entries
- [x] Verify: `bun run src/index.ts` starts without import errors, model sees `text_to_speech` in tools

Implements spec requirements:
- **Voice command converts last assistant message to speech** (wiring)
- **Shorthand /v alias**
- **Help command lists available commands** (MODIFIED)
- **Cancel cascades to all live subagents** (voice in set)
- **Commands use interrupt semantics not queue** (voice in set)
- **AgentRunner includes text_to_speech in custom tools** (via getBetaTools)

## Phase 5: End-to-end verification

Smoke test both flows with real Edge TTS.

- [x] Verify `uvx edge-tts` is callable from the bot's environment
- [x] Manual: send `/voice` with prior assistant response → voice message delivered, temp file cleaned via `onTurnEnd`
- [x] Manual: send `/v` → behaves identically to `/voice`
- [ ] Manual: send `/voice` while agent is streaming → stream aborted, last completed message voiced
- [ ] Manual: set `VOICE_NAME=en-US-AndrewMultilingualNeural` → male voice
- [ ] Manual: ask model "convert the project README to a voice message" → model calls text_to_speech + send_voice
- [ ] Manual: ask model "voice your response to me" → model generates response text, calls text_to_speech + send_voice
- [ ] Manual: kill `uvx` or use invalid voice name → graceful error reply, no crash
- [ ] Manual: unset `VOICE_NAME` and restart → default voice works, startup check passes
- [ ] Manual: set `VOICE_NAME=invalid-voice` → startup check warns, `/voice` fails gracefully with error from edge-tts
