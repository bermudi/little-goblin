# immutable-project-environments — Design

## Architecture

### Execution environment is persisted with history

The upstream `telegram-surface-identity` change provides complete `Surface` and `SurfaceId` values plus SurfaceId-keyed settings. This change adds a pure sessions-domain value:

```ts
type ExecutionEnvironment =
  | { kind: "personal" }
  | { kind: "project"; projectRoot: string };
```

`src/sessions/environment.ts` owns validation, canonicalization, equality, and CWD resolution. `personal` resolves to `workdirPath(home)`. A new project assignment resolves the supplied path to an absolute path, verifies it is a directory, and canonicalizes it with `realpathSync`; only the canonical root is persisted.

`SessionState` gains required `executionEnvironment`. The legacy optional `projectDir`, `chatId`, and `topicId` fields remain readable only for migration. New session creation always receives the effective environment from the addressed Surface. Internal dreaming sessions explicitly receive `personal`; no fake project or Telegram Surface is constructed.

```text
Surface settings                         Session state
┌─────────────────────────┐              ┌──────────────────────────┐
│ projectRoot?            │ --capture--> │ executionEnvironment     │
│ (absent = personal)     │  at create   │ (immutable thereafter)   │
└─────────────────────────┘              └────────────┬─────────────┘
                                                     │
                                                     ▼
                                            AgentRunner / pi history
```

Many Surfaces may store the same canonical `projectRoot`. Equality affects compatibility only; it never changes SurfaceId-keyed routing, memory, automation, or delivery.

### Project assignment is a recoverable lifecycle operation

`SessionManager.assignProject(surface, requestedPath, runtimeLifecycle)` becomes the single deep operation for first assignment. Its interface returns one of `assigned`, `already-assigned`, or `conflict`; callers do not edit settings, create sessions, and bind independently.

First assignment proceeds as follows:

1. Canonicalize and validate the project root without writes.
2. Re-read the Surface assignment and return idempotently/conflict if another command won.
3. Create fresh project session Q and persist its immutable environment.
4. Atomically persist a small pending-assignment record containing SurfaceId, old session ID, Q, and canonical root.
5. Ask the injected runtime lifecycle to quiesce/dispose old personal session P. `/project` is queue-timing, so its active turn has already settled.
6. Persist the Surface project assignment.
7. Atomically replace the binding with Q.
8. Clear the pending record and return Q.

Startup reconciles a pending record before polling: because Q and all intended values are recorded, replay is idempotent. If disposal had completed before a crash, replay does not need the old runtime (none exists after restart); it completes settings/binding. If failure occurs before disposal, existing settings/binding remain authoritative and retry can continue. P is never archived or deleted.

The operation uses one global pending record because Goblin is a single process and project-assignment commands already serialize through their Surface's command/runtime queue. It refuses a second concurrent assignment while a record exists. This is smaller and more honest than claiming three independent JSON renames form a transaction.

### `/project` initializes; it never switches

The command parses the full argument, expands `~`, resolves relative input against process CWD, and delegates canonicalization to the environment module. Behavior is:

```text
unassigned + valid path     -> fresh project session + binding
assigned + same realpath    -> report current assignment; no side effects
assigned + different path   -> reject; suggest another topic
assigned + none/clear       -> reject; assignment is immutable
```

The first transition starts fresh model history. The old personal conversation remains resumable from a personal Surface after `conversation-lifecycle` lands. Multiple Surfaces can independently assign the same root and receive separate histories.

### Runner authority comes only from persisted environment

`TurnDispatcher.createRunner` stops reading a mutable project path as authority. It receives the bound `SessionState`, resolves the addressed Surface's effective environment, and requires equality before constructing `AgentRunner`. Mismatch fails before file saving, project prompt reads, skill loading, or project-bound tool creation.

`AgentRunner` receives `executionEnvironment`:

