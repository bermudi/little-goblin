# conversation-lifecycle — Design

## Architecture

### Lifetimes become explicit

The hard dependency changes provide complete `Surface` identity, Surface-derived captured memory context, event-time transcript Surface provenance, and immutable `ExecutionEnvironment`. This change stops using one `SessionState` as all three:

```text
Surface (Telegram lane)
   │ 0..1
   ▼
Binding ─────────► Conversation (durable history + immutable environment)
                         │ 0..1 while bound/active
                         ▼
                  ConversationRuntime
                  (AgentRunner + prompt queue)
```

A Surface has at most one current Conversation. A Conversation has at most one active Surface. The runtime is disposable and contains Surface-derived tools, memory scope, output routing, model, and thinking preference; it is not persisted identity.

Existing `state/sessions/<id>/` directories stay in place. New code uses `ConversationState` and `ConversationId`, with compatibility aliases at old module edges while callers migrate. Conversation records no longer treat creation-time `chatId`/`topicId` as routing authority.

### A deep lifecycle module owns complete transitions

`src/orchestration/conversation-lifecycle.ts` exposes the caller interface:

```ts
interface ConversationLifecycle {
  inspect(surface: Surface): ConversationState | null;
  resolveOrStart(surface: Surface): Promise<ConversationState>;
  rotate(surface: Surface): Promise<ConversationState>;
  resume(surface: Surface, target: ConversationId): Promise<ConversationState>;
  archive(surface: Surface): Promise<void>;
  listResumable(surface: Surface): ConversationState[];
}
```

This seam belongs in orchestration because complete transitions span filesystem persistence and runtime quiescence. Every binding-changing operation runs under the process-wide `LifecycleTransitionLock` introduced by `immutable-project-environments`; per-runtime queues cannot serialize an unbound Surface or a `/resume` touching two Surfaces. Internally it uses narrow adapters:

- `ConversationStore`: create/load/list/archive/update-name under legacy session paths;
- `BindingStore`: one atomic SurfaceId-to-ConversationId map from the Surface dependency;
- `SurfaceSettings`: execution assignment plus model/thinking preferences;
- `ConversationRuntimeHost`: invalidate/quiesce a runtime by ConversationId.

`SessionManager` remains as a compatibility facade while call sites move; it delegates persistence behavior rather than remaining the public lifecycle interface. Commands and Telegram intake never edit bindings or coordinate runner side effects themselves.

Transition ordering is deliberately runtime-first, binding-second:

- **rotate:** invalidate/quiesce old P; only after quiescence succeeds create fresh compatible Conversation Q; atomically bind Surface to Q; P remains unbound.
- **resume:** validate target/environment without effects; identify target's source Surface and destination's displaced Conversation; invalidate/quiesce both runtimes; atomically remove every target binding and bind target at destination; displaced history remains unbound.
- **archive:** invalidate/quiesce current runtime; atomically clear its binding; then archive its directory. Surface settings/automation remain.

If rotate quiescence fails, no fresh Conversation is created and the binding remains unchanged. Runtime identity is invalidated synchronously before asynchronous cleanup, so stale queued work cannot regain authority; a later retry may construct a fresh runtime for the still-bound Conversation. If Q is created after successful quiescence but the atomic binding replacement fails, P remains bound and Q may remain as an unbound resumable Conversation; the operation logs that boundary and never deletes history to fake rollback. If the archive directory move fails after the binding is cleared, the Conversation remains unbound, unarchived, and resumable; the operation fails loudly and never restores the invalidated runtime.

### User content creates; inspection does not

Telegram intake gets two explicit paths:

```text
authorized ordinary text/media -> resolveOrStart(surface)
commands/status/scheduler       -> inspect(surface)
```

All supported ordinary Surfaces, including DMs and topic variants, lazily create. `/new` and dependency-owned `/project` are explicit creation commands. `/start`, `/debug`, `/name`, `/archive`, `/resume` listing, `/schedule`, scheduler ticks, internal jobs, and future proactive delivery never create through lookup.

This removes the current implicit policy inside `SessionManager.resolve()` where topics/supergroups/guests create but DMs return `null`. Guest text remains an authorized ordinary interaction and therefore creates through the same lifecycle operation.

### Environment-compatible resume

Every target already carries the immutable environment introduced by `immutable-project-environments`. `listResumable(surface)` filters before presenting names. `resume` rechecks equality immediately before any runtime disposal or binding write; stale Surface settings therefore cannot slip through a list-then-resume race.

A named personal Conversation can move among personal Surfaces. A Project-A Conversation can move among Surfaces assigned to the same canonical Project-A root. A project/personal or Project-A/Project-B move fails without side effects.

