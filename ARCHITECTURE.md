---
nospec: true
role: record
owns: system-architecture
---

# Little Goblin Architecture

> **Status: architecture stabilization.** This document maps the implemented system, accepted target architecture, and unresolved design work. Code/tests own current behavior, designated contract records own their assigned promises, and accepted decisions own architectural rulings.

## How to read this document

Goblin currently has three simultaneous truths:

- **CURRENT** — behavior implemented in `src/` and exercised by current tests.
- **TARGET** — behavior established by accepted decisions and the current stabilization plan.
- **OPEN** — architecture that is known to need work but has not yet been accepted as a contract.

Never silently present TARGET or OPEN behavior as implemented. During stabilization, check all of:

| Source | Job |
|---|---|
| `AGENTS.md` | Engineering guardrails and stabilization gate |
| `ARCHITECTURE.md` | Whole-system ownership, lifetime, authority, and dependency map |
| `decisions/` | Accepted architectural rulings and their rationale |
| `glossary.md` | Canonical domain language |
| `BACKLOG.md` | Current priority, next cycle, parked scope, and open questions |
| code, tests, and designated contracts | Current implemented behavior and explicit promises |
| `specs/` | Frozen Litespec-era history and design input; not active authority |

Detailed current behavior belongs in code/tests or an explicitly designated contract record; consequential rulings belong in decisions. This file links concepts and exposes contradictions rather than copying every requirement.

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

A runtime is never routing or persistence identity. Stale runtime work must fail its current-binding check before filesystem writes, Telegram replies, schedule mutation, or model prompts. Lifecycle commands already acknowledged behind a turn are serialized by current Binding authority rather than stale runner identity, so same-binding preference invalidation preserves their order while a binding change drops them.

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

**External-agent exception — accepted by decision 0041.** The Conversation Execution Environment remains immutable and authoritative for the main runtime and pi history. A fully trusted same-user external agent may select a working directory and invocation outside that environment. Its captured Conversation environment remains provenance and default context, not filesystem confinement.

`/project` is one-time Surface initialization. First assignment preserves the personal Conversation and starts fresh project history. Switching or clearing through ordinary `/project` is rejected.

## Ownership by lifetime

| State or behavior | Target owner |
|---|---|
| Telegram address and lane kind | Surface |
| Project assignment | Surface |
| Model and thinking preferences | Surface |
| SkillPolicy | Surface **(CURRENT — decision 0034)** |
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
| Delegated-run record and cross-run lifecycle | Delegated-work subsystem **(CURRENT store + attached lifetime — decision 0045; remaining durable/completion scope — decision 0036)** |
| Pi session construction for delegated work | Pi execution host **(CURRENT — decision 0040)** |
| External provider/process protocol mechanics | External-agent execution host **(TARGET — decision 0040)** |
| External-agent working directory, invocation parameters, and permission profile | Main model through structured launch input **(TARGET — decision 0041)** |
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
  ├── Surface SkillPolicy (CURRENT — decision 0034)
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

The dispatcher receives mandatory lifecycle-owned Surface runtime authority at construction. It also receives the concrete `ConversationRuntimeHost` mandatorily; it cannot create a second runtime owner. That authority reconciles a pending project assignment before every Surface-backed runtime acquisition. `PreparedRuntimeAssembler` now produces one ephemeral immutable `PreparedSurfaceRuntimePlan` before `AgentRunner` construction: runtime and Surface identity, the Conversation environment/CWD, one coherent Surface settings fingerprint, resolved model and thinking, prompt text plus source provenance and frozen memory summary, captured memory authority, exact resolved skills, and a closed code-owned current-capability manifest. The plan is never persisted and its credential-bearing resolved model is never logged.

Preparation retains asynchronous binding and synchronous reservation/settings checks around skill resolution, old-runtime quiescence, memory capture, and prompt reads. A final synchronous no-await section checks the candidate, constructs the Surface runner solely from the plan, and registers that generation. Surface `AgentRunner` initialization does not reread model, prompt files, or skill catalogs; internal runtimes retain their existing lazy assembly path. The runner's synchronous authority closure still makes queued work fail closed after a binding change. Resuming a Conversation on another compatible Surface creates a fresh plan using destination Surface settings.

