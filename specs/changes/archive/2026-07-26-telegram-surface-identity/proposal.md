# telegram-surface-identity

## Motivation

Goblin identifies Telegram routing with `ChatLocator` (`chatId` plus optional `topicId`) while passing `isSupergroup`, `isGuest`, and related routing facts as separate options. A topicless locator is therefore ambiguous: it may mean a DM, supergroup, or guest chat depending on knowledge held by the caller. Persistence repeats that hidden distinction across separate `dm`, `topics`, `supergroups`, and `guest` maps, and settings code sometimes falls back to chat-ID sign to infer the missing kind.

This is already a leaky interface, and Telegram now permits topics in private conversations as well as forum supergroups. The rest of Goblin should receive one complete routing value rather than reconstruct Telegram chat semantics from flags and numeric conventions. A stable surface identity is also prerequisite for separating Telegram routing from conversations, execution environments, schedules, and proactive delivery.

## Scope

This change affects two capabilities: `telegram` and `sessions`.

### Telegram

- Replace `locatorFromCtx()` as the domain-facing normalization result with a discriminated **Surface** value that completely describes the Telegram delivery lane: DM, topic, topicless supergroup, or guest chat.
- Represent a topic with its `chatId`, `topicId`, and container kind so private-chat topics and supergroup forum topics remain distinct without out-of-band flags.
- Centralize Telegram-context-to-surface normalization in the Telegram layer. Downstream modules MUST NOT infer surface kind from chat-ID sign, `topicId` absence, or separately supplied booleans.
- Provide one canonical, reversible `SurfaceId` encoding for map keys, persistence, logging, queue keys, and equality. Telegram numeric identifiers remain numbers in the value object and are validated before encoding.
- Keep Telegram-specific send parameters and grammy context details inside the Telegram adapter; domain modules address a `Surface` and do not decide whether Telegram needs a thread or direct-message-topic parameter.

### Sessions

- Key bindings and surface settings by canonical `SurfaceId` while preserving the distinction between routing identity and conversation identity.
- Replace `resolve(loc, { isSupergroup, isGuest })`, `createForChat(...)`, `peekBinding(...)`, project-setting methods, and scheduler records with complete `Surface` inputs.
- Register conversion of existing `bindings.json`, `topic-settings.json`, and schedule locator records as canonical offline filesystem migration step 1 (`stateVersion` 0 → 1). The migration command preflights every pending step in the ordered chain before mutating persisted inputs, takes one complete restorable backup, then applies per-file atomic replacements and advances each version only after its step succeeds. Legacy topic records lacking enough persisted evidence to recover their container kind fail for explicit repair rather than defaulting to supergroup. Startup only enforces the required state version; it never performs this conversion.
- Preserve existing creation, binding, scheduling, memory-scope, and delivery behavior. This change establishes identity and removes ambiguous flags; it does not redesign conversation lifecycle.

## Non-Goals

- **Conversation semantics:** renaming sessions to conversations, lazy DM creation, rebinding invariants, `/new`, and `/resume` behavior belong to `conversation-lifecycle`.
- **Internal model-run identity:** the dreaming `chatId: 0` compatibility sentinel and `enqueueInternalTurn` are not Telegram surfaces. Removing that borrowed session machinery belongs to inner life; this change MUST NOT add an `internal` Surface variant merely to preserve the sentinel.
- **Project semantics:** set-once project environments and immutable conversation CWD belong to `immutable-project-environments`.
- **Topic lifecycle:** closed/deleted topic detection, reachability state, schedule suspension, and project recovery are deferred.
- **New Telegram products:** this change does not add channel support, multi-account routing, a web UI, or a generic transport abstraction. `Surface` is intentionally Telegram-native.
- **Topic UI mutation:** Goblin does not create, rename, close, reopen, or delete user-owned topics; decisions 0002 and 0004 remain authoritative.
- **Filesystem layout changes:** conversation directories and memory paths remain unchanged.
