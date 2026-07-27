# delegated-work-ownership — Tasks

## Phase 1: Route attached subagents through DelegatedWorkHost

- [ ] Add failing `src/delegated-work/host.test.ts` coverage for runtime fencing, one invalidation call, recursive attached cancellation, durable observer detachment, owner-scoped cancellation, equal-CWD denial, and unproven-quiescence failure; reference “DelegatedWorkHost owns cross-run lifecycle policy” and modified “Runtime disposal precedes binding movement.”
- [ ] Create `src/delegated-work/types.ts`, `host.ts`, and `mod.ts` with the validated ownership union, adapter registration, synchronous runtime fence, structured quiescence report, `invalidateRuntime`, run-specific owner control, and `cancelByConversation`.
- [ ] Extend the prerequisite `ConversationRuntimeHost` and `TurnDispatcher` with stable runtime identity; replace direct subagent `cancelBySession` lifecycle choreography and cleanup-success timeout with the host's single invalidation result.
- [ ] Add attached ownership epoch fields to `src/subagents/types.ts` and validated atomic persistence in `src/subagents/meta.ts`; bind top-level spawn to owner Conversation, runtime, origin Surface, immutable environment, and captured memory context.
- [ ] Refactor `src/subagents/runner.ts`, `tool.ts`, and `execution.ts` so recursive children inherit exact root authority, epoch fencing prevents late child creation, invalidation reports real quiescence failures, and late result/status callbacks cannot reach a stale runtime.
- [ ] Make subagent inspect/list/cancel owner-scoped; make revival authorize stored owner and persist a fresh attached epoch while keeping blocking result-to-caller, depth, generic/named skills, and persona-memory behavior unchanged.
- [ ] Extend `src/subagents/test/*.suite.ts`, `src/subagents/mod.test.ts`, and orchestration tests for owner isolation, recursive inheritance, terminal-parent traversal, invalidate/complete races, fresh revival epochs, legacy terminal revival without backfill, and no direct `cancelBySession` lifecycle seam.
- [ ] Run focused delegated-work/subagent/orchestration tests, `bun run typecheck`, and full `bun test`; commit as `phase 1: Route attached subagents through delegated work ownership`.

## Phase 2: Make new ACP runs Conversation-durable

- [ ] Add failing external-agent runner/store/tool tests for new durable classification, owner-Conversation isolation, moved-owner status/control, equal-CWD denial, immutable origin/environment, stale-observer detachment, explicit owner cancellation, and ACP continuation-child inheritance.
- [ ] Update `src/external-agents/types.ts` and `store.ts` with validated canonical `ownerConversationId`, lifetime, optional attached runtime identity, immutable Execution Environment, canonical origin Surface, and delivery state while preserving mixed-generation ACP checkpoint/status fields.
- [ ] Bind `external_agent start` to one validated runtime `DelegatedStartContext`; remove owner, lifetime, Surface, and CWD authority from runner/tool inputs and reject non-project environments before metadata or process creation.
- [ ] Refactor `src/external-agents/runner.ts` to register new ACP runs as durable, detach runtime observers without ACP cancellation, authorize status/list/message/cancel by owner Conversation, and implement destructive `cancelByConversation` through the host adapter.
- [ ] Make `message` children copy owner, durable lifetime, origin Surface, and Execution Environment while preserving lineage-head, fingerprint, resume-eligibility, and deadline rules.
- [ ] Replace the prerequisite orchestration's destructive runtime-disposal call to external `cancelBySession` with host invalidation; keep explicit Conversation cancel and process shutdown on their distinct destructive/detach-aware paths.
- [ ] Add race tests proving runtime invalidation never sends ACP cancellation for a new durable run, explicit owner cancellation still claims one terminal outcome, cleanup failure remains `stopping`, and process restart remains governed by ACP proof rather than Conversation lifetime.
- [ ] Run focused external-agent/delegated-work/orchestration tests, `bun run typecheck`, and full `bun test`; commit as `phase 2: Make new ACP runs Conversation-durable`.

## Phase 3: Persist pending delegated completion

