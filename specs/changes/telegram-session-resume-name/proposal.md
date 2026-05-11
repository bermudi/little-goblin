# telegram-session-resume-name

## Motivation

pi has useful session management commands (`/resume`, `/name`) that let a user move between long-running conversations without losing context. Goblin already has Telegram-native `/new`, `/archive`, and `/compact`, but there is no Telegram surface to name a session or rebind a chat/topic back to an existing session.

That makes `/new` too one-way: old sessions remain on disk and can be listed internally, but the user cannot intentionally return to them from Telegram. Naming also matters because 10-character session IDs are useful for machines and miserable for humans.

## Scope

- **`/name <name>` command** in Telegram for naming the active session.
- **`/resume <id-or-name>` command** in Telegram for binding the current chat surface to an existing active session.
- **Session title persistence** via `SessionState.title`.
- **Existing-session binding** in `SessionManager` without archiving or deleting the previously bound session.
- **Help output** includes both commands.
- **Cancel-capable semantics**: both commands interrupt any active turn before changing session metadata/bindings.

## Non-Goals

- **No archived-session revival** — `/resume` only searches active session directories; archived sessions remain under `sessions/archive/`.
- **No fuzzy search** — matching is exact session ID, session ID prefix, or exact title. Ambiguous prefix matches are reported.
- **No automatic Telegram topic rename** — session naming is internal metadata, not user-owned topic UI mutation.
- **No session list command** — this change enables resume by known id/name but does not add `/sessions`.
