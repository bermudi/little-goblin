# telegram-surface-identity — Design

## Architecture

### One value crosses the Telegram boundary

The Telegram boundary will normalize every supported update before intake sees it:

```text
grammy Context / guest_message
        │
        ▼
surfaceFromCtx / guestSurface
        │  validates numeric IDs
        ▼
Surface ───────────────► TelegramIntakeMessage
  │                         │
  │                         ├─► SessionManager (binding/settings)
  │                         ├─► TurnDispatcher / AgentRunner (runtime + memory scope)
  │                         ├─► ScheduleStore / SchedulerLoop (captured delivery lane)
  │                         └─► MessageBuffer / beta tools (Telegram delivery)
  │
  └─ surfaceId(surface) ─► persistence, logs, coalescer keys, equality
```

`Surface` is Telegram-native, not a generic transport address:

```ts
type Surface =
  | { kind: "dm"; chatId: number }
  | {
      kind: "topic";
      container: "private" | "supergroup" | "direct-messages";
      chatId: number;
      topicId: number;
    }
  | { kind: "supergroup"; chatId: number }
  | { kind: "guest"; chatId: number };
```

The `direct-messages` topic container covers Telegram's private conversation lane represented by Bot API `direct_messages_topic`; it does not make ordinary channel posts supported. Basic groups and ordinary channel updates remain outside the normalized union. This keeps the implementation within “Telegram surfaces are complete discriminated values” and the proposal's no-new-products boundary.

`src/surface.ts` owns the pure value, constructors/validation, and canonical codec without importing grammy, sessions, or Telegram adapters. `src/tg/context-surface.ts` owns grammy update normalization and `src/tg/mod.ts` re-exports the value for Telegram callers. This placement preserves the existing rule that orchestration and sessions do not import modules under `src/tg/`, while the type itself remains deliberately Telegram-native rather than pretending to be a multi-channel abstraction.

### Surface identity is versioned at storage boundaries

The canonical encoding is deliberately plain and inspectable:

```text
tg:v1:dm:889192981
tg:v1:supergroup:-1003958530002
tg:v1:guest:-1003958530002
tg:v1:topic:private:889192981:42
tg:v1:topic:supergroup:-1003958530002:180
tg:v1:topic:direct-messages:-1003958530002:91
```

`SurfaceId` is a branded string produced only by `surfaceId(surface)` or `parseSurfaceId(text)`. Both paths validate with `Number.isSafeInteger`; chat IDs must be non-zero and topic IDs must be positive. The parser also re-encodes the parsed value and requires byte-for-byte equality, which rejects padded numbers, exponent notation, alternate separators, and other non-canonical spellings. Unknown versions and discriminants fail loudly.

The value remains numeric in memory. String conversion occurs only at key, persistence, equality, or logging boundaries, satisfying “SurfaceId is canonical and reversible.”

### Session persistence becomes one key space

The canonical files are:

```ts
interface BindingsFile {
  version: 1;
  surfaces: Record<SurfaceId, string>; // SurfaceId -> sessionId
}

interface TopicSettingsFile {
  version: 1;
  surfaces: Record<SurfaceId, TopicSettings>;
}
```

`SessionManager.resolve(surface)`, `createForSurface(surface)`, `bindExistingToSurface(sessionId, surface)`, `peekBinding(surface)`, and project-setting methods compute one SurfaceId and perform one map lookup. Auto-create policy branches on `surface.kind`, never number sign or optional-field absence:

- `dm`: explicit creation remains required; stale binding is removed and returns `null`.
- `topic`, `supergroup`, `guest`: first resolve and stale binding both create a replacement session.

`SessionState.chatId` and `SessionState.topicId` remain unchanged compatibility/history fields in this change. Rebinding still does not rewrite them. That apparent redundancy is intentional: changing conversation ownership and rebinding invariants belongs to `conversation-lifecycle`, while this change only makes the active binding key unambiguous.

Archive cleanup scans the single `surfaces` map for the session ID. Settings use the same SurfaceId, so a numerically equal guest, DM, supergroup, or differently contained topic cannot inherit another lane's project setting.

