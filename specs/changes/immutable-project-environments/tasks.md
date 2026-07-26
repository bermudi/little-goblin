# immutable-project-environments — Tasks

## Phase 1: Persist immutable execution environments

- [ ] Create `src/sessions/environment.ts` with `personal | project` values, canonical root resolution, equality, and CWD derivation (`$GOBLIN_HOME/workspace` for personal). Satisfies “Execution environments have canonical persisted identities.”
- [ ] Add required `executionEnvironment` validation to canonical session state and capture it in every Surface/session creation and stale-recreation path, including `ensureInternal()` as personal.
- [ ] Update Surface settings to persist optional canonical `projectRoot` while retaining legacy `projectDir` parsing only for migration.
- [ ] Add focused environment/state/manager/settings tests for personal, project, symlink equality, invalid roots, internal state, and shared-root Surface isolation.
- [ ] Run touched session tests and `bun run typecheck`.

## Phase 2: Seal legacy execution authority

- [ ] Create `src/sessions/environment-migration.ts` to promote legacy `scratch/workdir` contents into `workspace` with a restart-safe manifest and collision refusal, then group bindings by session and assign environments to equal-bound, unbound, archived, and internal legacy sessions after Surface migration.
- [ ] Add a pi-JSONL header validator that checks every retained history file plus atomic normalization limited to personal scratch-to-workspace relocation and canonically equivalent project spellings; preserve every non-header line and log each safe normalization.
- [ ] Validate all paths/associations before state/history writes; fail on differing environments across multi-bindings or incompatible headers without selecting/rewriting, and support canonical/mixed reruns without duplicate sessions or history branches.
- [ ] Wire environment migration before manager/scheduler/polling startup.
- [ ] Add tests for bound/unbound/internal migration, malformed or missing roots, refusal of mixed-environment history, byte-preserved history bodies, safe equivalent-path normalization, interrupted rerun, and non-ENOENT errors.
- [ ] Run migration/pi-host tests and `bun run typecheck`.

## Phase 3: Enforce environment-bound AgentRunner authority

- [ ] Replace the `AgentRunner` mutable `projectDir` option with persisted `ExecutionEnvironment`; derive personal/project CWD and project-only guidance/tools from it.
- [ ] Keep pi `agentDir` at `$GOBLIN_HOME/state/pi` and Goblin-wide skills at `$GOBLIN_HOME/.agents/skills/`; ensure personal runners load no project guidance or project-bound tools while the dependent resolver owns final source policy.
- [ ] Make `TurnDispatcher.createRunner()` compare the session and addressed Surface environments before constructing tools, sinks, attachment destinations, or pi state.
- [ ] Replace CWD-agnostic pi history reopening with strict header/environment compatibility; never override history with a different CWD or silently create empty history.
- [ ] Add runner/backend/dispatcher tests for matching personal/project environments, mismatch-before-effects, malformed history, explicit prompt/skill loading without duplicate context discovery, and canonical-path equivalence.
- [ ] Run touched agent/orchestration tests and `bun run typecheck`.

## Phase 4: Make project assignment recoverable and one-way

- [ ] Create the shared process-wide lifecycle-transition lock and use it for project assignment so unbound creation and future cross-Surface binding operations cannot race.
- [ ] Create the pending project-assignment record/store through a sanctioned path helper, with Surface/root/optional-old/planned-new Conversation intent persisted atomically before Conversation/settings/binding creation and affected-Surface mutations fenced while intent exists.
- [ ] Implement the deep first-assignment operation in `SessionManager`: validate under the lock, conditionally invalidate/quiesce bound personal P before durable work, allocate Q, persist intent, idempotently create/verify Q, write Surface assignment and binding, then clear intent.
- [ ] Make same-root assignment idempotent and reject different-root or personal-clear requests before runtime disposal.
- [ ] Change `/project` parsing/replies/help to one-time assignment, keep queue timing, remove clear behavior, and return lifecycle side effects without reopening personal pi history.
- [ ] Add command/integration/crash-point tests for bound and unbound first assignment, assigned-but-unbound same-root idempotence, conflict, clear rejection, queued active turn, pre-intent quiescence failure, ID collision, post-intent Surface fencing, replay after every write boundary, and concurrent unbound creation without orphan or duplicate Conversations.
- [ ] Run project/session/command tests, `bun run typecheck`, and `litespec validate immutable-project-environments`.
