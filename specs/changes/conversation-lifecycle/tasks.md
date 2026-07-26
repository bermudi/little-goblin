# conversation-lifecycle — Tasks

## Phase 1: Introduce canonical Conversation persistence

- [ ] Create `ConversationId`/`ConversationState`, 10-hex ID generation, canonical state validation, and compatibility parsing for legacy SessionState under unchanged `state/sessions/` paths.
- [ ] Create `ConversationStore` with create/load/list/name/archive operations that never edit bindings.
- [ ] Remove routing/model/thinking fields from canonical Conversation writes while retaining migration-only reads.
- [ ] Add store/state tests for atomic writes, filesystem layout, archive/list filtering, names, missing directories, and immutable environment preservation.
- [ ] Run touched session tests and `bun run typecheck`.

## Phase 2: Add the deep conversation lifecycle

- [ ] Define the narrow `ConversationRuntimeHost` invalidation/quiescence interface and implement it in `TurnDispatcher` with synchronous runner/queue removal before cleanup.
- [ ] Create `ConversationLifecycle` with non-creating inspect, authorized resolve-or-start, rotate, compatible resume/move, archive, and environment-filtered listing.
- [ ] Enforce one active Surface binding per Conversation through one atomic binding-map write; preserve displaced/rotated Conversations as resumable.
- [ ] Verify environment compatibility before runtime disposal or binding mutation and keep transitions unchanged when validation/quiescence fails.
- [ ] Add lifecycle tests for DM/topic lazy creation, rotate, same-target idempotence, two-runtime resume, incompatible resume, disposal failure, and stale capture invalidation.
- [ ] Run lifecycle/dispatcher tests and `bun run typecheck`.

## Phase 3: Route authorized intake through lifecycle

- [ ] Wire ordinary authorized text and media intake through `resolveOrStart(surface)` for every supported Surface, including DMs and guest text.
- [ ] Route commands, status reads, scheduler inspection, internal jobs, and proactive-delivery seams through non-creating `inspect(surface)`.
- [ ] Replace direct SessionManager binding/create side effects in intake with ConversationLifecycle results and runtime-host behavior.
- [ ] Add intake tests proving first DM/media creation, command non-creation, guest creation, unbound status behavior, and unrelated Conversation concurrency.
- [ ] Run Telegram intake tests and `bun run typecheck`.

## Phase 4: Convert lifecycle commands

- [ ] Update `/new` to rotate through ConversationLifecycle while preserving Surface environment/settings/automation and leaving prior history resumable.
- [ ] Update `/resume` to list only named compatible Conversations, recheck compatibility, atomically move bound targets, and report incompatible/missing/ambiguous cases without effects.
- [ ] Update `/archive`, `/name`, `/start`, `/debug`, help, and replies to use Conversation terminology and non-creating inspection.
- [ ] Preserve queue/instant timing and stale-runtime behavior for each command; do not mutate Telegram topic UI.
- [ ] Add command and integration tests for all lifecycle transitions, terminology, compatible cross-Surface resume, and no accidental creation.
- [ ] Run command tests and `bun run typecheck`.

## Phase 5: Move model and thinking preferences to Surface

- [ ] Extend Surface settings with model/thinking preferences and atomic read/write helpers.
- [ ] Update `/model` and `/think` to persist by Surface, apply compatible changes to a current runtime, and work without creating a Conversation.
- [ ] Make runtime creation read destination Surface preferences; remove canonical reads/writes of Conversation model/thinking fields.
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

- [ ] Create `conversation-migration.ts` to canonicalize Conversation records, copy bound legacy model/thinking preferences to Surface, convert schedule ownership, and move heartbeat prompts.
- [ ] Repair legacy multi-bound Conversations by retaining lexicographically smallest SurfaceId, clearing others atomically, and logging retained/cleared identities.
- [ ] Fail loudly on duplicate heartbeat conflicts or differing source/destination prompt files; preserve all Conversation directories and non-owner schedule fields.
- [ ] Support idempotent canonical/mixed-generation reruns after any per-file write boundary and wire migration after both dependencies but before scheduler/polling.
- [ ] Add migration fixtures for every ownership field, multi-binding repair, prompt conflicts, partial restart, malformed state, and non-ENOENT failures.
- [ ] Remove obsolete public partial-binding APIs and update compatibility aliases/JSDoc without renaming filesystem paths.
- [ ] Run `bun test`, `bun run typecheck`, and `litespec validate conversation-lifecycle`.
