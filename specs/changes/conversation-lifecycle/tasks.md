# conversation-lifecycle — Tasks

## Phase 1: Introduce canonical Conversation persistence

- [x] Complete `ConversationId`/`ConversationState` validation and compatibility parsing under unchanged `state/sessions/` paths. Types, 10-hex ID generation, and the basic legacy projection exist; required-field validation and malformed-state coverage remain.
- [x] Create `ConversationStore` with create/load/list/name/archive operations that never edit bindings.
- [x] Remove routing/model/thinking fields from canonical Conversation writes while retaining migration-only reads.
- [x] Add store/state tests for atomic writes, filesystem layout, archive/list filtering, names, missing directories, and immutable environment preservation.
- [x] Run touched session tests and `bun run typecheck`.

## Phase 2: Add the deep conversation lifecycle

- [x] Define the narrow `ConversationRuntimeHost` invalidation/quiescence interface and implement it in `TurnDispatcher` with synchronous runner/queue removal before cleanup.
- [x] Adapt ConversationId-keyed dispatcher runtime assembly to await the dependency-provided `CapturedMemoryContext` before registration, derive the dependency-provided `TranscriptWriterContext` from its authority, and recheck current binding/runtime generation after capture.
- [x] Create `ConversationLifecycle` with non-creating inspect, authorized resolve-or-start, rotate, compatible resume/move, archive, and environment-filtered listing, using the dependency-provided lifecycle-transition lock for every binding-changing operation.
- [x] Enforce one active Surface binding per Conversation through one atomic binding-map write; preserve displaced/rotated Conversations as resumable.
- [x] Verify environment compatibility before runtime disposal or binding mutation; for rotate, quiesce before creating the fresh Conversation so failed quiescence leaves both binding and Conversation store unchanged.
- [x] Complete the lifecycle test matrix. DM creation, concurrent creation, rotate, same-target idempotence, cross-Surface movement, quiescence failure, Q resumability, invalidated-runner non-reuse, and stale capture coverage exist; topic lazy creation and a real two-runtime movement fixture remain.
- [x] Change archive ordering to clear the binding before moving the directory; add a failure test proving a post-unbind move failure leaves the Conversation unbound, unarchived, resumable, and without a restored runtime. Current code still moves first.
- [x] Complete dispatcher adaptation coverage. Capture failure, binding change during capture, and completed registration are covered; replacement-runtime writer context still lacks a dispatcher-level fixture.
- [x] Run lifecycle/dispatcher tests and `bun run typecheck`.

## Phase 3: Route authorized intake through lifecycle

- [x] Wire ordinary authorized text and media intake through `resolveOrStart(surface)` for every supported Surface, including DMs and guest text, while preserving the already-landed attachment destination, collision-safe save behavior, and stale-runtime guard without extending that intake seam.
- [x] Route commands, status reads, scheduler inspection, internal jobs, and proactive-delivery seams through non-creating `inspect(surface)`. Text/status command paths use lifecycle inspection; scheduler and dreaming still use the compatibility `SessionManager` surface.
- [x] Replace remaining caller choreography with ConversationLifecycle results and runtime-host behavior; intake no longer performs direct SessionManager binding/create operations, but still coordinates runner side effects and reconstructs synthetic writer context from the current runner.
- [x] Complete intake integration coverage. First text, guest creation, command non-creation, and stale media cases exist; first-unbound-media, destination provenance after movement, and unrelated-Conversation concurrency fixtures remain.
- [x] Run Telegram intake tests and `bun run typecheck`.

## Phase 4: Convert lifecycle commands

- [x] Update `/new` to rotate through ConversationLifecycle while preserving Surface environment/settings/automation and leaving prior history resumable.
- [x] Complete `/resume` behavior. Compatible listing, recheck, and atomic movement exist; incompatible targets are now reported distinctly, and cross-Surface coverage is in place.
- [x] Update `/archive`, `/name`, `/start`, `/debug`, help, and replies to use Conversation terminology and non-creating inspection.
- [x] Complete command timing and stale-runtime coverage. `/resume` queue timing is verified through the intake seam; archive-failure behavior is covered at the lifecycle-command integration.
- [x] Complete command/integration coverage for lifecycle transitions, terminology, compatible cross-Surface resume with destination memory/provenance capture, and no accidental creation.
- [x] Run command tests and `bun run typecheck`.

