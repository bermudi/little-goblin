# memory

## MODIFIED Requirements

### Requirement: Memory store filesystem layout

The system SHALL maintain a curated memory store at `$GOBLIN_HOME/state/memory/` containing:

- `user.md` — the global user identity file (preferences, recurring people, communication style).
- `general/memory.md` — the catch-all scope for DMs and supergroup-no-topic chats.
- `topics/<chatId>/<topicId>/memory.md` — one file per Telegram forum topic.
- `agents/<name>/memory.md` — one file per named subagent persona.
- `archive/topics/<chatId>/<topicId>/` — orphaned topic scopes moved here automatically.

All `memory.md` and `user.md` files MUST be created lazily on first write if missing. Intermediate scope directories SHALL be created with `mkdir -p` semantics.

#### Scenario: First write to user.md creates it

- **WHEN** `memory_write` is called with `target = "user"` and `user.md` does not exist
- **THEN** `$GOBLIN_HOME/state/memory/user.md` SHALL be created with the new entry as its only content

#### Scenario: First write to a new topic scope creates the tree

- **WHEN** `memory_write` is called with `target = "memory"` from a session in topic `42` and no scope file exists
- **THEN** `$GOBLIN_HOME/state/memory/topics/<chatId>/42/memory.md` SHALL be created with the new entry
- **AND** the parent directories SHALL be created if absent

#### Scenario: Loading absent files

- **WHEN** the snapshot formatter loads any scope file that does not exist
- **THEN** the loader SHALL treat the file as empty without throwing

### Requirement: Atomic writes

Every memory file mutation SHALL use atomic write (write to temp file in `$GOBLIN_HOME/state/memory/`, then rename to final path).

#### Scenario: Write succeeds

- **WHEN** `memory.add` writes a new entry
- **THEN** a temp file SHALL be written and renamed atomically to the target path

#### Scenario: Write interrupted

- **WHEN** the process crashes mid-write
- **THEN** the original file SHALL remain intact (the temp file may be left behind)

### Requirement: Git-backed versioning

The system SHALL initialize `$GOBLIN_HOME/state/memory/` as a git repository on first write if one does not already exist. After every successful `memory_write` operation, the system SHALL stage and commit the changed file(s) with a commit message of the form `memory: <action> in <target>` where:

- `action ∈ {add, replace, remove, rewrite, set_description}`
- `target` is one of: `user`, `general`, `topics/<chatId>/<topicId>`, `agents/<name>`

A single git repo at `$GOBLIN_HOME/state/memory/.git` covers all scopes; per-scope repos MUST NOT be created.

#### Scenario: Successful add in a topic commits with scope tag

- **WHEN** `memory_write({action: "add", target: "memory", ...})` succeeds from topic `42` in chat `-100123`
- **THEN** a git commit SHALL be created with the message `memory: add in topics/-100123/42`

#### Scenario: Successful set_description commits with scope tag

- **WHEN** `memory_write({action: "set_description", target: "memory", description: "..."})` succeeds in `general`
- **THEN** a git commit SHALL be created with the message `memory: set_description in general`

#### Scenario: First write initializes repo

- **WHEN** any `memory_write` action is called and `$GOBLIN_HOME/state/memory/.git` does not exist
- **THEN** `git init` SHALL run before the first commit

#### Scenario: Failed write does not commit

- **WHEN** any `memory_write` action fails (cap overflow, ambiguous match, target=agent for non-named caller)
- **THEN** no commit SHALL be created

### Requirement: Memory scopes by chat surface and named agent

The system SHALL key each memory scope by one of:
- `general` — DMs and supergroup-no-topic chats. Resolves on disk to `$GOBLIN_HOME/state/memory/general/memory.md`.
- A topic scope identified by `(chatId, topicId)`. Resolves to `$GOBLIN_HOME/state/memory/topics/<chatId>/<topicId>/memory.md`.
- A named-agent persona scope identified by `<name>` where `<name>` is a sanitized named-agent identifier. Resolves to `$GOBLIN_HOME/state/memory/agents/<name>/memory.md`.

Topic-scope keying SHALL use the numeric Telegram topic ID, not the topic's display name. Renaming a forum topic in Telegram MUST NOT change the resolved on-disk path. The `general` scope file is shared across every DM and every supergroup-no-topic chat.

`user.md` is global and lives at `$GOBLIN_HOME/state/memory/user.md`. There is no per-scope `user.md`.

#### Scenario: First write in a topic creates its scope tree

- **WHEN** `memory_write` is called with `target = "memory"` from a session bound to `(chatId=-100123, topicId=42)` and the scope file does not exist
- **THEN** `$GOBLIN_HOME/state/memory/topics/-100123/42/memory.md` SHALL be created with the new entry as its only content
- **AND** intermediate directories (`topics/`, `topics/-100123/`, `topics/-100123/42/`) SHALL be created with `mkdir -p` semantics

#### Scenario: First write in a DM resolves to general scope

- **WHEN** `memory_write` is called with `target = "memory"` from a DM session and `general/memory.md` does not exist
- **THEN** `$GOBLIN_HOME/state/memory/general/memory.md` SHALL be created with the new entry as its only content

#### Scenario: First write to a named agent's persona resolves to that agent's scope

- **WHEN** `memory_write` is called with `target = "agent"` from a named subagent `researcher` and `agents/researcher/memory.md` does not exist
- **THEN** `$GOBLIN_HOME/state/memory/agents/researcher/memory.md` SHALL be created with the new entry as its only content

#### Scenario: Topic rename does not move the scope file

- **WHEN** the user renames the forum topic with id `42` in Telegram from `Health` to `Wellness`
- **THEN** the on-disk path `$GOBLIN_HOME/state/memory/topics/<chatId>/42/memory.md` SHALL remain unchanged
- **AND** subsequent reads and writes SHALL continue to use the same file

### Requirement: Orphan topic scopes move to archive on failed resolve

When goblin attempts a Telegram operation against a topic and Telegram responds with a not-found error, the system SHALL move the topic's scope directory to `$GOBLIN_HOME/state/memory/archive/topics/<chatId>/<topicId>/` via `renameSync`. After the move, the scope SHALL NOT appear in `memory_read_index` results.

The `general` scope and named-agent persona scopes are NOT subject to orphan handling. Detection SHALL NOT poll Telegram; the move is triggered only on the next failed resolve.

#### Scenario: Topic deleted in Telegram, next operation surfaces 404

- **WHEN** the user deletes a forum topic in Telegram
- **AND** goblin next attempts to send or edit a message in that topic
- **AND** Telegram returns a "topic not found" error
- **THEN** the matching `state/memory/topics/<chatId>/<topicId>/` directory SHALL be moved to `state/memory/archive/topics/<chatId>/<topicId>/`
- **AND** subsequent `memory_read_index` calls SHALL omit the orphaned scope

#### Scenario: General scope is exempt

- **WHEN** any failed resolve occurs
- **THEN** `state/memory/general/` SHALL NOT be moved or otherwise modified
