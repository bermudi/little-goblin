# visible-dreaming — Design

## Architecture

The change adds a "dream surfacing" layer on top of the existing dreaming pipeline. The pipeline already runs three sleep phases and writes a dream diary; this change adds a distillation step after REM sleep, a fragment store, two surfacing paths (proactive message + per-turn aside), and a command to read the diary.

### Data flow

```
REM sleep (3 AM, existing)
  │
  │  promoted themes (tags + session counts)
  ├─► Dream distillation (NEW)
  │     │  enqueueInternalTurn → model → first-person fragment ≤400 chars
  │     ├─► writeFragment() → fragment.json
  │     └─► appendDreamHistory() → dreams/history.json
  │
  ├─► Dream message delivery (NEW, if enabled)
  │     │  read prefs.json → enabled?
  │     │  read delivered.json → already delivered within 24h?
  │     │  resolve primary session (DM or most recently created)
  │     └─► enqueueScheduledTurn → Telegram message "🌙 <fragment>"
  │
  └─► (existing) appendDreamDiarySummary → dreams/YYYY-MM-DD.md (export-only)

Per-turn (every prompt):
  AgentRunner.prompt()
    ├─► (existing) formatRelevantMemory → sendCustomMessage(memory aside)
    ├─► (NEW) readFragment() → format dream aside → sendCustomMessage(dream aside)
    └─► sendUserMessage(content)

On-demand:
  /dreams         → readDreamDiarySummary(home, 7) → formatted list
  /dreams full    → readFragment() → full text + themes
  /dreams on/off  → writeDreamPrefs()
```

### Component relationships

- **DreamingPipeline** (`src/memory/dreaming.ts`): gains a `distillDream()` method called at the end of `remSleepInner()` when themes were promoted. Uses the existing `enqueueInternalTurn` path (via a callback injected by the scheduler loop, same pattern as the candidate extractor).
- **Dream fragment store** (`src/memory/dream-fragment.ts`, new): `readFragment`, `writeFragment`, `readDreamPrefs`, `writeDreamPrefs`, `readDeliveryRecord`, `writeDeliveryRecord`, `readDreamDiarySummary`. All use atomic writes. All read paths return `null`/defaults on ENOENT. `readDreamDiarySummary` reads the operational JSON history, not the export-only markdown diary.
- **AgentRunner** (`src/agent/mod.ts`): `prompt()` gains a second `sendCustomMessage` call for the dream aside, after the memory aside (line 633) and before `sendUserMessage` (line 636).
- **SchedulerLoop** (`src/scheduler/loop.ts`): after `runRemSleep()` resolves, `distillDream()` has already run inside the pipeline; the loop checks prefs and delivers the fragment via `enqueueScheduledTurn` when throttling allows. The loop already has `this.dispatcher.enqueueScheduledTurn` and `this.sessionSource.list()` available.
- **Commands** (`src/commands/dreams.ts`, new + registry entry): instant-timing command reading from the fragment store and operational dream history.

## Decisions

### Decision: Distillation uses the same `enqueueInternalTurn` path as light sleep

The dream distillation prompt is dispatched through the existing `__goblin_dreaming__` internal session via `enqueueInternalTurn`, exactly like the light sleep candidate extractor. This reuses the per-session queue serialization, the capture buffer, and the `onComplete` return path.

**Why not a separate subagent or a direct model call:** A separate subagent would create a new session and inject goblin's tool set (memory tools, spawn_subagent) which the distillation prompt doesn't need. A direct model call would bypass the per-session queue and could overlap with a light sleep pass. The internal turn path is already wired, tested, and serialized.

**Constraint:** The distillation prompt must complete before the fragment is written. If the internal turn fails (model error, abort), no fragment is written and no message is delivered. This is acceptable — a failed distillation is a quiet night.

### Decision: Dream state is operational JSON, not canonical memory

`fragment.json`, `prefs.json`, and `delivered.json` are simple operational state files in `$GOBLIN_HOME/state/memory/dreams/`. They hold transient runtime state for the dream feature and are not part of the canonical curated memory store in SQLite. The dream diary markdown files are export-only views generated from the dreaming pipeline's output; the `/dreams` command reads the operational JSON state, not the markdown export.

**Why not SQLite:** The fragment store is a single current record (one fragment, overwritten each cycle). A database table for one row is overkill. The prefs and delivery record are equally minimal. The memory SQLite store is for curated memory entries with search, scopes, and metadata — the dream fragment is ephemeral narrative content that doesn't need query infrastructure. Nightly `/dreams` history is stored in a small operational JSON file and exported to markdown for human inspection.

**Constraint:** All writes use atomic write (tmp + renameSync) per the AGENTS.md guardrail. Reads return `null`/defaults on ENOENT. Markdown diary files are export-only and must not be treated as authoritative by application code.

### Decision: Dream aside is a separate `sendCustomMessage` from the memory aside

The dream fragment is injected as its own `sendCustomMessage` call, independent of the memory snapshot. The memory aside is built by `formatRelevantMemory` and injected at `mod.ts:631-633`. The dream aside is a separate call immediately after.

**Why not merge into the memory snapshot:** The memory snapshot is built by the memory context module (`src/memory/context.ts`) from curated memory entries. The dream fragment is not curated memory — it's a narrative artifact. Merging them would couple the memory context module to the dream fragment store and complicate the snapshot's null-return semantics. Two independent `sendCustomMessage` calls are simpler and preserve the existing memory snapshot contract.

**Why not inject into the system prompt:** The system prompt is built once at session creation (`mod.ts:328-345`) and is immutable after init. Injecting the dream there would only affect sessions created after the dream. The per-turn aside reaches every turn regardless of session age, and the system prompt's provider prefix cache is preserved.