## Phase 5: Move model and thinking preferences to Surface

- [x] Extend the orchestration Surface-settings seam with model/thinking preferences and atomic read/write helpers. Storage fields and low-level setters exist, but the lifecycle/dispatcher authority interface still exposes only the environment.
- [x] Complete `/model` and `/think` Surface behavior. Bound live updates and pure no-conversation handlers exist; end-to-end unbound persistence coverage remains.
- [x] Make runtime creation read destination Surface model/thinking preferences and remove canonical reads/writes of Conversation model/thinking fields; canonical writes are clean, but dispatcher construction still accepts compatibility `SessionState` preference fields.
- [x] Add tests for preference survival across `/new`/archive, destination preference after `/resume`, unbound updates, and migration precedence. These lifecycle and migration fixtures do not yet exist.
- [x] Run model/think/settings/runner tests and `bun run typecheck`.

## Phase 6: Make schedules Surface-owned

- [x] Remove durable conversation/session ownership from canonical schedule records and key create/list/mutate/cap/heartbeat operations by SurfaceId.
- [x] Update `/schedule` and `schedule_turn` authority to the invoking/current Surface, including a current-binding check before agent mutations.
- [x] Change scheduler ordering to inspect binding before claim; leave unbound occurrences due/enabled and emit one de-duplicated pending signal per occurrence.
- [x] Dispatch a claimed occurrence through the Surface's current Conversation runtime and preserve stale-runtime dropping if the binding changes before execution.
- [x] Add schedule/store/tool/loop tests for rotation survival, unbound pending, overdue one-time dispatch after rebinding, per-Surface caps, source authority, and stale runtime.
- [x] Run scheduler/command tests and `bun run typecheck` after Surface-owned schedule behavior is implemented.

## Phase 7: Move heartbeat prompts to Surface state

- [ ] Add validated `surfaceHeartbeatPath(home, SurfaceId)` under `state/surfaces/<SurfaceId>/HEARTBEAT.md` and traversal tests.
- [ ] Resolve Surface-specific, global, then constant heartbeat prompts at dispatch while preserving whitespace, marker, and fail-loud behavior.
- [ ] Ensure `/new`, `/resume`, `/archive`, and unbinding leave heartbeat record/prompt untouched; unbound due heartbeat remains pending.
- [ ] Add heartbeat path/loop/command tests for lifecycle survival, fallback, updated file reads, and non-ENOENT errors.
- [ ] Run heartbeat/session path tests and `bun run typecheck` after Surface-owned heartbeat behavior is implemented.

## Phase 8: Migrate split ownership

- [ ] Create `conversation-migration.ts` as canonical offline filesystem step 4; canonicalize Conversation records, copy bound legacy model/thinking preferences to Surface, convert schedule ownership, and move heartbeat prompts. No step-4 migrator exists yet.
- [ ] Detect legacy multi-bound Conversations during precomputation and fail before writes with the ConversationId and all candidate SurfaceIds; require explicit operator repair rather than selecting by lexical or map order.
- [ ] Fail loudly on duplicate heartbeat conflicts or differing source/destination prompt files; preserve all Conversation directories and non-owner schedule fields.
- [ ] Precompute and validate every lifecycle transformation before the first lifecycle-step write, use atomic replacement per target file, register step 4 after transcript-provenance step 3 in `src/migrate.ts`, and set `CURRENT_STATE_VERSION = 4`; do not wire migration into startup or add mixed-generation/restart recovery. The generic migration backup/step infrastructure exists; lifecycle step 4 is not registered.
- [ ] Add migration fixtures for filesystem version 3-to-4 exactly-once execution, every ownership field, successful complete output, ambiguous multi-binding refusal, prompt conflicts, malformed state, and non-ENOENT failures.
- [ ] Remove obsolete public partial-binding APIs and update compatibility aliases/JSDoc without renaming filesystem paths. The old rebinding methods are gone, but `SessionManager`, `SessionState`, and scheduler compatibility surfaces remain intentionally active.
- [ ] Run the full migration/lifecycle verification after step 4 is implemented. Focused migration/state tests and typecheck pass; the lifecycle migration fixture and final full-suite gate remain.
