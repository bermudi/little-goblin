# workspace-files — Design

## Architecture

This change adds a file-reading layer to the existing heartbeat dispatch path. No new modules, no new state, no substrate changes.

Current heartbeat dispatch flow in `src/scheduler/loop.ts`:

```
processOne(schedule)
  → isHeartbeat = schedule.kind === "heartbeat"
  → prompt = isHeartbeat ? HEARTBEAT_PROMPT : schedule.prompt
  → claimDue(schedule.id)
  → peekBinding(schedule.locator)
  → enqueue prompt as fresh turn
```

New flow:

```
processOne(schedule)
  → isHeartbeat = schedule.kind === "heartbeat"
  → prompt = isHeartbeat ? resolveHeartbeatPrompt(home) : schedule.prompt
  → claimDue(schedule.id)
  → peekBinding(schedule.locator)
  → enqueue prompt as fresh turn
```

`resolveHeartbeatPrompt(home)` reads `$GOBLIN_HOME/workspace/HEARTBEAT.md` if present and prepends `[heartbeat] `. If the file is absent (ENOENT) or empty/whitespace-only, it returns the existing `HEARTBEAT_PROMPT` constant. Non-ENOENT read errors propagate (fail loud, per AGENTS.md). The constant already includes the `[heartbeat]` prefix, so no additional prefix is prepended on the fallback path.

`resolveHeartbeatPrompt` lives in `src/scheduler/loop.ts` because it closes over the `HEARTBEAT_PROMPT` constant which is defined there; the path helper `heartbeatMdPath` still lives in `src/pi-host.ts` to keep path canonicalization centralized with the other prompt-file path helpers.

### AGENTS.md guardrail exception for workspace prompt file reads

The AGENTS.md guardrail restricts `$GOBLIN_HOME` access to `SessionManager`, `MemoryStore`, and `paths.ts`. `resolveHeartbeatPrompt` reads `workspace/HEARTBEAT.md` directly from `src/scheduler/loop.ts`, which is outside these modules. This is governed by architectural decision `workspace-prompt-file-reads` (0009), which exempts read-only access to user-authored `workspace/` prompt files (`SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`, and future prompt files) from the guardrail, subject to: (1) path construction via path-helper modules, (2) read-only access, (3) fail-loud error propagation, (4) the exemption covers only `workspace/` prompt files, not `state/` or `scratch/`. This decision also covers the existing `src/agent/system-prompt.ts` reads of `SOUL.md` and `AGENTS.md`, which already follow this pattern. The AGENTS.md guardrail exception SHALL be documented as part of the implementation (see decision 0009).

## Decisions

### HEARTBEAT.md is global, not per-session

Chosen: one `$GOBLIN_HOME/workspace/HEARTBEAT.md` shared across all sessions with heartbeat enabled.

Why: heartbeat instructions are deployment-level ("check the build, if failed notify me"), not per-session. Per-session customization already exists via scheduled turns with custom prompts. A per-session HEARTBEAT.md would require a path-resolution scheme (by session id? by chat surface?) that adds complexity without clear value for a single-user agent.

Constraints: if the user wants different heartbeat behavior per topic, they should use `/schedule every <duration> <custom prompt>` instead of `/schedule heartbeat on`.

### File is read at dispatch time, not at schedule creation

Chosen: `resolveHeartbeatPrompt(home)` runs inside `processOne()` at each heartbeat wake, not when heartbeat is enabled.

Why: the user can edit HEARTBEAT.md at any time. Reading at dispatch time means edits take effect on the next heartbeat without restart. Reading at creation time would freeze the prompt until the user runs `/schedule heartbeat off && /schedule heartbeat on`.

Constraints: the file read happens on every heartbeat wake (every 30 minutes by default). This is negligible I/O compared to the LLM turn that follows. No caching is needed.

### `[heartbeat]` prefix is always present, but prepended asymmetrically

Chosen: the dispatched prompt always begins with exactly one `[heartbeat]` marker. When the prompt comes from HEARTBEAT.md, the system prepends `[heartbeat] ` to the file's content. When the prompt comes from the constant, the constant is used as-is (it already includes the `[heartbeat]` prefix). No double-prefixing occurs on the fallback path.

Why: the scheduled-turns spec requires the prefix to "make the prompt distinguishable from user-authored text at the agent layer and in transcripts." The constant already bakes in the prefix; prepending again would produce `[heartbeat] [heartbeat] ...`.

Constraints: the user writes the *body* of the heartbeat prompt in HEARTBEAT.md; the system owns the prefix. The file content should not itself start with `[heartbeat]` — the system adds it. Defending against a user-authored `[heartbeat]` prefix in the file is the user's responsibility, not the system's: the spec's "begins with exactly one marker" guarantee is satisfied by the single system-prepended marker.

### Trailing whitespace stripped, leading whitespace preserved

Chosen: when the file is present and non-empty, `resolveHeartbeatPrompt` returns `[heartbeat] ${raw.trimEnd()}`. Leading whitespace is preserved; only trailing whitespace (including trailing blank lines) is stripped. The emptiness check uses `raw.trim().length === 0` so a file of only whitespace falls back to the constant.

Why: trailing blank lines are almost always an editor artifact and would otherwise produce a prompt that trails whitespace into the agent layer. Leading whitespace, by contrast, can be intentional (an indented first line, a code-block-style body), and stripping it would silently rewrite user intent.

