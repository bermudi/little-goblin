# memory

## ADDED Requirements

### Requirement: Active-scope-to-memory-scope conversion has one home

The system SHALL provide the `ActiveScope → MemoryScope` conversion in exactly one module: `src/memory/scope.ts`. The conversion SHALL be exported from `scope.ts` and imported by every consumer. No other module SHALL define a private `activeMemoryScopeFor` or `activeMemoryScope` function.

The four existing private copies (`reflector.ts:450`, `tool.ts:340`, `snapshot.ts:172`, `search.ts:306`) SHALL be removed and replaced with imports from `scope.ts`.

#### Scenario: Single source for the conversion

- **WHEN** any module needs to convert an `ActiveScope` to a `MemoryScope`
- **THEN** it SHALL import the conversion from `src/memory/scope.ts`
- **AND** SHALL NOT define its own copy of the function

#### Scenario: Existing consumers are unchanged in behavior

- **WHEN** the conversion is centralized
- **THEN** each of `reflector.ts`, `tool.ts`, `snapshot.ts`, and `search.ts` SHALL resolve the same `MemoryScope` for a given `ActiveScope` as before
- **AND** no memory file path or scope tag SHALL change

### Requirement: Memory context assembly is caller-typed

The system SHALL provide a memory-context module that builds the memory context for a given caller behind a caller-typed interface, rather than exposing raw policy knobs (`includePersona`, `includeAgents`, `persona`, `promptText`) at every call site.

The module SHALL own caller-kind discrimination (main goblin / named subagent / anonymous subagent), active-scope resolution (via the centralized conversion from `Active-scope-to-memory-scope conversion has one home`), persona policy, relevant-memory retrieval, and snapshot formatting. Callers SHALL pass a caller descriptor, not a bag of policy knobs.

The visibility rules SHALL be preserved exactly as they exist today:
- The main goblin agent sees `user.md`, the active scope, same-chat topic scopes, and every named-agent persona scope.
- A named subagent sees `user.md`, the parent active scope, same-chat topic scopes, and its own persona scope only.
- An anonymous subagent sees `user.md`, the parent active scope, and same-chat topic scopes, and SHALL NOT see any named-agent persona scope.

#### Scenario: Main goblin agent context includes all personas

- **WHEN** the context is built for the main goblin agent in a topic-bound session
- **THEN** the assembled context SHALL include `user.md`, the active topic scope, same-chat topic scopes, and every named-agent persona scope

#### Scenario: Named subagent context includes only its own persona

- **WHEN** the context is built for a named subagent `researcher` spawned from a topic-bound parent
- **THEN** the assembled context SHALL include `user.md`, the parent's active scope, same-chat topic scopes, and `agents/researcher/memory.md`
- **AND** SHALL NOT include other named-agent persona scopes such as `agents/writer/memory.md`

#### Scenario: Anonymous subagent context excludes all personas

- **WHEN** the context is built for an anonymous subagent
- **THEN** the assembled context SHALL include `user.md`, the parent's active scope, and same-chat topic scopes
- **AND** SHALL NOT include any named-agent persona scope

#### Scenario: Callers pass a descriptor, not policy knobs

- **WHEN** `AgentRunner` or a subagent execution path requests the per-turn memory context
- **THEN** it SHALL pass a caller descriptor identifying the caller kind and (for named subagents) the agent name
- **AND** SHALL NOT pass `includeAgents`, `includePersona`, or `persona` knobs directly into `formatSnapshot` or `searchMemoryEntries`

## MODIFIED Requirements

### Requirement: Snapshot format for prompt injection

The system SHALL provide a snapshot formatter that produces the per-turn aside payload from the current memory store contents resolved against the calling session's active scope. The formatter SHALL accept a caller descriptor (as defined in `Memory context assembly is caller-typed`) instead of raw policy knobs. The payload SHALL begin with the literal header `[goblin memory snapshot]` followed by the sections defined in `Per-turn snapshot includes active scope and cross-scope index`. Empty sections SHALL render `(empty)`. The formatter MUST return `null` when all sources are empty AND no cross-scope index entries exist.

#### Scenario: Topic-bound session, only user.md populated

- **WHEN** the formatter is invoked for a main-goblin caller whose active scope is topic `42`, topic `42`'s `memory.md` is empty, `user.md` has content, and no other scopes exist
- **THEN** the formatter SHALL return a non-null payload
- **AND** the payload SHALL include `## scope` (topic `42`), `## user.md` with content, and `## memory.md` with `(empty)`
- **AND** the `## other scopes` section SHALL be omitted

#### Scenario: DM session with cross-scope topics available

- **WHEN** the formatter is invoked for a main-goblin caller whose active scope is `general`, `general/memory.md` has content, and topics `7` and `42` have non-empty `memory.md` files with descriptions
- **THEN** the payload SHALL include `## scope` (general), `## user.md`, `## memory.md` (general's contents), and `## other scopes` listing topics `7` and `42` with descriptions

#### Scenario: Everything empty

- **WHEN** `user.md`, the active scope's `memory.md`, and every other scope are empty or absent
- **THEN** the formatter SHALL return `null`
