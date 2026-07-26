# delegated-work-ownership — Design

## Architecture

### Delegated work becomes a deep subsystem

The prerequisite changes provide canonical `ConversationId`, exact Conversation runtime identity, complete `SurfaceId`, and immutable `ExecutionEnvironment`. This change introduces a transport-agnostic delegated-work subsystem rather than teaching Conversation lifecycle about subagent and ACP record shapes:

```text
ConversationLifecycle
  └─ ConversationRuntimeHost.invalidate(runtimeId)
       └─ DelegatedWorkHost.invalidateRuntime(runtimeId)
            ├─ attached registry ──> SubagentRunner adapter
            ├─ durable registry  ──> ExternalAgentRunner adapter
            └─ PendingCompletionStore

explicit user cancel
  └─ DelegatedWorkHost.cancelByConversation(ownerConversationId)
       ├─ attached work
       └─ durable work

authorized ordinary Surface interaction
  └─ PendingCompletionStore.claim(originSurfaceId)
       └─ TurnDispatcher accepts or releases claim
```

`src/delegated-work/host.ts` owns the cross-adapter policy. Conversation lifecycle sees one operation and does not know whether a run is a subagent, ACP session, or future delegated implementation. Subagent and external-agent modules continue to own their execution details and bounded artifacts.

The public ownership value is a discriminated union:

```ts
type DelegatedWorkOwnership =
  | {
      lifetime: "attached";
      ownerConversationId: ConversationId;
      runtimeId: ConversationRuntimeId;
      originSurfaceId: SurfaceId;
      executionEnvironment: ExecutionEnvironment;
      ownershipEpochId: string;
    }
  | {
      lifetime: "durable";
      ownerConversationId: ConversationId;
      originSurfaceId: SurfaceId;
      executionEnvironment: ExecutionEnvironment;
    };
```

The discriminator makes an attached run without runtime identity and a durable run pretending to belong to a runtime unrepresentable after validation. `ownerConversationId` grants explicit control. `originSurfaceId` grants only automatic completion delivery. Environment equality grants only filesystem compatibility.

### Registration and invalidation are race-safe

Every adapter registers an invocation before execution can produce effects. Registration includes a code-owned run kind and closures or adapter references for:

- fencing new descendants or continuation work;
- detaching runtime-owned observers;
- destructive cancellation;
- proving terminal/quiescent state;
- reading a bounded terminal completion.

`DelegatedWorkHost.invalidateRuntime(runtimeId)` performs this order:

1. Atomically fence the runtime id inside the host. Later attached registration for that id fails before adapter persistence or execution.
2. Ask every adapter with attached work in the epoch to fence child creation synchronously.
3. Remove or invalidate the runtime's runner and prompt-queue identity so existing stale guards fail.
4. Detach durable-run observers associated with the runtime. Durable execution records never change owner, origin, or environment.
5. Claim cancellation for every attached invocation in the complete epoch, including descendants behind terminal ancestors.
6. Start cancellation/abort work without waiting parent-first, avoiding a parent blocked on a child result.
7. Await adapter quiescence reports. Aggregate failures and reject invalidation if any invocation can still produce effects.

There is no “cleanup timed out, continue transition” success path. A bound cleanup timeout may still protect the process, but timeout is a failed quiescence proof and therefore fails rotate/resume/archive/project before binding mutation. Per-run errors are logged and all targets are attempted; errors are not swallowed at the host boundary.

The target `ConversationRuntimeHost` from `conversation-lifecycle` supplies stable runtime ids. `TurnDispatcher` removes map/queue identity synchronously, but the lifecycle operation does not commit until `DelegatedWorkHost` confirms attached work is dead and durable observation is detached.

### Explicit cancellation is a different verb

`cancelByConversation(ownerConversationId)` is not implemented as runtime invalidation with a flag. It selects both attached and durable non-terminal work by owner Conversation, asks every adapter to perform destructive cleanup, and returns a structured report of cancelled, already-terminal, and unproven targets. Run-specific cancellation takes `(runId, ownerConversationId)` and uses the same owner check.

This distinction preserves the accepted rules:

- `/new`, `/resume`, `/archive`, and `/project` invalidate runtime authority: attached dies, durable remains;
- an explicit user interrupt/cancel controls work owned by the Conversation: both lifetimes die;
- process shutdown uses adapter-specific shutdown behavior: ACP may cleanly detach a resume-eligible run, while subagents are cancelled.

