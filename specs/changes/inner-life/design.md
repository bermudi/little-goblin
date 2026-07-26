# inner-life — Design

## Architecture

### One deep host owns wake-to-effect transitions

`src/inner-life/host.ts` exposes a narrow `InnerLifeHost` rather than letting schedulers, dreaming, or delegated-work callbacks construct model turns and execute effects independently:

```ts
interface InnerLifeHost {
  enqueue(request: WakeRequest): Promise<WakeId>;
  runReady(): Promise<void>;
  reconcile(): Promise<void>;
}
```

`WakeRequest` is a closed discriminated union owned by code. A source supplies the wake kind and bounded source data; it never supplies tool names, an arbitrary capability profile, effect permissions, or a Telegram destination. Kinds whose profile permits contact require a canonical home `SurfaceId` at the request boundary.

The host coordinates four narrow adapters:

- `WakeStore` validates and atomically replaces durable wake records;
- `WakeProfileRegistry` maps `(wakeKind, profileVersion)` to a frozen code-owned authority description;
- `ReflectionRunner` runs the model with only profile-approved context/tools and returns unknown data for schema validation;
- `EffectExecutorRegistry` authorizes and executes each registered effect according to its declared guarantee.

No caller receives prepare/commit methods. This keeps the critical sequence inside one module:

```text
validate request
  → select profile
  → persist pending wake
  → persist reflecting attempt
  → run reflection
  → parse and authorize bounded intents
  → persist accepted intents
  → persist each effect attempt
  → cross that effect's boundary
  → persist observed outcome
  → persist terminal wake state
```

### Wake records are canonical durable state

Records live at:

```text
$GOBLIN_HOME/state/inner-life/wakes/<wakeId>.json
```

`src/inner-life/types.ts` defines branded IDs and Zod schemas at the disk/request/model boundaries. The version-1 shape contains:

```ts
type WakeState =
  | "pending"
  | "reflecting"
  | "effects-pending"
  | "completed"
  | "failed";

type EffectState =
  | "pending"
  | "dispatching"
  | "pending-destination"
  | "applied"
  | "denied"
  | "failed"
  | "delivery-unknown";
```

The full record includes timestamps, bounded attempt counters, frozen profile ID/version, optional home SurfaceId, bounded source data, validated intents, and effect attempts/outcomes. Prompt bodies, credentials, and raw provider responses are not persisted. Each record is one atomic file replacement; there is no cross-record transaction claim.

Wake IDs use UUIDs rather than Conversation IDs because wake records are machine-managed internal state, not user-facing resume handles. Directory enumeration is sorted by creation time and ID for deterministic reconciliation.

### Profiles freeze authority, not implementation objects

`src/inner-life/profiles.ts` contains a versioned registry. A profile declares:

- accepted wake kind and source-data schema;
- whether Conversation context may be resolved;
- bounded context inputs and model/tool exposure;
- maximum reflection attempts and effect count;
- allowed effect kinds;
- whether a home Surface is required;
- behavior when that Surface is unbound.

The wake record stores profile identity/version, not serialized functions. Startup must still have that exact version registered; silently mapping an old wake to a newer profile is forbidden. Profiles expose no main-agent ambient tool registry. The first implementation needs only infrastructure profiles and the proactive-contact effect; later `visible-dreaming` adds its wake profile through a delta rather than receiving unrestricted defaults.

### Reflection output is data, not authority

`ReflectionRunner` receives the frozen profile and bounded context assembled by code. It returns `unknown`. `src/inner-life/effects.ts` parses that value into a closed versioned result:

```ts
type ReflectionResult =
  | { kind: "no-effect"; summary?: string }
  | { kind: "effects"; effects: EffectIntent[] };
```

The initial executable intent is bounded proactive contact. Future memory or delegated-work effects require explicit registry entries, profile permission, schemas, and guarantee definitions. Unknown fields/kinds, excessive counts, oversized payloads, free-form prose, or model-shaped tool calls fail validation and cannot reach an executor.