When a bound target moves, its prior Surface becomes unbound. The next authorized ordinary message there lazily starts fresh history. The destination's displaced Conversation remains unbound and can be resumed later.

### State ownership is split by lifetime

The canonical owners are:

| State | Owner |
|---|---|
| Surface kind and Telegram address | Surface |
| project assignment | Surface |
| model and thinking preference | Surface |
| active memory-context projection | derived from current Surface |
| schedules and heartbeat configuration | Surface |
| surface heartbeat prompt file | Surface |
| current Conversation pointer | Binding |
| ID, name, creation time | Conversation |
| transcript, events, metrics, pi history | Conversation |
| immutable execution environment | Conversation |
| AgentRunner and prompt queue | ConversationRuntime |

`SurfaceSettings` extends the dependency's SurfaceId-keyed record with `modelName` and `thinkingLevel`. `/model` and `/think` persist there; a live runtime may apply a supported change immediately, while every replacement runtime reads the Surface preference. Old Conversation fields are migration-only and no longer consulted.

### Surface-owned schedules resolve late

`ScheduledTurn` replaces durable `sessionId` ownership with `surfaceId`. Existing schedule source/authority semantics remain, but store queries, agent caps, heartbeat uniqueness, and command management are per Surface.

The scheduler does not claim an occurrence until `lifecycle.inspect(surface)` returns a bound compatible Conversation. If unbound, it leaves `nextRunAt` and state unchanged and emits one structured debug/metric signal per `(scheduleId, nextRunAt)` rather than logging every minute. The next tick after a binding appears can claim and dispatch the overdue occurrence once.

After claiming, dispatch captures the current runtime. If `/new`, `/resume`, or `/archive` invalidates it before execution, the stale-runtime guard drops that captured work. Existing one-shot completion and recurrence advancement happen only at claim, as today.

The main-agent `schedule_turn` tool is closed over the runtime's bound Surface, not ConversationId. It verifies the runtime is still current on that Surface before mutation. Human authority, agent/user provenance, redaction, and last-writer ownership stay unchanged.

### Heartbeat configuration follows Surface

The heartbeat schedule is Surface-owned. Its user-editable prompt moves from the Conversation directory to:

```text
$GOBLIN_HOME/state/surfaces/<canonical SurfaceId>/HEARTBEAT.md
```

`surfaceHeartbeatPath(home, surfaceId)` parses/canonicalizes before joining, preventing traversal. Colons and minus signs in canonical v1 SurfaceIds are filesystem-safe on the supported Linux deployment. Read semantics remain ENOENT/whitespace fallback and fail-loud otherwise.

At dispatch, prompt order is:

1. Surface-specific `HEARTBEAT.md`;
2. global workspace `HEARTBEAT.md`;
3. system constant.

Rotation, movement, archive, and temporary unbinding do not mutate the heartbeat. An unbound due heartbeat remains pending like any other schedule.

### Runtime context always comes from the current binding

`TurnDispatcher` continues to key runners and queues by ConversationId. `getOrCreateRunner` accepts the current `(conversation, surface)` pair and verifies it against a narrow binding/settings read seam before returning an existing runtime. A runtime created on X is never returned after the Conversation moves to Y.

Construction combines:

- Conversation: pi history and immutable Execution Environment;
- destination Surface: Telegram tools/sink, model/thinking preferences, schedule tool ownership, and delivery parameters;
- `surface-derived-memory-context`: one immutable `CapturedMemoryContext` completed before runtime registration;
- `transcript-surface-provenance`: one `TranscriptWriterContext` derived from `CapturedMemoryContext.authority.sourceSurfaceId` and closed over every user-visible transcript write performed by that runtime.

These last two inputs are hard prerequisites rather than sequencing advice. Without them, moving a Conversation would either retain memory authority derived from legacy creation metadata or write new history without event-time destination provenance.

`disposeRuntime` removes runner and queue map entries synchronously, then awaits `AgentRunner.dispose()` and existing `cancelBySession(conversationId)` compatibility cleanup. Work-run lifetime is intentionally unchanged here; a later patch will separate attached and detached work.

### Offline versioned migration preserves history

`src/sessions/conversation-migration.ts` implements filesystem migration step 4 in the canonical append-only list owned by `src/migrate.ts`, advancing `CURRENT_STATE_VERSION` from 3 to 4 only after success. It runs only through explicit `bun run migrate` while the service is stopped, after the prerequisite Surface, execution-environment, and transcript-provenance steps. Startup performs only the state-version gate; it never invokes this step.