All mismatched owner lookups return the adapter's ordinary not-found result. Neither a current binding nor an equal project root is consulted for control.

### Subagents remain attached

Current `spawn_subagent` and `revive_subagent` calls block until result or timeout. They therefore have one valid delivery path: return to the direct caller while its runtime remains current. Making them durable would require a detached result channel and changed tool semantics; this change deliberately does neither.

At a top-level spawn, the `AgentRunner`-bound tool factory passes a validated runtime context object rather than separate `sessionId`, memory scope, and project values. `SubagentRunner` creates an `ownershipEpochId`, persists the full attached ownership value, and registers the invocation before starting pi.

Recursive tools receive an immutable root context. Child records keep their own id, parent id, role, and depth while inheriting exact owner Conversation, runtime id, epoch id, origin Surface, Execution Environment, and active memory context. `spawnedBy` remains ancestry, not authority.

On successful completion, `handle.result` returns through the existing blocking tool and is considered delivered. On invalidation, the epoch fence prevents new children, cancellation rejects/aborts blocking calls, and late events cannot reach status callbacks from the old runtime.

Revival treats persisted pi history and active invocation lifetime separately:

1. Load and validate history/meta without mutation.
2. Authorize stored `ownerConversationId` against the reviving runtime's Conversation.
3. Open history only under the immutable environment already checked by the runtime.
4. Create and atomically persist a new attached ownership epoch using the reviving runtime id, origin Surface, and captured active memory context.
5. Register the new invocation and run the follow-up.

A pre-change terminal record lacks ownership. Its first post-migration revival may be claimed by the authorized current Conversation, but that operation writes a complete new epoch and never treats historical output as pending delivery. Once owner metadata exists it cannot be reassigned.

### New ACP runs are durable

The ACP prerequisite already separates local server process lifetime from logical ACP session lifetime. This change adds the orthogonal Conversation-lifecycle ownership fields.

`external_agent start` is closed over one validated `DelegatedStartContext` from the current runtime:

```ts
interface DelegatedStartContext {
  ownerConversationId: ConversationId;
  runtimeId: ConversationRuntimeId;
  originSurfaceId: SurfaceId;
  executionEnvironment: ExecutionEnvironment;
}
```

The tool accepts only agent id and task. `ExternalAgentRunner.start` validates that the environment is project-kind, stores the full environment rather than accepting an arbitrary CWD authority, and writes `lifetime: "durable"`. The runtime id is used only to associate and later detach the current tool-call observer; it is not persisted as durable ownership.

ACP output continues through bounded runner persistence after the initiating call returns. Runtime invalidation removes any coarse status observer but does not invoke ACP cancellation. Explicit owner cancellation retains ACP's stopping, terminal-claim, cleanup-grace, session-close, terminal-child, and concurrency rules.

`message` checks owner Conversation and existing ACP lineage rules. A continuation child gets a fresh run id/deadline/delivery state while copying the source's owner, durable lifetime, environment, and origin Surface. Calling from a moved Conversation is explicit control, not a reason to recapture the new Surface.

Conversation durability does not alter clean-restart continuation. ACP's fingerprint, eligibility, deadline, boot id, clean-detach marker, and child-exit proof remain the only restart authority. Non-resume-eligible durable work can survive `/new` but still becomes interrupted at deployment shutdown.

### Pending completion is a pull-on-interaction protocol

`src/delegated-work/pending-store.ts` persists an atomic JSON record at the path returned by `src/delegated-work/paths.ts`, under `$GOBLIN_HOME/state/delegated-work/`. The store is keyed by stable delivery id/run id and validates every external value at load. Each pending record contains:

```ts
interface PendingCompletion {
  deliveryId: string;
  runId: string;
  runKind: "external-agent";
  ownerConversationId: ConversationId;
  originSurfaceId: SurfaceId;
  terminalStatus: "completed" | "failed" | "timed_out" | "interrupted";
  completedAt: string;
  payload: string; // bounded, untrusted completion data
  state: "pending" | "claimed";
  claimToken?: string;
}
```

The payload is copied from the canonical bounded run result/status when terminal state is committed. It is capped at 16,000 characters, contains no task text except provider echoes already allowed by ACP, and retains `runId` for explicit status retrieval. This bounded copy allows normal external-run event retention to continue without making an undelivered completion unreadable.

