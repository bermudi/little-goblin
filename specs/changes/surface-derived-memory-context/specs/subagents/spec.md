# subagents

## ADDED Requirements

### Requirement: Subagent memory context is captured per invocation

Every subagent spawn or revival invocation SHALL receive a captured memory context from the invoking parent runtime. The invocation capture SHALL contain the parent's already-projected ActiveScope and a caller descriptor derived from the child role; it MUST NOT contain a parent locator or binding reader. It SHALL remain immutable until that invocation terminates.

A generic child SHALL use the inherited ActiveScope with an anonymous-subagent caller descriptor. A named child SHALL use the inherited ActiveScope with its own named-subagent caller descriptor. Recursive children SHALL inherit their immediate parent invocation's ActiveScope unchanged and derive only their own caller descriptor. Invocation metadata MAY persist the capture for audit, but persisted context MUST NOT become live authority for a later revival.

#### Scenario: Parent moves after spawn

- **GIVEN** a parent runtime on Surface X spawns a subagent
- **WHEN** the parent Conversation later moves to Surface Y
- **THEN** the running subagent SHALL continue using the ActiveScope captured from X
- **AND** SHALL not query the new binding

#### Scenario: Recursive child inherits capture

- **WHEN** a subagent recursively spawns a child
- **THEN** the child SHALL receive the same captured ActiveScope
- **AND** a named child SHALL add only its own persona caller identity

#### Scenario: Persisted context is audit-only

- **WHEN** an old subagent invocation's metadata contains a captured ActiveScope
- **THEN** status and diagnostics MAY display it
- **AND** a new revival invocation SHALL not use it as current routing authority

### Requirement: Internal extraction does not invent parent memory context

A model invocation used solely for internal dreaming extraction SHALL use the explicit Surface-free internal path. It SHALL not receive ordinary subagent memory tools, synthesize an ActiveScope, or inherit the dreaming compatibility session's `chatId: 0`.

#### Scenario: Dreaming invokes model extraction

- **WHEN** dreaming requests structured candidate extraction
- **THEN** the model invocation SHALL have no source Surface or active memory write scope
- **AND** promotion scope SHALL be resolved later from transcript provenance

## MODIFIED Requirements

### Requirement: Subagent revival loads persisted session

The subagent revival operation SHALL load and continue the persisted pi conversation history and SHALL process the new prompt as currently accepted. Revival SHALL be treated as a new invocation: its caller MUST supply the reviving parent runtime's captured memory context, and the revived invocation SHALL derive its caller descriptor from the persisted role/name. It MUST NOT restore active memory authority from persisted legacy `activeScope`, Conversation creation metadata, or current binding lookup.

#### Scenario: Revive after restart

- **WHEN** a parent runtime revives a persisted subagent after restart
- **THEN** the prior subagent conversation history SHALL be loaded
- **AND** the new invocation SHALL capture the reviving parent runtime's ActiveScope

#### Scenario: Conversation moved before revival

- **GIVEN** a subagent was originally spawned from Surface X
- **AND** its owning Conversation now has a runtime on Surface Y
- **WHEN** that runtime revives the subagent
- **THEN** the revival invocation SHALL use Y's captured ActiveScope
- **AND** SHALL preserve the subagent history without treating X's persisted scope as live authority

#### Scenario: Revival without parent context is rejected

- **WHEN** revival is requested without an invoking runtime memory capture
- **THEN** it SHALL fail before creating a subagent AgentSession

### Requirement: Anonymous subagents inherit parent's active memory scope

A generic subagent SHALL receive the parent runtime's captured ActiveScope and an anonymous-subagent caller descriptor. Its `memory_search` and `memory_write` tools SHALL consume that immutable invocation capture. `target = "memory"` SHALL resolve to the captured topic/general scope, while `target = "agent"` SHALL be rejected. The subagent MUST NOT resolve a parent locator or current binding.

#### Scenario: Generic subagent writes captured topic

- **WHEN** a generic subagent captured topic 42 and writes `target = "memory"`
- **THEN** the entry SHALL be inserted in `topics/<chatId>/42`
- **AND** a later parent move SHALL not retarget the write

#### Scenario: Generic persona write is rejected

- **WHEN** a generic subagent writes `target = "agent"`
- **THEN** the call SHALL fail with the same non-named-caller error as the main agent

### Requirement: Named subagents have a three-tier memory model

A named subagent SHALL preserve the accepted three-tier model: global user plus its own persona identity tier, the parent invocation's captured active tier, and caller-authorized progressive discovery. Its named caller descriptor SHALL control persona visibility and `target = "agent"`; its captured ActiveScope SHALL control `target = "memory"` and same-chat discovery. Named identity MUST NOT be added to or resolved through `Surface → ActiveScope`.

All tiers SHALL be frozen/queried through the invocation capture. The subagent SHALL not receive a path-based scope write, parent locator, binding reader, or other persona scopes.

#### Scenario: Named context keeps persona separate

- **WHEN** named subagent `researcher` is spawned from a topic runtime
- **THEN** its frozen context SHALL include global user memory, the captured topic memory, and `agents/researcher`
- **AND** SHALL exclude other persona scopes

#### Scenario: Named writes use separate authorities

- **WHEN** `researcher` writes `target = "memory"` and then `target = "agent"`
- **THEN** the first write SHALL use the captured ActiveScope
- **AND** the second SHALL use the named caller descriptor

### Requirement: Subagent memory access uses the same tool surface as the main agent

Subagents SHALL use the same `memory_search` and `memory_write` schemas as the main agent. The schemas SHALL remain caller-agnostic; behavior SHALL differ only through the validated invocation memory capture. Generic and named subagents MUST NOT receive locator, Surface, arbitrary-scope, or policy-knob inputs. Persona rejection and active-scope write behavior SHALL retain parity with the main memory module.

#### Scenario: Tool schema parity

- **WHEN** main, generic-subagent, and named-subagent memory tool schemas are compared
- **THEN** they SHALL be identical
- **AND** none SHALL expose runtime memory authority as model input

#### Scenario: Runtime capture differs behind the same schema

- **WHEN** callers invoke identical memory tool inputs
- **THEN** the tool implementation SHALL apply each caller's prevalidated capture
- **AND** SHALL not branch on a model-supplied runner kind