### Schedules use Surface in memory and SurfaceId on disk

The scheduler public model changes from `locator` to `surface`. The store separates the in-memory model from its disk DTO:

```ts
interface ScheduledTurn {
  // existing fields unchanged
  surface: Surface;
}

interface PersistedScheduledTurn {
  // existing fields unchanged
  surfaceId: string;
}
```

`ScheduleStore` validates and decodes every `surfaceId` on load, and encodes every `surface` on save. Commands and the agent scheduling tool pass their current complete surface. `SchedulerLoop` validates eligibility with `peekBinding(schedule.surface)` and dispatches the same surface through `TurnDispatcher`. Per-session prompt queues remain keyed by session ID: they serialize conversation runtime work, not Telegram surface work. Only surface-addressed queues such as text coalescing use SurfaceId. This preserves the routing-versus-conversation distinction instead of mechanically replacing every key with SurfaceId.

### Telegram delivery owns Telegram options

`src/tg/delivery.ts` derives API addressing from `Surface`:

- DM/topicless supergroup: `chatId`, no topic parameter;
- private or supergroup topic: `chatId` plus `message_thread_id`;
- direct-messages topic: `chatId` plus `direct_messages_topic_id`;
- guest: rejected by normal-send helpers because delivery is through the one-shot `replyVia` closure.

`MessageBuffer`, send-photo/document/voice tools, `/voice`, chat actions, drafts, rich-message sends, edits, and file fallback all call this helper. Intake and orchestration no longer pass a `threadId`. Draft mode is derived from the complete surface (`dm` and private-topic lanes retain private-chat draft behavior), rather than any legacy locator flag.

The guest adapter constructs `{ kind: "guest", chatId }` beside the reply closure. The guest query identifier remains inside `ctx.answerGuestQuery` exactly as today; SurfaceId never includes it.

### Memory scope behavior is preserved

`resolveActiveScope(surface)` continues the existing behavior:

- any `topic` surface maps to `{ topic: { chatId, topicId } }`;
- DM, topicless supergroup, and guest surfaces map to `general`.

No memory paths or SQLite scope tags change. Topic container is routing identity but is not added to the legacy memory directory shape in this change, because the proposal explicitly preserves memory scope and filesystem layout.

Internal dreaming turns are not Telegram surfaces. The current `chatId: 0` compatibility sentinel remains on the internal dispatch path, represented explicitly as no Telegram surface (or an internal runner option), rather than adding an `internal` member to `Surface`. This follows the proposal's “Internal model-run identity” non-goal.

### Offline migration is precomputed and atomic per file

The filesystem layout is versioned separately from the memory SQLite schema. A new `state/state-version.json` is read at startup; if it does not match `CURRENT_STATE_VERSION`, the process refuses to poll and tells the operator to run `bun run migrate` with the service stopped.

`bun run migrate` is an offline command. It takes a backup of `state/` before its first mutation, loads all legacy and canonical inputs, computes every canonical output in memory, validates every `SurfaceId`, and only then writes. It is not restart-safe or mixed-generation-tolerant; recovery from a failed migration is restoration from the backup.

Conversion rules:

1. `bindings.json`
   - `dm[C]` → `tg:v1:dm:C`
   - `supergroups[C]` → `tg:v1:supergroup:C`
   - `guest[C]` → `tg:v1:guest:C`
   - `topics[C][T]` has no intrinsic container kind and is converted only after the evidence pass below.
2. `topic-settings.json` uses the same DM and supergroup conversions. A legacy topic setting inherits a uniquely proven container for its `(chatId, topicId)`; the legacy schema has no guest settings map.
3. Before producing topic keys, migration gathers persisted container evidence from every legacy record addressing the same topic. Explicit private metadata proves `private`; explicit forum/supergroup metadata proves `supergroup`. Evidence must agree on exactly one container. Absence or conflict fails with the source paths and numeric topic identity. Legacy state has no supported evidence for `direct-messages`, so migration never invents that container.
4. Each legacy schedule keeps every non-routing field. A topic locator uses its explicit container evidence or the uniquely proven container for its exact topic. A topicless locator with explicit private/supergroup metadata maps directly. Otherwise, migration matches `(chatId, sessionId)` against converted bindings and requires exactly one DM, supergroup, or guest candidate.