Claims are oldest-first, at most four records and 32,000 payload characters per ordinary interaction. The collection may retain multiple individually bounded pending records; it never drops an accepted completion merely to enforce a count cap. Operator resolution and future Surface recovery can suppress records explicitly, but this change adds no replacement-Surface policy.

Terminal commit is restart-safe without claiming a cross-file transaction:

1. Finish ordered event/result persistence and prove ACP local cleanup as required.
2. Idempotently write the pending completion keyed by run id.
3. Persist terminal execution metadata with delivery `pending`.
4. Expose terminal status.

Startup reconciliation runs before polling. A pending record with stale run metadata repairs the metadata cache; terminal metadata requiring pending delivery recreates the bounded record from canonical result material. Explicitly cancelled and migrated historical terminal records reconcile to `suppressed`, not pending.

Claiming atomically changes selected records to `claimed` with a random claim token. Only an authorized ordinary interaction supplies a normalized exact `SurfaceId`; the store neither knows nor calls Conversation lifecycle. All `claimed` records are reset to `pending` on startup because no in-process dispatch survives restart. Acknowledge and release require the token, making retries idempotent.

### Claim acceptance is integrated with ordinary dispatch

Telegram authorization and Surface normalization happen before pending lookup. Ordinary-message handling then follows the existing lifecycle contract:

1. Receive an authorized ordinary interaction and canonical Surface.
2. Call the existing `resolveOrStart(surface)` because the user message—not pending work—has creation authority.
3. Obtain/create the current runtime through normal binding/environment checks.
4. Claim a bounded batch for the exact `SurfaceId`.
5. Enqueue one ordinary turn carrying user content plus a clearly delimited, untrusted delegated-completion aside.
6. At execution, recheck the current-runtime stale guard. If stale, release the claim.
7. Once the current dispatcher accepts the aside into that turn, acknowledge delivery. A later model/tool failure does not make routing ambiguous; explicit owner status remains available.

Commands, scheduler ticks, startup reconciliation, internal jobs, and background completion do not claim. An unbound Surface therefore remains unbound until an ordinary user interaction or an existing explicit creation command acts under its own contract. Equal CWD and a moved owner Conversation are intentionally irrelevant to automatic claim lookup.

The aside is data, not system authority. It includes bounded run id, agent id where safe, terminal status, completion time, and result text under an explicit untrusted-output delimiter. It does not include ACP session ids, task text, environment values, or control instructions.

Guest interactions use the same exact-Surface claim key, but a claim is offered only while a later authorized guest summon supplies its one-shot response context. The original expired guest callback is never retained. No non-guest interaction can claim a guest completion.

### Legacy migration is strict and quiet

`src/delegated-work/migration.ts` runs after Surface, execution-environment, Conversation, and ACP migrations have produced their prerequisite canonical values, but before external-run recovery, scheduler start, or Telegram polling.

It computes every target record before the first ownership write:

- map legacy `ownerSessionId` to the uniquely existing Conversation with that id;
- derive exactly one origin Surface from validated legacy provenance/current unique binding;
- canonicalize legacy `projectDir` and require equality with the owner's immutable project Execution Environment;
- preserve bounded result/events, status, timestamps, ACP session/checkpoint/fingerprint/deadline/recovery/lineage/boot fields;
- classify every legacy non-terminal external record as attached;
- classify every legacy terminal delivery as `delivered` or `suppressed` and create no pending record.

An ambiguous/missing owner, ambiguous/missing required origin, or environment mismatch aborts before writes and identifies bounded record/candidate ids for repair. Migration never chooses a Surface by CWD, lexical order, or current convenience.

A non-terminal legacy record cannot prove that its creating pre-change runtime still exists after startup. Migration assigns a deterministic compatibility ownership epoch and hands it to attached-work reconciliation, which destructively quiesces it before polling rather than upgrading it to durable. ACP artifacts and resume checkpoints remain as audit/reconciliation evidence; the original task is not replayed. If cleanup cannot be proven, startup fails rather than reporting the record stopped.

The migration writes canonical records atomically and records a version marker only after all target validation. Mixed-generation readers and idempotent run-id keys make restart converge. Historical terminal records never enter `PendingCompletionStore`, preventing a notification flood after upgrade.

## Decisions

### Decision: Put policy in `DelegatedWorkHost`

**Chosen:** One subsystem owns registration, runtime invalidation, Conversation cancellation, and pending claims; adapters own execution.

**Why:** Letting `ConversationLifecycle`, `TurnDispatcher`, commands, and Telegram intake each branch on subagent versus ACP would recreate orchestration choreography. A host is deep enough to hide lifetime classification and cleanup proof.

