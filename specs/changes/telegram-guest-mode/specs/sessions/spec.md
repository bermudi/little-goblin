# sessions

## ADDED Requirements

### Requirement: Guest session bindings keyed on foreign chat id

The session manager SHALL persist guest session bindings in a separate `guest` map in `state/bindings.json`, keyed by the foreign `chat.id` (the chat the bot was summoned in but is not a member of). The guest map SHALL be distinct from the existing `dm`, `topics`, and `supergroups` maps so guest auto-create does not collide with normal DM/supergroup binding semantics for the same numeric chat id.

The `BindingsFile` interface SHALL add `guest?: Record<string, string>` (chatId → sessionId), matching the existing `dm` and `supergroups` maps' string-keyed shape. Lookups SHALL use `String(loc.chatId)` as the key, mirroring the existing branches. Existing consumers that ignore unknown binding keys SHALL continue to work unchanged; consumers that read bindings SHALL treat the `guest` map as a new surface.

#### Scenario: BindingsFile includes a guest map

- **WHEN** the bindings file is read or written
- **THEN** its type SHALL permit a `guest: Record<number, string>` field
- **AND** the field SHALL be optional (existing bindings files without it SHALL parse)

#### Scenario: Guest binding is separate from DM binding for the same chat id

- **WHEN** a guest session is bound to foreign chat id `C`
- **AND** a normal DM session is later bound to the same numeric id `C` (or vice versa)
- **THEN** the two bindings SHALL coexist without overwriting each other
- **AND** `resolve(loc, { isGuest: true })` SHALL return the guest binding
- **AND** `resolve(loc)` (no `isGuest`) SHALL return the DM binding

### Requirement: Auto-create guest sessions on first resolve

The session manager SHALL accept an `isGuest: boolean` option on `resolve()` and `createForChat()`. When `resolve()` is called with `{ isGuest: true }` for a locator with no existing guest binding, it SHALL create a new session and bind it in the `guest` map — mirroring the topic/supergroup auto-create behavior, NOT the DM-style explicit-create (which returns `null` when unbound). Stale guest bindings (state.json missing) SHALL auto-heal by recreating, mirroring topic stale-binding behavior.

#### Scenario: First guest resolve creates a session

- **WHEN** `resolve(loc, { isGuest: true })` is called for a chatId with no guest binding
- **THEN** it SHALL create a new session
- **AND** SHALL write the binding to the `guest` map
- **AND** SHALL return the new session state

#### Scenario: Subsequent guest resolve returns the bound session

- **WHEN** `resolve(loc, { isGuest: true })` is called for a chatId with an existing guest binding
- **THEN** it SHALL return the existing session state

#### Scenario: Stale guest binding auto-heals

- **WHEN** `resolve(loc, { isGuest: true })` is called
- **AND** the bound session's `state.json` is missing
- **THEN** it SHALL log a warning, create a new session, update the guest binding, and return the new state

#### Scenario: isGuest defaults to false

- **WHEN** `resolve(loc)` is called without the `isGuest` option
- **THEN** it SHALL behave exactly as before (DM/topic/supergroup routing unchanged)
- **AND** SHALL NOT consult or write the `guest` map