This deliberately refuses ambiguous legacy topic bindings/settings even though most historical topics were probably forum supergroups. `ChatLocator` did not persist that fact, and defaulting would violate the promise to preserve the Telegram lane. The diagnostic tells the operator which canonical `SurfaceId` alternatives can replace the legacy entry explicitly.

If any topic or schedule has absent/conflicting evidence or zero/multiple candidates, migration throws with its source identity before any write. If all outputs are valid, each file is replaced through the existing atomic JSON writer.

## Decisions

### Decision: Surface has a neutral module seam but Telegram-native semantics

**Chosen:** Put `Surface`, `SurfaceId`, validation, and codecs in `src/surface.ts`; Telegram normalizers and delivery adapters consume and re-export them.

**Why:** The value encodes Telegram concepts (`dm`, supergroup, guest, Telegram topic containers), so it is not a generic transport abstraction. However, placing the pure value under `src/tg/` would force sessions and orchestration to violate their existing no-Telegram-import rule. A neutral source seam keeps dependency direction honest without generalizing the domain.

**Rejected:** A generic `Address`/`ChannelSurface` module. It invents a plugin seam for products this project explicitly does not support.

### Decision: Topic container is part of identity

**Chosen:** Encode `private`, `supergroup`, and `direct-messages` in both the value and SurfaceId.

**Why:** Equal numeric IDs are not sufficient to establish the Telegram container or the required delivery parameter. Keeping the container in the discriminated value eliminates the current out-of-band `isSupergroup`/`isPrivate` knowledge. Treating direct-messages topics as a topic container supports Telegram's private conversation lane without accepting ordinary channel posts.

**Rejected:** `{ chatId, topicId? }` plus a helper that inspects number sign. That reproduces the original leak. Also rejected: two booleans such as `isPrivate` and `isDirectMessages`; invalid combinations become representable.

### Decision: SurfaceId is a versioned textual codec

**Chosen:** Use the `tg:v1:...` format and strict parse/re-encode validation.

**Why:** It is reversible, readable in JSON/logs, safe as a JavaScript object/map key, and versioned for future additive migration. JSON-stringifying the object would be reversible but sensitive to property order and verbose in logs; a hash would not be reversible; delimiter-free numeric concatenation would be ambiguous.

**Constraint:** New surface kinds or incompatible encoding changes require a new version and migration. Existing `v1` parsing remains stable.

### Decision: Persist only SurfaceId, not both ID and object

**Chosen:** Bindings/settings use SurfaceId keys; schedule DTOs store `surfaceId`; in-memory callers use decoded `Surface`.

**Why:** Storing both forms creates two authorities that can disagree. The codec is total, so persistence loses no information. Decode at the store boundary also validates external state before domain code uses it.

### Decision: Keep session runtime queues keyed by session ID

**Chosen:** Use SurfaceId for surface-addressed structures and the coalescer, but retain session ID for `TurnDispatcher`'s runner/prompt queues.

**Why:** Those queues serialize one conversation runtime. Rekeying them by surface in this change would alter rebinding/runtime semantics owned by `conversation-lifecycle` and could allow two runners for one session. The proposal asks to distinguish surface identity from conversation identity, not collapse them.

### Decision: Migration fails on topic or schedule ambiguity

**Chosen:** Derive every legacy topic container and schedule Surface before writing. Require one explicit, consistent topic-container result and exactly one candidate for a locator lacking kind.

**Why:** Guessing from chat-ID sign, treating missing private metadata as supergroup, or preferring one binding map would violate the new identity rule and could route history, settings, or proactive output to the wrong lane. Failing startup is safer and observable. Diagnostics name the source record and candidate SurfaceIds so state can be repaired deliberately.

**Constraint:** Legacy topic records with no corroborating persisted container metadata require manual conversion to a canonical SurfaceId before startup. This is intentionally stricter than assuming all historical topics were forum supergroups.

