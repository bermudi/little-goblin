# conversation-lifecycle

## Motivation

Goblin currently uses “session” for a Telegram routing lane, the binding from that lane to history, the persisted history itself, and the in-memory `AgentRunner` plus prompt queue. `SessionState.id` is consequently used as a binding target, directory name, runner key, schedule owner, and delegated-work owner, while `chatId` and `topicId` describe where a session was created rather than necessarily where it is currently bound.

The conflation creates incorrect behavior. `bindExistingToChat()` can leave one session bound to multiple Telegram surfaces, but `TurnDispatcher` caches one runner by session ID. Reusing that runner on another surface can retain stale memory scope, Telegram tools, surface settings, and delivery assumptions. Scheduled automation is meanwhile captured against both session ID and locator, so `/new` can disable an ongoing surface commitment merely because conversational history rotated.

With stable Telegram surfaces and immutable execution environments supplied by prerequisite changes, Goblin can give each lifetime a precise owner before adding wakes, proactive utterances, or visible dreaming.

## Scope

This change has four hard prerequisites: `telegram-surface-identity`, `immutable-project-environments`, `surface-derived-memory-context`, and `transcript-surface-provenance`. Its runtime assembly consumes the dependency-provided captured memory context, and its transcript writes consume the dependency's writer context with event-time Surface provenance; those contracts must exist before cross-Surface resume can be correct. `personal-attachment-intake` remains a soft sequencing concern. The change affects three capabilities: `sessions`, `commands`, and `orchestration`.

### Sessions

- Establish **surface**, **binding**, **conversation**, and **conversation runtime** as canonical Goblin terms. “Session” remains only for pi’s `AgentSession`, compatibility exports, and the legacy `state/sessions/` disk path.
- Replace the broad `SessionManager` caller interface with a deep conversation-lifecycle interface that owns complete operations: inspect the current binding, resolve-or-start for authorized user interaction, rotate, resume, and archive. Internal persistence may remain split, but callers do not coordinate partial binding and conversation mutations.
- Lazily create a conversation for an authorized user message on any ordinary unbound surface, including DMs. Internal jobs, scheduler ticks, and proactive delivery do not auto-create conversations.
- Enforce at most one active surface binding per conversation. Resuming a bound conversation atomically moves it: clear its previous binding, leave the destination’s displaced conversation stored and resumable, then bind the target.
- Permit resume only when the target conversation’s immutable execution environment matches the destination surface’s effective environment.
- Keep project assignment and model/thinking preferences Surface-owned so they survive conversation rotation. Derive active memory context from the current Surface rather than persisting it as Conversation metadata or a second Surface setting. Keep conversation ID, name, creation time, transcript, events, metrics, pi history, and execution environment conversation-owned. Skill policy remains owned by the later `surface-skill-policy` change.
- Make schedules and heartbeat configuration surface-owned. `/new` and `/resume` do not transfer, disable, or duplicate them. Due automation resolves the surface’s current conversation at dispatch time; if none is bound, the occurrence remains pending and does not create one.
- Add the ownership split as one offline, versioned step in the canonical migration runner. Migrate legacy bindings, model/thinking settings, schedules, and heartbeat configuration without deleting conversation history. Precompute and validate the complete lifecycle transformation before its first write. If a legacy conversation is bound to several surfaces, fail with the conversation and candidate SurfaceIds so the operator can choose the retained binding explicitly; do not invent a winner.

### Commands

- `/new` starts a fresh conversation on the same surface and execution environment. For a bound Surface, required runtime quiescence completes before fresh Conversation creation; quiescence failure leaves the Conversation store and binding unchanged, while the invalidated runtime object is never restored. The previous conversation remains resumable and surface settings/automation survive.
- `/resume <id-or-name>` retains pi-style named-conversation continuation. It filters/listings by compatible execution environment, fails incompatible targets without changing bindings, and atomically moves a compatible conversation when it is active elsewhere.
- `/name`, `/debug`, `/start`, `/archive`, schedule commands, help, and replies use “conversation” when referring to Goblin’s durable history. Existing command names remain unchanged.
- `/start` no longer owns special DM initialization; an authorized ordinary message lazily starts the first conversation. `/start` remains a welcome/status command.

### Orchestration

- Key each conversation runtime and prompt queue by conversation ID while deriving surface-specific tools, the dependency-provided captured memory context, model/thinking preferences, and output sink from the conversation’s current binding. User-visible transcript writes use the dependency-provided writer context derived from the runtime capture's immutable event-time `sourceSurfaceId`.
- Dispose and remove a runtime before moving its conversation to another surface, then create a new runtime for the destination. A conversation MUST NOT have simultaneous runners on two surfaces.
- Preserve the stale-runner guard across `/new` and `/resume` so queued work captured by a displaced runtime cannot produce effects.
- Dispatch surface-owned schedules through the current conversation runtime for that surface rather than a conversation captured when the schedule was created.

## Non-Goals

- **Project assignment:** set-once `/project` and immutable CWD are owned by `immutable-project-environments`.
- **Attachment destination:** saving personal uploads under the personal execution environment, collision-safe naming, and never forwarding a caption after silently dropping its document are owned by `personal-attachment-intake`; lifecycle transitions only preserve its stale-runtime guard.
- **Inner life:** decision 0035 fixes bounded wake/effect authority, durable wake records, home-Surface routing, and layered proactive-contact consent. Their behavior belongs to the follow-up `inner-life` change; whether heartbeat becomes a private wake remains unsettled.
- **Visible dreaming:** the provisional change will be rewritten to depend on inner life.
- **Work-run ownership:** decision 0036 defines attached versus durable survival, immutable environment plus origin-Surface capture, origin-only result routing, and pending results for unavailable destinations. Implementation belongs to `delegated-work-ownership`; `acp-external-agents` will need a follow-up patch after this model lands.
- **Topic lifecycle:** closed/deleted topic detection, destination reachability, pending completion delivery, and project-surface recovery are separate work.
- **Automatic rotation:** no daily or idle reset is introduced.
- **Filesystem rename:** `state/sessions/` and compatibility symbols may remain where renaming has no behavioral benefit.
- **Event sourcing or database:** no universal event bus, new database, or replay architecture is introduced.
