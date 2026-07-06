# reply-formatting

## Motivation

Goblin sends every bot reply as plain text today. This has two problems:

1. **Agent markdown renders as literal characters.** The model emits `*bold*`, `` `code` ``, fenced code blocks, and links — but Telegram shows the raw syntax because no `parse_mode` is set on any send. A code block from the model appears as a wall of text with literal triple backticks.

2. **System messages are indistinguishable from agent replies.** Command results (`Project bound to /path`), error acks (`Failed to save file.`), queue acks (`Queued. Will run after this turn.`), and status notices all look the same as an agent's conversational reply. The only existing distinction is occasional emoji prefixes (`❌`, `⚠️`) on a few strings, which is inconsistent and insufficient.

## Scope

Three capabilities are affected: **message-buffer**, **commands**, and **telegram**.

### What changes

1. **Agent replies render markdown.** `MessageBuffer` adds `parse_mode: "MarkdownV2"` to `sendMessage` and `editMessageText` in the response path. On 400 parse error, the buffer strips markdown formatting and retries as plain text (same recovery pattern as Hermes' Telegram adapter). The status line is unaffected — it uses emoji slots that are already plain-text-safe.

2. **System messages get a monospaced tag prefix.** A new `src/tg/format.ts` module provides `systemReply(text, tag)` which wraps text as `` `[tag]` `` + escaped content, ready for MarkdownV2. Five tags cover all ~100 existing reply strings:
   - `[ok]` — success / confirmation (project bound, saved, switched, archived, cancelled, created, scheduled)
   - `[error]` — something broke (failed to save, download failed, command crashed)
   - `[warn]` — config issue / soft warning (ASR not configured, path doesn't exist, level not supported)
   - `[info]` — state feedback / usage / lists (no active session, usage text, schedule list, nothing to cancel)
   - `[queued]` — deferred behind a running turn

3. **System messages send silently.** All system replies use `disable_notification: true` so they don't ping the user's device. Agent replies notify normally.

4. **Existing `❌` emoji prefixes on message replies are stripped.** The `❌` prefix on `ModelNotCapableError` replies (2 occurrences in `intake.ts`) is removed — the `[error]` tag replaces it. Guest-mode inline query articles (`⏳`, `⚠️` in `article()` calls) are NOT touched — they use a different code path (`answerGuestQuery`, not `message.reply`).

5. **Command handlers tag their results.** `DispatchResult` gains an optional `tag` field (defaulting to `"ok"`). Commands that return errors set `tag: "error"`, warnings set `tag: "warn"`, usage info sets `tag: "info"`. The intake dispatch point calls `sendSystemReply(message, result.reply, result.tag)` instead of `message.reply(result.reply)`.

6. **Intake system replies are tagged at the call site.** The ~20 `message.reply(text)` calls in `intake.ts` (download failures, save confirmations, queue acks, ASR warnings) are replaced with `sendSystemReply(message, text, tag)` where the tag is determined by the surrounding context. Existing backticks in reply strings (e.g. `` Project bound to `${projectDir}` ``) are preserved — `escapeMdV2` leaves code-span content untouched, so paths and model names render in monospace.

7. **`/start` and `/ping` route through the same helper.** These use `ctx.reply` directly (grammy handler path). They get tagged as `[info]`.

### What does NOT change

- **Status line.** The `MessageBuffer` status line (🤔 thinking, 🔧 bash, ✅ read) keeps its current emoji-based format and plain-text sends. It's already visually distinct as its own message and is not a "system reply" in the same sense.
- **Streaming mechanism.** `MessageBuffer` continues using `sendMessage` + `editMessageText` (edit-in-place). No `sendMessageDraft` / stream plugin. Drafts are ephemeral 30-second previews that vanish after the turn, requiring a separate final send — worse UX than one persistent message that grows in place.
- **`recordAssistantReply`.** Logs the raw text, unaffected by formatting.
- **File escape.** The 20KB → `reply.md` attachment path is unchanged.
- **Rollover.** The 4096-char split logic is unchanged; chunks get MarkdownV2 parse mode with plain-text fallback.

## Non-Goals

- **No `@grammyjs/stream` plugin or `sendMessageDraft`.** Rejected because Telegram drafts are ephemeral 30-second previews; final delivery still requires a separate `sendMessage`, producing a flicker-then-pop-in UX for long agent turns. Edit-in-place keeps one persistent message.
- **No blockquotes or HTML parse mode.** Considered and rejected in favor of monospaced tag prefixes in MarkdownV2. Blockquotes would require HTML parse mode for system messages (mixed parse modes add complexity), and the tag prefix provides sufficient visual distinction.
- **No `EphemeralReply` / auto-delete.** Little-goblin is single-user; the thread history is useful context. Could add later if the chat gets noisy.
- **No i18n framework.** The tag set is small and hardcoded. Hermes' i18n layer is not warranted here.
- **No status line redesign.** The status line already has its own visual identity (emoji slots). It's out of scope for this change.