### Decision: Do not create a cross-file transaction protocol

**Chosen:** Precompute all outputs, atomically replace each file, and make migration idempotent across mixed generations.

**Why:** The project has atomic single-file writes but no journal/transaction manager. Adding one solely for three small startup files is disproportionate. Precomputation prevents validation failures from producing partial writes; idempotent mixed-version loading handles process death between successful renames.

## File Changes

### New files

- **`src/surface.ts`** — Define `Surface`, `TopicContainer`, branded `SurfaceId`, validated constructors, `surfaceId`, `parseSurfaceId`, and small narrowing helpers. Implements “Telegram surfaces are complete discriminated values” and “SurfaceId is canonical and reversible” without introducing a dependency on Telegram adapters.
- **`src/tg/context-surface.ts`** — Normalize grammy message contexts and guest messages into validated surfaces. Replaces `locatorFromCtx` and owns support/rejection by Telegram chat/update shape.
- **`src/tg/delivery.ts`** — Convert a non-guest Surface into Telegram API `chatId` and the correct `message_thread_id`/`direct_messages_topic_id` options; reject normal-send use for guests. Implements “Telegram adapter derives delivery parameters from Surface.”
- **`src/migrate.ts`** — Offline migration command: backups `state/`, runs each pending step, writes `state-version.json`, and exits nonzero on any step failure.
- **`src/state-version.ts`** — Persist and read the monotonic `stateVersion` for `$GOBLIN_HOME/state/`.
- **`src/sessions/surface-migration.ts`** — Precompute and apply the bindings/settings/schedule migration as an offline step called from `bun run migrate`; fail before writes on ambiguous evidence.
- **`src/surface.test.ts`, `src/tg/context-surface.test.ts`, `src/tg/delivery.test.ts`, `src/sessions/surface-migration.test.ts`, `src/migrate.test.ts`, `src/state-version.test.ts`** — Colocated round-trip, normalization, delivery-option, collision, migration, ambiguity, state-version, and offline-migration coverage.

### Deleted files

- **`src/tg/locator.ts`** — Remove `locatorFromCtx`; `context-surface.ts` replaces its only responsibility.

### Modified Telegram files

- **`src/tg/mod.ts`** — Export Surface types/codecs/normalizers and delivery helpers; stop exporting `locatorFromCtx`. Implements “Export telegram module public API.”
- **`src/bot.ts`** — Build `TelegramIntakeMessage.surface` once, remove `isSupergroup`/`threadId`, use SurfaceId for coalescing, normalize guest messages, and pass complete surfaces to intake. Its context-owned reply closures continue using grammy. Implements the intake, coalescer, and guest-handler requirements.
- **`src/tg/intake.ts`** — Replace locator/flag fields and calls with `Surface`; derive DM no-session policy by discriminant; pass Surface through commands, session manager, dispatcher, sinks, settings, and guest resolution.
- **`src/tg/coalesce.ts`** — Replace `{ chatId, topicId, fromUserId }` with `{ surfaceId, fromUserId }`; buffering/timing/cap behavior remains unchanged.
- **`src/tg/buffer.ts`** — Accept `Surface`, derive all send/edit/draft/chat-action/document options through `delivery.ts`, and derive private draft behavior without `ChatLocator.isPrivate`.
- **`src/tg/tools.ts`** — Make send-voice/photo/document factories surface-addressed and remove caller-supplied chat/thread pairs.
- **`src/tg/intake.test.ts`, `src/tg/coalesce.test.ts`, `src/tg/buffer.test.ts`, `src/tg/tools.test.ts`** — Replace locator fixtures with each Surface variant and assert container-correct routing without flags.

### Modified session and migration wiring files

