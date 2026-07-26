# Little Goblin Architecture

> **Status: architecture stabilization.** This document maps the implemented system, accepted target architecture, and unresolved design work. It is not a substitute for litespec requirements.

## How to read this document

Goblin currently has three simultaneous truths:

- **CURRENT** — behavior implemented in `src/` and described by `specs/canon/`.
- **TARGET** — behavior established by accepted decisions and active, validated litespec changes.
- **OPEN** — architecture that is known to need work but has not yet been accepted as a contract.

Never silently present TARGET or OPEN behavior as implemented. During stabilization, check all of:

| Source | Job |
|---|---|
| `AGENTS.md` | Engineering guardrails and stabilization gate |
| `ARCHITECTURE.md` | Whole-system ownership, lifetime, authority, and dependency map |
| `specs/canon/` | Implemented behavioral contracts |
| `specs/changes/` | Proposed target behavior and migration plans |
| `specs/decisions/` | Why consequential choices were made |
| `specs/glossary.md` | Canonical domain language |

Detailed behavior belongs in litespec. This file should link concepts and expose contradictions, not copy every requirement.

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
  ├── skill profile (OPEN)
  ├── Surface-derived memory context captured for this runtime
  ├── schedule authority
  └── Telegram delivery/tool closures

Deployment
  ├── product shell
  ├── SOUL.md
  ├── deployment AGENTS.md
  ├── Goblin skill catalog + Surface SkillPolicy
  └── model credentials/catalog
