# immutable-project-environments — Design

## Architecture

### Execution environment is persisted with history

The upstream `telegram-surface-identity` change provides complete `Surface` and `SurfaceId` values plus SurfaceId-keyed settings. This change adds a pure sessions-domain value:

```ts
type ExecutionEnvironment =
  | { kind: "personal" }
  | { kind: "project"; projectRoot: string };
```

`src/sessions/environment.ts` owns validation, canonicalization, equality, and CWD resolution. `personal` resolves to `workspacePath(home)`, the persistent `$GOBLIN_HOME/workspace` root. A new project assignment resolves the supplied path to an absolute path, verifies it is a directory, and canonicalizes it with `realpathSync`; only the canonical root is persisted.

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

First assignment proceeds under the shared lifecycle-transition lock:

1. Canonicalize and validate the project root without writes.
2. Re-read the Surface assignment and current optional binding; return idempotently/conflict if another command won.
3. If personal Conversation P is bound, synchronously invalidate and quiesce its runtime. Failure here creates no intent or Conversation and leaves settings/binding unchanged; the invalidated runtime object is not restored. An unbound Surface skips this step.
4. Allocate and collision-check the future project Conversation ID Q without creating its directory.
5. Atomically persist a pending-assignment intent at `$GOBLIN_HOME/state/pending-project-assignment.json` containing version, SurfaceId, optional P, planned Q, and canonical root. This is the durable commit point.
6. Idempotently create Q at the recorded ID with its immutable project environment; an existing Q must match the intent exactly.
7. Persist the Surface project assignment.
8. Atomically replace the expected optional old binding with Q.
9. Clear the pending record and return Q.

The durable intent precedes every assignment-persistence mutation and Conversation creation, closing the crash window in which an untracked Q could be created. Startup reconciliation validates that assignment is absent or equals the recorded root; binding is absent, still points to P, or already points to Q; Q is absent or exactly matches its recorded environment; and Q is not bound elsewhere. It then creates/verifies Q and completes settings/binding idempotently. Conflicting partial state fails without overwrite. A completed assignment/binding with a leftover intent only clears the intent.

Failure before the durable commit point leaves no recoverable operation: P remains bound and a later turn may build a new runtime. Failure after the commit point is forward-recovered from the intent. While such an intent exists, runtime construction and binding/environment mutation for its Surface are fenced behind replay. P is never archived or deleted.

The operation uses one global pending record because Goblin is a single process. Project assignment and every other binding-changing lifecycle operation share one process-wide transition lock; a runtime queue is insufficient for an unbound Surface and cannot serialize cross-Surface `/resume`. While an intent exists, assignment replay owns that Surface: runtime construction and other binding/environment mutations for it are fenced until replay completes, and a second assignment is refused. This is smaller and more honest than claiming independent JSON renames form a transaction.

### `/project` initializes; it never switches

The command parses the full argument, expands `~`, resolves relative input against process CWD, and delegates canonicalization to the environment module. Behavior is:

```text
unassigned + bound + valid path   -> quiesce/preserve P; create and bind project Q
unassigned + unbound + valid path -> create and bind project Q directly
assigned + same realpath          -> report current assignment; no creation or binding, even if unbound
assigned + different path         -> reject; suggest another topic
assigned + none/clear             -> reject; assignment is immutable
```

The first transition starts fresh model history. If the Surface had an old personal Conversation, it remains resumable from a personal Surface after `conversation-lifecycle` lands; an unbound Surface has no provisional history to preserve. Multiple Surfaces can independently assign the same root and receive separate histories.

### Runner authority comes only from persisted environment

`TurnDispatcher.createRunner` stops reading a mutable project path as authority. It receives the bound `SessionState`, resolves the addressed Surface's effective environment, and requires equality before constructing `AgentRunner`. Mismatch fails before file saving, project prompt reads, skill loading, or project-bound tool creation.

`AgentRunner` receives `executionEnvironment`:

- `personal`: CWD `$GOBLIN_HOME/workspace`; deployment `SOUL.md`, `AGENTS.md`, and global skills remain explicitly loaded once, while pi context-file auto-discovery stays disabled and no project-only guidance or tools are enabled;
- `project`: CWD and project authority are `projectRoot`; exact `<projectRoot>/AGENTS.md` is loaded as supplemental guidance, resource discovery uses that CWD, and project-bound tools receive the same canonical root.

Pi's `agentDir` remains deployment-owned at `$GOBLIN_HOME/state/pi`, matching current `src/agent/backend.ts`. This change preserves the implemented Goblin-wide skill path and loading behavior; `pi-native-skill-layout`, `skill-catalog-resolution`, and `surface-skill-policy` own later path and source-policy changes. Personal CWD being the workspace root does not authorize duplicate implicit prompt loading: `noContextFiles` remains enabled, and prompt provenance continues through Goblin's explicit system-prompt builder.

