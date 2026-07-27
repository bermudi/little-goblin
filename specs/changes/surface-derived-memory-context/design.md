# surface-derived-memory-context — Design

## Architecture

### Project Surface identity into one memory authority

The pure Surface value supplied by `telegram-surface-identity` becomes the only routing input to active memory:

```text
Surface ── resolveActiveScope ──► ActiveScope ── activeMemoryScopeFor ──► MemoryScope
   │                                  │
   └── surfaceId(surface)             └── chatId remains the discovery boundary
```

`src/memory/scope.ts` owns both conversions. Topic Surfaces of every container project to `topics/<chatId>/<topicId>`; DM, topicless supergroup, and guest project to singleton `general`. The chat ID remains in `ActiveScope` even for `general`, because curated scope and transcript/discovery boundary are different facts.

`ActiveScope` no longer carries `namedAgent`. `MemoryCaller` remains the sole persona-policy authority. This prevents impossible values where a deterministic Surface projection disagrees with caller identity.

### Capture before a conversation runtime exists

A new memory deep module exposes two context forms:

```ts
interface SurfaceMemoryAuthority {
  kind: "surface";
  sourceSurfaceId: SurfaceId;
  activeScope: ActiveScope;
}

interface CapturedMemoryContext {
  authority: SurfaceMemoryAuthority;
  caller: MemoryCaller;
  frozenSummary: string | null;
  frozenUserBody: string;
  frozenActiveMemoryBody: string;
}

type InternalMemoryContext = {
  kind: "internal";
  caller: { kind: "internal" };
};
```

`captureRuntimeMemoryContext(surface, caller, store, getTopicName)` validates/encodes the Surface, projects ActiveScope, reads the frozen summary inputs, and completes formatting before returning. A caller cannot separately supply scope, chat, persona visibility, or a binding reader.

The conversation-runtime factory awaits capture before it registers an `AgentRunner`. Its in-flight map deduplicates concurrent creation for the same compatibility runtime identity. After capture resolves, the factory rechecks that the requested runtime/binding generation is still current; stale work is discarded rather than registered. A failed capture leaves no half-created current runtime.

Lazy pi `AgentSession` initialization consumes the completed capture. It does not reread the store for frozen-summary bodies and does not resolve routing. Per-turn relevant-memory search and both memory tools use the same capture, so summary, deduplication, search boundary, and writes cannot disagree.

### Make internal context unrepresentable as a Telegram Surface

Internal model work receives `InternalMemoryContext`, not `ActiveScope { chatId: 0 }`. Internal search may deliberately use the accepted all-transcript rule, but internal work has no ordinary active-memory write target and cannot call `resolveActiveScope`. The compatibility dreaming session may continue to exist until inner-life migration; it remains outside this type boundary.

### Capture subagents from parent authority

Subagent spawn receives the parent's `SurfaceMemoryAuthority`, never a locator or binding reader. It keeps the inherited ActiveScope and source Surface authority while deriving only the child's caller descriptor:

- generic child → anonymous-subagent caller;
- named child → named-subagent caller;
- recursive child → immediate parent's unchanged Surface authority plus its own caller.

Each invocation captures its own frozen summary from that authority. A running invocation remains immutable if the parent Conversation later moves.

Revival separates history from authority. Pi history is loaded from disk, but the new invocation receives the reviving parent's current capture. Legacy persisted `activeScope` may be parsed for diagnostics or migration only. Missing parent authority is an error before pi-session creation.

`TurnDispatcher` owns the one external `reviveSubagent(surface, conversationId, subagentId, prompt)` operation. Commands only parse/reply and call it; they never join a runner, capture, and Binding themselves. The dispatcher performs the operation through a lifecycle-provided current-binding guard, which holds the relevant transition exclusion while it verifies that the requested Surface is still bound to the Conversation, the registered runner is current for that same Surface, and its captured `sourceSurfaceId` equals that Surface. It starts/attaches the revived invocation before releasing the guard. A lifecycle replacement waits for the guarded operation; a stale or absent runner/capture fails before `AgentSession` creation. The lifecycle exposes only this guard, not runtime state, and the dispatcher remains the owner of runner identity and capture.

Internal dreaming extraction does not enter this ordinary subagent path and receives no memory tools merely to satisfy invocation construction.

## Decisions

### Decision: ActiveScope contains routing facts, not persona identity

**Chosen:** `Surface → ActiveScope` is deterministic; `MemoryCaller` owns named identity and persona visibility.

**Why:** Keeping `namedAgent` in both values creates disagreement states and makes Surface projection caller-dependent.

### Decision: Frozen capture completes before runtime registration

**Chosen:** Runtime construction is asynchronous and registration occurs only after summary inputs and text are complete.

**Why:** Capturing ActiveScope at construction but reading memory during lazy pi initialization would allow intervening writes to alter a supposedly frozen summary.

### Decision: One capture feeds summary, search, and tools

**Chosen:** `AgentRunner` and subagent execution receive the validated capture, not its individual policy fields.

**Why:** A shallow bag of scope/chat/persona knobs would recreate the authority leak at every call site. The capture is a deeper interface: one input pins several invariants.

### Decision: Revival captures new authority

**Chosen:** Persisted subagent history survives; persisted scope does not. Revival uses the reviving parent runtime's capture.

**Why:** A revived invocation is new work. Historical scope metadata describes where old work ran, not where the current parent is authorized now.

## File Changes

### New files

- **`src/memory/runtime-context.ts`** — Surface-backed/internal authority types and async capture factory.
- **`src/memory/runtime-context.test.ts`** — Exhaustive projection, capture timing, immutable summary inputs, caller separation, and internal-context tests.

### Memory

- **`src/memory/scope.ts`** — Replace locator projection with exhaustive Surface projection; remove persona identity from ActiveScope.
- **`src/memory/context.ts`** — Consume discriminated captured contexts and keep caller policy centralized.
- **`src/memory/snapshot.ts`** — Format frozen and relevant context from one capture.
- **`src/memory/search.ts` / `src/memory/tool.ts`** — Derive discovery, search, and write authority from the capture while preserving schemas.
- **`src/memory/mod.ts`** — Export the deep context interface and centralized conversions.

### Main runtime

- **`src/agent/mod.ts`** — Require `CapturedMemoryContext` and use it for summary, relevant memory, and tools.
- **`src/orchestration/dispatcher.ts`** — Await capture, deduplicate creation, and guard registration against stale runtime generations.
- **Focused agent/dispatcher tests** — Prove lazy initialization does not refresh, capture failure registers nothing, and replacement runtimes receive destination context.

### Subagents

- **`src/subagents/types.ts` / `meta.ts`** — Model invocation authority separately from audit-only legacy metadata.
- **`src/subagents/tool.ts` / `runner.ts` / `execution.ts`** — Close spawn/revive over parent authority, capture each invocation, and preserve caller/schema parity.
- **`src/subagents/test/*.suite.ts`** — Cover movement after spawn, recursion, persona separation, revival, and internal exclusion in the single mock harness.

### Intentionally unchanged

- Transcript entry format, transcript migration, transcript index schema, and dreaming promotion are owned by `transcript-surface-provenance`.
- Curated memory scope keys and public tool schemas remain unchanged.
- Conversation binding/lifecycle behavior remains owned by `conversation-lifecycle`.
