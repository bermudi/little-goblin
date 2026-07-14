# Topic UI Is User Owned

## Status

accepted

## Context

Goblin uses Telegram supergroup forum topics as the primary surface for organizing
conversations by life domain (e.g. `#Health`, `#IT`, `#Finance`). Topics are user-managed
artifacts: the user creates them, names them, pins them, closes them, and deletes them
through the Telegram client. They are not transient session containers — they are
durable folders for distinct areas of the user's life.

Goblin's session lifecycle (a `(chat, topic) → sessionId` binding plus the rolling LLM
context backing it) is conceptually distinct from the topic itself. Multiple sessions
may live and die inside one topic over time. The two lifecycles do not coincide.

Conflating these — for example, having `/archive` rename the topic to
`Archived: <id>` — pollutes the user's domain UI with goblin's internal session
metadata, mutates a surface goblin does not own, and produces UX that is impossible
to make coherent (the topic is renamed but not closed, the title is filled with an
opaque session id, the user must rename it back manually).

## Decision

Goblin SHALL NOT mutate Telegram topic UI state as a side effect of any session-level
or memory-level operation. Specifically:

- Goblin MUST NOT rename a forum topic.
- Goblin MUST NOT close, reopen, hide, unhide, or delete a forum topic.
- Goblin MUST NOT change a forum topic's icon or icon color.
- Goblin MUST NOT create a forum topic.

The Telegram topic surface — name, status, icon, existence — is owned by the user.
Goblin observes topics (resolves `(chatId, topicId)` to a session, scopes memory to
the topic) but never mutates them.

This rule applies to all current and future commands, including but not limited to
`/new`, `/archive`, `/cancel`, and any memory-management commands introduced later.

## Consequences

- `/archive` becomes a pure session operation (move `sessions/<id>/` to
  `sessions/archive/<id>/`, drop bindings). It does not signal completion in
  Telegram. The user closes/renames the topic manually if they want to.
- `/new` rotates the session in place. The topic title is unchanged.
- Memory scoped by `(chatId, topicId)` (see change `scoped-memory`) is durable across
  topic renames — the binding key is the topic ID, not its name.
- If the user deletes a topic in Telegram, the orphaned scope is detected on the
  next failed resolve and moved to `memory/archive/topics/<chat>/<topic>/`. The
  deletion remains the user's action; goblin only reacts to it.
- New beta-tools (e.g. icon updates, status reactions) MUST respect this rule:
  message-level reactions are fine; topic-level mutations are not.
- Future "named subagent topic binding" (parked in backlog) MUST NOT auto-rename
  the bound topic to the agent's name, even if the user explicitly requests it
  via a non-`/`-prefixed message — the binding is configuration, the topic name
  remains user-authored.