Accepted intents are persisted before execution. Therefore a crash after model completion reruns effect reconciliation, not reflection. A crash while `reflecting` may rerun the model because no effect exists yet; attempts are bounded and observable.

### Guarantees belong to effect executors

Each executor declares an authorization check, idempotency/deduplication strategy, retryable states, and ambiguous-outcome handling. There is deliberately no shared `executeExactlyOnce()` fiction.

Initial matrix:

| Effect | Boundary | Automatic guarantee | Recovery |
|---|---|---|---|
| no effect | local wake record | one terminal state transition | terminal record is idempotent |
| proactive contact | Telegram send | at most one automatic API invocation per effect attempt | unavailable-before-call stays pending; persisted `dispatching` without a proven result becomes `delivery-unknown` and is not resent automatically |

Before Telegram invocation, contact execution revalidates all consent layers and current home-Surface authority, then persists `dispatching`. A successful API result becomes `applied`; a policy denial becomes `denied`. A known unavailable destination before invocation becomes `pending-destination`. Errors after invocation begins are not assumed safe to retry.

This may lose a message after a crash between Telegram accepting it and outcome persistence. That is preferable to silently duplicating proactive contact, and the unknown result remains observable for future operator tooling.

### Consent is layered and deny-by-default

Deployment config gains `innerLife.proactiveContact: boolean`, default false. Surface settings gain affirmative proactive-contact consent, also default false/missing-denied. The frozen WakeProfile must additionally list the proactive-contact effect. `ContactAuthorizer` requires all three.

Consent is checked when intents are accepted and immediately before any delayed send. Revocation turns a pending effect into terminal `denied`; enabling a previously denied effect does not resurrect it. `/new` and `/resume` preserve destination Surface consent because it is Surface-owned.

`/presence on|off|status` is the explicit user mechanism. It uses non-creating Surface inspection/settings access, works while unbound, and reports both the stored Surface choice and effective deployment gate. `on` records affirmative Surface consent but cannot override a disabled deployment master switch. The command does not create wakes or Conversations.

### Home Surface is immutable routing authority

A contact-capable wake stores exactly one home SurfaceId. At execution, the host decodes it, inspects current binding non-creatively through `ConversationLifecycle`, and asks an injected Surface delivery/reachability adapter about that same Surface. It never searches for another Surface by Conversation, project root, memory scope, or CWD.

Temporary unbinding or known unavailability before Telegram invocation leaves the effect pending according to profile policy and creates no Conversation. If the Surface later becomes usable, delivery rechecks current binding/context and consent but retains the original destination. Permanent topic recovery or retargeting is outside this change.

### Startup reconciles before autonomous sources

After Surface, environment, pending project-assignment, and Conversation-lifecycle migration, startup constructs the wake store and runs `InnerLifeHost.reconcile()` before registering any inner-life source or beginning Telegram polling. Reconciliation rules are state-specific:

- `pending`: eligible for normal processing;
- `reflecting`: return to bounded reflection retry because no intents were committed;
- `effects-pending`: execute only persisted intents;
- `pending-destination`: recheck the same Surface and consent;
- `dispatching`: mark `delivery-unknown`, never auto-resend;
- terminal effect/wake states: no-op.

Every transition logs wake/effect identity and bounded error context without source payloads, generated contact text, or secrets.

### Existing heartbeat and dreaming remain compatibility paths

Heartbeat continues through the Surface-owned schedule and Conversation runtime defined by `conversation-lifecycle`; it neither creates nor consumes wake records.

Decision 0029's internal dreaming session remains CURRENT compatibility behavior until `visible-dreaming` is rewritten after this change. Inner life does not create another fake Telegram Surface or migrate old dreaming records. The later rewrite will replace internal-session dispatch with an explicit WakeRequest/profile and bounded effects.

## Decisions

### Decision: One file per wake

**Chosen:** Store each wake and its effect attempts in one validated JSON record.