### Pi history compatibility is checked, not overridden

Current `findMostRecentPiSession()` deliberately ignores header CWD and `PiAgentBackend.init()` calls pi's `SessionManager.open(recent, piSessionDir, cwd)` with the runner's current CWD. That was required for mutable `/project` and is the behavior this change removes.

A new pi-history helper reads and validates the first session header from the JSONL file selected for reopening. Runner initialization derives expected CWD from `executionEnvironment`, canonicalizes project paths, and compares before opening. Pi may still require an explicit CWD argument to `open`; if so, it MUST equal the validated header/environment CWD. Missing, malformed, or incompatible history fails visibly rather than silently starting empty history. Migration is stricter than ordinary selection: it validates the header of every pi-history JSONL retained by the Conversation so an older incompatible branch is not silently blessed.

### Offline migration seals existing history once

`src/sessions/environment-migration.ts` is canonical filesystem migration step 2 (`stateVersion` 1 → 2) in the append-only registry owned by `src/migrate.ts`. It runs only through explicit `bun run migrate` while Goblin is stopped, after Surface migration step 1. During a multi-step run its planner consumes step 1's projected canonical output, and all later pending planners must also succeed before any step is applied. Startup performs the state-version gate and never invokes this transformation.

The migration command is the sole recovery-backup owner. Before mutating persisted inputs, it covers every root any pending step can change. For this step that boundary includes `$GOBLIN_HOME/state/`, `$GOBLIN_HOME/workspace/`, and legacy `$GOBLIN_HOME/scratch/workdir/`, recording whether optional roots existed so restoration can remove destinations created by the failed attempt; no setup helper may create them first. `scripts/update.sh` stops Goblin before invoking that boundary, performs no narrower duplicate backup, restarts only after success, and leaves the service stopped on failure.

The step computes one complete immutable plan before its first write or rename:

1. Enumerate every regular file or directory to promote from legacy `scratch/workdir` into `workspace`; reject unsupported entries and every destination collision without moving anything.
2. Parse and canonicalize every environment-bearing field. When one Surface setting contains both canonical `projectRoot` and legacy `projectDir`, both paths must resolve to the same root; disagreement, inaccessibility, or invalidity fails rather than preferring one field, deleting the setting, or downgrading to personal.
3. Group bindings by Conversation and select authority with an explicit matrix:
   - an internal legacy record (`chatId === 0`) selects `personal`, must not be Surface-bound, and rejects project evidence;
   - a bound Conversation gathers the effective environment of every bound Surface; all candidates and any legacy Conversation `projectDir` must agree;
   - an unbound or archived Conversation gathers its legacy state `projectDir` plus every Surface setting matching its recorded legacy chat/topic address; conflicting matches fail, no project evidence means personal, and malformed/missing routing identity fails;
   - a record already carrying canonical `executionEnvironment` retains it only when every applicable legacy/binding candidate agrees; migration never overwrites a canonical disagreement.
4. Validate the header of every retained pi-history JSONL against the selected environment, not only the newest candidate. A legacy personal header naming `scratch/workdir` may normalize to `workspace`; a canonically equivalent project spelling may normalize to the canonical root. Every non-header line remains byte-for-byte unchanged.

Only after all four parts validate may the step apply the planned workdir moves and atomic state/header replacements. A header resolving to a different Execution Environment is evidence of historical mixed authority and fails with the Conversation, selected environment, history path, and recorded CWD; migration does not rewrite declarations to manufacture safety.

`src/migrate.ts` writes state version 2 only after the step returns successfully. Failure leaves version 1 and requires restoration from the command's backup before retry. The step has no independent manifest or marker and is not required to be idempotent, restart-safe, mixed-generation tolerant, or rerunnable after a partial write. By contrast, pending project-assignment replay remains startup reconciliation over current-version data because interrupted assignment is ordinary operational state, not legacy-format conversion.

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

### Decision: Environment conversion is canonical offline step 2

**Chosen:** Register the complete transformation as state version 1 → 2 and use the migration command's full backup for recovery.

**Why:** Workdir promotion, Surface settings, Conversation state, and pi headers cross several files and roots. An independent restart manifest cannot make those writes transactional, and a state-only backup cannot undo a move into `workspace`. The deployment can stop, validate first, and restore one complete backup on failure under decision 0038.

### Decision: Migration never relabels mixed-authority history

**Chosen:** Normalize only explicit personal-workspace relocation or canonically equivalent path spellings. If the recorded pi-history CWD identifies another environment, fail for explicit repair without rewriting the header.

**Why:** Mutable historical CWD cannot be reconstructed perfectly, and changing a header does not revoke assumptions or tool effects already embedded in model history. Refusal is more honest than blessing unsafe history, continuing runtime overrides, or silently discarding it.

## File Changes

### New files