The runtime host is also the shutdown fence for ephemeral Conversation work. `closeAdmission()` synchronously rejects new runtime creation, registration, and queue admission. Its idempotent single-flight `disposeAll()` then awaits admitted prompt queues, in-flight construction reservations, active per-runtime disposals, and runner/delegated-work cleanup. The deployment signal path closes Telegram intake and text coalescing, stops scheduler timers, and shares one shutdown promise across repeated signals before it awaits cleanup. Runtime admission also fences any scheduler dispatch that was already in flight.

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

There is no reserved-path write guard. The main runtime already has `bash` active (`src/agent/backend.ts:145-155` passes no tool allowlist; pi's default active set is `[read, bash, edit, write]`), and pi resolves absolute paths, so a guard could prevent accidents but never constitute a boundary. The process runs as the operator's Unix user; stronger filesystem isolation requires an OS-level sandbox and is outside this file-tool policy.

Three constraints bound the authority:

- every prompt-file write posts a bounded notice to the Surface whose runtime performed it;
- inner-life wakes cannot write prompt files — expressed as an absence in the decision 0035 capability profile, not as a file guard; autonomous reflection may propose an identity change, never apply one;
- subagents do not receive Goblin's agent-owned prompt files; named agents keep their own `workspace/agents/<name>/AGENTS.md`.

Recovery is git in `$GOBLIN_HOME/workspace`, documented for the operator. Goblin builds no snapshot or undo store.

The archived `agent-owned-prompt-files` change amended the legacy canon statements that previously called `SOUL.md` "deployment-owned" (`glossary.md`, formerly `specs/glossary.md`, and `specs/canon/agent/spec.md`), implemented the bounded Surface notice, filtered Goblin's agent-owned prompt files out of subagent bootstrap, and documented the `git-in-workspace/` recovery path.

## Skill architecture

**CURRENT — accepted by decisions 0034 and 0043.** Goblin stores deployment-wide skills at `.agents/skills/` and personal-environment skills at `workspace/.agents/skills/`. The one deployment's empty legacy catalog was moved manually; Goblin has no migration step or legacy path compatibility. Runtime construction resolves exact roots from Conversation environment plus a SkillPolicy via `SkillCatalogResolver` (`src/agent/skills/`), disables Pi ambient skill discovery (`noSkills: true`), and passes only the selected skill file paths as `additionalSkillPaths`. The process-wide `skillSources` config field is removed; a legacy key fails validation with actionable guidance. The frozen skill proposals are historical design input, not specifications to execute.

| Skill source | Canonical location | Authority |
|---|---|---|
| Goblin catalog | `$GOBLIN_HOME/.agents/skills/` | Deployment-wide capabilities eligible on personal or project Surfaces |
| Personal environment catalog | `$GOBLIN_HOME/workspace/.agents/skills/` | Capabilities authored for the personal Execution Environment |
| Project environment catalog | exact `<projectRoot>/.agents/skills/` and `<projectRoot>/.pi/skills/` | Capabilities supplied by one project Execution Environment |
| Host catalog | exact `~/.agents/skills/` | Unix-user capabilities, disabled by default and explicitly selectable |
| Named-agent catalog | `$GOBLIN_HOME/workspace/agents/<name>/.agents/skills/` | Isolated named-agent capabilities; legacy `skills/` is ignored |

A Surface owns independent `goblin`, `environment`, and `host` selections. Each source is `all`, `none`, or an explicit selected-name set. Defaults are Goblin all, environment all, host none. The optional policy is persisted in the SurfaceId-keyed topic settings record; absence means the defaults without an eager write. `/new` preserves policy; `/resume` uses destination Surface policy.

`ConversationLifecycle` owns `/skills` inspection, policy mutation, and reload transitions. It also owns atomic Surface model/thinking preference transitions for `/model` and `/think`; commands validate intent but never mutate an `AgentRunner` directly. Inspection is non-creating; mutation and reload resolve the candidate catalog before persistence/invalidation, then invalidate the current runtime through the existing runtime-host seam. Cleanup failure is reported after the durable policy is already authoritative. Runtime construction resolves exact roots from Conversation environment plus destination Surface policy before registering the runner, freezes the resolved manifest, disables Pi ambient skill discovery, and records source/path provenance. It never walks above canonical `projectRoot`, never implicitly loads `~/.pi/agent/skills/` or package skills, and fails on distinct selected files with duplicate names rather than depending on discovery order. Catalog edits take effect on runtime recreation or `/skills reload`.

The operator moved legacy `workspace/skills/` to the Goblin catalog because it historically followed the assistant into every environment. Generic subagents inherit the caller runtime's exact environment and frozen manifest. Named agents use only their canonical isolated `.agents/skills/` catalog; legacy per-agent `skills/` directories are ignored and any deployment move is operator-owned.

## MCP

**CURRENT and TARGET — accepted by decision 0042.** `mcporter` is Goblin's sole MCP gateway. It owns MCP transport, OAuth, server configuration, and server lifecycle. Goblin's `McpRunner` may invoke the gateway, select configured servers, cache and describe its catalog, normalize and bound results, and enforce timeouts; Goblin does not implement a direct MCP client or alternate gateway.

The current `bunx --silent mcporter` command is implementation rather than architecture. Installation, version pinning, preflight, media normalization, and catalog UX may change without moving the gateway boundary. A direct stdio/HTTP/SSE client or another gateway requires a superseding decision.

## Attachment architecture

**CURRENT — archived `personal-attachment-intake` patch.** File attachments derive their destination from the Conversation environment:

- personal: `$GOBLIN_HOME/workspace/attachments/`;
- project: canonical project root, preserving existing project behavior.

Intake uses basename validation and collision-safe reservation, never overwrites an existing file, includes the actual saved relative path in the model prompt, and never forwards a caption alone after silently discarding its file. Personal uploads cannot directly replace workspace prompt or skill paths.

Native model document ingestion remains unavailable in the current pi-ai content model; the agent receives a readable filesystem path.

## Automation and inner life

### Scheduled automation

**CURRENT — archived `conversation-lifecycle`.** Schedules and heartbeat configuration are Surface-owned. At dispatch, automation resolves the Surface's current Conversation; an unbound Surface remains pending and does not auto-create history. Schedule records, late binding inspection, pending-unbound occurrences, and heartbeat prompt paths all use Surface authority. The scheduler reaches that authority through `ConversationLifecycle.resolveCurrent`; the compatibility `SessionManager.peekBinding` seam is removed.

Scheduled turns use the same dispatcher and prompt queue as user turns. A captured occurrence becomes stale if its runtime is invalidated before execution.

### Inner life

**TARGET — accepted by decision 0035.** Inner-life wakes have durable records, code-owned per-wake capability profiles, bounded validated effects, effect-specific delivery guarantees, one explicit home Surface, and layered proactive-contact consent. Model output cannot mint authority or reroute contact. Whether heartbeat becomes a private wake remains unsettled, so current Surface-owned heartbeat behavior stays unchanged.

The frozen `inner-life` proposal is historical design input, not an implementation specification. Fresh shaping must settle the remaining wake-store, profile/effect state-machine, crash-recovery, and deny-by-default contact details under decision 0035. `visible-dreaming` remains blocked until that implementation exists; it may later supply reflection content but must not create a parallel scheduler, delivery, or consent system.

## Memory

Memory's canonical store is `$GOBLIN_HOME/state/memory/memory.sqlite`. Markdown under `state/memory/` is export-only.

**CURRENT — decision 0037, `surface-derived-memory-context`, and `transcript-surface-provenance`.** The current Surface is the sole input to `Surface → ActiveScope`; the projection is not persisted as a mutable setting. A conversation runtime captures that context and frozen summary at runtime creation. Subagents capture the parent runtime's context per invocation rather than resolving a later binding. Equal project roots do not merge memory context.

Each new user-visible transcript entry records event-time `sourceSurfaceId`. Indexing and dreaming use that provenance per entry, so one moved Conversation may contain several source Surfaces without rewriting history. Unknown legacy provenance stays null rather than being guessed from the current binding. Filesystem `stateVersion` is now 4; the transcript migration, mixed-chat index rebuild, provenance-driven dreaming, startup gate, boundary tests, two-Surface end-to-end fixture, and lifecycle migration are implemented.

**CURRENT — conversation lifecycle and closure hardening complete.** Cross-Surface movement is wired into intake and commands; runtime capture/writer authority, archive ordering, Surface-owned preferences and automation, offline ownership migration step 4, canonical authority validation, planned-assignment recovery, and mandatory runtime authority are implemented and covered by current tests. The archived `conversation-lifecycle` material is delivery provenance only.

Dreaming currently uses compatibility internal-session machinery. TARGET architecture uses an explicit Surface-free internal memory context and later removes fake Telegram/session identity through `inner-life`/`visible-dreaming`, never by adding an internal Surface variant.

## Delegated work

### Subagents

**CURRENT — Pi execution host extraction and host-owned attached records complete.** Subagents have custom Pi construction behind `PiSubagentHost`, generic/named definitions, recursive spawning, and host-owned records. `PiSubagentHost` owns Pi session construction, resource loading, Pi event mechanics, and one invocation-lifetime execution lease; `SubagentRunner` and `execution.ts` own invocation preparation, memory/tool assembly, and durable lifecycle transitions through `DelegatedWorkHost`. Generic subagents inherit the caller runtime's immutable Execution Environment and frozen resolved skill manifest — exact selected files with no catalog re-discovery; recursive spawns inherit the received authority, revivals inherit the reviving runtime's authority, and a missing or unloaded inherited file fails the invocation visibly. Named definitions load only their isolated `workspace/agents/<name>/.agents/skills/` catalog with ambient discovery disabled; they do not inherit caller skills, and legacy `skills/` directories are ignored.

**CURRENT — decision 0045 record store.** Attached generic and named subagent runs persist only under `state/delegated-work/runs/<id>/`: one validated `record.json` (stable identity plus append-only invocation log) plus that run's pi session state. `DelegatedWorkHost` owns record creation, lifecycle transitions, listing, revival intent, attached-work fence/cancellation, and startup reconciliation that marks non-terminal attached invocations interrupted. Revival appends a new invocation continuing the persisted session in place; a prior interrupted invocation is never patched back to `running`. Offline step 5 is a layout break to state version 5: it creates the runs root and advances the gate; legacy `scratch/subagents/` and `workspace/agents/*/instances/` are abandoned in place with no data transformation. Current blocking generic/named invocations are attached and their full recursive tree dies with the creating runtime.

TARGET direction:

- `DelegatedWorkHost` still owes cross-run durable lifetime, cancellation races beyond the attached fence, completion delivery, and pending-completion claim/ack/release under decision 0036. Durable subagents require a future detached-result contract. External-agent records join the same store when the ACP cycle lands under decision 0044.

### External agents

**CURRENT legacy / TARGET accepted by decision 0044.** Current code still uses provider-native Codex/Claude adapters, new-session ACP for Devin, and optional PTY fallback. The accepted target replaces the Claude and Devin paths with capability-scoped ACP behind the external-agent execution host: exact-version-pinned `@agentclientprotocol/claude-agent-acp` for Claude and native `devin acp --model glm-5.2` for Devin. Neither qualified backend needs Goblin-hosted ACP filesystem or terminal capability. Claude continues completed context with `session/resume`; Devin uses `session/load`. Permission mode is reapplied on every connection, and local process cleanup remains distinct from provider-session retirement. Codex transport is still unclassified and must not inherit claims proved only for Claude and Devin.

Executable scouting proved that neither backend retains an interrupted user turn across a fresh server process. An active prompt therefore becomes terminally interrupted after process loss; Goblin does not send a generic continuation prompt or claim process-restart durability without a separate task-persistence and replay decision. Completed provider context may support explicit follow-up work under the owning Conversation.

**TARGET — accepted by decisions 0036 and 0040.** The delegated-work subsystem owns run authority, cross-run lifetime, cancellation policy, and completion delivery. Pi construction and external provider/process execution remain distinct hosts behind that subsystem. Every run captures a controlling owner Conversation, lifetime, Conversation Execution Environment, and origin Surface. Backend protocol capability determines whether completed provider context can continue; active Claude and Devin prompts cannot continue across process death under decision 0044. Explicit owner cancellation remains destructive. Automatic completion delivery never leaves the origin Surface merely because another lane shares a CWD.

**TARGET trust boundary — accepted by decision 0041.** Goblin's main model and spawned external agents are fully trusted delegates of the same Unix user. The model may select working directory, invocation parameters, and permission profile, including an unattended dangerous profile. Project CWD and provider modes are not confinement; the same-user OS boundary is the security floor. Goblin does not inject its ambient Telegram or model-provider secrets by default; external CLIs use their same-user credential stores. That default prevents accidental secret duplication but cannot make a same-user child untrusted. Whether executable selection or explicit child-environment overrides become model-facing remains unresolved.

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
    ├── delegated-work/runs/<id>/      # delegated-run records + execution state (decision 0045)
    └── pi/                            # auth + model catalog, not execution CWD
```

There is no target `$GOBLIN_HOME/scratch/` tree. True temporary data belongs in the OS temp directory or atomic sibling temp files and must not be authoritative. `scratch/workdir` is retired. Subagent records already live under `state/delegated-work/runs/`; legacy `scratch/subagents/` and `workspace/agents/*/instances/` are abandoned in place after the state-version-5 layout break (operator deletes manually). `scratch/external-agents/` remains a live legacy tree until the ACP cycle abandons it the same way under decision 0044.

Named-agent definitions stay under `workspace/agents/<name>/`; machine-managed run state does not share that directory.

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

The implemented machine-managed filesystem sequence is Surface identity (step 1), immutable Execution Environments (step 2), transcript Surface provenance (step 3), Conversation lifecycle ownership (step 4), then delegated-work layout break (step 5). The current filesystem gate is state version 5. Step 5 creates `state/delegated-work/runs/` and advances the version; it does not transform legacy subagent trees. Native skill layout was an operator-owned move and does not participate in this sequence.

The frozen `pi-native-skill-layout` proposal remains historical input and contains obsolete migration language; its delivered replacement is owned by current paths/tests plus decision 0043's operator action. The parked `delegated-work-ownership` proposal also has obsolete migration language and must not carry it into fresh work. Current offline migration behavior is owned by the migration runner and its tests; archived and frozen change material is provenance only.

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
| Explicit Goblin path + `skillSources` | ~~Native storage exists, but runtime source authority is still process-wide and ambient~~ Resolved: `SkillCatalogResolver` owns exact-root resolution; `skillSources` removed; Surface-owned policy selects sources | ~~`skill-catalog-resolution`~~ → ~~`surface-skill-policy`~~ |
| Personal CWD under `scratch/workdir` | User work is ephemeral and unbacked-up | personal workspace environment migration |
| Durable records under `scratch/` | “Durable but disposable” contradiction | ~~Subagent half: one host-owned store + v5 layout break (decision 0045)~~; external-agent half rides ACP cycle (decision 0044), abandoned in place |
| Named definitions mixed with instance state | User-authored and machine-managed lifetimes mixed | ~~Resolved for subagents: runs under `state/delegated-work/runs/`; definitions stay in `workspace/agents/<name>/`~~ |
| Internal dreaming fake session identity | Borrowed routing/runtime machinery | `inner-life` → future `visible-dreaming` rewrite |
| Attached/durable work implicit | Rotation may cancel or orphan wrong work | `delegated-work-ownership` |
| External-agent fixed project CWD and two non-dangerous profiles | Contradicts the accepted fully trusted same-user delegate boundary | model-selected launch context under decision 0041 |
| `bot.ts`/`tg/intake.ts` orchestration choreography | Shallow seams and duplicated transitions | lifecycle + dispatcher modules |

## Stabilization dependency graph

Dependencies in the stabilization train are explicit only when a phase consumes a type, persisted format, or module interface from an earlier phase. Shared vocabulary, deferred scope, and correctness sequencing are recorded here or in `BACKLOG.md`; they do not create phantom work. Keep each phase narrow enough to verify and deliver along the train below.

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
                        └─► delegated-work-ownership ◄─ immutable-project-environments, classified external-host capabilities
```

`conversation-lifecycle` and its four hard prerequisites are implemented; current code and tests own that behavior, while the archived change material preserves delivery provenance. Runtime assembly consumes the captured-memory interface, and user-visible transcript writes consume writer context and event-time provenance. The persistence/runtime-authority hardening slice, Surface skill-policy train, and both halves of subagent skill inheritance are complete.

A temporary "same-Surface resume" mode was rejected because canonical unbound Conversations intentionally persist no previous-Surface authority. Enforcing it would require a second historical-binding store that the target model does not otherwise need. Memory capture and transcript provenance were therefore prerequisites, not runtime feature flags.

## Implementation train

One ordered sequence, walked end to end. Historical change names and task counts are provenance only; accepted decisions and this architecture record define direction, while fresh work is shaped from current code.

| # | Change | Tasks | Status | Value delivered |
|--:|---|--:|---|---|
| 1 | `telegram-surface-identity` | 33 | **archived** | None user-visible. Unblocks everything; removes chat-ID-sign inference |
| 2 | `immutable-project-environments` | 24 | **archived** | `/project` becomes set-once; personal CWD moves to `workspace/`; `scratch/workdir` dies |
| 3 | `personal-attachment-intake` | patch | **archived** | **First user-visible fix**: captioned uploads stop being silently discarded |
| 3b | `agent-owned-prompt-files` | 12 | **archived** | Decision 0039: legacy-doc amendment, prompt-file write notice, subagent bootstrap filter |
| 4 | `surface-derived-memory-context` | 27 | **archived** | Memory scope derives from Surface, not session metadata |
| 5 | `transcript-surface-provenance` | 29 | **archived** | Event-time provenance for history that may move; state version 3; provenance-aware indexing and dreaming |
| 6 | `conversation-lifecycle` | 48 | **archived** | Surface/Binding/Conversation split; compatible movement; Surface-owned preferences and automation; filesystem state version 4 |
| 6a | Persistence and runtime-authority closure | authority corruption + pending-assignment fence | **complete** | Fail closed on canonical authority corruption; recover only intent-owned planned directories; require lifecycle authority for every Surface runtime |
| 6b | Command/lifecycle authority closure | architectural review D1–D2 | **complete** | Commands use complete lifecycle operations; Surface preference writes invalidate runtime authority without direct runner mutation |
| 7 | `pi-native-skill-layout` | fresh Nospec slice | **implemented** | Native scoped roots; operator-owned one-time move |
| 8 | `skill-catalog-resolution` | fresh Nospec slice | **implemented** | Explicit catalog roots; `SkillCatalogResolver`; `skillSources` switch dies |
| 9 | `surface-skill-policy` | fresh Nospec slice | **implemented** | Per-Surface `/skills` selection |
| 10 | `subagent-skill-inheritance` | patch | **implemented** | Generic subagents inherit frozen runtime authority; named agents use isolated pi-native catalogs |
| 10a | `delegated-run-records` | fresh Nospec cycle | **implemented** | Decision 0045: host-owned store at `state/delegated-work/runs/`; attached subagent records; revival appends invocations; v5 layout break abandons legacy trees in place; startup reconciliation interrupts non-terminal attached invocations |
| 11 | `inner-life` | 25 | **parked** | Bounded wake/effect authority |
| 12 | `delegated-work-ownership` | 36 | **parked** | Remaining durable lifetime, completion delivery, claim/ack/release (record store carved out as 10a) |
| 13 | `visible-dreaming` | — | **deferred; prior placeholder deleted** | Rewrite against `inner-life`; recover historical notes from Git only if needed |

Steps 1–10a, including attachment intake, agent-owned prompt files, the persistence/runtime-authority and command/lifecycle authority closures, native skill layout, catalog resolution, Surface skill policy, subagent skill inheritance, and the delegated-run record store, are complete. Steps 11–12 remain frozen historical inputs under `specs/parked/`, and step 13 has no live parked artifact (see `BACKLOG.md`).

### Second inward solidification pass

Before ACP or other product work, the implementation returns to the remaining mismatch between the accepted runtime model and its physical module ownership. This pass borrows discipline rather than scale from larger agent systems: prepare authoritative facts before activation, freeze one runtime generation's inputs, and keep execution behind narrow code-owned seams. It does not introduce a gateway, plugin SDK, dynamic tool discovery, SQLite-only persistence, provider registry, or generic channel abstraction.

The delivery order is:

1. **Runtime-kernel ownership — implemented.** `ConversationRuntimeHost` concretely owns runtime registration, in-flight construction, queues, and disposal authority. The composition root constructs it before lifecycle and dispatcher; Telegram intake receives the completed kernel and no longer contains the nullable lifecycle/dispatcher hookup.
2. **Prepared runtime assembly — implemented in this cycle.** `PreparedRuntimeAssembler` resolves one immutable ephemeral Surface-runtime plan before runner construction and registration while preserving every asynchronous authority and race-closing checkpoint. Surface `AgentRunner` consumes that plan without lazy model, prompt, or skill rereads; internal runtimes are unchanged.
3. **Capability/tool assembly plus a smaller `AgentRunner` facade — implemented.** `CapabilityManifestToolSource` owns concrete Surface capability selection and tool assembly behind a narrow interface. `AgentEventHandler` owns transcript writes, metrics, callback dispatch, streamed-text reconciliation, prompt-file notices, and stale-event fencing. `AgentRunner` remains the execution facade for prompt control and runtime authority; no dynamic discovery or plugin registry was introduced.
4. **Runtime authority consolidation — accepted by decision 0046, implementation pending.** One per-conversation runtime machine behind the `ConversationRuntimeHost` port owns admission, generation identity, queueing, and disposal. Authority is held as epochs and compared at commit points rather than re-derived at module boundaries; the prompt queue becomes an explicit entry list; shutdown becomes one owned phase list. This supersedes the completed pass's single-check guardrail clause.

**WIP limit: one implementation phase in progress, one plainly described next.** Prepared runtime assembly, capability/tool assembly, and event handling are implemented and verified. Runtime authority consolidation under decision 0046 is the one named next cycle; ACP external agents follows it under decision 0044 with its accepted backend and persistence scope unchanged.

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
2. ~~**No-scratch subagent records.**~~ Settled by decision 0045 and implemented: host-owned store, v5 layout break, legacy subagent trees abandoned in place. External-agent half remains: abandon `scratch/external-agents/` in place when ACP lands under decision 0044.
3. **Delegated-work remainder:** attached record store is CURRENT under decision 0045; cancellation races beyond the attached fence, durable lifetimes, completion wakes, reachability input, and pending-delivery reconciliation remain under decision 0036.
4. **Surface lifecycle:** Telegram topic deletion/reachability, schedule suspension, pending outputs, and project recovery.
5. **Inner-life implementation:** wake/effect schemas, per-effect guarantees, consent persistence, and observability under decision 0035; heartbeat conversion remains undecided.

Each unsettled answer should become an ADR; each accepted direction should have a focused implementation phase. Once the repair map is implemented and remaining questions are either accepted or explicitly deferred, this document can lose the stabilization banner and become the compact permanent architecture map.