- `personal`: CWD `$GOBLIN_HOME/scratch/workdir`, no project guidance, project skills, external-agent tool, or project attachment destination;
- `project`: CWD and project authority are `projectRoot`; exact `<projectRoot>/AGENTS.md` is loaded as supplemental guidance, resource discovery uses that CWD, and project-bound tools receive the same canonical root.

Pi's `agentDir` remains deployment-owned at `$GOBLIN_HOME/state/pi`, matching current `src/agent/backend.ts`; global Goblin skills remain explicitly added from `$GOBLIN_HOME/workspace/skills`.

### Pi history compatibility is checked, not overridden

Current `findMostRecentPiSession()` deliberately ignores header CWD and `PiAgentBackend.init()` calls pi's `SessionManager.open(recent, piSessionDir, cwd)` with the runner's current CWD. That was required for mutable `/project` and is the behavior this change removes.

A new pi-history helper reads and validates the first session header from the most recent JSONL file. Runner initialization derives expected CWD from `executionEnvironment`, canonicalizes project paths, and compares before opening. Pi may still require an explicit CWD argument to `open`; if so, it MUST equal the validated header/environment CWD. Missing, malformed, or incompatible history fails visibly rather than silently starting empty history.

### Legacy migration seals existing history once

`src/sessions/environment-migration.ts` runs after Surface migration and before manager/scheduler/polling startup. It loads and validates all target records before writes:

- bound sessions use the bound Surface's effective environment;
- unbound/archived legacy sessions use the uniquely reconstructable recorded legacy Surface (legacy sign inference is confined to this migration);
- internal sessions use `personal`;
- canonical records are verified and left unchanged.

Mutable historical `/project` means legacy pi headers may disagree with the environment selected from current persisted Surface authority. The migration makes that one ambiguity explicit: it atomically rewrites only the header CWD to the selected environment and preserves every other JSONL line byte-for-byte. It logs each normalization. After this one-time seal, ordinary runtime code never overrides CWD again.

If a path or association cannot be validated uniquely, startup fails with the session/Surface/path. Guessing personal would silently broaden or change authority. Migration is idempotent; temp-file-plus-rename is used for state and rewritten JSONL.

## Decisions

### Decision: Execution environment is a value, not a project registry

**Chosen:** `personal | project(canonical root)`.

**Why:** The only current identity needed is filesystem authority. A project table, generated ID, display name, repository detector, or ORM would add another lifecycle without leverage. Canonical roots make symlink spellings compare safely.

**Constraint:** Moving a repository changes environment identity. Recovery/rebinding after a move is future explicit administration, not silent path mutation.

### Decision: Surface assignment and session environment are both persisted

**Chosen:** Surface stores the default for future history; each session stores the immutable captured value.

**Why:** Surface-only storage permits old history to reopen under new authority. Session-only storage makes `/new` lose a topic's project posture. The duplicated values have a strict invariant and are checked before runner creation.

### Decision: First assignment creates fresh history

**Chosen:** Preserve personal P and create project Q.

**Why:** Reopening P under a project root is the bug being removed. Editing P in place or injecting a project notice cannot retroactively scope earlier model/tool history.

### Decision: Normal `/project` has no reset path

**Chosen:** Same root is idempotent; different root and clear are rejected.

**Why:** A one-way initialization keeps CWD and authority stable. Telegram topics are cheap execution lanes, including private-chat topics. Topic deletion recovery is real but separate; hiding it behind ordinary `/project` would make accidental retargeting easy.

### Decision: Use a pending-operation record

**Chosen:** Persist enough assignment intent to replay settings/binding writes after a crash.

**Why:** Session creation, runtime disposal, settings, and binding cannot be one filesystem rename. A tiny idempotent operation record provides a real recovery mechanism. Exposing prepare/commit steps to command callers would make a shallow interface and duplicate failure handling.

### Decision: Legacy header normalization is migration-only

**Chosen:** Seal current persisted Surface authority into old pi headers once, log it, then enforce strict checks forever.

**Why:** Mutable historical CWD cannot be reconstructed perfectly. Preserving mixed history while making the chosen environment explicit is more honest than continuing runtime overrides or silently discarding history.