- **`src/sessions/types.ts`** — Replace the legacy multi-map `BindingsFile` with versioned SurfaceId-keyed bindings; retain `SessionState` fields and keep a migration-only `ChatLocator` type (not exported from `sessions/mod.ts`).
- **`src/sessions/bindings.ts`** — Load/save the canonical binding shape and expose legacy parsing only to the migration path.
- **`src/sessions/topic-settings.ts`** — Replace sign/topic branching with one SurfaceId slot lookup while preserving empty-slot pruning and pending notices.
- **`src/sessions/manager.ts`** — Change public methods to complete Surface inputs, remove `ChatLocator`/flag overloads, branch auto-create policy on `surface.kind`, and clear/archive through one binding map.
- **`src/sessions/mod.ts`** — Stop exporting `ChatLocator`; continue exporting manager/state and optionally re-export the shared types from `src/surface.ts` for compatibility.
- **`src/sessions/surface-compat.ts`** — Keep a narrow migration-only bridge from legacy topicless locators to `Surface`; remove non-migration flag-based routing.
- **`src/sessions/manager.test.ts`, `src/sessions/topic-settings.test.ts`** — Cover all surface kinds, topic containers, numeric collisions, stale behavior, and no-sign-inference settings.
- **`src/index.ts`** — Read `stateVersion` after `ensureGoblinHome` and refuse to begin polling or scheduler startup when it does not match `CURRENT_STATE_VERSION`, directing the operator to `bun run migrate`.

### Modified schedule files

- **`src/scheduler/types.ts`** — Replace `ScheduledTurn.locator` with in-memory `surface: Surface` and define the SurfaceId disk DTO.
- **`src/scheduler/store.ts`** — Encode/decode schedule surfaces at the file boundary and fail loudly on invalid IDs while preserving atomic writes and all non-routing fields.
- **`src/scheduler/loop.ts`** — Validate and dispatch `schedule.surface` through `peekBinding(surface)`; retain mismatch/archive outcomes.
- **`src/scheduler/tool.ts`** — Capture the runner's Surface when the agent creates or changes schedules.
- **`src/commands/schedule.ts`** — Pass the command's Surface into schedule creation/heartbeat operations.
- **`src/scheduler/store.test.ts`, `src/scheduler/loop.test.ts`, `src/scheduler/tool.test.ts`, `src/commands/schedule.test.ts`** — Update fixtures and add round-trip/mismatched-kind cases.

### Modified downstream callers

- **`src/orchestration/dispatcher.ts`** — Replace ChatLocator/thread arguments with Surface; create sinks and Telegram beta tools from the surface; keep runner and prompt queues keyed by session ID. The internal-turn path uses no Telegram surface rather than fabricating one.
- **`src/agent/mod.ts`** — Store the runner's optional Telegram Surface, derive active memory scope from it, and pass it to `schedule_turn`; internal runners retain their explicit internal scope.
- **`src/memory/scope.ts`** — Derive the existing topic/general scope from a Surface without changing persisted memory scope shapes.
- **`src/commands/registry.ts`** — Replace `DispatchOpts.locator` and `isSupergroup` with `surface`; route `/new`, `/resume`, `/project`, `/debug`, `/voice`, and `/schedule` through surface-based methods.
- **`src/commands/start.ts`** — Normalize with `surfaceFromCtx` and decide welcome/topic behavior by discriminant; remove chat-type reconstruction.
- **`src/commands/voice.ts`** — Accept a Surface and send through the Telegram delivery helper instead of constructing `message_thread_id`.
- **`src/commands/ping.ts`** — Let grammy's context reply carry routing options; remove its manual thread-parameter construction.
- **Relevant colocated tests in `src/orchestration/`, `src/agent/`, `src/memory/`, and `src/commands/`** — Replace ChatLocator fixtures and prove preserved memory, command, runtime, and delivery behavior.

### Files intentionally unchanged

- **`src/sessions/paths.ts` and session directory contents** — No filesystem-layout change.
- **Memory store/export/path modules** — Topic memory remains keyed by existing `(chatId, topicId)` scope; no scope migration.
- **Conversation lifecycle behavior** — `/new`, `/resume`, DM explicit creation, multi-binding behavior, and runtime ownership remain as currently specified until the dependent `conversation-lifecycle` change.
- **Project assignment semantics** — This change only changes the settings key; immutable environments remain owned by `immutable-project-environments`.
