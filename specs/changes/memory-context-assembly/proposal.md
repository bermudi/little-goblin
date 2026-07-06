# Memory Context Assembly

## Motivation

Two distinct forms of policy scatter exist in the memory layer:

- **The `ActiveScope → MemoryScope` conversion is duplicated four times.** Byte-identical ~8-line copies live in `src/memory/reflector.ts:450` (`activeMemoryScopeFor`), `src/memory/tool.ts:340` (`activeMemoryScope`), `src/memory/snapshot.ts:172` (`activeMemoryScopeFor`), and `src/memory/search.ts:306` (`activeMemoryScopeFor`). `src/memory/scope.ts` exports the sibling primitives (`MemoryScope`, `ActiveScope`, `resolveActiveScope`, `scopeTag`) but not this conversion.
- **Per-tool scope and persona policy is re-derived at each tool's call site.** `src/memory/tool.ts` defines three resolve-helpers — `resolveSearchPersonaPolicy` (`tool.ts:177`), `resolveReadScope` (`tool.ts:295`), `resolveWriteScope` (`tool.ts:329`) — each re-deriving scope/persona from `ActiveScope` + the tool's input parameters. `personaPolicyFor` and the `PersonaPolicy` type are *not* duplicated — defined once in `src/memory/search.ts:72-79` and imported by `snapshot.ts` — but the policy knobs that feed them are threaded through each caller separately.

Callers feed in raw policy knobs rather than asking "build context for this caller." `AgentRunner` passes `includeAgents: true`, `promptText` into `formatSnapshot` (`src/agent/mod.ts:367-373`). Subagent execution passes `includePersona`, `persona` (`src/subagents/execution.ts:144-148, 201-208`). The interface is policy-knob-shaped, so the visibility rules for main agent vs named subagent vs anonymous subagent live implicitly across three files and two call sites.

This is a shallow set of modules where a deep one would concentrate the policy. Visibility bugs (a named subagent seeing persona memory it shouldn't, an anonymous subagent seeing named-agent personas, the wrong active scope) currently have no single test surface.

## Scope

Affected capabilities: `memory`, `agent`, and `subagents`.

This change introduces:

- A deep memory-context module that owns caller-kind discrimination (main goblin / named subagent / anonymous subagent), active-scope resolution, persona policy, relevant-memory retrieval, and snapshot formatting behind a "build context for this caller" interface.
- One home for the `ActiveScope → MemoryScope` conversion that today is copied byte-for-byte in four places (`reflector.ts:450`, `tool.ts:340`, `snapshot.ts:172`, `search.ts:306`). The new module absorbs this conversion; the four copies become imports.
- Caller-typed entry points so `AgentRunner` and subagent execution pass a caller descriptor instead of policy knobs. The existing snapshot/search/tool behavior is preserved; only the assembly path is consolidated.

## Non-Goals

- No change to memory visibility semantics. The rules ("named subagent sees only its own persona; anonymous subagent sees none; main agent sees all personas") are preserved as-is — this change relocates them, it does not redefine them.
- No change to the snapshot's on-wire format, the search ranking algorithm, or the memory tool's surface.
- No new memory scopes, no change to disk layout.
- No change to reflection write semantics.
- Not addressing the transcript-module seam (separate change) or the state-file duplication (separate change).
- The four duplicated `activeMemoryScopeFor` copies are absorbed here because they are part of the assembly path; this is the only cross-candidate consolidation in scope.
