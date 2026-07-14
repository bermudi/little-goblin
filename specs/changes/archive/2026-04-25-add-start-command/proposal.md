## Motivation

Telegram users expect `/start` to be every bot's entry point. Currently, `registerCommands` wires only `/ping` and `/new`. When a user sends `/start`, grammy's command handler does not match it, so it falls through to the `message:text` handler. There, if the user is in a DM without an active session, the message is silently dropped with a debug log. This is a poor first-contact experience — the bot appears unresponsive.

## Scope

- **Add a `/start` command handler** (`src/commands/start.ts`) with behavior:
  - In a **private chat (DM)**: creates a new session via `SessionManager` (same as `/new`) and replies with a welcome message that includes the session ID.
  - In a **forum topic**: replies that the topic is already its own session and the user can just start typing.
  - In a **plain group (non-forum)**: replies that the bot works in DMs or forum topics, and `/start` is not needed there.
- **Register the handler** in `src/commands/mod.ts` alongside `/ping` and `/new`.
- **Reuse existing patterns**: follow the `buildNewHandler` pattern for chat-type discrimination and reply-thread handling.

## Non-Goals

- Do not change `/new` behavior or merge `/start` and `/new` into a single handler. They remain separate commands with distinct semantics (`/start` is the entry point, `/new` explicitly orphans and resets).
- Do not add bot-level command descriptions (`setMyCommands`) or menu UI.
- Do not change the `message:text` fall-through behavior for non-command text.