**Why:** Wake/effect transitions need atomic consistency with each other, while a global append log would require replay and compaction machinery the project does not otherwise need. Independent files also isolate one malformed record and make deterministic reconciliation simple.

### Decision: Persist intents before effects

**Chosen:** Reflection and execution are separate durable phases.

**Why:** A transient “model returned, now call Telegram” path cannot distinguish a safe reflection retry from a duplicated external effect after a crash. Persisted intents establish the recovery boundary.

### Decision: Proactive contact favors duplicate avoidance

**Chosen:** Persist `dispatching` before Telegram and never automatically retry an ambiguous in-flight attempt.

**Why:** Telegram does not provide a Goblin-controlled idempotency key for ordinary sends. Exactly-once cannot be promised. For unsolicited contact, avoiding accidental duplicate messages is preferable to guaranteeing eventual delivery after an ambiguous crash.

### Decision: Profiles are versioned code, not persisted permissions

**Chosen:** Store profile identity/version and require the matching code registry entry.

**Why:** Serializing arbitrary permissions/functions creates a second plugin system and can preserve unsafe authority after code changes. Explicit versions force migrations or deliberate retirement.

### Decision: Heartbeat stays separate

**Chosen:** Do not route current heartbeat through inner life.

**Why:** The authority envelope is settled, but heartbeat's product meaning as private reflection versus ordinary scheduled prompt is not. Quietly absorbing it would make an unresolved decision look implemented.

## File Changes

### New files

- **`src/inner-life/types.ts`** — branded wake/effect IDs, request/result/record Zod schemas, lifecycle states, and bounded validation. Implements “Persist durable wake records” and “Reflection produces bounded effect intents.”
- **`src/inner-life/paths.ts`** — the only path constructors for `$GOBLIN_HOME/state/inner-life/wakes/`, with validated WakeIds and no direct path joins in callers.
- **`src/inner-life/store.ts`** — atomic record replacement, deterministic listing, and fail-loud reads through the sanctioned path helpers.
- **`src/inner-life/profiles.ts`** — versioned code-owned WakeProfile registry and source/context/effect bounds.
- **`src/inner-life/effects.ts`** — effect-intent union, executor registry, proactive-contact guarantee, and layered authorization.
- **`src/inner-life/host.ts`** — deep enqueue/run/reconcile state machine coordinating store, reflection, lifecycle inspection, and effects.
- **`src/inner-life/mod.ts`** — public WakeRequest and InnerLifeHost exports without exposing mutation internals.
- **`src/inner-life/*.test.ts`** — schema, profile, transition, crash-boundary, consent, routing, and guarantee-matrix coverage.

### Modified files

- **`src/config.ts` / `src/validate-config.ts` / config tests** — typed deny-by-default deployment proactive-contact switch and startup creation of the canonical inner-life state roots through `ensureGoblinHome()`.
- **`src/sessions/topic-settings.ts` and tests** — affirmative Surface-owned proactive-contact consent with atomic settings persistence; no Conversation-owned copy.
- **`src/commands/presence.ts`, `src/commands/registry.ts`, and command tests** — non-creating `/presence on|off|status` control and effective-policy reporting.
- **`src/orchestration/conversation-lifecycle.ts`** — supply non-creating current-binding inspection through the existing narrow interface; no inner-life state ownership.
- **`src/bot.ts` / `src/index.ts`** — compose adapters, reconcile wake records at fail-before-polling startup, and stop autonomous processing on shutdown.
- **`src/log.ts` call sites** — structured wake/effect transition diagnostics through the existing logger.

### Files intentionally unchanged

- **`src/scheduler/loop.ts` heartbeat dispatch and `src/scheduler/store.ts` heartbeat records** — heartbeat conversion is explicitly unsettled.
- **Current dreaming implementation and decision 0029 compatibility paths** — replaced only by the later `visible-dreaming` rewrite.
- **Subagent/external-agent run ownership** — belongs to decision 0036 and `delegated-work-ownership`.
- **Telegram destination selection** — delivery adapters consume the exact decoded home Surface; they do not choose fallback routing.