## File Changes

### New files

- **`src/sessions/environment.ts`** — `ExecutionEnvironment`, canonical project resolution, CWD resolution, and equality. Implements “Execution environments have canonical persisted identities.”
- **`src/sessions/project-assignment.ts`** — pending-assignment DTO/store and replay helpers used internally by `SessionManager`. Implements recoverable “Session manager owns one-time Surface project assignment.”
- **`src/sessions/environment-migration.ts`** — migrate legacy state/settings/pi headers before dispatch. Implements “Legacy execution environments migrate before dispatch.”
- **`src/sessions/environment.test.ts`, `src/sessions/project-assignment.test.ts`, `src/sessions/environment-migration.test.ts`** — canonicalization, idempotence, conflict, crash-point, invalid-path, and header-preservation tests.

### Modified session files

- **`src/sessions/types.ts`** — add required `executionEnvironment` to `SessionState`; retain legacy fields for migration parsing only.
- **`src/sessions/state.ts`** — validate canonical execution-environment state at the disk boundary.
- **`src/sessions/topic-settings.ts`** — replace mutable `projectDir`/notice behavior with optional canonical `projectRoot`; expose internal first-assignment operations, not clear/switch.
- **`src/sessions/manager.ts`** — capture environment on every create/stale recreate/internal create; add `effectiveEnvironment(surface)` and deep `assignProject(...)`; enforce compatibility in existing bind path.
- **`src/sessions/mod.ts`** — export environment types and lifecycle result types.
- **`src/sessions/manager.test.ts`, `src/sessions/topic-settings.test.ts`, `src/sessions/state.test.ts`** — environment capture, shared-root isolation, immutable state, and assignment cases.
- **`src/index.ts`** — run environment/pending-assignment migration after upstream Surface migration and before scheduler/polling.

### Modified project command files

- **`src/commands/project.ts`** — remove clear semantics, canonicalize through sessions environment code, and format assigned/already/conflict results.
- **`src/commands/registry.ts`** — make handler delegate the one lifecycle operation, emit runtime side effects from its result, and update help text/argument hint; retain queue timing.
- **`src/commands/project.test.ts`, `src/commands/dispatch.test.ts`, `src/commands/integration.test.ts`** — first assignment, symlink identity, no-session, same-root idempotence, conflict/clear rejection, queued turn, and fresh-history coverage.

### Modified runner and pi files

- **`src/orchestration/dispatcher.ts`** — derive/compare Surface and session environments before runner construction; inject `ExecutionEnvironment` instead of mutable project path.
- **`src/agent/mod.ts`** — replace `projectDir` option/state with `executionEnvironment`; derive project-only tools and destinations from it.
- **`src/agent/backend.ts`** — derive CWD from environment and reject incompatible/malformed pi headers before `SessionManager.open`.
- **`src/agent/system-prompt.ts`** — accept project root only from project environment and keep exact project `AGENTS.md` semantics.
- **`src/pi-host.ts`** — replace CWD-agnostic recent-session behavior with header-reading/compatibility helpers.
- **`src/tg/intake.ts`** — use the environment-derived project root for attachment destinations after dispatcher compatibility validation.
- **`src/agent/mod.test.ts`, `src/agent/contract.test.ts`, `src/orchestration/dispatcher.test.ts` (or existing dispatcher coverage in `src/tg/intake.test.ts`), `src/pi-host.test.ts`** — personal/project initialization, mismatch-before-effects, agentDir/global-skills preservation, and strict reopen tests.

### Files intentionally unchanged

- **`state/sessions/` path helpers and transcript/event formats** — later terminology changes do not justify a disk move.
- **Memory scope storage** — still Surface-derived and independent of shared CWD.
- **Schedule ownership and `/resume` filtering** — handled by dependent `conversation-lifecycle`.
- **External-agent run records** — work ownership is a later patch; new runs still receive canonical project authority from the runner.
