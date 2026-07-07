# Tasks

## Phase 1: Centralize the active-scope conversion

- [ ] Add `activeMemoryScopeFor(activeScope)` (the body duplicated in four places) to `src/memory/scope.ts` and export it. Covers: `Active-scope-to-memory-scope conversion has one home`.
- [ ] Delete the private copy in `src/memory/reflector.ts:450` and import from `scope.ts`.
- [ ] Delete the private copy in `src/memory/tool.ts:340` and import from `scope.ts`.
- [ ] Delete the private copy in `src/memory/snapshot.ts:172` and import from `scope.ts`.
- [ ] Delete the private copy in `src/memory/search.ts:306` and import from `scope.ts`.
- [ ] Run `bun test src/memory` and `bun run typecheck`. Existing memory tests must pass unchanged (behavior identical, only the call site changed).

Commit: `phase 1: centralize active-scope conversion`

## Phase 2: Introduce the caller-typed context module

- [ ] Add `src/memory/context.ts` exporting the `MemoryCaller` discriminated union (`{ kind: "main" } | { kind: "named-subagent"; name: string } | { kind: "anonymous-subagent" }`) and `buildMemoryContext({ caller, store, activeScope, promptText?, getTopicName? })`. Internally derive `includeAgents`, persona policy, and relevant-memory retrieval from `caller`. Covers: `Memory context assembly is caller-typed`.
- [ ] Move or re-export `personaPolicyFor` and `PersonaPolicy` so `snapshot.ts` and `tool.ts` import them from one place (decision D3 finalized here: prefer moving to `context.ts` so the context module owns all caller-kind policy).
- [ ] Add `src/memory/context.test.ts` asserting: main sees all personas; named subagent sees only its own persona; anonymous subagent sees no personas; `buildMemoryContext` output matches the prior `formatSnapshot` output for each caller kind. Covers: `Memory context assembly is caller-typed` scenarios.
- [ ] Run `bun test src/memory/context.test.ts` and `bun run typecheck`.

Commit: `phase 2: add caller-typed memory context module`

## Phase 3: Route callers through the context module

- [ ] Update `src/memory/snapshot.ts`: `FormatSnapshotArgs` accepts a `caller: MemoryCaller`; derive `includePersona`/`includeAgents` internally. On-wire snapshot output unchanged. Covers modified: `Snapshot format for prompt injection`.
- [ ] Update `src/agent/mod.ts`: replace the `formatSnapshot({ ..., includeAgents: true, promptText })` call (`mod.ts:367-373`) and the `createMemorySearchTool({ ..., includeAgents: true })` call (`mod.ts:189`) with caller-typed equivalents (`{ kind: "main" }`).
- [ ] Update `src/subagents/execution.ts`: replace the two `formatSnapshot` calls (`execution.ts:144-148, 201-208`) and the `createMemorySearchTool({ persona: ... })` knob with caller-typed equivalents (`{ kind: "named-subagent", name }` or `{ kind: "anonymous-subagent" }`).
- [ ] Update existing snapshot/subagent tests that assert on the old knob shapes.
- [ ] Run `bun test src/memory src/agent/mod.test.ts src/subagents` and `bun run typecheck`.

Commit: `phase 3: route memory callers through the context module`

## Phase 4: Boundary check and validation

- [ ] Grep the tree for any remaining `includeAgents`, `includePersona`, or hand-rolled `persona: { kind:` knobs at call sites outside the memory layer; the only remaining occurrences should be inside `context.ts`/`snapshot.ts`/`tool.ts` internals.
- [ ] Grep for any remaining private `activeMemoryScopeFor`/`activeMemoryScope` definitions outside `src/memory/scope.ts`; fix stragglers.
- [ ] Run full validation: `litespec validate memory-context-assembly`, `bun test`, `bun run typecheck`.

Commit: `phase 4: finalize memory context assembly`
