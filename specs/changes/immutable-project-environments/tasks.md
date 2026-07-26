# immutable-project-environments — Tasks

## Phase 1: Persist immutable execution environments

- [x] Create `src/sessions/environment.ts` with `personal | project` values, canonical root resolution, equality, and CWD derivation (`$GOBLIN_HOME/workspace` for personal). Satisfies “Execution environments have canonical persisted identities.”
- [x] Add required `executionEnvironment` validation to canonical session state and capture it in every Surface/session creation and stale-recreation path, including `ensureInternal()` as personal.
- [x] Update Surface settings to persist optional canonical `projectRoot` while retaining legacy `projectDir` parsing only for migration.
- [x] Add focused environment/state/manager/settings tests for personal, project, symlink equality, invalid roots, internal state, and shared-root Surface isolation.
- [x] Run touched session tests and `bun run typecheck`.

## Phase 2: Seal legacy execution authority offline

- [ ] Refactor `src/sessions/environment-migration.ts` as canonical filesystem step 2 (`stateVersion` 1 → 2): compute one complete plan for workdir promotion, settings, every live/unbound/archived/internal Conversation, and every retained pi header before its first mutation; implement the specified authority matrix across canonical environment, bound/recorded Surface settings, legacy Conversation `projectDir`, and dual `projectRoot`/`projectDir` fields; fail on invalid roots, collisions, disagreement, malformed identity/history, or incompatible CWD without deleting, selecting, or relabeling.
- [ ] Remove the independent workdir-promotion manifest and restart/mixed-generation recovery paths; apply planned moves and atomic replacements only after validation, preserving every non-header pi-history line byte-for-byte and logging safe equivalent normalization.
- [ ] Make the canonical migration command the sole migration-backup owner and capture prior contents/existence for `state/`, `workspace/`, and legacy `scratch/workdir/` before setup can create missing roots; update `scripts/update.sh` to stop Goblin before invoking that boundary, remove its state-only copy, and restart only after success (leaving the service stopped on failure).
- [ ] Register and test environment conversion as step 2 after Surface step 1, advance `CURRENT_STATE_VERSION` from 1 to 2 only after success, leave version 1 on failure, and ensure startup performs only the version gate while pending-project-assignment replay remains reconciliation.
- [ ] Replace interrupted-rerun fixtures with tests for complete prevalidation/no mutation, backup restoration coverage, version-1 failure, version-1→2 success, no second invocation at version 2, bound/unbound/archived/internal authority, mixed-history refusal, byte-preserved bodies, equivalent-path normalization, and non-`ENOENT` errors.
- [ ] Run migration/environment/pi-host tests, `bun run typecheck`, and `litespec validate immutable-project-environments`.

## Phase 3: Enforce environment-bound AgentRunner authority

- [x] Replace the `AgentRunner` mutable `projectDir` option with persisted `ExecutionEnvironment`; derive personal/project CWD and project-only guidance/tools from it.
- [x] Keep pi `agentDir` at `$GOBLIN_HOME/state/pi` and preserve the currently implemented Goblin-wide skill path/loading behavior; ensure personal runners load no project guidance or project-bound tools while later skill-layout/resolver changes own path and source policy.
- [x] Make `TurnDispatcher.createRunner()` compare the session and addressed Surface environments before constructing tools, sinks, attachment destinations, or pi state.
- [x] Replace CWD-agnostic pi history reopening with strict header/environment compatibility; never override history with a different CWD or silently create empty history.
- [x] Add runner/backend/dispatcher tests for matching personal/project environments, mismatch-before-effects, malformed history, explicit prompt/skill loading without duplicate context discovery, and canonical-path equivalence.
- [x] Run touched agent/orchestration tests and `bun run typecheck`.

## Phase 4: Make project assignment recoverable and one-way

- [x] Create the shared process-wide lifecycle-transition lock and use it for project assignment so unbound creation and future cross-Surface binding operations cannot race.
- [x] Create the pending project-assignment record/store through a sanctioned path helper, with Surface/root/optional-old/planned-new Conversation intent persisted atomically before Conversation/settings/binding creation and affected-Surface mutations fenced while intent exists.
- [x] Implement the deep first-assignment operation in `SessionManager`: validate under the lock, conditionally invalidate/quiesce bound personal P before durable work, allocate Q, persist intent, idempotently create/verify Q, write Surface assignment and binding, then clear intent.
- [x] Make same-root assignment idempotent and reject different-root or personal-clear requests before runtime disposal.
- [x] Change `/project` parsing/replies/help to one-time assignment, keep queue timing, remove clear behavior, and return lifecycle side effects without reopening personal pi history.
- [x] Add command/integration/crash-point tests for bound and unbound first assignment, assigned-but-unbound same-root idempotence, conflict, clear rejection, queued active turn, pre-intent quiescence failure, ID collision, post-intent Surface fencing, replay after every write boundary, and concurrent unbound creation without orphan or duplicate Conversations.
- [x] Run project/session/command tests, `bun run typecheck`, and `litespec validate immutable-project-environments`.
