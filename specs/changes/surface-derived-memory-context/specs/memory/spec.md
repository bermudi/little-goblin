# memory

## ADDED Requirements

### Requirement: Surface projection and runtime memory capture have one authority

The memory module SHALL expose a deterministic `resolveActiveScope(surface)` projection and a runtime-memory-context capture operation. `resolveActiveScope` SHALL accept a validated `Surface`, never a `ChatLocator`, binding, Conversation record, or persisted Surface setting. Every topic container SHALL project to `{ chatId, topicScope: { topicId } }`; DM, topicless supergroup, and guest SHALL project to `{ chatId, topicScope: "general" }`.

The projected `ActiveScope` SHALL contain no named-agent identity. Caller kind and optional persona name SHALL remain in the caller descriptor. A user-visible conversation runtime capture SHALL contain the canonical source `SurfaceId`, projected `ActiveScope`, caller descriptor, frozen summary, and frozen-summary deduplication inputs. It SHALL be created once at conversation-runtime creation and remain immutable for that runtime lifetime. Surface persistence MUST NOT contain an active-scope value or cached projection.

Internal callers SHALL use an explicit Surface-free internal context. They MUST NOT call `resolveActiveScope`, invent an internal Surface, or reinterpret `chatId: 0` as a Telegram Surface.

#### Scenario: Topic containers share the accepted memory key

- **WHEN** private, supergroup, and direct-messages topic Surfaces have the same `chatId` and `topicId`
- **THEN** each SHALL project to the same topic `ActiveScope` and `topics/<chatId>/<topicId>` MemoryScope
- **AND** their distinct SurfaceIds SHALL still remain available as transcript provenance

#### Scenario: General surfaces retain discovery chat

- **WHEN** a DM, topicless supergroup, or guest Surface is projected
- **THEN** its curated MemoryScope SHALL be `general`
- **AND** its Telegram `chatId` SHALL remain in `ActiveScope` for same-chat discovery and transcript filtering

#### Scenario: Moving a Conversation captures destination context

- **GIVEN** a Conversation runtime captured memory context from Surface X
- **WHEN** the Conversation later receives a replacement runtime on Surface Y
- **THEN** the replacement SHALL capture a new memory context from Y
- **AND** the old runtime capture SHALL not be reused or mutated

#### Scenario: Internal extraction is Surface-free

- **WHEN** the dreaming extractor runs through an internal model context
- **THEN** it SHALL receive explicit internal context with no `SurfaceId` or `ActiveScope`
- **AND** it SHALL not gain an ordinary active-scope write target

## MODIFIED Requirements

### Requirement: memory tool exposes add, replace, remove

The system SHALL expose `memory_search` and `memory_write`; `memory_read` and `memory_read_index` SHALL remain removed. Existing input schemas, result schemas, safety filtering, limits, ranking behavior, description validation, and corpus selection SHALL remain unchanged.

The tool factory SHALL receive a validated captured memory context rather than a locator or raw policy knobs. `memory_search` with `scope = "active"`, default same-chat discovery, and `memory_write target = "memory"` SHALL use the capture's `ActiveScope`. Persona eligibility and `target = "agent"` SHALL use the separate caller descriptor. The write schema MUST NOT accept a scope, Surface, SurfaceId, chat ID, or Conversation ID. No invocation may refresh its capture by reading a current binding.

#### Scenario: Active write uses captured context

- **WHEN** a main runtime captured topic 42 and calls `memory_write({action: "add", target: "memory", content: "..."})`
- **THEN** the entry SHALL be inserted in `topics/<chatId>/42`
- **AND** a later binding move SHALL not retarget that live invocation

#### Scenario: Named persona uses caller identity

- **WHEN** a named subagent with caller descriptor `researcher` calls `memory_write` with `target = "agent"`
- **THEN** the write SHALL target `agents/researcher`
- **AND** the persona name SHALL not be part of `resolveActiveScope(surface)`

#### Scenario: Search schemas remain compatible

- **WHEN** `memory_search` is called with or without a query
- **THEN** it SHALL preserve the accepted ranked-result, scope-entry, and scope-index response shapes
- **AND** transcript results SHALL continue to identify their Conversation/session compatibility ID and timestamp

### Requirement: Snapshot format for prompt injection

The system SHALL inject the accepted bounded frozen memory summary when a user-visible conversation runtime is created. The summary SHALL be frozen for the duration of that runtime; mid-runtime writes SHALL not refresh it. Conversation creation without a runtime SHALL not capture a summary, and replacement runtime creation after movement SHALL capture a new destination-Surface summary.

The summary SHALL retain the accepted 1200-character bound, header, stale-memory guardrail, active-scope description, bounded global-user and active-memory bodies, cross-scope index ordering, truncation order, omission for empty memory, and exclusion of transcript entries. The per-turn full snapshot SHALL remain removed; prompt-specific `## relevant memory` SHALL remain the per-turn signal.

#### Scenario: Runtime creation freezes summary

- **WHEN** a conversation runtime is created with non-empty memory
- **THEN** its captured memory context SHALL contain the bounded frozen summary
- **AND** the summary SHALL remain unchanged for that runtime lifetime

#### Scenario: Move creates a destination summary

- **WHEN** a Conversation moves from Surface X to Surface Y and a replacement runtime is created
- **THEN** the replacement SHALL freeze Y's active-scope description, memory, and same-chat index
- **AND** SHALL not reuse X's frozen summary

#### Scenario: Empty memory omits summary

- **WHEN** all eligible memory sources are empty at runtime creation
- **THEN** the captured frozen summary SHALL be absent

### Requirement: Memory scopes by chat surface and named agent