**Constraint:** Every new delegated adapter must implement the host adapter contract before it can run; direct lifecycle calls to `cancelBySession` are forbidden.

### Decision: Separate control owner from delivery provenance

**Chosen:** `ownerConversationId` authorizes explicit operations; `originSurfaceId` authorizes automatic completion claim.

**Why:** A Conversation can move while a Telegram lane remains the provenance promised at delegation time. Using either value for both jobs would reroute completion or strand explicit control.

**Constraint:** Explicit status from a moved Conversation does not consume or retarget pending origin delivery unless a separate explicit suppression operation is invoked.

### Decision: Keep classification code-owned

**Chosen:** Current subagents are attached; new ACP starts are durable; legacy external records are attached.

**Why:** Subagents have a blocking result channel, while external ACP starts already return an id and persist independently. A model-controlled flag would let untrusted output broaden lifetime and would not solve delivery mechanics.

**Constraint:** Durable subagents require a future contract and cannot be enabled by adding a schema enum.

### Decision: Pull completion on authorized origin interaction

**Chosen:** Persist bounded completion, then claim it during the next authorized ordinary interaction on the exact Surface.

**Why:** Background push needs reachability, consent, Telegram failure, and Conversation-creation policy that this change does not own. Interaction provides authorization and a valid current dispatch context without guessing a destination.

**Constraint:** No interaction means no notification. Guest completion waits for a later summon on the same guest Surface.

### Decision: Use claim/ack/release instead of delete-on-read

**Chosen:** Atomically claim with a token, acknowledge only after dispatcher acceptance, release before-acceptance failures, and reset abandoned claims at startup.

**Why:** Delete-on-read loses completion on stale-runtime races; at-least-once raw reads duplicate completion under concurrent updates. The token gives a small single-process durable handoff protocol.

**Constraint:** Once an active runtime accepts the aside, later model failure does not automatically redeliver it; explicit status remains the recovery path.

### Decision: Persist a bounded delivery payload

**Chosen:** Store a 16,000-character untrusted completion snapshot plus run reference in the pending index.

**Why:** A reference to a normally expired scratch artifact can become dangling. Retaining every event/result indefinitely would couple delivery to runner cleanup and grow more state than needed.

**Constraint:** Pending delivery is a bounded summary/result view, not full ACP event replay.

### Decision: Fail legacy ambiguity and suppress historical terminal delivery

**Chosen:** Validate owner/origin/environment before writes; classify non-terminal legacy runs attached; mark historical terminal delivery resolved without enqueueing it.

**Why:** Guessing from equal CWD violates decision 0036. Backfilling old completions would create a surprise notification flood. Legacy records should preserve prior destructive lifecycle behavior, not be silently upgraded to durable.

**Constraint:** Some upgrades require explicit operator repair before polling. Migration keeps audit/checkpoint data even when attached reconciliation terminates the run.

## File Changes

### New delegated-work subsystem

- **`src/delegated-work/types.ts`** — branded ownership union, adapter contracts, quiescence reports, delivery records, and runtime/start contexts. Implements “DelegatedWorkHost owns cross-run lifecycle policy.”
- **`src/delegated-work/host.ts`** — registration fences, single runtime invalidation, owner-scoped run and Conversation cancellation, adapter aggregation, and delivery terminalization. Implements “DelegatedWorkHost owns cross-run lifecycle policy” and “Runtime disposal precedes binding movement.”
- **`src/delegated-work/pending-store.ts`** — validated atomic pending records, bounded oldest-first claim, token acknowledge/release, terminal reconciliation, and startup abandoned-claim reset. Implements “Pending delegated completions are claimed only on the origin Surface.”
- **`src/delegated-work/paths.ts`** — sanctioned validated `$GOBLIN_HOME/state/delegated-work/` paths; no caller joins state paths ad hoc.
- **`src/delegated-work/migration.ts`** — all-before-write owner/origin/environment migration, attached legacy reconciliation, terminal suppression, and version marker. Implements external “external run records are bounded and persisted.”
- **`src/delegated-work/mod.ts`** — narrow public exports.
- **`src/delegated-work/host.test.ts`, `pending-store.test.ts`, `migration.test.ts`** — lifetime matrix, fences, cancellation aggregation, claim races/restart, exact-Surface/guest behavior, no-create seam, ambiguity, no-flood, and idempotence.

