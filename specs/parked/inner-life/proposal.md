# inner-life

## Motivation

Goblin currently has user turns and Surface-owned scheduled turns, but no bounded architecture for internal reflection that may later affect memory, work, or proactive contact. Reusing a normal conversation runtime would give an autonomous wake ambient tools and delivery authority, while a transient scheduler callback would lose the evidence needed to recover safely after a crash.

Decision 0035 establishes the safety envelope: durable wake records, code-owned capability profiles, bounded validated effects, effect-specific delivery guarantees, explicit home-Surface routing, and layered proactive-contact consent. This change materializes that envelope before visible dreaming or other autonomous behavior can produce user-visible effects.

## Scope

This change depends on `conversation-lifecycle` and affects at most three capabilities: a new `inner-life` capability, orchestration, and scheduled/proactive delivery.

### Inner life

- Persist a durable wake record before reflection begins, with stable identity, wake kind, selected capability-profile version, home Surface when contact is possible, lifecycle state, attempts, and bounded outcomes.
- Select a code-owned capability profile per wake kind. The model cannot add tools, effect kinds, filesystem authority, or destinations beyond the selected profile.
- Accept model output only as a bounded effect proposal union. Validate it structurally and against current wake authority before execution; retain validation and terminal outcomes durably.
- Specify retry, idempotency/deduplication, pending, and terminal semantics separately for each effect kind rather than claiming universal exactly-once execution.

### Orchestration

- Run reflection separately from effect execution so a completed model turn is not confused with a committed side effect.
- Reconcile interrupted wake/effect records at startup and expose structured lifecycle/error signals.
- Resolve Conversation/runtime context through the home Surface late and non-creatively; an unbound Surface does not gain hidden conversation-creation authority.

### Proactive delivery

- Address proactive contact to one explicit home `SurfaceId`; never reroute because another Surface shares a Conversation, environment, or memory scope.
- Require deployment-wide policy, current home-Surface consent, and the WakeProfile all to permit contact. Recheck consent at delayed delivery time. Provide non-creating `/presence on|off|status` control for the invoking Surface so consent is not a hand-edited hidden switch.
- Retain an authorized contact effect as pending when its home Surface is temporarily unavailable, with effect-specific retry policy and no fallback destination.

## Non-Goals

- **Heartbeat conversion:** whether heartbeat becomes a private wake was not settled. Existing Surface-owned heartbeat scheduling and prompt behavior remain unchanged.
- **Visible dreaming behavior:** `visible-dreaming` depends on this change but defines its own reflection content after the bounded wake/effect machinery exists.
- **Delegated work:** attached/durable work-run ownership and completion delivery belong to decision 0036 and `delegated-work-ownership`.
- **General Surface recovery:** topic deletion, reassignment, and project recovery are separate. Inner life consumes reachability state; it does not invent a new routing destination.
- **Arbitrary model tools:** inner-life profiles are a closed code-owned authority set, not aliases for the main agent's ambient tool registry.