```

The dispatcher verifies the current Binding and environment agreement before constructing any side-effectful adapter. Resuming a Conversation on another compatible Surface creates a fresh runtime using destination Surface settings.

## Prompt architecture

**Accepted by decision 0003.** Main Goblin prompt ownership is explicit:

1. code-owned product shell for runtime mechanics;
2. required deployment `workspace/SOUL.md` for identity and voice;
3. optional deployment `workspace/AGENTS.md` for operating rules;
4. exact `<projectRoot>/AGENTS.md` for project Conversations only;
5. bounded frozen memory summary at runtime creation;
6. relevant-memory aside per turn.

Pi context-file auto-discovery stays disabled for the main runtime. Project guidance is supplemental and must not replace deployment identity. Prompt reads use path helpers and fail loudly according to required/optional semantics.

### Prompt-file write authority

**TARGET — settled by decision 0039.** Prompt files are **agent-owned**. Goblin MAY rewrite `workspace/SOUL.md`, `AGENTS.md`, and `HEARTBEAT.md` with ordinary file tools during a user-facing turn. Onboarding creates them from templates and never overwrites; `SOUL.md` remains required at startup.

There is no reserved-path write guard. The main runtime already has `bash` active (`src/agent/backend.ts:145-155` passes no tool allowlist; pi's default active set is `[read, bash, edit, write]`), and pi resolves absolute paths, so a guard could prevent accidents but never constitute a boundary. Per decision 0012, real isolation is an OS-level concern.

Three constraints bound the authority:

- every prompt-file write posts a bounded notice to the Surface whose runtime performed it;
- inner-life wakes cannot write prompt files — expressed as an absence in the decision 0035 capability profile, not as a file guard; autonomous reflection may propose an identity change, never apply one;
- subagents do not receive deployment prompt files; named agents keep their own `workspace/agents/<name>/AGENTS.md`.

Recovery is git in `$GOBLIN_HOME/workspace`, documented for the operator. Goblin builds no snapshot or undo store.

The `agent-owned-prompt-files` change amends the canon statements that previously called `SOUL.md` "deployment-owned" (`specs/glossary.md:75`, `specs/canon/agent/spec.md`), implements the bounded Surface notice, filters deployment prompt files out of subagent bootstrap, and documents the `git-in-workspace/` recovery path.

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

**TARGET — `personal-attachment-intake` patch.** File attachments derive their destination from the Conversation environment:

- personal: `$GOBLIN_HOME/workspace/attachments/`;
- project: canonical project root, preserving existing project behavior.

Intake uses basename validation and collision-safe reservation, never overwrites an existing file, includes the actual saved relative path in the model prompt, and never forwards a caption alone after silently discarding its file. Personal uploads cannot directly replace workspace prompt or skill paths.

Native model document ingestion remains unavailable in the current pi-ai content model; the agent receives a readable filesystem path.

## Automation and inner life

### Scheduled automation

**TARGET — conversation-lifecycle.** Schedules and heartbeat configuration belong to Surface, not Conversation. At dispatch, automation resolves the Surface's current Conversation. An unbound Surface remains pending and does not auto-create history.

Schedule execution uses the same dispatcher and prompt queue as user turns. A captured occurrence becomes stale if its runtime is invalidated before execution.

### Inner life

**TARGET — decision 0035 and the validated `inner-life` change.** Inner-life wakes have durable records, code-owned per-wake capability profiles, bounded validated effects, effect-specific delivery guarantees, one explicit home Surface, and layered proactive-contact consent. Model output cannot mint authority or reroute contact. Whether heartbeat becomes a private wake remains unsettled, so current Surface-owned heartbeat behavior stays unchanged.

`inner-life` specifies the wake store, profile/effect state machine, crash recovery, and deny-by-default contact path. `visible-dreaming` remains blocked until that dependency is implemented; it may later supply reflection content but must not create a parallel scheduler, delivery, or consent system.

## Memory

Memory's canonical store is `$GOBLIN_HOME/state/memory/memory.sqlite`. Markdown under `state/memory/` is export-only.

**TARGET — decision 0037, `surface-derived-memory-context`, and `transcript-surface-provenance`.** The current Surface is the sole input to `Surface → ActiveScope`; the projection is not persisted as a mutable setting. A conversation runtime captures that context and frozen summary at runtime creation. Subagents capture the parent runtime's context per invocation rather than resolving a later binding. Equal project roots do not merge memory context.

Each new user-visible transcript entry records event-time `sourceSurfaceId`. Indexing and dreaming use that provenance per entry, so one moved Conversation may contain several source Surfaces without rewriting history. Unknown legacy provenance stays null rather than being guessed from the current binding. CURRENT locator/session-derived memory and file-level transcript chat attribution remain compatibility seams until both changes land.

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

Migrations compute and validate every transformation before the first write, use atomic replacement per file, and fail loudly on ambiguity without selecting a winner. They are *not* required to be idempotent, restart-safe, or mixed-generation tolerant; recovery from a failed migration is restoration from backup.

Five remaining changes currently specify their own restart-safe startup migration and need a patch stripping that language before they are built: `immutable-project-environments`, `pi-native-skill-layout`, `conversation-lifecycle`, `transcript-surface-provenance`, and `delegated-work-ownership`.

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

Two kinds of edge exist, and conflating them produced a chain far deeper than the domain requires.

- **Hard edge** — the dependent change's own tasks consume a type, persisted format, or module interface the dependency introduces. Implementing out of order means writing throwaway code. Hard edges live in `dependsOn` in each change's `.litespec.yaml`.
- **Soft edge** — shared vocabulary, a Non-Goals deferral, or a correctness-sequencing concern. Recorded here and in `.litespec.yaml` comments, never in `dependsOn`.

The litespec planning guardrail (*"if your proposal touches more than 3 capabilities, pause and ask whether this should be split"*) is a **spec-hygiene** rule. It keeps a delta spec reviewable. It is not a delivery-planning rule, and treating it as one is what produced a six-deep chain in front of `conversation-lifecycle`. Keep specs narrow; deliver along the train below.

### Hard edges only

```text
telegram-surface-identity ─┬─► immutable-project-environments ─┬─► conversation-lifecycle
                           │                                   ├─► personal-attachment-intake
                           │                                   └─► skill-catalog-resolution
                           ├─► surface-derived-memory-context ─► transcript-surface-provenance
                           └─► surface-skill-policy

pi-native-skill-layout ─► skill-catalog-resolution ─► surface-skill-policy ─► subagent-skill-inheritance

conversation-lifecycle ─┬─► inner-life ─► visible-dreaming rewrite
                        └─► delegated-work-ownership ◄─ immutable-project-environments, ACP boundary
