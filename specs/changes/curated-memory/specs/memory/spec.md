# memory

## ADDED Requirements

### Requirement: Memory store filesystem layout

The system SHALL maintain a curated memory store at `$GOBLIN_HOME/memory/` containing two markdown files: `memory.md` (agent's notes about the environment, projects, conventions, decisions) and `user.md` (user preferences, communication style, recurring people and places). Both files MUST be created lazily on first write if missing.

#### Scenario: Both files absent on first write

- **WHEN** `memory.add` is called with `target = "memory"` and the file does not exist
- **THEN** `$GOBLIN_HOME/memory/memory.md` SHALL be created with the new entry as its only content

#### Scenario: Loading absent files

- **WHEN** the memory snapshot is loaded for prompt injection and `memory.md` does not exist
- **THEN** the loader SHALL treat the file as empty without throwing

### Requirement: Entry delimiter

Entries within each memory file SHALL be separated by the delimiter `\n§\n`. A file containing zero entries is the empty string. A file containing one entry MUST NOT contain the delimiter.

#### Scenario: First entry added

- **WHEN** `memory.add` writes the first entry to an empty file
- **THEN** the file contents SHALL equal the entry text with no surrounding delimiters

#### Scenario: Second entry added

- **WHEN** `memory.add` appends a second entry
- **THEN** the file contents SHALL be `<first><\n§\n><second>`

### Requirement: Enforce character caps with overflow errors

The system SHALL enforce hard character limits per file: 4000 characters for `memory.md` and 2000 characters for `user.md`. When an `add` or `replace` operation would push the file over its cap, the operation SHALL fail with an error message reporting the current size, the cap, and the overflow amount. The file MUST NOT be modified on overflow.

#### Scenario: Add under cap

- **WHEN** the resulting `memory.md` would be ≤ 4000 characters
- **THEN** the write SHALL succeed

#### Scenario: Add exceeds cap

- **WHEN** the resulting `memory.md` would be 4100 characters
- **THEN** the tool SHALL return an error reporting current size, cap (4000), and overflow (100)
- **AND** `memory.md` on disk SHALL be unchanged

### Requirement: memory tool exposes add, replace, remove

The system SHALL expose a single custom tool named `memory` accepting an `action` parameter of `"add" | "replace" | "remove"` and a `target` parameter of `"memory" | "user"`. `add` requires `content`. `replace` requires `old_text` and `content`. `remove` requires `old_text`.

#### Scenario: Add operation

- **WHEN** the tool is called with `{action: "add", target: "memory", content: "..."}`
- **THEN** the content SHALL be appended as a new entry to `memory.md`

#### Scenario: Missing required arg

- **WHEN** the tool is called with `{action: "replace", target: "user", content: "..."}` and no `old_text`
- **THEN** the tool SHALL return a validation error and MUST NOT write to disk

### Requirement: Substring match for replace and remove

`replace` and `remove` SHALL locate the target entry by substring match on `old_text` within the file's contents. If `old_text` matches zero or more than one location, the operation SHALL fail with an error and the file MUST NOT be modified.

#### Scenario: Unique match

- **WHEN** `old_text` matches exactly one substring
- **THEN** that substring SHALL be replaced (or its containing entry removed)

#### Scenario: Ambiguous match

- **WHEN** `old_text` matches more than one substring
- **THEN** the tool SHALL return an error reporting the match count
- **AND** the file SHALL be unchanged

#### Scenario: No match

- **WHEN** `old_text` matches no substring
- **THEN** the tool SHALL return a "not found" error
- **AND** the file SHALL be unchanged

### Requirement: Atomic writes

Every memory file mutation SHALL use atomic write (write to temp file in `$GOBLIN_HOME/memory/`, then rename to final path).

#### Scenario: Write succeeds

- **WHEN** `memory.add` writes a new entry
- **THEN** a temp file SHALL be written and renamed atomically to the target path

#### Scenario: Write interrupted

- **WHEN** the process crashes mid-write
- **THEN** the original file SHALL remain intact (the temp file may be left behind)

### Requirement: Git-backed versioning

The system SHALL initialize `$GOBLIN_HOME/memory/` as a git repository on first write if one does not already exist. After every successful `memory.*` write, the system SHALL stage and commit the changed file(s) with a commit message of the form `memory: <action> in <target>` where `action ∈ {add, replace, remove}` and `target ∈ {memory, user}`.

#### Scenario: First write initializes repo

- **WHEN** `memory.add` is called and `$GOBLIN_HOME/memory/.git` does not exist
- **THEN** `git init` SHALL run before the first commit

#### Scenario: Successful add commits

- **WHEN** `memory.add` writes a new entry
- **THEN** a git commit SHALL be created with the message `memory: add in memory` (when target is `memory`) or `memory: add in user` (when target is `user`)

#### Scenario: Failed write does not commit

- **WHEN** a write fails (e.g., overflow, ambiguous match)
- **THEN** no commit SHALL be created

### Requirement: Snapshot format for prompt injection

The system SHALL provide a snapshot formatter that produces the per-turn aside payload from the current memory store contents. The formatter MUST return `null` when both `memory.md` and `user.md` are empty (or absent). Otherwise it MUST return a payload whose textual content begins with the header `[goblin memory snapshot]` and contains both `## memory.md` and `## user.md` sections in that order. An individual section whose file is empty or absent MUST render the literal placeholder `(empty)` as its body so the agent always sees both targets exist.

#### Scenario: Both files empty

- **WHEN** both `memory.md` and `user.md` are empty or absent
- **THEN** the formatter SHALL return `null`

#### Scenario: Only memory.md populated

- **WHEN** `memory.md` has content and `user.md` is empty
- **THEN** the formatter SHALL return a non-null payload
- **AND** the payload text SHALL include `## memory.md` followed by the file's contents
- **AND** the payload text SHALL include `## user.md` followed by `(empty)`

#### Scenario: Only user.md populated

- **WHEN** `user.md` has content and `memory.md` is empty
- **THEN** the payload text SHALL include `## memory.md` followed by `(empty)`
- **AND** the payload text SHALL include `## user.md` followed by the file's contents