- [ ] Add failing `src/delegated-work/pending-store.test.ts` coverage for atomic terminal enqueue, 16,000-character payload bounds, four-record/32,000-character claim bounds, token claim/ack/release, concurrent claims, abandoned-claim restart reset, and idempotent terminal reconciliation.
- [ ] Create `src/delegated-work/paths.ts` and `pending-store.ts` with validated sanctioned state paths, atomic JSON persistence, oldest-first exact-Surface claims, token-guarded transitions, and no dependency on Telegram or Conversation lifecycle.
- [ ] Integrate external terminal commit ordering so ordered result/cleanup proof precedes idempotent pending persistence and terminal exposure; explicitly cancelled runs suppress duplicate delivery and `stopping` runs do not enqueue false completion.
- [ ] Persist only bounded untrusted completion material plus run reference; ensure ordinary external artifact retention cannot make an undelivered completion unreadable and task/ACP-session/environment data does not enter the pending payload.
- [ ] Add startup reconciliation for cross-file crash points between result, pending index, execution metadata, and delivery metadata; prove retries do not duplicate pending records or acknowledgements.
- [ ] Run focused pending-store/external-agent tests, `bun run typecheck`, and full `bun test`; commit as `phase 3: Persist bounded delegated completions`.

## Phase 4: Claim completion on origin interaction

- [ ] Add failing dispatcher/intake tests for exact-origin ordinary claims, user-caused creation on an unbound Surface, command/status/no-interaction non-creation, stale-runtime release, accepted-dispatch acknowledgement, concurrent interaction isolation, equal-CWD non-routing, and moved-owner non-retargeting.
- [ ] Extend ordinary Telegram intake to request pending work only after authorization, canonical Surface normalization, normal `resolveOrStart`, and current runtime resolution; keep commands, scheduler ticks, internal jobs, startup, and background completion off the claim path.
- [ ] Extend `TurnDispatcher` queue entries with pending claim tokens; inject a bounded explicitly untrusted completion aside, release before-acceptance failures or stale captures, and acknowledge only after the current runtime accepts dispatch.
- [ ] Implement guest handling so an expired one-shot callback is never retained and only a later authorized summon with the identical guest `SurfaceId` can claim pending completion.
- [ ] Add payload-rendering tests proving bounded run/status/time/result fields are present while task text, ACP session ids, environment values, and authority-like framing are absent.
- [ ] Run focused pending-store/dispatcher/intake/guest tests, `bun run typecheck`, and full `bun test`; commit as `phase 4: Claim completion on origin interaction`.

## Phase 5: Migrate legacy delegated records quietly

- [ ] Add failing `src/delegated-work/migration.test.ts` fixtures for unique and ambiguous owners/origins, canonical environment match/mismatch, active-to-attached classification, terminal delivered/suppressed classification, preserved bounded artifacts/checkpoints, interrupted writes, and zero historical pending notifications.
- [ ] Implement `src/delegated-work/migration.ts` to compute every ownership rewrite before mutation, map legacy owner-session ids to Conversations, derive one authoritative origin Surface without CWD guessing, validate immutable project environments, and write canonical records atomically.
- [ ] Route every legacy non-terminal external record through a deterministic attached compatibility epoch and destructive startup quiescence; fail startup when no stopped-work proof is available rather than upgrading it to durable or replaying its task.
- [ ] Mark legacy terminal external records delivered or suppressed without creating pending entries; retain output, result, status, timestamps, and ACP resume/checkpoint evidence so upgrade emits no backfill flood.
- [ ] Keep legacy terminal subagent history revival-readable; stamp complete ownership only when a later authorized revival starts a fresh attached epoch and never enqueue historical subagent output.
- [ ] Wire delegated migration/reconciliation in `src/index.ts` after prerequisite Surface/environment/Conversation/ACP data migration and before external recovery, scheduler start, or Telegram polling; log aggregate bounded counts and no task/result/session-id content.
- [ ] Add mixed-generation and rerun integration tests proving malformed or ambiguous authority fails before ownership writes, partial migration converges, terminal history stays quiet, and new records remain canonical.
- [ ] Run focused migration/startup tests, `bun run typecheck`, full `bun test`, and `litespec validate delegated-work-ownership --type change --strict`; commit as `phase 5: Migrate delegated ownership without notification backfill`.
