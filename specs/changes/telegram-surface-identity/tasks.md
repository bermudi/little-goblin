# telegram-surface-identity — Tasks

## Phase 1: Introduce canonical Surface identity

- [ ] Create `src/surface.ts` with the discriminated `Surface`, `TopicContainer`, branded `SurfaceId`, strict validation, canonical `tg:v1` encode/decode, and narrowing helpers. Satisfies “Telegram surfaces are complete discriminated values” and “SurfaceId is canonical and reversible.”
- [ ] Create `src/surface.test.ts` covering every variant, cross-kind/container collisions, safe-integer bounds, malformed/non-canonical input, and round trips.
- [ ] Create `src/tg/context-surface.ts` and tests for DM, private topic, forum topic, direct-messages topic, topicless supergroup, guest, unsupported chat, and invalid IDs; retain a temporary locator compatibility adapter so downstream code still compiles.
- [ ] Re-export Surface identity/normalization from `src/tg/mod.ts` without making `src/surface.ts` import grammy.
- [ ] Run `bun test src/surface.test.ts src/tg/context-surface.test.ts` and `bun run typecheck`.

## Phase 2: Canonicalize binding and settings persistence

- [ ] Change binding and topic-settings DTOs to versioned SurfaceId-keyed `surfaces` maps while retaining migration-only legacy decoders.
- [ ] Update `SessionManager` and topic-setting operations to accept complete Surface values and perform one-key lookups without sign inference or routing flags; preserve the existing DM/topic/supergroup/guest creation policies in this change.
- [ ] Create `src/sessions/surface-migration.ts` to precompute and validate legacy binding/settings conversion before atomic writes, accept mixed-generation input, and remain idempotent after an interrupted migration.
- [ ] Add migration and manager/settings tests for every Surface kind, numeric collisions, stale behavior, archive cleanup, mixed-generation restart, and invalid data.
- [ ] Wire migration before manager/scheduler/polling startup while retaining compatibility at not-yet-migrated callers.
- [ ] Run the touched session/migration tests and `bun run typecheck`.

## Phase 3: Persist schedules with Surface identity

- [ ] Split in-memory `ScheduledTurn.surface` from persisted `surfaceId`, with strict decode at the schedule-store boundary and no legacy locator in canonical writes.
- [ ] Migrate legacy schedule locators using explicit metadata or exact `(chatId, sessionId)` binding matches; fail before writes on zero/multiple candidates and preserve every non-routing field.
- [ ] Update schedule command/tool/store APIs and scheduler eligibility to pass Surface and call non-mutating `peekBinding(surface)`.
- [ ] Add store/loop/tool/command tests for round trips, invalid IDs, similar-kind mismatch, migration ambiguity, and unchanged claim/recurrence behavior.
- [ ] Run scheduler/command tests and `bun run typecheck`.

## Phase 4: Move Telegram intake to Surface

- [ ] Replace `TelegramIntakeMessage.locator`, `isSupergroup`, `isGuest`, and `threadId` with one `surface` value across `src/bot.ts` and `src/tg/intake.ts`.
- [ ] Update guest intake to carry a guest Surface beside the encapsulated one-shot reply closure without persisting the guest query identifier.
- [ ] Rekey the text coalescer by `(SurfaceId, fromUserId)` and preserve all timing, adjacency, command-boundary, and hard-cap behavior.
- [ ] Update intake/coalescer tests for each Surface kind/container, null surfaces, guest behavior, and no cross-surface fragment merging.
- [ ] Run touched Telegram tests and `bun run typecheck`.

## Phase 5: Centralize Surface-aware Telegram delivery

- [ ] Create `src/tg/delivery.ts` and tests deriving no topic parameter, `message_thread_id`, or `direct_messages_topic_id` from Surface and rejecting guest use on normal sends.
- [ ] Convert `MessageBuffer` send/edit/draft/status paths to Surface and remove manual thread/private reconstruction.
- [ ] Convert voice/photo/document/beta-tool factories and command delivery paths to Surface-aware delivery helpers.
- [ ] Add delivery assertions for DM, private topic, forum topic, direct-messages topic, topicless supergroup, and guest callback delivery.
- [ ] Run buffer/tool/command tests and `bun run typecheck`.

## Phase 6: Convert runtime and memory callers

- [ ] Update `TurnDispatcher` runner/sink/tool factories to accept Surface while keeping runtime and prompt queues keyed by session ID; represent internal turns without an `internal` Surface variant.
- [ ] Update `AgentRunner`, scheduling tools, and memory active-scope resolution to consume Surface and preserve existing topic/general scope paths.
- [ ] Convert command registry/start/debug/voice/project callers from locator plus flags to Surface.
- [ ] Delete `src/tg/locator.ts`, remove `ChatLocator` domain exports, and remove all non-migration sign/flag routing inference.
- [ ] Update affected orchestration/agent/memory/command tests and add a static search assertion that no production caller uses `ChatLocator`, `locatorFromCtx`, or routing options.
- [ ] Run `bun test`, `bun run typecheck`, and `litespec validate telegram-surface-identity`.
