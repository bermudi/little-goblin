# Memory Context Assembly Design

## Architecture

Today memory context is built by threading raw policy knobs through `formatSnapshot` and the memory tools. Two different knob dialects exist for the same concern:

```
╭──────────────╮  includeAgents:true, promptText  ╭────────────────╮
│ AgentRunner  │─────────────────────────────────▶│ formatSnapshot │
╰──────────────╯                                   ╰──────┬─────────╯
                                                          │ activeMemoryScopeFor() ← private copy
╭──────────────────╮  includePersona:{name}              ▼
│ subagent         │────────────────────────────────▶ formatScopedSnapshot
│ execution        │            ╭────────────────────────╮
│                  │  persona:  │ createMemorySearchTool │ ← own PersonaPolicy knob
╰──────────────────╯  {kind:..} ╰────────────────────────╯
```

After this change a single memory-context module owns caller-kind discrimination, the active-scope conversion, persona policy, relevant-memory retrieval, and snapshot formatting:

```
╭──────────────╮  {kind:"main"}                         ╭──────────────────────╮
│ AgentRunner  │──────────────────────────────────────▶│ memory-context       │
╰──────────────╯                                        │  • resolveCallerCtx  │
                                                        │  • toMemoryScope ←   │
╭──────────────────╮  {kind:"named", name}              │    (moved to scope.ts)│
│ subagent         │──────────────────────────────────▶│  • personaPolicyFor  │
│ execution        │            ╭──────────────────╮    │  • formatSnapshot    │
╰──────────────────╯            │ memory tools     │◀───│  • searchEntries     │
                                  ╰──────────────────╯    ╰──────────────────────╯
```

### Two consolidated changes in one

This change bundles two related consolidations because they share the assembly path:

1. **Centralize the `ActiveScope → MemoryScope` conversion** in `scope.ts` (the 4 duplicated copies). This is the cheaper, more mechanical half.
2. **Introduce the caller-typed context module** that replaces the policy-knob dialects. This is the structural half.

Bundling them avoids touching the same four files twice.

## Decisions

### D1. Conversion moves to `scope.ts`; the four copies become imports

**Chosen:** add `toMemoryScope(activeScope: ActiveScope): MemoryScope` (or `activeMemoryScopeFor` — name TBD during build, prefer the existing most-common name `activeMemoryScopeFor`) to `src/memory/scope.ts`. Delete the four private copies and import instead.

**Why:** `scope.ts` already exports the sibling primitives (`MemoryScope`, `ActiveScope`, `resolveActiveScope`, `scopeTag`) but not this conversion. It is the natural home; the four copies already import from it.

**Constraint:** the conversion is a pure function with no I/O. The four call sites change from calling a local function to calling an import; behavior is identical.

Specs: `Active-scope-to-memory-scope conversion has one home`.

### D2. A caller descriptor replaces the policy-knob dialects

**Chosen:** introduce a `MemoryCaller` discriminated union:
```ts
type MemoryCaller =
  | { kind: "main" }
  | { kind: "named-subagent"; name: string }
  | { kind: "anonymous-subagent" };
```
The context module accepts a `MemoryCaller` (plus the `MemoryStore`, `activeScope`, and optional `promptText`/`getTopicName`) and internally derives `includeAgents`, the persona policy, and the search persona policy. `AgentRunner` passes `{ kind: "main" }`; subagent execution passes `{ kind: "named-subagent", name }` or `{ kind: "anonymous-subagent" }`.

**Why:** the two existing knob dialects (`includeAgents: boolean` for snapshot, `persona: { kind: "own"|"none" }` for search tools) are both projections of the same caller kind. A caller descriptor makes the three visibility cases (main / named / anonymous) explicit and testable as one thing.

**Rejected:** keeping the knobs and just centralizing the conversion. That would leave the policy scatter in place — the visibility rules would still live implicitly across three files.

**Constraint:** `formatSnapshot`'s public signature changes. This is an internal API (not a Telegram/user-facing surface), so the breakage is bounded to `AgentRunner` and subagent execution. The on-wire snapshot format is unchanged.

Specs: `Memory context assembly is caller-typed`, modified `Snapshot format for prompt injection`.

### D3. The context module owns `personaPolicyFor`; search/tool import it

