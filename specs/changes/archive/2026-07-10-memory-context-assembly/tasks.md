# Tasks

## Phase 1: Centralize the active-scope conversion

- [x] Add `activeMemoryScopeFor(activeScope)` (the body duplicated in four places) to `src/memory/scope.ts` and export it. Covers: `Active-scope-to-memory-scope conversion has one home`.
- [x] Delete the private copy in `src/memory/reflector.ts:450` and import from `scope.ts`.
- [x] Delete the private copy in `src/memory/tool.ts:340` and import from `scope.ts`. NOTE: tool.ts named its copy `activeMemoryScope` (no `For` suffix); the two call sites were updated to `activeMemoryScopeFor` and the unused `MemoryScope` type import was kept (still used by `resolveReadScope`/`resolveWriteScope` signatures).
- [x] Delete the private copy in `src/memory/snapshot.ts:172` and import from `scope.ts`. NOTE: `MemoryScope` type import dropped (was only used by the deleted local function's signature); `ActiveScope` kept.
- [x] Delete the private copy in `src/memory/search.ts:306` and import from `scope.ts`.
- [x] Run `bun test src/memory` and `bun run typecheck`. Existing memory tests must pass unchanged (behavior identical, only the call site changed).

Commit: `phase 1: centralize active-scope conversion`

## Phase 2: Introduce the caller-typed context module

- [x] Add `src/memory/context.ts` exporting the `MemoryCaller` discriminated union (`{ kind: "main" } | { kind: "named-subagent"; name: string } | { kind: "anonymous-subagent" }`) and the caller→knob projections (`personaPolicyForCaller`, `personaSectionFor`, `includeAgentsFor`). The caller-typed entry point is `formatSnapshot({ caller })` itself — `snapshot.ts` imports the projections and derives `includePersona` / `includeAgents` / `personaPolicy` from `caller` internally. A separate `buildMemoryContext` wrapper was rejected because it would create a circular import (context.ts → snapshot.ts → context.ts); this satisfies design D2's explicit alternative ("or pass `caller` into `formatSnapshot`"). Covers: `Memory context assembly is caller-typed`.
- [x] Move or re-export `personaPolicyFor` and `PersonaPolicy` so `snapshot.ts` and `tool.ts` import them from one place (decision D3 finalized here: prefer moving to `context.ts` so the context module owns all caller-kind policy). NOTE: the *caller-typed* resolver `personaPolicyForCaller` lives in `context.ts` and is the single home for caller→PersonaPolicy — used by both the search tools and the snapshot's `## relevant memory` path. The existing `personaPolicyFor(activeScope)` stays in `search.ts` (it keys off `activeScope.namedAgent`, not caller kind) and is no longer used by the snapshot path after the review fix; `PersonaPolicy` stays defined in `search.ts` and is imported by `context.ts`. Tool.ts now imports `personaPolicyForCaller` from `context.ts` instead of the old `resolveSearchPersonaPolicy` helper (deleted).
- [x] Add `src/memory/context.test.ts` asserting: main sees all personas; named subagent sees only its own persona; anonymous subagent sees no personas; `formatSnapshot({ caller })` output matches the prior knob-based output for each caller kind. Covers: `Memory context assembly is caller-typed` scenarios.
- [x] Run `bun test src/memory/context.test.ts` and `bun run typecheck`.

Commit: `phase 2: add caller-typed memory context module`

## Phase 3: Route callers through the context module

- [x] Update `src/memory/snapshot.ts`: `FormatSnapshotArgs` accepts a `caller: MemoryCaller`; derive `includePersona`/`includeAgents` internally. On-wire snapshot output unchanged. Covers modified: `Snapshot format for prompt injection`.
- [x] Update `src/agent/mod.ts`: replace the `formatSnapshot({ ..., includeAgents: true, promptText })` call (`mod.ts:375-381`) and the `createMemorySearchTool({ ..., includeAgents: true })` call (`mod.ts:193`) with caller-typed equivalents (`{ kind: "main" }`). NOTE: also updated `createMemoryReadIndexTool` at `mod.ts:187` (same knob).
- [x] Update `src/subagents/execution.ts`: replace the single `formatSnapshot` call (`execution.ts:200-207`) and the `createMemorySearchTool({ persona: ... })` knob (`execution.ts:143-146`) with caller-typed equivalents (`{ kind: "named-subagent", name }` or `{ kind: "anonymous-subagent" }`). There is only one `formatSnapshot` call in this file. NOTE: also updated `createMemoryReadIndexTool` at `execution.ts:130` (same knob).
- [x] Update existing snapshot/subagent tests that assert on the old knob shapes. NOTE: updated `snapshot.test.ts` (17 sites), `tool.test.ts` (5 sites + test descriptions), `quarantine.test.ts` (2 sites), and `subagents/test/memory.suite.ts` (1 site). `createMemoryReadIndexTool`/`createMemorySearchTool` now take `caller` instead of `includeAgents`/`persona`.
- [x] Run `bun test src/memory src/agent/mod.test.ts src/subagents` and `bun run typecheck`.

Commit: `phase 3: route memory callers through the context module`

## Phase 4: Boundary check and validation

- [x] Grep the tree for any remaining `includeAgents`, `includePersona`, or hand-rolled `persona: { kind:` knobs at call sites outside the memory layer; the only remaining occurrences should be inside `context.ts`/`snapshot.ts`/`tool.ts` internals.
- [x] Grep for any remaining private `activeMemoryScopeFor`/`activeMemoryScope` definitions outside `src/memory/scope.ts`; fix stragglers.
- [x] Run full validation: `litespec validate memory-context-assembly`, `bun test`, `bun run typecheck`.

Commit: `phase 4: finalize memory context assembly`
