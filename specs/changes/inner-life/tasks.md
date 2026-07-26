# inner-life — Tasks

## Phase 1: Persist validated wake records

- [ ] Create `src/inner-life/types.ts` with branded IDs, versioned WakeRequest/WakeRecord/effect schemas, bounded lifecycle states, and strict unknown-field rejection.
- [ ] Create `src/inner-life/paths.ts` as the only validated path-construction seam for `$GOBLIN_HOME/state/inner-life/wakes/`.
- [ ] Create `src/inner-life/store.ts` with atomic single-record replacement, deterministic listing, and fail-loud non-ENOENT behavior through those path helpers.
- [ ] Wire canonical inner-life state-root creation through `ensureGoblinHome()` and add store/schema tests for valid round trips, malformed/version-unknown records, traversal-bearing IDs, missing directories, atomic replacement, and bounded payloads.
- [ ] Export the narrow record/request types from `src/inner-life/mod.ts` without exposing arbitrary record mutation.
- [ ] Run inner-life type/store tests and `bun run typecheck`.

## Phase 2: Bound reflection with WakeProfiles

- [ ] Create the versioned `WakeProfileRegistry` mapping closed wake kinds to source/context schemas, model/tool bounds, attempt/effect caps, allowed effect kinds, home-Surface requirement, and no-binding policy.
- [ ] Create the `ReflectionRunner` seam and parse its `unknown` output into the closed no-effect/effect-intent result without exposing the main agent's ambient tools.
- [ ] Persist the selected profile before reflection, bound reflection attempts, and persist validated intents before any executor can observe them.
- [ ] Add tests for unknown wake/profile versions, frozen profile restart, malformed/prose output, excessive/unknown intents, profile authority rejection, no-effect completion, and crash after intent persistence.
- [ ] Run inner-life profile/reflection tests and `bun run typecheck`.

## Phase 3: Enforce proactive-contact authority

- [ ] Add the deny-by-default deployment proactive-contact switch to typed config validation and startup diagnostics.
- [ ] Add affirmative proactive-contact consent to Surface settings, preserving it across `/new` and using destination policy after `/resume` without copying it into Conversation state.
- [ ] Implement non-creating `/presence on|off|status` to mutate or report Surface consent plus effective deployment gating while unbound or bound.
- [ ] Implement the effect-executor registry and initial proactive-contact executor with persisted pre-boundary attempts, current consent recheck, same-home-Surface routing, and no fallback lookup.
- [ ] Implement proactive-contact recovery semantics: unavailable-before-call remains pending, `dispatching` becomes `delivery-unknown` after uncertain restart, and no ambiguous attempt is automatically resent.
- [ ] Add tests for every consent-layer denial, `/presence` persistence/status/non-creation, revocation while pending, shared-CWD non-rerouting, unbound/no-create behavior, known unavailability, successful delivery, boundary failure, and ambiguous restart.
- [ ] Run config/settings/inner-life effect tests and `bun run typecheck`.

## Phase 4: Reconcile wakes through the deep host

- [ ] Implement `InnerLifeHost.enqueue/runReady/reconcile` as the sole coordinator of durable wake, reflection, authorization, effect, and terminal transitions.
- [ ] Inject non-creating ConversationLifecycle inspection plus exact-Surface delivery/reachability adapters; keep prompt bodies and contact text out of structured logs.
- [ ] Wire fail-before-polling startup reconciliation after Surface/environment/project-assignment/Conversation migrations and before any inner-life source registration.
- [ ] Add bounded concurrency/shutdown behavior so process stop begins no new reflections/effects while preserving recoverable durable states.
- [ ] Add state-machine and crash-boundary tests for every persisted wake/effect state, interrupted reflection retry limits, denied/failed terminal states, startup ordering, and structured diagnostics.
- [ ] Add a regression test proving existing heartbeat dispatch creates no wake record and update decision/glossary references only if implementation discoveries changed terminology.
- [ ] Run `bun test`, `bun run typecheck`, and `litespec validate inner-life`.