**Chosen:** `personaPolicyFor` and the `PersonaPolicy` type (currently defined once in `search.ts:72-79`, which is correct) move into the context module (or stay in `search.ts` and get re-exported through the context module — TBD during build). The per-tool `resolveReadScope`/`resolveSearchPersonaPolicy`/`resolveWriteScope` helpers in `tool.ts` stay (they translate tool-input parameters, which is genuine tool-side logic) but call the centralized conversion and the context module's persona resolver.

**Why:** `personaPolicyFor` is part of the assembly policy; it belongs with the caller-kind discrimination. The tool-side resolve-helpers do genuine tool-input translation (e.g. `target: "agent"` is only valid for named subagents) and are not pure duplication — they stay, but stop re-deriving scope/persona from scratch.

**Constraint:** `PersonaPolicy` remains the internal type; callers no longer construct it by hand.

Specs: `Memory context assembly is caller-typed`.

### D4. No change to visibility semantics, snapshot format, or search ranking

**Chosen:** the rules (main sees all personas, named sees own, anonymous sees none), the snapshot's section order and section headers, and the lexical search ranking are all preserved.

**Why:** this change relocates policy; it does not redefine it. Any behavior change would be a regression.

**Proof that `MemoryCaller` is sufficient (verified against `formatScopedSnapshot`, `snapshot.ts:66-118`, during planning):** the snapshot function consumes exactly three inputs that vary by caller — `activeScope` (carried through), `includePersona` (derived from caller kind), and the persona policy used inside `formatRelevantMemory` (derived from `activeScope.namedAgent` via `personaPolicyFor`). Tracing each caller kind:

- **Main agent:** `activeScope.namedAgent === null` (set by `resolveActiveScope(locator)` with no name at `agent/mod.ts:133`). `personaPolicyFor` returns `{kind:"all"}` → searches all personas. `MemoryCaller {kind:"main"}` maps to `includePersona: undefined` + persona policy `{kind:"all"}`. ✓
- **Named subagent:** `activeScope.namedAgent = {name}`. `personaPolicyFor` returns `{kind:"own", name}`. `MemoryCaller {kind:"named-subagent", name}` maps to `includePersona:{name}` + persona policy `{kind:"own", name}`. ✓
- **Anonymous subagent:** `activeScope.namedAgent === null` (indistinguishable from main by `activeScope` alone). Today the subagent execution path passes `includePersona: undefined` and `includeAgents: false`. `MemoryCaller {kind:"anonymous-subagent"}` maps to `includePersona: undefined` + persona policy `{kind:"none"}`.

The honest justification for the union is narrower than "necessary." The three-way caller distinction **already exists at the call sites today** — `mod.ts:375-381` sets `includeAgents: true` for main, `execution.ts:200-207` sets `includeAgents: false` and derives `includePersona` from `instance.role`, and the `persona` policy for the search tool is built at `execution.ts:143-146`. So the distinction is not new; what's new is *typing it as one thing instead of leaving it implicit in boolean knobs spread across two files*. The anonymous-subagent case is where the typing pays off: `activeScope.namedAgent === null` for both main and anonymous, so the snapshot/search layer cannot derive "is this anonymous?" from `activeScope` alone — only the caller knows. Today that knowledge lives in `execution.ts`'s `includeAgents: false` + `{ kind: "none" }` literal; the union moves it into a typed value that the context module branches on once. That is a locality and testability argument, not a correctness necessity. If the anonymous case were ever dropped, the union would collapse to `{ kind: "main" } | { kind: "named-subagent"; name }` and could equivalently be derived from `activeScope.namedAgent` — at which point the union would add little over the status quo.

Specs: the `Scenario:` blocks under `Memory context assembly is caller-typed` restate the existing rules as assertions.

## File Changes

### `src/memory/scope.ts` (modified)

Add the `ActiveScope → MemoryScope` conversion (the body currently duplicated in four places). Export it. Sibling primitives unchanged.

Covers `Active-scope-to-memory-scope conversion has one home`.

### `src/memory/context.ts` (new)

