# conversation-lifecycle — Tasks

## Phase 1: Introduce canonical Conversation persistence

- [ ] Create `ConversationId`/`ConversationState`, 10-hex ID generation, complete canonical state validation, and compatibility parsing for legacy SessionState under unchanged `state/sessions/` paths.
- [x] Create `ConversationStore` with create/load/list/name/archive operations that never edit bindings.
- [x] Remove routing/model/thinking fields from canonical Conversation writes while retaining migration-only reads.
- [x] Add store/state tests for atomic writes, filesystem layout, archive/list filtering, names, missing directories, and immutable environment preservation.
- [x] Run touched session tests and `bun run typecheck`.

## Phase 2: Add the deep conversation lifecycle

- [x] Define the narrow `ConversationRuntimeHost` invalidation/quiescence interface and implement it in `TurnDispatcher` with synchronous runner/queue removal before cleanup.
- [ ] Adapt ConversationId-keyed dispatcher runtime assembly to await the dependency-provided `CapturedMemoryContext` before registration, derive the dependency-provided `TranscriptWriterContext` from its authority, and recheck current binding/runtime generation after capture.
- [x] Create `ConversationLifecycle` with non-creating inspect, authorized resolve-or-start, rotate, compatible resume/move, archive, and environment-filtered listing, using the dependency-provided lifecycle-transition lock for every binding-changing operation.
- [x] Enforce one active Surface binding per Conversation through one atomic binding-map write; preserve displaced/rotated Conversations as resumable.
- [x] Verify environment compatibility before runtime disposal or binding mutation; for rotate, quiesce before creating the fresh Conversation so failed quiescence leaves both binding and Conversation store unchanged.
- [ ] Add lifecycle tests for DM/topic lazy creation, concurrent unbound creation, rotate, same-target idempotence, two-runtime resume, incompatible resume, quiescence failure before Q creation, post-Q binding-write failure leaving Q resumable, invalidated-runner non-reuse, and stale capture invalidation.
- [ ] Change archive ordering to clear the binding before moving the directory; add a failure test proving a post-unbind move failure leaves the Conversation unbound, unarchived, resumable, and without a restored runtime.
- [ ] Add dispatcher adaptation tests for capture failure, binding/generation change during capture, completed-capture registration, and replacement-runtime writer context.
- [ ] Run lifecycle/dispatcher tests and `bun run typecheck`.

## Phase 3: Route authorized intake through lifecycle

- [ ] Wire ordinary authorized text and media intake through `resolveOrStart(surface)` for every supported Surface, including DMs and guest text, while preserving the already-landed attachment destination, collision-safe save behavior, and stale-runtime guard without extending that intake seam.
- [ ] Route commands, status reads, scheduler inspection, internal jobs, and proactive-delivery seams through non-creating `inspect(surface)`.
- [ ] Replace direct SessionManager binding/create side effects in intake with ConversationLifecycle results and runtime-host behavior; route user-visible and synthetic transcript writes through the runtime's captured `TranscriptWriterContext`, never a live binding lookup.
- [ ] Add intake tests proving first DM/media creation, command non-creation, guest creation, unbound status behavior, destination transcript provenance through the writer context, and unrelated Conversation concurrency.
- [ ] Run Telegram intake tests and `bun run typecheck`.

## Phase 4: Convert lifecycle commands

- [ ] Update `/new` to rotate through ConversationLifecycle while preserving Surface environment/settings/automation and leaving prior history resumable.
- [ ] Update `/resume` to list only named compatible Conversations, recheck compatibility, atomically move bound targets, and report incompatible/missing/ambiguous cases without effects.
- [ ] Update `/archive`, `/name`, `/start`, `/debug`, help, and replies to use Conversation terminology and non-creating inspection.
- [ ] Preserve queue/instant timing and stale-runtime behavior for each command; do not mutate Telegram topic UI.
- [ ] Add command and integration tests for all lifecycle transitions, terminology, compatible cross-Surface resume with destination memory/provenance capture, and no accidental creation.
- [ ] Run command tests and `bun run typecheck`.

## Phase 5: Move model and thinking preferences to Surface

- [ ] Extend Surface settings with model/thinking preferences and atomic read/write helpers.
- [ ] Update `/model` and `/think` to persist by Surface, apply compatible changes to a current runtime, and work without creating a Conversation.
- [ ] Make runtime creation read destination Surface model/thinking preferences and remove canonical reads/writes of Conversation model/thinking fields; leave skill-policy resolution unchanged for the later `surface-skill-policy` change.
- [ ] Add tests for preference survival across `/new`/archive, destination preference after `/resume`, unbound updates, and migration precedence.
- [ ] Run model/think/settings/runner tests and `bun run typecheck`.

## Phase 6: Make schedules Surface-owned

- [ ] Remove durable conversation/session ownership from canonical schedule records and key create/list/mutate/cap/heartbeat operations by SurfaceId.
- [ ] Update `/schedule` and `schedule_turn` authority to the invoking/current Surface, including a current-binding check before agent mutations.
- [ ] Change scheduler ordering to inspect binding before claim; leave unbound occurrences due/enabled and emit one de-duplicated pending signal per occurrence.
- [ ] Dispatch a claimed occurrence through the Surface's current Conversation runtime and preserve stale-runtime dropping if the binding changes before execution.
- [ ] Add schedule/store/tool/loop tests for rotation survival, unbound pending, overdue one-time dispatch after rebinding, per-Surface caps, source authority, and stale runtime.
- [ ] Run scheduler/command tests and `bun run typecheck`.

## Phase 7: Move heartbeat prompts to Surface state

- [ ] Add validated `surfaceHeartbeatPath(home, SurfaceId)` under `state/surfaces/<SurfaceId>/HEARTBEAT.md` and traversal tests.
- [ ] Resolve Surface-specific, global, then constant heartbeat prompts at dispatch while preserving whitespace, marker, and fail-loud behavior.
- [ ] Ensure `/new`, `/resume`, `/archive`, and unbinding leave heartbeat record/prompt untouched; unbound due heartbeat remains pending.
- [ ] Add heartbeat path/loop/command tests for lifecycle survival, fallback, updated file reads, and non-ENOENT errors.
- [ ] Run heartbeat/session path tests and `bun run typecheck`.

## Phase 8: Migrate split ownership

- [ ] Create `conversation-migration.ts` as canonical offline filesystem step 4; canonicalize Conversation records, copy bound legacy model/thinking preferences to Surface, convert schedule ownership, and move heartbeat prompts.
- [ ] Detect legacy multi-bound Conversations during precomputation and fail before writes with the ConversationId and all candidate SurfaceIds; require explicit operator repair rather than selecting by lexical or map order.
- [ ] Fail loudly on duplicate heartbeat conflicts or differing source/destination prompt files; preserve all Conversation directories and non-owner schedule fields.
- [ ] Precompute and validate every lifecycle transformation before the first lifecycle-step write, use atomic replacement per target file, register step 4 after transcript-provenance step 3 in `src/migrate.ts`, and set `CURRENT_STATE_VERSION = 4`; do not wire migration into startup or add mixed-generation/restart recovery.
- [ ] Add migration fixtures for filesystem version 3-to-4 exactly-once execution, every ownership field, successful complete output, ambiguous multi-binding refusal, prompt conflicts, malformed state, and non-ENOENT failures.
- [ ] Remove obsolete public partial-binding APIs and update compatibility aliases/JSDoc without renaming filesystem paths.
- [ ] Run `bun test`, `bun run typecheck`, and `litespec validate conversation-lifecycle`.
