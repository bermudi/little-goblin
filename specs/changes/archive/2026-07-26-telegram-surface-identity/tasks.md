# telegram-surface-identity — Tasks

## Phase 1: Introduce canonical Surface identity

- [x] Create `src/surface.ts` with the discriminated `Surface`, `TopicContainer`, branded `SurfaceId`, strict validation, canonical `tg:v1` encode/decode, and narrowing helpers. Satisfies “Telegram surfaces are complete discriminated values” and “SurfaceId is canonical and reversible.”
- [x] Create `src/surface.test.ts` covering every variant, cross-kind/container collisions, safe-integer bounds, malformed/non-canonical input, and round trips.
- [x] Create `src/tg/context-surface.ts` and tests for DM, private topic, forum topic, direct-messages topic, topicless supergroup, guest, unsupported chat, and invalid IDs; retain a temporary locator compatibility adapter so downstream code still compiles.
- [x] Re-export Surface identity/normalization from `src/tg/mod.ts` without making `src/surface.ts` import grammy.
- [x] Run `bun test src/surface.test.ts src/tg/context-surface.test.ts` and `bun run typecheck`.

## Phase 2: Canonicalize binding and settings persistence

- [x] Change binding and topic-settings DTOs to versioned SurfaceId-keyed `surfaces` maps while retaining migration-only legacy decoders.
- [x] Update `SessionManager` and topic-setting operations to accept complete Surface values and perform one-key lookups without sign inference or routing flags; preserve the existing DM/topic/supergroup/guest creation policies in this change.
- [x] Refactor `src/sessions/surface-migration.ts` into a read-only planner plus applier for canonical step 1 (`stateVersion` 0 → 1), preserving unique topic/schedule evidence rules and atomic per-file writes while removing mixed-generation/restart convergence obligations.
- [x] Replace mixed-generation restart fixtures with planner/applier tests for every Surface kind, explicit private/supergroup evidence, absent/conflicting evidence refusal during whole-run preflight, numeric collisions, stale behavior, archive cleanup, and invalid data.
- [x] Refactor the canonical runner to strictly parse supported state versions, preflight every pending step against projected prior output before any source mutation, snapshot every plan-declared root and prior absence before setup, apply in order, and advance each version only after success; startup remains an exact version gate.
- [x] Make the migration command the sole recovery-backup owner; update and test `scripts/update.sh` ordering as stop service → invoke canonical backup/migration → restart only on success, leaving the service stopped on failure; cover malformed/future versions, 0→2 later-plan failure with no step-1 mutation, CLI absent-root restoration, unexpected apply failure, and whole-backup recovery.
- [x] Run the touched session/migration/update tests, `bun run typecheck`, and `litespec validate telegram-surface-identity`.

## Phase 3: Persist schedules with Surface identity

- [x] Split in-memory `ScheduledTurn.surface` from persisted `surfaceId`, with strict decode at the schedule-store boundary and no legacy locator in canonical writes.
- [x] Migrate legacy schedule locators using explicit container metadata, uniquely proven topic identity, or exact `(chatId, sessionId)` topicless binding matches; fail before writes on absent/conflicting/zero/multiple candidates and preserve every non-routing field.
- [x] Update schedule command/tool/store APIs and scheduler eligibility to pass Surface and call non-mutating `peekBinding(surface)`.
- [x] Add store/loop/tool/command tests for round trips, invalid IDs, similar-kind mismatch, migration ambiguity, and unchanged claim/recurrence behavior.
- [x] Run scheduler/command tests and `bun run typecheck`.

## Phase 4: Move Telegram intake to Surface

- [x] Replace `TelegramIntakeMessage.locator`, `isSupergroup`, `isGuest`, and `threadId` with one `surface` value across `src/bot.ts` and `src/tg/intake.ts`.
- [x] Update guest intake to carry a guest Surface beside the encapsulated one-shot reply closure without persisting the guest query identifier.
- [x] Rekey the text coalescer by `(SurfaceId, fromUserId)` and preserve all timing, adjacency, command-boundary, and hard-cap behavior.
- [x] Update intake/coalescer tests for each Surface kind/container, null surfaces, guest behavior, and no cross-surface fragment merging.
- [x] Run touched Telegram tests and `bun run typecheck`.

## Phase 5: Centralize Surface-aware Telegram delivery

- [x] Create `src/tg/delivery.ts` and tests deriving no topic parameter, `message_thread_id`, or `direct_messages_topic_id` from Surface and rejecting guest use on normal sends.
- [x] Convert `MessageBuffer` send/edit/draft/status paths to Surface and remove manual thread/private reconstruction.
- [x] Convert voice/photo/document/beta-tool factories and command delivery paths to Surface-aware delivery helpers.
- [x] Add delivery assertions for DM, private topic, forum topic, direct-messages topic, topicless supergroup, and guest callback delivery.
- [x] Run buffer/tool/command tests and `bun run typecheck`.

## Phase 6: Convert runtime and memory callers

- [x] Update `TurnDispatcher` runner/sink/tool factories to accept Surface while keeping runtime and prompt queues keyed by session ID; represent internal turns without an `internal` Surface variant.
- [x] Update `AgentRunner`, scheduling tools, and memory active-scope resolution to consume Surface and preserve existing topic/general scope paths.
- [x] Convert command registry/start/debug/voice/project callers from locator plus flags to Surface.
- [x] Delete `src/tg/locator.ts`, remove `ChatLocator` domain exports, and remove all non-migration sign/flag routing inference.
- [x] Update affected orchestration/agent/memory/command tests and add a static search assertion that no production caller uses `ChatLocator`, `locatorFromCtx`, or routing options.
- [x] Run `bun test`, `bun run typecheck`, and `litespec validate telegram-surface-identity`.

## Phase 7: Repair General-topic delivery divergence

- [x] Split `src/tg/delivery.ts` into `deliveryOpts(surface)` for normal send/edit/media/draft/rich-message options and `chatActionDeliveryOpts(surface)` for `sendChatAction` options, keeping both helpers Telegram-native and `Surface`-driven.
- [x] Make `deliveryOpts` omit `message_thread_id` when `container === "supergroup"` and `topicId === 1`, while `chatActionDeliveryOpts` retains `message_thread_id = 1` for that same General topic surface.
- [x] Update all affected send paths — `MessageBuffer` send/edit/draft/document/photo/voice factories, command replies (`/voice`, `/ping`), file fallback, and rich-message sends — to call `deliveryOpts`.
- [x] Update `MessageBuffer.sendChatActionSafe()` to call `chatActionDeliveryOpts` instead of the normal-send helper.
- [x] Backfill `src/tg/delivery.test.ts` with cases for ordinary forum topic, supergroup General normal send, supergroup General chat action, private topic, direct-messages topic, topicless surfaces, and guest rejection.
- [x] Run `bun run typecheck`, touched `src/tg/` tests, and `bun test`.
- [x] Run `litespec validate telegram-surface-identity` and keep the change in pre-archive review mode.