**Constraint:** The dream aside is read fresh from `fragment.json` on every `prompt()` call. The `followUp()` path does not inject it (same as the memory snapshot).

### Decision: Primary session resolution for dream delivery

Dream messages are delivered to the user's primary session, resolved as:
1. The DM session (a session with `chatId > 0` and no `topicId`) if one exists and is not archived.
2. The most recently created non-archived, non-internal session (the last element from `SessionManager.list()`, which sorts by `createdAt` ascending) if no DM session exists.
3. Silently skip if no suitable session exists.

**Why not deliver to every session:** Dreams reflect cross-session patterns and are not topic-specific. Delivering to multiple chats would spam. A single delivery to the primary session is sufficient.

**Why not a fixed chat ID:** The user may not have a DM session yet (they might only use topics). The resolution logic handles this gracefully.

**Constraint:** The `SessionManager.list()` method already returns non-archived, non-internal sessions sorted by `createdAt` ascending. The resolution logic filters for DM sessions first (positive `chatId`, no `topicId`), then falls back to the last session in the list.

### Decision: `/dreams off` instead of react-to-mute

The user opts out of dream messages via `/dreams off`, not by reacting to a dream message. Reaction handling on goblin's messages requires grammy `message_reaction` update handling, which does not exist today and would require a telegram capability change. A command is simpler, already fits the commands infrastructure, and doesn't mix concerns.

### Decision: Distillation prompt receives theme tags, not transcript text

The distillation model receives the promoted theme tags and their session counts (e.g., `{"migration": 3, "refactor": 4}`), not raw transcript snippets. This grounds the dream in real cross-session patterns without exposing private conversation content to the distillation prompt. The light sleep extractor already sees transcript text, but that's for memory candidate extraction — the dream fragment is a narrative artifact and should not echo private content.

## File Changes

### New files

- **`src/memory/dream-fragment.ts`** — Dream fragment store, prefs, delivery record, and diary summary reader. Exports `readFragment`, `writeFragment`, `readDreamPrefs`, `writeDreamPrefs`, `readDeliveryRecord`, `writeDeliveryRecord`, `readDreamDiarySummary`, `appendDreamHistory`, and the `DreamFragment` / `DreamDiaryNight` types. All reads return `null`/defaults on ENOENT; all writes use `atomicWrite` from `src/fs.ts`. `readDreamDiarySummary` reads the operational JSON history; the markdown diary remains an export-only view. Satisfies "Dream fragment store", "Dream message preferences", and "Dream diary summary line for /dreams command" requirements.
- **`src/memory/dream-fragment.test.ts`** — Colocated tests for the fragment store.
- **`src/commands/dreams.ts`** — The `/dreams` command handler. Reads from `dream-fragment.ts` functions. Returns `DispatchResult` with the formatted reply. Satisfies "Implement /dreams command" requirement.
- **`src/commands/dreams.test.ts`** — Colocated tests for the command.

### Modified files

- **`src/memory/dreaming.ts`** — Add `distillDream()` method to `DreamingPipeline`. Called at the end of `remSleepInner()` (after line 515) when `promoted > 0`. The method builds a distillation prompt from the promoted theme tags and session counts, dispatches it via a new `distillCallback` (injected the same way as the `extractor` — set by the scheduler loop), parses the response, truncates to 400 chars, and calls `writeFragment()`. It also appends a nightly summary to the operational dream history via `appendDreamHistory()`. The `DreamingPipelineOptions` gains an optional `distillCallback?: (prompt: string) => Promise<string>` field, set by the scheduler loop's `createModelExtractor`-equivalent for distillation. Satisfies "Dream distillation after REM sleep" requirement.
- **`src/agent/mod.ts`** — In `prompt()`, after the memory aside injection (line 633) and before `sendUserMessage` (line 636), add a dream aside injection: read `fragment.json` via `readFragment(this.cfg.goblinHome)`, format the `## last dream` aside, and call `this.backend.sendCustomMessage(aside, { deliverAs: "nextTurn" })`. Omit when `readFragment` returns `null`. Satisfies "AgentRunner injects dream fragment as per-turn aside" requirement.
- **`src/scheduler/loop.ts`** — Add `createDistillCallback()` (same pattern as `createModelExtractor`) and set it on `this.memoryEngine.dreaming` in `startMemoryTimers()`. After `this.memoryEngine!.dreaming.runRemSleep()` resolves (line 289-292), add a dream delivery step: check `readDreamPrefs()`, `readDeliveryRecord()`, resolve the primary session via `this.sessionSource.list()`, and call `this.dispatcher.enqueueScheduledTurn()` with the formatted dream message when the last `deliveredAt` is absent or more than 24 hours ago. Write `deliveredAt` to `delivered.json` after successful dispatch. Satisfies "Dream distillation after REM sleep" and "Dream message delivery" requirements.
- **`src/commands/registry.ts`** — Add a `dreams` entry to `COMMAND_REGISTRY` with `timing: "instant"`, `argsHint: "[full|on|off]"`, and a `handler` that delegates to `executeDreams` from `src/commands/dreams.ts`. Satisfies "/dreams is registered in the command registry and help" requirement.

### Files NOT modified

- **`src/agent/system-prompt.ts`** — The system prompt assembly is unchanged. The dream fragment is a per-turn aside, not a system prompt section. Decision 0003 (main goblin prompt ownership) is respected: the dream is not deployment identity, not runtime mechanics, not project guidance — it's a transient context aside.
- **`src/tg/`** — No telegram layer changes. Dream message delivery uses the existing `enqueueScheduledTurn` → `MessageBuffer` → Telegram path. No reaction handling is added.
- **`src/memory/store.ts`** — The SQLite memory store is unchanged. The dream fragment is not a memory entry; it lives in JSON files.
