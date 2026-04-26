# Status Line Redesign — Tasks

## Phase 1: Phase state machine in MessageBuffer

- [x] In `src/tg/buffer.ts`, remove `toolStates: Map<string, ToolState>` and the `TOOL_STATE_EMOJI` table.
- [x] Add new state fields: `phase`, `toolsObserved` (string[]), `toolsRunning` (Set<string>), `hadError`, `statusFrozen`, `placeholderSent`.
- [x] Rewrite `buildStatusLine()` to render the current phase:
  - `"none"` visibility → empty string.
  - `"thinking"` → `"🤔 thinking…"`.
  - `"working"` → `"🔧 working: " + toolsObserved.join(", ")`.
  - `"done"` → (`hadError` ? `"❌ "` : `"✅ "`) + `toolsObserved.join(", ")`. If `toolsObserved` is empty, render an empty/minimal final string.
- [x] Update `_state()` debug accessor to expose the new fields. _(Kept an empty `toolStates: Map` stub for typecheck-compat with the not-yet-rewritten tests; removed when tests land in phase 3.)_
- [x] Verify `bun run typecheck` passes.

Commit: `phase 1: phase state machine replaces per-tool emoji map`

## Phase 2: Wire callbacks to phase transitions

- [x] `onStatusUpdate(_msg)` — if `!placeholderSent && visibility !== "none"`, set `placeholderSent = true` and `void flushStatus(true)`. Otherwise no-op. _(Implemented via `maybeSendPlaceholder()`.)_
- [x] `onToolStart(name, _)` — apply `shouldShowTool` filter; if visible, push to `toolsObserved` (only if not already present), add to `toolsRunning`. If `phase === "thinking"`, set `phase = "working"` and `void flushStatus(true)`. If already `"working"`, no flush.
- [x] `onToolEnd(name, isError)` — apply `shouldShowTool` filter; if visible, remove from `toolsRunning`, OR `isError` into `hadError`. If `toolsRunning.size === 0 && phase === "working"`, set `phase = "done"` and `void flushStatus(true)`.
- [x] `onTextDelta` — keep response-side logic identical (chat action, response flush). Remove any code that mutated `toolStates` or scheduled status edits as a side-effect of text streaming. _(Removed the per-delta `flushStatus()`; lazy `maybeSendPlaceholder()` retained as a defensive fallback.)_
- [x] `onAgentEnd` — set `statusFrozen = true`, transition `phase` to `"done"` if currently `"working"`, `void flushStatus(true)` once, then preserve existing chat-action stop and response force-flush.
- [x] `flushStatus` — early-return when `statusFrozen` is set.
- [x] Verify `bun run typecheck` passes.

Commit: `phase 2: wire callbacks to phase transitions and freeze on agent_end`

## Phase 3: Test rewrite — phase machine & coalescing

- [ ] Remove obsolete tests from `src/tg/buffer.test.ts`:
  - `"renders empty string when no tool activity"` (replaced by phase tests).
  - `"marks a tool as running on onToolStart"` (per-tool assertion).
  - `"transitions running → success on onToolEnd(false)"`, `"transitions running → error on onToolEnd(true)"`.
  - `"preserves insertion order for multiple tools"` (replaced by phase tool-list test).
  - `"appends ✍️ composing when streaming with no running tool"`.
  - `"hides ✍️ composing while a tool is still running"`.
  - `"clears isStreaming on onAgentEnd"` — adapt: `statusFrozen` instead of `isStreaming`.
- [ ] Add tests:
  - `"onStatusUpdate sends eager placeholder before any response message"` — verify `sendMessage` for status fires before any response send.
  - `"thinking phase renders 🤔 thinking…"`.
  - `"working phase renders 🔧 working: <names>"` with multiple tools.
  - `"done phase renders ✅ <names> when no errors"`.
  - `"done phase renders ❌ <names> when at least one tool errored"`.
  - `"phase transitions: thinking → working → done produces ≤3 status writes"` (1 send + 2 edits).
  - `"many tools collapse to one Working edit"` — start 4 tools, only 1 edit fires for the Working phase.
  - `"agent_end freezes status; later events do not edit"` — set `statusFrozen`, fire stray events, assert no new `editMessageText` calls.
  - `"zero-tool turn leaves placeholder or empty resting state"` — agent_start → agent_end with no tools; verify final state is acceptable.
  - `"visibility=minimal filters tool names from phase rendering"` — `read` does not appear in working/done lists.
  - `"visibility=none suppresses placeholder entirely"`.
- [ ] Adapt remaining throttle / error-recovery / chat-action tests to the new phase-driven flow.
- [ ] Verify `bun run typecheck` + `bun test` all pass.

Commit: `phase 3: test suite for phase machine and coalescing`

## Phase 4: Validate and archive

- [ ] `litespec validate status-line-redesign` (strict).
- [ ] Manual review of spec deltas vs implementation.
- [ ] Smoke test in real Telegram: trigger a multi-tool turn, verify exactly one placeholder + working + done sequence appears in chat with no churn.
- [ ] `litespec preview status-line-redesign`.
- [ ] `litespec archive status-line-redesign` once satisfied.
