# telegram-session-resume-name

## Motivation

pi has useful session management commands (`/resume`, `/name`) that let a user move between long-running conversations without losing context. Goblin already has Telegram-native `/new`, `/archive`, and `/compact`, but the session lifecycle semantics are wrong for switching:

```text
/name ttt
/new
/resume ttt
```

The expected behavior is obvious: name the current session, start a fresh session, then switch back to the named session. Today `/new` archives the previous session, which makes it disappear from normal resume lookup. That turns "start a fresh branch of conversation" into "put the old conversation away."

Those are different operations. `/archive` should mean "put this session away." `/new` should mean "make a fresh session current, leaving the previous session resumable."

## Scope

- **Terminology cleanup** in `specs/glossary.md`: bound session, unbound session, archived session, resumable session.
- **Change `/new` semantics**: create a fresh session and bind the chat surface to it; do not archive the previous session.
- **Keep `/archive` semantics**: explicitly move a session to `sessions/archive/<id>/` and clear bindings.
- **Add `/name <name>` command** in Telegram for naming the bound session.
- **Add `/resume <id-or-name>` command** in Telegram for binding the current chat surface to an existing resumable session.
- **Add `/resume` command with no arguments** as a named-session switchboard.
- **Session title persistence** via `SessionState.title`.
- **Existing-session binding** in `SessionManager` without creating, archiving, or deleting sessions.
- **Help output** includes both commands.
- **Cancel-capable semantics**: both commands interrupt any active turn before changing session metadata/bindings.

## Non-Goals

- **No archived-session revival** — archived sessions remain intentionally put away. If we want revival later, that should be a separate explicit command/flow.
- **No fuzzy search** — matching is exact session ID, session ID prefix, or exact title. Ambiguous prefix matches are reported.
- **No automatic Telegram topic rename** — session naming is internal metadata, not user-owned topic UI mutation.
- **No session list command** — this change enables resume by known id/name but does not add `/sessions` or `/ls`.
- **No full session listing** — `/resume` with no arguments lists named resumable sessions only, not every anonymous session ID.
- **No topic auto-create behavior change** — first messages in an unbound topic still create a fresh session.
