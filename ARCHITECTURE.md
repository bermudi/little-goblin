# Little Goblin Architecture

> **Status: architecture stabilization.** This document maps the implemented system, accepted target architecture, and unresolved design work. Canonical specs and accepted decisions are the behavioral contracts.

## How to read this document

Goblin currently has three simultaneous truths:

- **CURRENT** — behavior implemented in `src/` and described by `specs/canon/`.
- **TARGET** — behavior established by accepted decisions and the current stabilization plan.
- **OPEN** — architecture that is known to need work but has not yet been accepted as a contract.

Never silently present TARGET or OPEN behavior as implemented. During stabilization, check all of:

| Source | Job |
|---|---|
| `AGENTS.md` | Engineering guardrails and stabilization gate |
| `ARCHITECTURE.md` | Whole-system ownership, lifetime, authority, and dependency map |
| `specs/canon/` | Implemented behavioral contracts |
| `specs/changes/` | Historical target behavior and migration plans |
| `specs/decisions/` | Why consequential choices were made |
| `specs/glossary.md` | Canonical domain language |

Detailed behavior belongs in canonical specs and decisions. This file should link concepts and expose contradictions, not copy every requirement.

## Product boundary

Little Goblin is one Telegram-native personal assistant:

- one human operator;
- one Bun process;
- Telegram long polling, not a generic channel gateway;
- filesystem-backed persistence, except the canonical SQLite memory store;
- pi-coding-agent as the main model runtime;
- project mode, subagents, external agents, memory, and automation are capabilities of the same assistant, not sibling products.

Non-goals remain: web UI, multi-channel abstraction, plugin SDK, multi-agent gateway, Kubernetes, and distributed coordination.

## Target domain model

```text
Telegram update
      │
      ▼
   Surface ───────────── owns routing, preferences, automation, presence
      │ 0..1
      ▼
   Binding ───────────── current pointer only
      │
      ▼
Conversation ─────────── durable history + immutable Execution Environment
      │ 0..1 while active
      ▼
ConversationRuntime ─── AgentRunner + prompt queue + Surface-derived context
      │
      ├── main pi AgentSession
      ├── captured Surface-derived memory context
      ├── resolved prompts and skills
      ├── Telegram delivery/tools
      └── attached work for this runtime; durable work remains subsystem-owned
```

### Surface

**TARGET — accepted by decision 0031.** A Surface is one complete Telegram routing lane: DM, topic with container kind, topicless supergroup, or guest. `SurfaceId` is its canonical reversible persisted identity.

Surface does not identify model history or CWD. Telegram adapters normalize grammy context into Surface and derive Telegram send parameters from it. Domain modules must not infer Telegram kind from chat-ID sign, optional topic IDs, or boolean flags.

### Binding

**TARGET — accepted by decision 0033.** A Binding is only the current association between a Surface and a Conversation.

- A Surface has at most one bound Conversation.
- A Conversation is actively bound to at most one Surface.
- `/resume` moves a compatible Conversation; it never shares one runtime across Surfaces.
- Displaced Conversations remain stored and resumable.

### Conversation

**TARGET — accepted by decisions 0032 and 0033.** A Conversation is durable model history:

- identity, optional name, and creation time;
- transcript, events, metrics, and pi history;
- immutable Execution Environment.

The legacy disk path remains `state/sessions/<id>/`; path churn has no architectural value by itself. “Session” is otherwise reserved for pi's `AgentSession` and temporary compatibility symbols.

### Conversation runtime

**TARGET.** A Conversation runtime is ephemeral: one `AgentRunner` plus one serialized prompt queue. It is assembled from the current Conversation and its bound Surface, then invalidated before `/new`, `/resume`, `/archive`, or another authority-changing transition can commit.

A runtime is never routing or persistence identity. Stale runtime work must fail its current-binding check before filesystem writes, Telegram replies, schedule mutation, or model prompts.

### Execution Environment

**TARGET — accepted by decision 0032.** Filesystem authority is immutable for a Conversation:

```ts
type ExecutionEnvironment =
  | { kind: "personal" }
  | { kind: "project"; projectRoot: CanonicalAbsolutePath };
```