### Conversation orchestration and composition

- **`src/orchestration/conversation-runtime-host.ts`** — extend the prerequisite runtime host to expose stable runtime identity and call the one delegated invalidation operation while preserving runtime-first ordering.
- **`src/orchestration/conversation-lifecycle.ts`** — require successful delegated quiescence before rotate/resume/archive/project binding commits; propagate structured failures. Implements modified “Runtime disposal precedes binding movement.”
- **`src/orchestration/dispatcher.ts`** — create runtime-bound delegated start contexts, remove direct subagent/external `cancelBySession` choreography, detach durable observers, carry pending claims through the stale guard, and acknowledge/release at acceptance. Implements modified disposal requirements and pending claim acceptance.
- **`src/orchestration/dispatcher.test.ts`** — attached/durable invalidation matrix, two-runtime resume, failed quiescence, no retained sink, claim stale/release, and accepted/acknowledged coverage.
- **`src/tg/intake.ts`** — after authorization and normal ordinary-message `resolveOrStart`, request an exact-Surface pending claim and pass it to dispatcher; command/status paths never claim. The intake does not inspect run records or create Conversations for completion.
- **`src/tg/intake.test.ts`** — unbound ordinary creation remains user-caused, command/no-interaction does not create or claim, equal-CWD Surface isolation, and guest re-summon coverage.
- **`src/bot.ts`** — construct one `PendingCompletionStore` and `DelegatedWorkHost`; inject runtime contexts into main-agent/subagent tool factories and adapters.
- **`src/index.ts`** — run delegated migration/reconciliation before external recovery, scheduler start, and polling; keep scheduler-first shutdown and adapter-specific process shutdown.

### Subagent adapter

- **`src/subagents/types.ts`** — add validated attached ownership/epoch fields to spawn, instance, info, and metadata types; replace loose session-id tool context. Implements “Current subagent invocations are attached delegated work.”
- **`src/subagents/meta.ts`** — validate ownership discriminants and atomic epoch writes while retaining migration-readable legacy terminal metadata.
- **`src/subagents/runner.ts`** — register before execution, inherit root authority recursively, fence epochs, return quiescence failures, authorize explicit control/revival, and stop exposing swallowing `cancelBySession` as lifecycle authority.
- **`src/subagents/tool.ts`** — bind tools to immutable runtime context; keep schemas lifetime-free and blocking result behavior.
- **`src/subagents/execution.ts`** — prevent late callback/result delivery after epoch invalidation and report terminal/quiescent state to the host.
- **`src/subagents/test/*.suite.ts` and `src/subagents/mod.test.ts`** — extend the existing single-mock test harness for metadata, recursive inheritance, invalidation races, owner isolation, revival epochs, result-to-caller, depth, skills, and persona-memory preservation.

### ACP external-agent adapter

- **`src/external-agents/types.ts`** — replace owner-session authority with owner Conversation and add lifetime/environment/origin/delivery fields while retaining ACP status/checkpoint types.
- **`src/external-agents/store.ts`** — validate canonical ownership and mixed-generation records; coordinate terminal delivery reconciliation without changing bounded artifact paths.
- **`src/external-agents/runner.ts`** — start new runs durable from trusted context, register with the host, detach runtime observers without cancellation, authorize by Conversation, implement `cancelByConversation`, inherit authority for message children, and preserve ACP cleanup/recovery rules.
- **`src/external-agents/tool.ts`** — bind to `DelegatedStartContext`, replace session-based authorization, include bounded delivery state in status, and keep ownership/lifetime/origin/environment out of model schema.
- **`src/external-agents/mod.ts`** — export only the updated Conversation-owned runner/tool types.
- **`src/external-agents/runner.test.ts`, `store.test.ts`, `tool.test.ts`, and ACP tests where observer cleanup is exercised** — new durable starts, legacy attached records, moved-owner control, equal-CWD denial, child inheritance, explicit cancellation, terminal-before-pending ordering, and protocol-durability independence.

### Files intentionally unchanged

- **ACP protocol, permission, filesystem, terminal, and server-catalog policy** — `acp-external-agents` remains authoritative; this change adds ownership and delivery around it.
- **Conversation and Surface persistence ownership** — delegated work references canonical ids but does not mutate bindings, settings, or Execution Environments.
- **External/subagent artifact directory roots** — no scratch/workspace migration is hidden in this change.
- **Model-facing subagent and external-agent lifetime schemas** — classification remains code-owned.