The system SHALL retain the accepted curated scopes: global `user`; singleton `general`; topic `topics/<chatId>/<topicId>`; and named persona `agents/<name>`. DM, topicless supergroup, and guest Surfaces SHALL all resolve to `general`. Every topic Surface SHALL resolve to the numeric topic scope regardless of container kind. Topic display-name changes and container identity MUST NOT alter the MemoryScope key. Named-agent persona scope SHALL derive from caller identity, not from the Surface projection.

#### Scenario: Guest uses general

- **WHEN** a runtime is created for a guest Surface
- **THEN** its active curated scope SHALL be `general`

#### Scenario: Topic container does not fork memory

- **WHEN** a topic's Surface container is private, supergroup, or direct-messages
- **THEN** its scope SHALL remain `topics/<chatId>/<topicId>`

### Requirement: Memory writes are restricted to the active scope

`memory_write` SHALL resolve `target = "memory"` only from the caller's captured `ActiveScope`, `target = "user"` to global user memory, and `target = "agent"` only from a named-subagent caller descriptor. Its input MUST NOT permit arbitrary scope or routing authority. The main agent and anonymous subagents SHALL receive the same rejection for `target = "agent"`. Current bindings, Conversation creation metadata, and persisted legacy subagent scope MUST NOT be consulted during an invocation.

#### Scenario: Captured topic write

- **WHEN** a caller captured topic 42 and writes `target = "memory"`
- **THEN** only `topics/<chatId>/42` SHALL be mutated

#### Scenario: Main agent persona write rejected

- **WHEN** the main agent writes `target = "agent"`
- **THEN** the tool SHALL reject it without mutation

### Requirement: Cross-scope discovery defaults to the current chat

The scope index and frozen-summary cross-scope index SHALL derive the current chat from captured Surface-derived `ActiveScope`. By default they SHALL include only topic scopes with that `chatId`, plus the accepted global/persona visibility. `all_chats = true` SHALL continue to broaden only tool-driven discovery; it SHALL not broaden the frozen summary. No caller SHALL derive the discovery chat from Conversation state or a later binding.

#### Scenario: Destination runtime uses destination chat

- **WHEN** a moved Conversation receives a replacement runtime in chat B
- **THEN** its default cross-scope discovery SHALL include B's topic scopes
- **AND** SHALL exclude chat A's topic scopes unless `all_chats = true`

### Requirement: Memory search defaults to current chat scopes

Memory search SHALL preserve the accepted caller visibility, corpus selection, and `all_chats` behavior. For Surface-backed callers, the default curated and transcript chat boundary SHALL use the captured `ActiveScope.chatId`; no search invocation may derive that boundary from Conversation state or a later binding. An explicit internal caller with no Surface SHALL preserve the accepted all-transcript behavior without constructing an `ActiveScope` or Surface.

#### Scenario: Internal search is explicit

- **WHEN** an internal caller searches transcripts
- **THEN** all transcript chats SHALL be eligible under the accepted internal rule
- **AND** no zero-chat Surface SHALL be fabricated

### Requirement: Active-scope-to-memory-scope conversion has one home

The system SHALL keep `ActiveScope → MemoryScope` conversion in `src/memory/scope.ts` and SHALL additionally make that module the single home of `Surface → ActiveScope` for ordinary runtime-memory, search, and subagent execution. Every such Surface consumer MUST import `resolveActiveScope(surface)` and every such MemoryScope consumer MUST import the active-scope conversion. No private locator-based, binding-based, or session-state-based conversion SHALL remain in those paths.

Transcript indexing and dreaming promotion are intentionally excluded: their legacy session-state compatibility path remains until `transcript-surface-provenance` replaces it with per-entry event-time provenance. That path SHALL NOT be reused as authority for ordinary runtime memory, search, or subagent execution.

#### Scenario: Surface projection is centralized

- **WHEN** runtime construction needs active memory context
- **THEN** it SHALL call the shared Surface projection
- **AND** SHALL not branch on Surface kind elsewhere to derive memory scope

#### Scenario: Database conversion remains centralized

- **WHEN** a consumer needs the SQLite `(scope, entry_kind)` pair
- **THEN** it SHALL use the existing centralized MemoryScope conversion

### Requirement: Memory context assembly is caller-typed

The memory-context module SHALL build context from a discriminated captured context rather than raw policy knobs. A Surface-backed capture SHALL contain projected `ActiveScope`, validated source SurfaceId, and caller descriptor. An internal context SHALL be explicitly Surface-free. Main, named-subagent, and anonymous-subagent visibility SHALL remain: main sees all eligible personas; named sees only its own; anonymous sees none. Persona identity MUST remain separate from ActiveScope.

Subagent callers SHALL receive the parent invocation's captured `ActiveScope`; the module SHALL not resolve a parent locator or binding. Frozen summary and relevant-memory formatting SHALL consume the same capture so their scope and chat boundary cannot diverge.

#### Scenario: Main runtime context

- **WHEN** context is assembled for a main runtime
- **THEN** it SHALL use that runtime's captured ActiveScope and main caller descriptor
- **AND** SHALL retain the accepted main visibility

#### Scenario: Named subagent context

- **WHEN** context is assembled for named subagent `researcher`
- **THEN** it SHALL use the parent invocation's captured ActiveScope and caller descriptor `researcher`
- **AND** SHALL expose only `agents/researcher` among persona scopes

#### Scenario: Callers cannot pass policy knobs

- **WHEN** a runtime requests memory context
- **THEN** it SHALL pass a validated capture
- **AND** SHALL not pass `includeAgents`, `includePersona`, a locator, or a binding reader
