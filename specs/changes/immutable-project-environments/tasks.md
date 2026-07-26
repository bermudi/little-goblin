# immutable-project-environments — Tasks

## Phase 1: Persist immutable execution environments

- [ ] Create `src/sessions/environment.ts` with `personal | project` values, canonical root resolution, equality, and CWD derivation. Satisfies “Execution environments have canonical persisted identities.”
- [ ] Add required `executionEnvironment` validation to canonical session state and capture it in every Surface/session creation and stale-recreation path, including `ensureInternal()` as personal.
- [ ] Update Surface settings to persist optional canonical `projectRoot` while retaining legacy `projectDir` parsing only for migration.
- [ ] Add focused environment/state/manager/settings tests for personal, project, symlink equality, invalid roots, internal state, and shared-root Surface isolation.
- [ ] Run touched session tests and `bun run typecheck`.

## Phase 2: Seal legacy execution authority

- [ ] Create `src/sessions/environment-migration.ts` to assign environments to bound, unbound, archived, and internal legacy sessions after Surface migration.
- [ ] Add an atomic pi-JSONL header rewrite helper that changes only legacy header CWD and preserves every non-header line; log each normalization.
- [ ] Validate all paths/associations before writes, fail loudly on ambiguity, and support canonical/mixed reruns without duplicate sessions or history branches.
- [ ] Wire environment migration before manager/scheduler/polling startup.
- [ ] Add tests for bound/unbound/internal migration, malformed or missing roots, byte-preserved history bodies, interrupted rerun, and non-ENOENT errors.
- [ ] Run migration/pi-host tests and `bun run typecheck`.

## Phase 3: Enforce environment-bound AgentRunner authority

- [ ] Replace the `AgentRunner` mutable `projectDir` option with persisted `ExecutionEnvironment`; derive personal/project CWD and project-only guidance/tools from it.
- [ ] Keep pi `agentDir` at `$GOBLIN_HOME/state/pi` and global skills at `$GOBLIN_HOME/workspace/skills`; ensure personal runners load no project guidance or project-bound tools.
- [ ] Make `TurnDispatcher.createRunner()` compare the session and addressed Surface environments before constructing tools, sinks, attachment destinations, or pi state.
- [ ] Replace CWD-agnostic pi history reopening with strict header/environment compatibility; never override history with a different CWD or silently create empty history.
- [ ] Add runner/backend/dispatcher tests for matching personal/project environments, mismatch-before-effects, malformed history, global resource preservation, and canonical-path equivalence.
- [ ] Run touched agent/orchestration tests and `bun run typecheck`.

## Phase 4: Make project assignment recoverable and one-way

- [ ] Create the pending project-assignment record/store and startup replay, with idempotent Surface/root/old/new-session intent and atomic writes.
- [ ] Implement the deep first-assignment operation in `SessionManager`: validate, create project session, persist intent, quiesce the personal runtime, write Surface assignment and binding, then clear intent.
- [ ] Make same-root assignment idempotent and reject different-root or personal-clear requests before runtime disposal.
- [ ] Change `/project` parsing/replies/help to one-time assignment, keep queue timing, remove clear behavior, and return lifecycle side effects without reopening personal pi history.
- [ ] Add command/integration/crash-point tests for first assignment, same symlinked root, conflict, clear rejection, no session, queued active turn, disposal failure, and replay after each write boundary.
- [ ] Run project/session/command tests, `bun run typecheck`, and `litespec validate immutable-project-environments`.
