# surface-skill-policy — Tasks

## Phase 1: Inspect Surface skill policy

- [ ] Extend Surface settings validation with optional canonical `SkillPolicy`, effective defaults, sorted selected names, and complete-policy atomic writes. Satisfies “Skill policy is Surface-owned.”
- [ ] Add non-creating policy/catalog inspection through a narrow lifecycle read seam using the Surface's effective Execution Environment.
- [ ] Add `/skills` with no arguments as an instant command showing source modes, resolved names, source-qualified paths, and diagnostics without creating a Conversation.
- [ ] Add settings/command tests for absent defaults, persistence, invalid DTOs, shared-project independence, unbound personal/project inspection, and malformed catalog reporting.
- [ ] Run touched session/command tests and `bun run typecheck`.

## Phase 2: Apply policy mutations atomically

- [ ] Implement `/skills <source> all|none` and `/skills <source> only <name>...` parsing with queue timing for mutation forms.
- [ ] Add the deep policy transition operation: resolve candidate, wait for active turn, atomically persist, synchronously invalidate runtime/queue identity, then dispose asynchronously.
- [ ] Include Surface, Conversation, environment, canonical policy fingerprint, and manifest fingerprint in dispatcher runtime context; reject stale cache returns.
- [ ] Ensure validation/settings failure leaves runtime untouched and cleanup failure cannot restore stale authority; emit structured transition logs.
- [ ] Add lifecycle/dispatcher/command tests for successful modes, missing names, duplicate collisions, settings failure, cleanup failure, active-turn ordering, unrelated-runtime concurrency, and restart.
- [ ] Run touched orchestration/command/session tests and `bun run typecheck`.

## Phase 3: Reload and lifecycle integration

- [ ] Implement queue-timed `/skills reload` as runtime invalidation without policy writes; report no active runtime honestly on unbound Surfaces.
- [ ] Make compatible `/resume` and every runner recreation resolve the destination Surface policy while preserving Conversation environment/history.
- [ ] Preserve policy across `/new`, archive, project assignment, movement, and unbinding; add effective policy/provenance to `/debug`.
- [ ] Add integration tests for filesystem edit plus reload, destination-policy resume, policy survival across lifecycle operations, host opt-in, and two Surfaces sharing one project root.
- [ ] Run `bun test`, `bun run typecheck`, and `litespec validate surface-skill-policy`.