```

`conversation-lifecycle` has exactly two hard prerequisites, not six. None of its 45 tasks reference memory context, transcript provenance, or attachment destination, and it references skill policy only passively.

### Soft edges (sequencing, not blocking)

| Edge | Why it is soft | Consequence of ignoring it |
|---|---|---|
| `immutable-project-environments` → `pi-native-skill-layout` | Referenced as a path string only; no task consumes its helpers | None; `skill-catalog-resolution` owns the real coupling |
| `conversation-lifecycle` → `personal-attachment-intake` | Non-Goals deferral; lifecycle only preserves the stale-runtime guard | None |
| `conversation-lifecycle` → `surface-skill-policy` | One passive task clause: "preserve the prerequisite-defined destination skill policy" | Runtime assembly carries no skill policy field until the skill train lands |
| `conversation-lifecycle` → `surface-derived-memory-context` | **Correctness sequencing.** No task consumes it | Cross-Surface `/resume` moves a Conversation whose memory scope still derives from legacy session metadata |
| `conversation-lifecycle` → `transcript-surface-provenance` | **Correctness sequencing.** No task consumes it | A moved Conversation's prior transcript entries keep file-level chat attribution and can be indexed or dream-promoted into the wrong topic |

The last two are the only ones with teeth. `conversation-lifecycle` may therefore land before them **provided cross-Surface `/resume` is restricted to same-Surface reactivation until both have landed.** Same-Surface `/resume` is the `pi -r` behavior the operator actually asked for; cross-Surface movement is the part that needs provenance. Enforce this restriction in the change, do not leave it to discipline.

## Implementation train

One ordered sequence, walked end to end. The unit of specification is a litespec change; the unit of delivery is this train.

| # | Change | Tasks | Value delivered |
|--:|---|--:|---|
| 1 | `telegram-surface-identity` | 32 | None user-visible. Unblocks everything; removes chat-ID-sign inference |
| 2 | `immutable-project-environments` | 24 | `/project` becomes set-once; personal CWD moves to `workspace/`; `scratch/workdir` dies |
| 3 | `personal-attachment-intake` | patch | **First user-visible fix**: captioned uploads stop being silently discarded |
| 3b | `agent-owned-prompt-files` | — | Decision 0039: canon amendment, prompt-file write notice, subagent bootstrap filter. Not yet specced |
| 4 | `conversation-lifecycle` | 45 | Surface/Binding/Conversation split; stale-runner and multi-binding bugs fixed. Same-Surface `/resume` only |
| 5 | `surface-derived-memory-context` | 27 | Memory scope derives from Surface, not session metadata |
| 6 | `transcript-surface-provenance` | 29 | Event-time provenance; **unlocks cross-Surface `/resume`** |
| 7 | `pi-native-skill-layout` | 9 | `workspace/skills/` → `.agents/skills/` |
| 8 | `skill-catalog-resolution` | 16 | Explicit catalog roots; `skillSources` switch dies |
| 9 | `surface-skill-policy` | 16 | Per-Surface `/skills` selection |
| 10 | `subagent-skill-inheritance` | patch | Generic subagents inherit the frozen resolved manifest |
| 11 | `inner-life` | 25 | Bounded wake/effect authority |
| 12 | `delegated-work-ownership` | 36 | Attached vs durable work; origin-Surface delivery |
| 13 | `visible-dreaming` | — | Rewrite against `inner-life`; must not be built from its placeholder |

Steps 1–2 are behavior-preserving refactors with no user-visible payoff; step 3 is deliberately placed immediately after them so the train produces something the operator can feel before step 4's 45 tasks. Steps 7–9 may be walked in parallel with 5–6 by a second worker; nothing else may.

**WIP limit: one change in progress, one fully specced next.** Everything beyond position 2 in the train stays a paragraph in `specs/backlog.md` until its predecessor lands. Discovery has outpaced closure since 2026-07-22; the only thing that closes the gap is building.

Storage-layout cleanup and workspace write authority cross this chain and must declare dependencies before implementation.

### Overlapping requirement targets

`litespec validate --changes` currently reports two changes editing the same canonical requirement:

- `immutable-project-environments` and `surface-skill-policy` both target *"Surface settings are keyed by SurfaceId"* (`sessions`)
- `delegated-work-ownership` and `surface-derived-memory-context` both target *"Subagent revival loads persisted session"* (`subagents`)

These are merge conflicts waiting to happen. Whichever lands first wins; the second must be re-based against the new canon before it is built, not after.

## Feature readiness gate

A feature is ready to propose only when it can answer:

1. Which domain lifetime owns its state?
2. What is its authority source?
3. Which deep module owns the complete transition?
4. Where is canonical persistence, and how does crash recovery work?
5. How does runtime invalidation prevent stale effects?
6. What happens when the Surface is unbound or unreachable?
7. Which active architecture changes does it depend on?
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

Each unsettled answer should become an ADR; each accepted direction should have a focused litespec change. Once the repair map is implemented and remaining questions are either accepted or explicitly deferred, this document can lose the stabilization banner and become the compact permanent architecture map.