- **`src/sessions/environment.ts`** — `ExecutionEnvironment`, canonical project resolution, persistent workspace CWD resolution, and equality. Implements “Execution environments have canonical persisted identities.”
- **`src/sessions/project-assignment.ts`** — pending-assignment DTO/store and replay helpers used internally by `SessionManager`, including deterministic creation from the recorded future Conversation ID. Implements recoverable “Session manager owns one-time Surface project assignment.”
- **`src/orchestration/lifecycle-transition-lock.ts`** — one process-wide async transition lock shared by project assignment and later Conversation binding operations, including unbound-Surface creation.
- **`src/sessions/environment-migration.ts`** — compute and validate the complete step-2 plan, then promote legacy personal work and replace settings/state/pi headers without an independent manifest. Implements “Legacy execution environments migrate before dispatch.”
- **`src/sessions/environment.test.ts`, `src/sessions/project-assignment.test.ts`, `src/sessions/environment-migration.test.ts`** — canonicalization, authority conflicts, collision refusal, complete prevalidation, and header-preservation tests.

### Modified migration-runner files

- **`src/migrate.ts`, `src/state-version.ts`, and `scripts/update.sh`** — extend the dependency-owned canonical runner with version 1 → 2, broaden its restorable backup to every mutated root, advance only after success, and keep migration out of startup.
- **`src/migrate.test.ts`, `src/state-version.test.ts`** — add strict-version, full-chain preflight, backup-boundary, version advancement/failure, and CLI-ordering coverage.

### Modified session files

- **`src/sessions/types.ts`** — add required `executionEnvironment` to `SessionState`; retain legacy fields for migration parsing only.
- **`src/sessions/state.ts`** — validate canonical execution-environment state at the disk boundary.
- **`src/sessions/topic-settings.ts`** — replace mutable `projectDir`/notice behavior with optional canonical `projectRoot`; expose internal first-assignment operations, not clear/switch.
- **`src/sessions/manager.ts`** — capture environment on every create/stale recreate/internal create; add `effectiveEnvironment(surface)` and deep `assignProject(...)`; enforce compatibility in existing bind path.
- **`src/sessions/paths.ts`** — provide the validated pending-assignment path; assignment code does not join `$GOBLIN_HOME` paths directly.
- **`src/sessions/mod.ts`** — export environment types and lifecycle result types.
- **`src/sessions/manager.test.ts`, `src/sessions/topic-settings.test.ts`, `src/sessions/state.test.ts`** — environment capture, shared-root isolation, immutable state, and assignment cases.
- **`src/index.ts`** — enforce the required state version before module construction and run only pending-project-assignment reconciliation before scheduler/polling; it never invokes filesystem migration.

### Modified project command files

- **`src/commands/project.ts`** — remove clear semantics, canonicalize through sessions environment code, and format assigned/already/conflict results.
- **`src/commands/registry.ts`** — make the handler delegate the complete lifecycle operation and format its result; it does not perform runner, settings, Conversation, or binding side effects. Update help text/argument hint and retain queue timing.
- **`src/commands/project.test.ts`, `src/commands/dispatch.test.ts`, `src/commands/integration.test.ts`** — first assignment, symlink identity, no-session, same-root idempotence, conflict/clear rejection, queued turn, and fresh-history coverage.

### Modified runner and pi files

- **`src/orchestration/dispatcher.ts`** — derive/compare Surface and session environments before runner construction; inject `ExecutionEnvironment` instead of mutable project path.
- **`src/agent/mod.ts`** — replace `projectDir` option/state with `executionEnvironment`; derive project-only tools and destinations from it.
- **`src/agent/backend.ts`** — derive CWD from environment, preserve explicit prompt/skill loading with context-file discovery disabled, and reject incompatible/malformed pi headers before `SessionManager.open`.
- **`src/agent/system-prompt.ts`** — accept project root only from project environment and keep exact project `AGENTS.md` semantics.
- **`src/pi-host.ts`** — replace CWD-agnostic recent-session behavior with header-reading/compatibility helpers.
- **`src/tg/intake.ts`** — use the environment-derived project root for attachment destinations after dispatcher compatibility validation.
- **`src/agent/mod.test.ts`, `src/agent/contract.test.ts`, `src/orchestration/dispatcher.test.ts` (or existing dispatcher coverage in `src/tg/intake.test.ts`), `src/pi-host.test.ts`** — personal/project initialization, mismatch-before-effects, agentDir/global-skills preservation, and strict reopen tests.

### Files intentionally unchanged

- **`state/sessions/` path helpers and transcript/event formats** — later terminology changes do not justify a disk move.
- **Memory scope storage** — still Surface-derived and independent of shared CWD.
- **Schedule ownership and `/resume` filtering** — handled by dependent `conversation-lifecycle`.
- **External-agent run records** — work ownership is a later patch; new runs still receive canonical project authority from the runner.