Owns caller-kind discrimination and context assembly. Exports:
- `MemoryCaller` discriminated union (`{ kind: "main" } | { kind: "named-subagent"; name: string } | { kind: "anonymous-subagent" }`).
- `buildMemoryContext({ caller, store, activeScope, promptText?, getTopicName? })` — the single entry point. Internally resolves `includeAgents`, persona policy, relevant-memory retrieval, and delegates to `formatSnapshot`.
- `personaPolicyFor(caller, activeScope)` (moved from `search.ts:77`) — or re-exported from here if kept in `search.ts`.
- The caller → `PersonaPolicy` mapping.

Covers `Memory context assembly is caller-typed`, modified `Snapshot format for prompt injection`.

### `src/memory/context.test.ts` (new)

Asserts the three visibility cases (main sees all personas; named sees own only; anonymous sees none), the caller-descriptor interface, and that `buildMemoryContext` produces the same snapshot `formatSnapshot` produced before for each caller kind.

Covers `Memory context assembly is caller-typed` scenarios.

### `src/memory/snapshot.ts` (modified)

- Delete the private `activeMemoryScopeFor` (`snapshot.ts:172`); import from `scope.ts`.
- `FormatSnapshotArgs` gains a `caller: MemoryCaller` field; the `includePersona`/`includeAgents` knobs are derived from `caller` inside the formatter (or removed from the public args and computed in `buildMemoryContext`). The on-wire snapshot output is unchanged.
- `personaPolicyFor` import moves to come from `context.ts` (or stays from `search.ts` if D3 keeps it there).

Covers `Active-scope-to-memory-scope conversion has one home`, `Memory context assembly is caller-typed`, modified `Snapshot format for prompt injection`.

### `src/memory/search.ts` (modified)

- Delete the private `activeMemoryScopeFor` (`search.ts:306`); import from `scope.ts`.
- `personaPolicyFor`/`PersonaPolicy`: either stay here (re-exported via `context.ts`) or move to `context.ts` — decision finalized during build per D3. Either way, `snapshot.ts` and `tool.ts` import them from one place.

Covers `Active-scope-to-memory-scope conversion has one home`.

### `src/memory/tool.ts` (modified)

- Delete the private `activeMemoryScope` (`tool.ts:340`); import from `scope.ts`.
- The three resolve-helpers (`resolveReadScope:295`, `resolveWriteScope:329`, `resolveSearchPersonaPolicy:177`) stay but delegate scope conversion and persona resolution to the centralized helpers. They no longer re-derive scope/persona from scratch.
- The `persona` knob on `createMemorySearchTool`'s args is replaced by a `caller: MemoryCaller` (or the persona policy is derived inside the tool from the caller).

Covers `Active-scope-to-memory-scope conversion has one home`, `Memory context assembly is caller-typed`.

### `src/memory/reflector.ts` (modified)

- Delete the private `activeMemoryScopeFor` (`reflector.ts:450`); import from `scope.ts`.

Covers `Active-scope-to-memory-scope conversion has one home`. (Note: this file is also touched by `memory-transcript-module` on the read path — that change touches `reflector.ts:358-412`, this change touches `reflector.ts:450`. Different regions, no shared symbols. Land `memory-transcript-module` first so its line-number citations stay accurate; not a `dependsOn` relationship.)

### `src/agent/mod.ts` (modified)

- Replace the `formatSnapshot({ ..., includeAgents: true, promptText })` call (`mod.ts:375-381`) with `buildMemoryContext({ caller: { kind: "main" }, store, activeScope, promptText, getTopicName })` (or pass `caller` into `formatSnapshot`).
- Replace the `createMemorySearchTool({ ..., includeAgents: true })` call (`mod.ts:193`) with the caller-typed equivalent.

Covers `Memory context assembly is caller-typed` (main-agent call site).

### `src/subagents/execution.ts` (modified)

- Replace the single `formatSnapshot({ ..., includePersona, includeAgents: false })` call (`execution.ts:200-207`) with the caller-typed equivalent: `{ kind: "named-subagent", name }` for named subagents, `{ kind: "anonymous-subagent" }` otherwise. (There is only one `formatSnapshot` call in this file; the `persona` policy passed to `createMemorySearchTool` at `execution.ts:143-146` is a separate object, handled below.)
- Replace the `createMemorySearchTool({ ..., persona: { kind: "own"|"none" } })` knob (`execution.ts:143-146`) with the caller-typed equivalent.

Covers `Memory context assembly is caller-typed` (subagent call sites).