- `personal` resolves to persistent `$GOBLIN_HOME/workspace`.
- `project` resolves to one validated realpath.
- A Surface stores the environment future Conversations should capture.
- A Conversation stores the environment it captured and never changes it.
- Runner creation requires Surface and Conversation environments to agree.
- Equal environments permit `/resume`; they do not merge routing, history, memory, schedules, or notifications.

`/project` is one-time Surface initialization. First assignment preserves the personal Conversation and starts fresh project history. Switching or clearing through ordinary `/project` is rejected.

## Ownership by lifetime

| State or behavior | Target owner |
|---|---|
| Telegram address and lane kind | Surface |
| Project assignment | Surface |
| Model and thinking preferences | Surface |
| SkillPolicy | Surface **(TARGET — decision 0034)** |
| Schedules and heartbeat | Surface |
| Proactive-contact master policy | Deployment |
| Proactive-contact consent | Surface, intersected with deployment and WakeProfile policy |
| Active memory-context projection | Derived from current Surface; captured by runtime |
| Current Conversation pointer | Binding |
| Model history and immutable CWD | Conversation |
| Transcript, events, metrics, pi history | Conversation |
| Runner, prompt queue, Telegram sink/tools | Conversation runtime |
| Personal identity and deployment prompts | Deployment workspace |
| Curated memory entries | Memory store, keyed by active scope |
| Delegated-run record and execution lifecycle | Delegated-work subsystem **(TARGET — decision 0036)** |
| Explicit delegated-run control | Owner Conversation |
| Automatic delegated completion destination | Origin Surface |
| Wake/reflection/effect history | Inner-life wake store **(TARGET — decision 0035)** |

If new state has no unambiguous row, stop and design its lifetime before implementing it.

## Target module seams and dependency direction

```text
src/index.ts / composition root
       │
       ├── Telegram adapters (`src/tg`)
       │      normalize/deliver Surface; no conversation persistence
       │
       ├── Commands (`src/commands`)
       │      parse intent and call lifecycle modules; no choreography
       │
       ├── Scheduler / future inner life
       │      address Surface, resolve current binding late
       │
       ▼
ConversationLifecycle (`src/orchestration`)
       │  inspect / resolveOrStart / rotate / resume / archive
       ├── ConversationStore
       ├── BindingStore
       ├── SurfaceSettings
       └── ConversationRuntimeHost
                     │
                     ▼
TurnDispatcher ──► AgentRunner / pi backend
                     │
                     ├── prompt assembly
                     ├── skill resolution
                     ├── memory tools/context
                     ├── delegated-agent tools
                     └── Surface-bound Telegram tools

Persistence adapters ──► path helpers / atomic filesystem operations
```

Rules:

1. `src/index.ts` and `src/bot.ts` are composition roots, not domain modules.
2. Telegram adapters may know grammy; Surface/domain modules must not.
3. Commands and intake call complete lifecycle operations, never sequences of store/runtime mutations.
4. Persistence modules do not own runtime disposal; orchestration coordinates through a narrow runtime-host seam.
5. Agent runtime construction receives validated authority. It must not reconstruct project, routing, skill, or memory policy from convenience fields.
6. Every external boundary and critical transition logs structured identity and failure context without secrets.

## Runtime assembly

A main runtime is derived, not loaded from one overloaded record:

```text
Conversation
  ├── immutable Execution Environment / CWD
  └── pi history

Destination Surface
  ├── model + thinking preference
  ├── Surface SkillPolicy (TARGET — later skill-policy train)
  ├── Surface-derived memory context captured for this runtime
  ├── schedule authority
  └── Telegram delivery/tool closures

Deployment
  ├── product shell
  ├── SOUL.md
  ├── agent-owned AGENTS.md
  ├── Goblin skill catalog + Surface SkillPolicy
  └── model credentials/catalog
```

The dispatcher receives mandatory lifecycle-owned Surface runtime authority at construction. That authority reconciles a pending project assignment before every Surface-backed runtime acquisition and verifies the current Binding/environment both before and after memory capture. Its synchronous check is closed over by the runner, so queued work fails closed after a binding change. Resuming a Conversation on another compatible Surface creates a fresh runtime using destination Surface settings.

## Prompt architecture

**Accepted by decision 0003.** Main Goblin prompt ownership is explicit:

1. code-owned product shell for runtime mechanics;
2. required agent-owned `workspace/SOUL.md` for identity and voice;
3. optional agent-owned `workspace/AGENTS.md` for operating rules;
4. exact `<projectRoot>/AGENTS.md` for project Conversations only;
5. bounded frozen memory summary at runtime creation;
6. relevant-memory aside per turn.

Pi context-file auto-discovery stays disabled for the main runtime. Project guidance is supplemental and must not replace deployment identity. Prompt reads use path helpers and fail loudly according to required/optional semantics.

### Prompt-file write authority

**CURRENT — settled by decision 0039 and implemented by archived `agent-owned-prompt-files`.** Prompt files are **agent-owned**. Goblin MAY rewrite `workspace/SOUL.md`, `AGENTS.md`, and `HEARTBEAT.md` with ordinary file tools during a user-facing turn. Onboarding creates them from templates and never overwrites; `SOUL.md` remains required at startup.

There is no reserved-path write guard. The main runtime already has `bash` active (`src/agent/backend.ts:145-155` passes no tool allowlist; pi's default active set is `[read, bash, edit, write]`), and pi resolves absolute paths, so a guard could prevent accidents but never constitute a boundary. Per decision 0012, real isolation is an OS-level concern.

Three constraints bound the authority:

- every prompt-file write posts a bounded notice to the Surface whose runtime performed it;
- inner-life wakes cannot write prompt files — expressed as an absence in the decision 0035 capability profile, not as a file guard; autonomous reflection may propose an identity change, never apply one;
- subagents do not receive Goblin's agent-owned prompt files; named agents keep their own `workspace/agents/<name>/AGENTS.md`.

Recovery is git in `$GOBLIN_HOME/workspace`, documented for the operator. Goblin builds no snapshot or undo store.

The archived `agent-owned-prompt-files` change amended the canon statements that previously called `SOUL.md` "deployment-owned" (`specs/glossary.md:75`, `specs/canon/agent/spec.md`), implemented the bounded Surface notice, filtered Goblin's agent-owned prompt files out of subagent bootstrap, and documented the `git-in-workspace/` recovery path.

## Skill architecture

**TARGET — accepted by decision 0034 and specified by `pi-native-skill-layout`, `skill-catalog-resolution`, `surface-skill-policy`, and `subagent-skill-inheritance`.** CURRENT Goblin still uses non-native `workspace/skills/`, manually injects it through `additionalSkillPaths`, and conflates ambient discovery behind process-wide `skillSources`; do not extend that seam.

| Skill source | Canonical location | Authority |
|---|---|---|
| Goblin catalog | `$GOBLIN_HOME/.agents/skills/` | Deployment-wide capabilities eligible on personal or project Surfaces |
| Personal environment catalog | `$GOBLIN_HOME/workspace/.agents/skills/` | Capabilities authored for the personal Execution Environment |
| Project environment catalog | exact `<projectRoot>/.agents/skills/` and `<projectRoot>/.pi/skills/` | Capabilities supplied by one project Execution Environment |
| Host catalog | exact `~/.agents/skills/` | Unix-user capabilities, disabled by default and explicitly selectable |
| Named-agent catalog | `$GOBLIN_HOME/workspace/agents/<name>/.agents/skills/` | Isolated named-agent capabilities |

A Surface owns independent `goblin`, `environment`, and `host` selections. Each source is `all`, `none`, or an explicit selected-name set. Defaults are Goblin all, environment all, host none. `/new` preserves policy; `/resume` uses destination Surface policy.

Runtime construction resolves exact roots from Conversation environment plus Surface policy, disables Pi ambient skill discovery, and records source/path provenance. It never walks above canonical `projectRoot`, never implicitly loads `~/.pi/agent/skills/` or package skills, and fails on distinct selected files with duplicate names rather than depending on discovery order. Catalog edits take effect on runtime recreation or `/skills reload`.

Legacy `workspace/skills/` migrates to the Goblin catalog because it historically followed the assistant into every environment. Generic subagents inherit the caller's frozen resolved manifest; named agents remain isolated in their own catalog.

## Attachment architecture

**CURRENT — archived `personal-attachment-intake` patch.** File attachments derive their destination from the Conversation environment:

- personal: `$GOBLIN_HOME/workspace/attachments/`;
- project: canonical project root, preserving existing project behavior.

Intake uses basename validation and collision-safe reservation, never overwrites an existing file, includes the actual saved relative path in the model prompt, and never forwards a caption alone after silently discarding its file. Personal uploads cannot directly replace workspace prompt or skill paths.

Native model document ingestion remains unavailable in the current pi-ai content model; the agent receives a readable filesystem path.

## Automation and inner life

### Scheduled automation

**CURRENT — archived `conversation-lifecycle`.** Schedules and heartbeat configuration are Surface-owned. At dispatch, automation resolves the Surface's current Conversation; an unbound Surface remains pending and does not auto-create history. Schedule records, late binding inspection, pending-unbound occurrences, and heartbeat prompt paths all use Surface authority. The scheduler still reaches that authority through the compatibility `SessionManager.peekBinding` seam; replacing the compatibility name is cleanup, not missing lifecycle behavior.

Scheduled turns use the same dispatcher and prompt queue as user turns. A captured occurrence becomes stale if its runtime is invalidated before execution.

### Inner life

**TARGET — decision 0035 and the validated `inner-life` change.** Inner-life wakes have durable records, code-owned per-wake capability profiles, bounded validated effects, effect-specific delivery guarantees, one explicit home Surface, and layered proactive-contact consent. Model output cannot mint authority or reroute contact. Whether heartbeat becomes a private wake remains unsettled, so current Surface-owned heartbeat behavior stays unchanged.

`inner-life` specifies the wake store, profile/effect state machine, crash recovery, and deny-by-default contact path. `visible-dreaming` remains blocked until that dependency is implemented; it may later supply reflection content but must not create a parallel scheduler, delivery, or consent system.

## Memory

Memory's canonical store is `$GOBLIN_HOME/state/memory/memory.sqlite`. Markdown under `state/memory/` is export-only.

**CURRENT — decision 0037, `surface-derived-memory-context`, and `transcript-surface-provenance`.** The current Surface is the sole input to `Surface → ActiveScope`; the projection is not persisted as a mutable setting. A conversation runtime captures that context and frozen summary at runtime creation. Subagents capture the parent runtime's context per invocation rather than resolving a later binding. Equal project roots do not merge memory context.

Each new user-visible transcript entry records event-time `sourceSurfaceId`. Indexing and dreaming use that provenance per entry, so one moved Conversation may contain several source Surfaces without rewriting history. Unknown legacy provenance stays null rather than being guessed from the current binding. Filesystem `stateVersion` is now 4; the transcript migration, mixed-chat index rebuild, provenance-driven dreaming, startup gate, boundary tests, two-Surface end-to-end fixture, and lifecycle migration are implemented.

**CURRENT — archived `conversation-lifecycle`; closure hardening in progress.** Cross-Surface movement is wired into intake and commands; runtime capture/writer authority, archive ordering, Surface-owned preferences and automation, and offline ownership migration step 4 are implemented. The bounded merge-closure slice hardens canonical authority validation, planned-assignment recovery, and mandatory runtime authority; it is follow-up stabilization work, not an unfinished archived lifecycle feature.

Dreaming currently uses compatibility internal-session machinery. TARGET architecture uses an explicit Surface-free internal memory context and later removes fake Telegram/session identity through `inner-life`/`visible-dreaming`, never by adding an internal Surface variant.

## Delegated work

### Subagents

CURRENT subagents have custom pi construction, generic/named definitions, recursive spawning, and persisted instance records. Their skill loading still uses legacy paths and implicit inheritance; TARGET `subagent-skill-inheritance` makes generic agents inherit the caller's frozen resolved manifest and moves named definitions to isolated `.agents/skills/` catalogs.

TARGET direction:

- generic execution inherits an explicit parent environment, memory context, and resolved skill manifest;
- named-agent definitions remain user-authored under workspace;
- machine-managed instance records move to state in the separate storage-layout migration;
- a `SubagentHost` seam owns pi construction while `DelegatedWorkHost` owns cross-run lifetime;
- current blocking generic/named invocations are attached and their full recursive tree dies with the creating runtime; durable subagents require a future detached-result contract.

### External agents

CURRENT/active external-agent work is converging on ACP as the protocol and logical session boundary (proposed decision 0030). External agents receive bounded authority from code-owned configuration; model input never supplies executable, environment, credentials, ACP session identity, or permission policy.

**TARGET — decision 0036 and validated `delegated-work-ownership`.** Every run captures a controlling owner Conversation, immutable environment, and origin Surface. New ACP runs are code-classified durable across Conversation rotation; explicit owner cancellation remains destructive. Control follows the owner Conversation, but automatic completion delivery never leaves the origin Surface merely because another lane shares a CWD.

An unavailable origin retains a bounded pending completion. Background work never creates a Conversation or pushes to a fallback Surface; the next authorized ordinary interaction on the exact origin may claim the result through a tokenized claim/ack/release handoff. Execution outcome and delivery state remain separate.

## Target filesystem layout

```text
$GOBLIN_HOME/
├── goblin.json5
├── .agents/skills/                    # Goblin-wide skill catalog
├── workspace/                         # persistent personal execution environment
│   ├── SOUL.md
│   ├── AGENTS.md
│   ├── HEARTBEAT.md
│   ├── attachments/
│   ├── .agents/skills/                # personal-environment skill catalog
│   └── agents/<name>/                 # user-authored named-agent definitions
│       ├── AGENTS.md
│       └── .agents/skills/
└── state/                             # machine-managed and backed up
    ├── bindings.json
    ├── pending-project-assignment.json # replayable cross-file assignment intent
    ├── topic-settings.json            # legacy filename retained; SurfaceId-keyed target data
    ├── schedules.json
    ├── surfaces/<SurfaceId>/HEARTBEAT.md
    ├── sessions/<ConversationId>/     # legacy path retained
    │   ├── state.json
    │   ├── transcript.jsonl
    │   ├── events.jsonl
    │   ├── metrics.jsonl
    │   └── pi/
    ├── memory/memory.sqlite
    ├── inner-life/wakes/              # durable wake/effect records
    ├── delegated-work/                # pending completion index and migration state
    ├── pi/                            # auth + model catalog, not execution CWD
    ├── subagents/                     # proposed machine-managed instances
    └── external-agents/               # proposed durable run records
```

There is no target `$GOBLIN_HOME/scratch/` tree. True temporary data belongs in the OS temp directory or atomic sibling temp files and must not be authoritative. Existing `scratch/workdir`, `scratch/subagents`, and `scratch/external-agents` require explicit collision-safe migration steps before startup stops creating the old tree.

Named-agent definitions and machine-managed instances must not share one workspace directory in the target layout.

## Startup, migration, and reconciliation

**TARGET — accepted decision 0038.** Migration and reconciliation are different operations and must stop sharing the word "startup".

| | Migration | Reconciliation |
|---|---|---|
| What | One-time transformation of old-format persisted data | Recovery of in-flight state after an unclean stop |
| How often | Once per deployment, ever | Every boot, forever |
| When | Offline, `bun run migrate`, service stopped | At startup, before polling |
| Crash-safe | No — restore the backup the command took | Yes; a crash is its normal input |
| Owner | One module, one ordered append-only step list, one `stateVersion` | Each owning subsystem |

Reconciliation covers interrupted inner-life wakes, durable delegated runs, pending completion deliveries, and replayable project-assignment intent. It operates only on current-version data.

Target startup is fail-before-polling:

1. load and validate deployment configuration;
2. create canonical directories through path helpers;
3. read `state/` `stateVersion`; refuse to poll on mismatch, naming the required version and the `bun run migrate` remedy;
4. run memory SQLite schema migration (decisions 0015, 0020 — a database schema, not filesystem layout);
5. reconcile pending project-assignment operations;
6. reconcile pending lifecycle operations, delegated completions, durable runs, and inner-life wakes;
7. run preflight and model/tool dependency checks;
8. construct modules and start scheduler;
9. synchronize Telegram commands and begin polling.

Migrations compute and validate every transformation before the first write, use atomic replacement per file, and fail loudly on ambiguity without selecting a winner. They are *not* required to be idempotent, restart-safe, or mixed-generation tolerant; recovery from a failed migration is restoration from backup. The command's backup boundary covers every persisted root a pending step may mutate, not merely `state/` when a step also moves `workspace/` or legacy `scratch/` data.

The implemented filesystem sequence is Surface identity (step 1), immutable Execution Environments (step 2), transcript Surface provenance (step 3), then Conversation lifecycle ownership (step 4). The current filesystem gate is state version 4. Environment step 2 includes personal-workdir promotion; each step advances the version only after its complete transformation succeeds.

Two parked changes still specify their own restart-safe startup migration and need a patch stripping that language before they are revived: `pi-native-skill-layout` and `delegated-work-ownership` (both in `specs/parked/`). `immutable-project-environments`, `transcript-surface-provenance`, and `conversation-lifecycle` now specify offline steps in the canonical migration runner.

## Current-to-target repair map

| Current seam | Problem | Target owner/change |
|---|---|---|
| `ChatLocator` plus flags/sign inference | Incomplete routing identity | `telegram-surface-identity` |
| Separate DM/topic/supergroup binding maps | Collisions and branching persistence | SurfaceId-keyed binding/settings stores |
| Mutable `projectDir` | History changes filesystem authority | `immutable-project-environments` |
| Caption-only document fallback | Silently discards user input | `personal-attachment-intake` |
| `SessionState` owns routing/history/runtime settings | Mixed lifetimes | `conversation-lifecycle` |
| Public partial rebinding methods | Multi-bound history and stale runners | deep `ConversationLifecycle` |
| Schedule captures session and locator | Automation dies or misroutes on rotation | Surface-owned late resolution |
| Memory scope/transcript provenance derives from session metadata | Moved history gets stale context or wrong chat attribution | `surface-derived-memory-context` → `transcript-surface-provenance` |
| `workspace/skills` + `skillSources` | Non-native paths and mixed trust policies | `pi-native-skill-layout` → `skill-catalog-resolution` → `surface-skill-policy` |
| Personal CWD under `scratch/workdir` | User work is ephemeral and unbacked-up | personal workspace environment migration |
| Durable records under `scratch/` | “Durable but disposable” contradiction | **OPEN: storage-layout cleanup** |
| Named definitions mixed with instance state | User-authored and machine-managed lifetimes mixed | **OPEN: subagent state migration** |
| Internal dreaming fake session identity | Borrowed routing/runtime machinery | `inner-life` → future `visible-dreaming` rewrite |
| Attached/durable work implicit | Rotation may cancel or orphan wrong work | `delegated-work-ownership` |
| `bot.ts`/`tg/intake.ts` orchestration choreography | Shallow seams and duplicated transitions | lifecycle + dispatcher modules |

## Stabilization dependency graph

Dependencies in the stabilization train are explicit only when a phase consumes a type, persisted format, or module interface from an earlier phase. Shared vocabulary, deferred scope, and correctness sequencing are recorded here or in `specs/backlog.md`; they do not create phantom work. Keep each phase narrow enough to verify and deliver along the train below.

### Historical dependency map

The following graph records why the archived architectural phases were delivered in this order. It is reference material, not an active change queue.

```text
telegram-surface-identity ─┬─► immutable-project-environments ─────────────┬─► conversation-lifecycle
                           │                                               ├─► personal-attachment-intake
                           │                                               └─► skill-catalog-resolution
                           ├─► surface-derived-memory-context ─► transcript-surface-provenance ─► conversation-lifecycle
                           └─► surface-skill-policy

pi-native-skill-layout ─► skill-catalog-resolution ─► surface-skill-policy ─► subagent-skill-inheritance

conversation-lifecycle ─┬─► inner-life ─► visible-dreaming rewrite
                        └─► delegated-work-ownership ◄─ immutable-project-environments, ACP boundary
```

`conversation-lifecycle` and its four hard prerequisites are implemented and archived as canonical contracts. Runtime assembly consumes the captured-memory interface from `surface-derived-memory-context`, and user-visible transcript writes consume the writer-context and event-time provenance interfaces from `transcript-surface-provenance`. Compatibility cleanup and review-discovered hardening now proceed as follow-up stabilization work; attachment intake remains a soft edge. Skill policy is handled by its later train and is not a lifecycle contract.

A temporary "same-Surface resume" mode was rejected because canonical unbound Conversations intentionally persist no previous-Surface authority. Enforcing it would require a second historical-binding store that the target model does not otherwise need. Memory capture and transcript provenance were therefore prerequisites, not runtime feature flags.

## Implementation train

One ordered sequence, walked end to end. Historical change names remain useful labels, but the unit of delivery is a plainly tracked implementation phase.

| # | Change | Tasks | Status | Value delivered |
|--:|---|--:|---|---|
| 1 | `telegram-surface-identity` | 33 | **archived** | None user-visible. Unblocks everything; removes chat-ID-sign inference |
| 2 | `immutable-project-environments` | 24 | **archived** | `/project` becomes set-once; personal CWD moves to `workspace/`; `scratch/workdir` dies |
| 3 | `personal-attachment-intake` | patch | **archived** | **First user-visible fix**: captioned uploads stop being silently discarded |
| 3b | `agent-owned-prompt-files` | 12 | **archived** | Decision 0039: canon amendment, prompt-file write notice, subagent bootstrap filter |
| 4 | `surface-derived-memory-context` | 27 | **archived** | Memory scope derives from Surface, not session metadata |
| 5 | `transcript-surface-provenance` | 29 | **archived** | Event-time provenance for history that may move; state version 3; provenance-aware indexing and dreaming |
| 6 | `conversation-lifecycle` | 48 | **archived** | Surface/Binding/Conversation split; compatible movement; Surface-owned preferences and automation; filesystem state version 4 |
| 6a | Persistence and runtime-authority closure | authority corruption + pending-assignment fence | **in progress** | Fail closed on canonical authority corruption; recover only intent-owned planned directories; require lifecycle authority for every Surface runtime |
| 7 | `pi-native-skill-layout` | 9 | **parked** (`specs/parked/`) | `workspace/skills/` → `.agents/skills/` |
| 8 | `skill-catalog-resolution` | 16 | **parked** | Explicit catalog roots; `skillSources` switch dies |
| 9 | `surface-skill-policy` | 16 | **parked** | Per-Surface `/skills` selection |
| 10 | `subagent-skill-inheritance` | patch | **parked** | Generic subagents inherit the frozen resolved manifest |
| 11 | `inner-life` | 25 | **parked** | Bounded wake/effect authority |
| 12 | `delegated-work-ownership` | 36 | **parked** | Attached vs durable work; origin-Surface delivery |
| 13 | `visible-dreaming` | — | **parked (placeholder)** | Rewrite against `inner-life`; must not be built from its placeholder |

Steps 1–6, including attachment intake and agent-owned prompt files, are archived. The persistence and runtime-authority closure is the sole merge-gate implementation slice: it closes corruption/recovery and runtime-fencing gaps without extending parked feature seams. Steps 7–13 remain parked under `specs/parked/` (see `specs/backlog.md`).

**WIP limit: one implementation phase in progress, one plainly described next.** Persistence and runtime-authority closure is the sole current WIP. After its merge gate passes, the next candidate is the parked `pi-native-skill-layout` train; all other parked scope remains deferred until deliberately resumed.

Storage-layout cleanup and workspace write authority cross this chain and must declare dependencies before implementation.

## Feature readiness gate

A feature is ready to propose only when it can answer:

1. Which domain lifetime owns its state?
2. What is its authority source?
3. Which deep module owns the complete transition?
4. Where is canonical persistence, and how does crash recovery work?
5. How does runtime invalidation prevent stale effects?
6. What happens when the Surface is unbound or unreachable?
7. Which earlier implementation phases does it depend on?
8. Does it extend a known-bad compatibility seam?
9. What boundary validation, logs, and tests prove the contract?

If the answer to 1–4 is “the caller coordinates it,” the design is not ready.

## Open architecture work

These decisions or implementation plans block a stable baseline:

1. ~~**Workspace write authority.**~~ Settled by decision 0039 and implemented by `agent-owned-prompt-files`: prompt files are agent-owned, no write guard, bounded Telegram notice per write, inner-life excluded, subagents excluded, recovery via git in `workspace/`.
2. **No-scratch migration:** final destinations and migration steps for subagent and external-agent records.
3. **Delegated-work implementation:** cancellation races, durable storage, completion wakes, reachability input, and pending-delivery reconciliation under decision 0036.
4. **Surface lifecycle:** Telegram topic deletion/reachability, schedule suspension, pending outputs, and project recovery.
5. **Inner-life implementation:** wake/effect schemas, per-effect guarantees, consent persistence, and observability under decision 0035; heartbeat conversion remains undecided.

Each unsettled answer should become an ADR; each accepted direction should have a focused implementation phase. Once the repair map is implemented and remaining questions are either accepted or explicitly deferred, this document can lose the stabilization banner and become the compact permanent architecture map.
