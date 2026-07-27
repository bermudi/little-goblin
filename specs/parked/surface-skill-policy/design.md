# surface-skill-policy — Design

## Architecture

### Policy is a validated Surface setting

The dependency provides `SkillPolicy`, `SourceSelection`, defaulting, and resolution. The Surface settings DTO gains optional `skillPolicy`; absence is interpreted as `DEFAULT_SKILL_POLICY` and is not written until a mutation.

Canonical selected-name arrays are validated, sorted, and unique before persistence. `selected` requires at least one name; users select `none` for an empty source. The complete policy is atomically replaced in the SurfaceId-keyed settings file so partial source writes cannot survive a crash.

This ownership matches model/thinking/project assignment semantics:

```text
Surface ── owns SkillPolicy
Conversation ── owns immutable ExecutionEnvironment + history
Runtime ── freezes resolve(Conversation.environment, Surface.policy)
```

Two Surfaces at one canonical project root therefore share catalog files but not selection. `/new` keeps policy. Compatible `/resume` moves history and recreates the runtime under destination policy.

### A lifecycle operation owns policy transitions

`ConversationLifecycle` (or its pre-lifecycle compatibility coordinator during phased build) exposes:

```ts
inspectSkillPolicy(surface): SkillPolicyStatus
setSkillSelection(surface, source, selection): Promise<SkillPolicyStatus>
reloadSkills(surface): Promise<SkillPolicyStatus>
```

Mutation ordering is:

1. parse and canonicalize the candidate;
2. resolve candidate against the Surface's effective Execution Environment, even if currently unbound;
3. if resolution fails, return diagnostics without writes or runtime effects;
4. wait behind any active turn (command queue timing);
5. atomically persist the whole policy;
6. synchronously invalidate/remove the bound runtime identity and prompt-queue entry;
7. asynchronously dispose old runner; log cleanup failure without restoring it.

An atomic settings failure leaves policy/runtime unchanged. After persistence, dispatcher context comparison rejects the old policy even if process-local cleanup fails. `reloadSkills` skips persistence but follows steps 4, 6, and 7.

### Runtime context records policy identity

Dispatcher runner entries become `{runner, context}` where context includes SurfaceId, ConversationId, Execution Environment identity, canonical policy fingerprint, and the resolver's manifest fingerprint. `getOrCreateRunner` compares binding/environment/policy before cache return. Catalog files are not rescanned per turn; reload or runtime recreation updates the manifest.

Resolution emits one structured creation log with source modes and selected `{source,name,path}` entries, plus diagnostics. Skill bodies never enter logs. Errors include SurfaceId/ConversationId/environment but no prompt or secrets.

### `/skills` is a Surface command

Parsing is deliberately narrow:

```text
/skills
/skills goblin all|none
/skills environment all|none
/skills host all|none
/skills <source> only <skill-name>...
/skills reload
```

No argument is instant and non-creating. Mutations and reload are queue-timing. On an unbound Surface, policy changes still validate from Surface assignment/default environment and persist without creating history; there is no runtime to dispose. Status reports policy followed by resolved catalog entries grouped by source and warns about malformed unselected catalog entries without exposing file bodies.

## Decisions

### Decision: Surface owns selection

**Chosen:** policy is SurfaceId-keyed.

**Why:** personal topics can share workspace while needing different skills, and project Surfaces can share a root while choosing different Goblin/host exposure. Conversation ownership would lose policy on `/new` and incorrectly carry it on `/resume`.

### Decision: Destination policy wins

**Chosen:** moving a Conversation recreates its runtime with destination policy.

**Why:** skills are runtime capability posture like model/thinking and delivery tools. Filesystem authority remains Conversation-owned and compatible; skill availability is explicitly visible Surface configuration.

### Decision: Validate against live catalogs before write

**Chosen:** missing selected names and active collisions reject the mutation.

**Why:** accepting an unusable policy moves failure to the next user message and can silently remove expected capability. The filesystem is local and catalogs are bounded, so eager validation is cheap.

### Decision: Persist before invalidating runtime

**Chosen:** after the turn settles, atomically write policy, then synchronously invalidate.

**Why:** invalidating first makes a failed settings write needlessly destroy a valid runtime. Persisting first is safe because every cache return compares current policy; synchronous invalidation closes the same-process window.

### Decision: No reusable profiles yet

**Chosen:** store explicit policy per Surface.

**Why:** profiles add a second inheritance/update lifecycle. Add them only when duplicated real policies create maintenance pain.

## File Changes

### New files

- **`src/commands/skills.ts`** — parse/status formatting for the narrow command grammar and source-qualified diagnostics.
- **`src/commands/skills.test.ts`** — unbound inspection/mutation, source modes, selected names, missing/conflict errors, timing, and reload.
- **`src/orchestration/skill-policy-lifecycle.ts`** — deep validate/persist/invalidate operation if `ConversationLifecycle` is not yet available at build phase; later folded behind its public interface.
- **`src/orchestration/skill-policy-lifecycle.test.ts`** — write/disposal ordering, failure boundaries, and no stale authority.

### Modified files

- **`src/sessions/topic-settings.ts`** — schema/default/read/atomic complete-policy replacement keyed by SurfaceId.
- **`src/sessions/topic-settings.test.ts`** — canonical sorting, invalid DTOs, absent default, shared-project independence, restart.
- **`src/commands/registry.ts`** — register `/skills`, dynamic read/mutation timing, and lifecycle dependency.
- **`src/commands/dispatch.ts` / command dependency types** — expose narrow inspect/change/reload seam rather than stores/runners.
- **`src/orchestration/dispatcher.ts`** — resolve destination policy, store context fingerprints, reject stale cache entries, synchronously invalidate before disposal.
- **`src/orchestration/dispatcher.test.ts`** — policy cache mismatch, compatible move, reload, unrelated-runtime concurrency, cleanup failure.
- **`src/bot.ts` / composition root** — wire settings, resolver, dispatcher runtime host, and command operation.
- **`src/commands/debug.ts`** — include effective source modes and manifest names/provenance where debug output is assembled.
- **`specs/changes/conversation-lifecycle/*` implementation-facing call sites** — use destination Surface policy on move; no Conversation schema field.

### Intentionally unchanged

- **Skill files/catalog paths** — owned by prerequisite changes.
- **Conversation state** — no policy or manifest persisted with history.
- **Project assignment** — skill policy may change without changing immutable environment.
- **Subagent runtime** — dependent patch consumes the resolved manifest.
