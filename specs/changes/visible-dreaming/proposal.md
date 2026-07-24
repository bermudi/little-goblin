# visible-dreaming

## Motivation

Goblin already dreams. The dreaming pipeline (`src/memory/dreaming.ts`) runs three sleep phases — light sleep extracts memory candidates from transcripts every 4 hours, REM sleep detects recurring themes across sessions at 3 AM, and deep sleep promotes short-term entries to facts at 4 AM. A dream diary is written to `$GOBLIN_HOME/state/memory/dreams/YYYY-MM-DD.md` for every phase.

But the dreams are invisible. The diary is a maintenance log that no one reads. Dreaming uses `enqueueInternalTurn` with a capture buffer — no Telegram output, no prompt injection, no user-facing surface. Goblin has an inner life and hides it completely.

This change lets the dreams out of the basement. After REM sleep detects recurring themes, goblin distills a short first-person dream fragment and surfaces it two ways: as a proactive Telegram message (throttled, opt-in) and as a per-turn prompt aside that subtly colors goblin's voice. The dream diary becomes readable via `/dreams`.

The result is a personal agent that texts you "kept circling something tonight — the same shape turned up in three different rooms" — grounded in real recurring-theme detection, not hallucinated theater. It turns a maintenance task into a companion with a visible interior life, using infrastructure that already exists.

## Scope

Three capabilities are affected:

### memory

- **Dream distillation**: after REM sleep completes and has promoted recurring themes, generate a short first-person dream fragment (≤400 chars) from the detected theme tags and their session counts. The fragment is generated via the existing `enqueueInternalTurn` mechanism (same internal `__goblin_dreaming__` session). Stored as a single JSON file at `$GOBLIN_HOME/state/memory/dreams/fragment.json` (one current fragment, overwritten each cycle).
- **Dream fragment store**: a lightweight read/write helper for `fragment.json` with atomic writes. The store holds the fragment text, the date it was dreamt, the phase that produced it, and the theme tags that grounded it.
- **Distillation gating**: a fragment is only produced when REM sleep promoted at least one recurring theme. Quiet nights (no themes met the 3-session threshold) produce no fragment. This prevents the system from manufacturing dreams from nothing.
- **Dream surfacing trigger**: after distillation, if the user has opted in to dream messages, the scheduler loop delivers the fragment as a proactive Telegram message via `enqueueScheduledTurn` to the user's primary session. Throttled to ≤1 delivery per 24 hours.

### agent

- **Per-turn dream aside**: the most recent dream fragment is injected as a bounded aside via `AgentSession.sendCustomMessage(fragment, { deliverAs: "nextTurn" })` before each `prompt()` call, alongside the existing memory snapshot. The aside is a single `## last dream` section (≤400 chars) with the fragment text and the date it was dreamt. It is omitted when no fragment exists. SOUL.md remains the canonical voice; the dream is weather, not bedrock.

### commands

- **`/dreams` command**: lists the dream diary — one line per night for the last 7 nights, with the detected theme or "quiet" for nights with no fragments. Instant-timing, no session required.
- **`/dreams full`**: shows the full text of the most recent dream fragment, or "No dreams yet" if none exists.
- **`/dreams on` / `/dreams off`**: opt-in/opt-out for proactive dream messages. The preference is stored in `$GOBLIN_HOME/state/memory/dreams/prefs.json`. Default is off (opt-in).

## Non-Goals

- **Voice-message dreams (v2)**: dreams arriving as voice notes instead of text. Goblin has voice synthesis, but this is scope creep for v1.
- **React-to-mute**: handling Telegram reactions on goblin's dream messages to mute future dreams. Replaced by the simpler `/dreams off` command. Reaction handling infrastructure does not exist today and would require a telegram capability change.
- **Dream fragment in the system prompt**: the system prompt is static per session (built at lazy init). Injecting the dream there would only affect sessions created after the dream. The per-turn aside is the correct mechanism — every turn gets the latest dream regardless of session age.
- **Deep sleep dream messages**: deep sleep (4 AM) is pure maintenance — promotion and compaction. No dream fragment is produced from deep sleep. Only REM sleep (which detects recurring themes) produces fragments.
- **Light sleep dream messages**: light sleep runs every 4 hours and extracts memory candidates. It does not detect cross-session patterns and is not dreamworthy. No fragment is produced from light sleep.
- **Dream history browsing beyond 7 nights**: `/dreams` shows the last 7 nights. Older entries remain in the export diary files on disk but are not surfaced by the command. `/dreams full` shows only the most recent fragment.
- **Per-session or per-topic dream delivery**: dream messages are delivered to the user's primary session (the DM session, or the most recently created session if no DM session exists). Dreams are not scoped to individual topics — they reflect cross-session patterns by definition.
- **Dream fragment persistence in SQLite**: the fragment store and operational history are simple JSON files, not database tables. The dream diary remains markdown export files. This is ephemeral narrative content, not curated memory.