Before its first write, the step computes and validates the complete lifecycle transformation:

1. Convert `SessionState` to `ConversationState`, retaining IDs, names, timestamps, immutable environments, and paths; remove routing/model/thinking fields from canonical writes.
2. For each Surface binding, copy the currently bound legacy Conversation's model/thinking fields into that Surface setting when the Surface has no canonical preference. Unbound Conversation preferences do not travel.
3. Detect multi-bound Conversations while computing migration output. If one Conversation has several candidate SurfaceIds, fail before any lifecycle-step write and report the ConversationId plus every candidate SurfaceId. The operator must choose and repair the retained binding explicitly; migration does not infer recency or invent a winner.
4. Convert schedules from `(sessionId, surface)` to Surface ownership, preserving every non-owner field. Duplicate legacy heartbeats on one Surface fail loudly rather than guessing.
5. Move the active Surface heartbeat prompt from the legacy owner Conversation path to the Surface path. If both source and destination exist with different non-whitespace content, fail with both paths; identical content may be accepted as a non-conflicting destination.

After successful precomputation, each target file is replaced atomically and Conversation directories are never deleted. The canonical migration command owns the pre-mutation backup and advances `stateVersion` only after the step returns successfully. The step is deliberately not required to accept mixed-generation state, restart after partial writes, or be idempotent; failure recovery restores the command's backup as required by decision 0038.

## Decisions

### Decision: Lifecycle seam belongs in orchestration

**Chosen:** A deep `ConversationLifecycle` coordinates stores and runtime host; commands/intake call it.

**Why:** Putting runtime disposal into a filesystem store reverses dependencies, while exposing binding/store/runtime steps to every caller recreates the current bug. Orchestration is the honest seam for a complete transition.

### Decision: Conversation moves; it is never shared

**Chosen:** `/resume` atomically clears the old binding and moves one compatible Conversation.

**Why:** One runner contains Surface-specific tools, memory, and delivery context. Simultaneous bindings either require separate runtimes with shared pi history (unsafe) or one stale runtime (current bug). Movement preserves pi-style `-r` value without inventing multi-surface collaboration.

### Decision: Destination Surface settings win on resume

**Chosen:** model/thinking preferences, captured memory context, tools, and delivery come from the destination; CWD/history remain Conversation-owned.

**Why:** Model and presence are lane preferences, while changing filesystem authority would corrupt Conversation meaning. Skill policy is deliberately deferred to `surface-skill-policy`; layered Conversation overrides are deferred until a real use case exists.

### Decision: Automation is Surface-owned

**Chosen:** schedules and heartbeat survive Conversation changes and resolve current history at dispatch.

**Why:** `/new` means fresh context, not “forget my reminders.” Capturing ConversationId conflates a delivery commitment with model history. Surface remains stable while histories rotate.

### Decision: Unbound due work remains pending

**Chosen:** do not auto-create, claim, advance, or disable.

**Why:** Only authorized user interaction should create history. Disabling loses an explicit commitment; auto-creating gives timers hidden lifecycle authority. Pending preserves intent until the user returns. Topic reachability/deletion will later add suspension policy.

### Decision: Ambiguous legacy multi-bindings require explicit repair

**Chosen:** fail before migration writes and identify every candidate SurfaceId; do not select a binding automatically.

**Why:** Legacy state has no reliable last-active Surface timestamp. Lexical order is deterministic but has no domain meaning and can silently move routing, memory, tools, and delivery authority. Explicit repair is noisier but preserves operator intent.

### Decision: Keep filesystem paths and compatibility ownership names

**Chosen:** no `state/sessions/` rename and no work-run schema migration here.

**Why:** Path churn adds backup/migration risk without domain leverage. External/subagent work changes have their own active proposals and need explicit attached/detached semantics rather than incidental renaming.

## File Changes

### New files

- **`src/sessions/conversation.ts`** — `ConversationId`, `ConversationState`, ID generation, and canonical state validation while reusing legacy paths.
- **`src/sessions/conversation-store.ts`** — create/load/list/name/archive persistence without binding behavior.
- **`src/orchestration/conversation-lifecycle.ts`** — deep inspect/resolve-or-start/rotate/resume/archive interface and runtime-first transition ordering.
- **`src/orchestration/conversation-runtime-host.ts`** — narrow adapter implemented by `TurnDispatcher` for synchronous invalidation plus bounded cleanup.
- **`src/sessions/conversation-migration.ts`** — precomputing offline filesystem step 4, which splits ownership, rejects ambiguous multi-bindings, and migrates schedules/prompts under the canonical migration runner; `src/migrate.ts` and `src/state-version.ts` register the step and set required version 4.
- **`src/sessions/conversation.test.ts`, `src/sessions/conversation-store.test.ts`, `src/orchestration/conversation-lifecycle.test.ts`, `src/sessions/conversation-migration.test.ts`** — lifecycle invariants, environment filtering, transition failures, complete migration outputs, and migration conflicts.