Constraints: the spec's "Heartbeat due turn with HEARTBEAT.md present" scenario states this contract explicitly so design and implementation share one source of truth.

### Per-schedule error isolation in the tick loop

Chosen: `tick()` wraps each schedule's `processOne` call in its own try/catch. A throw from one schedule is logged with the schedule id and the loop continues to the next due schedule. The outer tick-level catch remains as a last resort (for throws from `listDue` itself or the iteration machinery).

Why: `processOne` resolves the heartbeat prompt *before* calling `claimDue`. A non-ENOENT read error on `HEARTBEAT.md` (e.g. a permissions regression) therefore throws without claiming, so the heartbeat stays due and re-fails on every tick. Before this change, that throw propagated to the tick-level catch and aborted the entire tick, skipping every other due schedule. In a single-user homelab that means a mis-permissioned heartbeat — which never clears on its own — would indefinitely delay every other schedule (`/schedule in 5m remind me to deploy`, recurring check-ins, etc.) by one tick at a time until an operator fixes the file. Per-schedule isolation contains the blast radius to the failing schedule alone.

The same isolation also covers the pre-existing synchronous-dispatcher-throw pattern (`processOne` re-throws after recording an "error" outcome); that throw now stops only its own schedule rather than the whole tick.

Constraints: this does not change "fail loud" semantics — the error is still surfaced (via `log.error`) and the failing schedule still retries on the next tick. It only prevents collateral damage to unrelated schedules. A tick-level fatal error (e.g. `listDue` throwing on a corrupt `schedules.json`) still aborts the tick as before.

### HEARTBEAT.md is optional with constant fallback

Chosen: if `$GOBLIN_HOME/workspace/HEARTBEAT.md` does not exist, is empty, or contains only whitespace, the system uses the existing `HEARTBEAT_PROMPT` constant.

Why: heartbeat works out of the box without requiring the user to create a file. The constant is a sensible default ("review context, say something useful or stay quiet"). HEARTBEAT.md is an opt-in customization layer. An empty file would produce a prefix-only prompt (`[heartbeat] ` with no body), which is not useful; falling back to the constant is safer.

Constraints: the constant stays in `src/scheduler/loop.ts` as the fallback. It is not removed. Non-ENOENT read errors (permissions, I/O) propagate per AGENTS.md "fail loud" — they do not fall back silently.

### No preflight check for HEARTBEAT.md

Chosen: unlike `SOUL.md` (which has a startup preflight that throws `MissingSoulError`), HEARTBEAT.md has no preflight check. The file is optional.

Why: `SOUL.md` is required — goblin cannot start without it. HEARTBEAT.md is optional — heartbeat is opt-in and has a constant fallback. A preflight warning would fire on every install that doesn't use heartbeat, which is noise. This is an instance of the standing architectural ruling `optional-prompt-files-skip-preflight` (decision 0010): optional workspace prompt files do not get preflight checks; only required prompt files do.

## File Changes

### `src/pi-host.ts`

- Add `heartbeatMdPath(home: string): string` returning `join(home, "workspace", "HEARTBEAT.md")`.
- Relates to: `Pi-host exposes Goblin prompt file paths`.

### `src/scheduler/loop.ts`

- Add `resolveHeartbeatPrompt(home: string): string` that reads `heartbeatMdPath(home)`. If the file is present and non-empty (i.e. `raw.trim().length > 0`), returns `[heartbeat] ${raw.trimEnd()}` (trailing whitespace stripped, leading whitespace preserved). If the file is absent (ENOENT) or empty/whitespace-only, returns `HEARTBEAT_PROMPT` (the constant, which already includes the `[heartbeat]` prefix). Non-ENOENT read errors propagate.
- In `processOne()`, replace `isHeartbeat ? HEARTBEAT_PROMPT : schedule.prompt` with `isHeartbeat ? resolveHeartbeatPrompt(this.home) : schedule.prompt`.
- In `tick()`, wrap each schedule's `processOne` call in its own try/catch so a throw from one schedule (heartbeat read error, synchronous dispatcher bug) is logged and the loop continues to the next due schedule. The outer tick-level catch remains for fatal errors (e.g. `listDue` throwing).
- The `SchedulerLoop` constructor already receives `home` (or can derive it from the store). Verify the home path is available; if not, pass it through the constructor.
- Relates to: `Heartbeat schedule is explicit and session-scoped`.

### `src/scheduler/loop.test.ts`

- Add tests for: HEARTBEAT.md present (file content used with prefix, leading whitespace preserved, trailing whitespace stripped), HEARTBEAT.md absent (constant fallback with exactly one `[heartbeat]` marker), HEARTBEAT.md edited between ticks (new content used on next tick), HEARTBEAT.md empty/whitespace-only (falls back to constant), non-ENOENT read error propagates, a failing heartbeat schedule does not starve other due schedules in the same tick.
- Relates to: `Heartbeat schedule is explicit and session-scoped`.

### `src/pi-host.test.ts` (or `src/agent/system-prompt.test.ts` if that's where pi-host path tests live)

- Add test for `heartbeatMdPath(home)` returning `$GOBLIN_HOME/workspace/HEARTBEAT.md`.
- Relates to: `Pi-host exposes Goblin prompt file paths`.