### Modified session/surface files

- **`src/sessions/types.ts`** — introduce canonical ConversationState and retain SessionState alias/legacy parser only where required.
- **`src/sessions/state.ts`** — canonical Conversation state reads/writes and migration-only legacy decoding.
- **`src/sessions/bindings.ts`** — add atomic move/rotate helpers that enforce at-most-one binding per Conversation.
- **`src/sessions/manager.ts`** — shrink to compatibility facade over ConversationStore/bindings/settings; remove public partial rebinding choreography.
- **`src/sessions/topic-settings.ts`** — add Surface-owned model/thinking fields and remove reads from Conversation state.
- **`src/sessions/paths.ts`** — add validated `surfaceHeartbeatPath`; retain legacy `heartbeatMdPathForSession` for migration reads only.
- **`src/sessions/mod.ts`** — export Conversation terminology and lifecycle read types; mark compatibility aliases.
- **Session/settings/bindings/path tests** — canonical state, preference survival, path traversal, and one-binding assertions.

### Modified orchestration and Telegram files

- **`src/orchestration/dispatcher.ts`** — implement runtime-host interface; verify current binding/context on get/create; invalidate maps before cleanup; keep queues keyed by ConversationId.
- **`src/tg/intake.ts`** — use `resolveOrStart` only for authorized ordinary content; commands/media/status use explicit lifecycle paths; write user-visible transcript entries with the runtime's captured `TranscriptWriterContext`; stop orchestrating binding/runtime side effects.
- **`src/bot.ts` / composition wiring (`src/index.ts` as applicable)** — construct ConversationStore/Lifecycle and inject narrow readers/runtime host plus the dependency-provided memory-capture and transcript-writer seams.
- **`src/tg/intake.test.ts`, dispatcher tests** — DM lazy creation, moved runtime context, destination provenance, stale queued effects, and unrelated-conversation concurrency.

### Modified command files

- **`src/commands/registry.ts`** — inject ConversationLifecycle; make `/new`, `/resume`, `/archive` call complete operations; persist `/model` and `/think` by Surface; update descriptions.
- **`src/commands/new.ts`, `src/commands/resume.ts`, `src/commands/archive.ts`, `src/commands/name.ts`, `src/commands/debug.ts`, `src/commands/start.ts`, `src/commands/model.ts`, `src/commands/think.ts`** — conversation terminology, compatible listing/resume, non-creating inspection, and Surface preferences.
- **`src/commands/schedule.ts`** — manage schedules by Surface even without a bound Conversation.
- **Command tests and integration tests** — terminology, no accidental creation, state survival, move semantics, and compatibility errors.

### Modified scheduler files

- **`src/scheduler/types.ts`** — remove durable Conversation/session owner; retain SurfaceId and optional creation provenance only if useful for diagnostics.
- **`src/scheduler/store.ts`** — query/cap/mutate by SurfaceId; migrate legacy ownership; preserve source authority.
- **`src/scheduler/loop.ts`** — inspect current binding before claim; leave unbound occurrence pending; dispatch current Conversation; de-duplicate pending logs.
- **`src/scheduler/tool.ts`** — bind tool authority to current Surface and verify runtime binding before mutation.
- **Scheduler/store/tool tests** — rotation survival, unbound pending, overdue later dispatch, per-Surface caps, and stale runtime rejection.

### Modified heartbeat files

- **`src/scheduler/loop.ts`** — resolve Surface heartbeat file before global/default prompt.
- **`src/workspace/paths.ts` and `src/sessions/paths.ts`** — keep global helper and add Surface-state helper in the sanctioned path module.
- **Heartbeat command/loop tests** — prompt migration, new/resume/archive survival, fallback, and fail-loud reads.

### Files intentionally unchanged

- **Conversation directory layout and transcript/event/metrics formats** — naming changes do not justify data movement.
- **Project assignment/environment mechanics** — owned by `immutable-project-environments`.
- **Attachment download/destination/naming behavior** — owned by `personal-attachment-intake`; this change only ensures attachment work obeys runtime invalidation during lifecycle transitions.
- **External-agent/subagent ownership schemas** — `cancelBySession` compatibility remains until attached/detached work is designed.
- **Memory scope persistence** — still derives from current Surface and does not merge merely because Conversations share an environment.
