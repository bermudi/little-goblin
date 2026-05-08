# Design: Status line trajectory

## Architecture

The change is contained to the Telegram layer's `MessageBuffer` ([src/tg/buffer.ts](file:///home/daniel/build/little-goblin/src/tg/buffer.ts)). No other layer is touched: agent callbacks (`onTextDelta`, `onToolStart`, `onToolEnd`, `onStatusUpdate`, `onAgentEnd`) keep the same shapes; the buffer's flush/throttle/in-flight machinery keeps its current contract; `events.jsonl`, sessions, subagents, and config remain untouched.

What changes is internal: the buffer's *render model*. Today the render is a function of a small set of scalars (`phase`, `toolsObserved[]`, `toolsRunning Set`, `hadError`). It becomes a function of an *ordered map of slots*, each slot a small record. `buildStatusLine` walks the map and produces a multi-line string.

Phase semantics simplify. The current `thinking | working | done` enum encodes a global state that gates an N-tools-into-one-line render. With per-tool slots, the global enum collapses to two roles:
- The header — fixed at `"🤔 thinking…"` from placeholder send through `onAgentEnd`. It is no longer derived from a phase machine; it is a constant string.
- The freeze flag (`statusFrozen`) — set on `onAgentEnd`, identical to today.

The Working/Done phase distinction disappears at the render level. Slot states (`running` / `ok` / `err`) carry that information per-tool. The `phase` field is removed entirely; `hadError` is removed entirely (errors live on the slot that caused them).

The Working→Done text-delta heuristic in [onTextDelta](file:///home/daniel/build/little-goblin/src/tg/buffer.ts#L201-L218) is no longer needed: there is no global phase to flip when the agent moves from tools to its final answer. The header stays put; tool slots stay in their last state. This simplifies that callback meaningfully.

The flush machinery — throttle, in-flight coalescing, `lastRenderedStatusText` dedupe, error policy, chat-action interval — is unchanged. Throughput stays acceptable because the dedupe guard now does more work: a `running → ok` transition on a slot that is currently elided by the cap produces an identical rendered string and is skipped at zero cost. Combined with the in-flight loop in [flushStatus](file:///home/daniel/build/little-goblin/src/tg/buffer.ts#L361-L424), edit count stays well under `2T + 2`.

## Decisions

### D1: Replace the phase machine with an ordered slot map; do not keep both

**Chosen:** Remove `phase: StatusPhase`, `toolsObserved: string[]`, `toolsRunning: Set<string>`, `hadError: boolean`. Introduce a single field:

```ts
type ToolSlot = {
  /** Active concurrent invocations. State is `running` while > 0. */
  runningCount: number;
  /** Total finished invocations (ok or err). */
  completedCount: number;
  /** Start time of the most recent `onToolStart` for this slot. */
  startedAt: number;
  /** End time of the most recent `onToolEnd` for this slot. */
  endedAt?: number;
  /** Sticky: set true on any error end, never cleared. */
  lastCompletedError: boolean;
};
private slots: Map<string, ToolSlot> = new Map();
```

Insertion order on `Map` is the observation order required by the spec — no parallel index needed. Effective render state is derived (not stored): `runningCount > 0 → "running"`, else `lastCompletedError → "err"`, else `"ok"`. The display count `×N` rendered when `runningCount + completedCount > 1` reflects total invocations observed.

**Why over alternatives:** A "compatibility" mode that keeps the old phase machine and synthesizes slots on top would double the state and double the test surface. There is one user (bermudi), no migration concerns, no public consumers of `_state()` outside tests. Hard cutover is the smallest correct change. A simpler `state` enum (no `runningCount`) would mishandle parallel invocations of the same tool (a second start while the first is still in flight): the first end would flip the slot to `ok` while another invocation is still running. Splitting into `runningCount`/`completedCount` keeps the slot honest under parallelism.

**Constraint:** The internal `_state()` accessor used by tests changes shape. Test rewrite is part of the work and is called out in the proposal. No production callers read `_state()`.

### D2: Header is a constant string, not a derived phase

**Chosen:** `buildStatusLine` always begins its output with the literal `"🤔 thinking…"` once any slot has been observed *or* the placeholder has been sent. The header has no `working` / `done` variants.

**Why over alternatives:**
- Showing `"⚡ active"` while tools run feels noisier without adding signal — slot states already convey activity.
- Showing `"✅ done"` at the end duplicates information the slots already carry.
- The user's complaint is specifically that they lose the "thinking" history; making `🤔 thinking…` durable directly addresses that.

**Constraint:** Zero-tool turns rest on `"🤔 thinking…"`. The current spec scenario "Zero-tool turn collapses placeholder" allowed either edit-to-empty or leave-as-is; the new spec pins it to leave-as-is. This is consistent.

### D3: Fold by tool name, not by tool name + arg signature

**Chosen:** The slot key is the tool name (`bash`, `read`, etc.). Multiple invocations of `bash` with different commands collapse into `"✅ bash ×3"`.

**Why over alternatives:** Per-arg slots would explode the line count for any agent that calls `read` on five different files. The status line is a *summary affordance* — the journal is `events.jsonl`. Folding by name preserves the at-a-glance signal.

**Constraint:** Mixed success/error across folded sequential retry invocations resolves to the latest completed outcome. A successful retry should render as success while preserving the attempt count, e.g. `"✅ edit ×3"`.

### D4: Cap elides oldest *completed* slots; running slots are immortal

**Chosen:** When `slots.size > cap`, walk the map in insertion order and elide the first `slots.size - cap` slots whose state is `ok` or `err`. Running slots are skipped during elision counting; they always render. The footer is `"… +N earlier"` where `N` is the elided count.

**Why over alternatives:**
- Eliding the newest would hide what the user most wants to see (recent activity).
- Eliding running slots could remove the only line in the message that is still changing — defeating the live-status purpose.
- Truncating by character count instead of slot count would risk cutting mid-line and would not match the "max N tool slots" mental model.

**Constraint:** A pathological turn with `>cap` concurrent running tools would produce a message larger than the cap. This is acceptable: the cap is meant to bound *history*, not concurrent activity, and concurrent running tools beyond the cap are vanishingly rare in practice.

### D5: Per-level cap and timing live in a static table beside `VISIBILITY_TOOLS`

**Chosen:** Add a parallel constant:

```ts
export const VISIBILITY_LIMITS: Record<string, { cap: number; timing: boolean }> = {
  none:     { cap: 0,  timing: false },
  minimal:  { cap: 8,  timing: false },
  standard: { cap: 12, timing: false },
  verbose:  { cap: 20, timing: true },
  debug:    { cap: 25, timing: true },
};
```

**Why over alternatives:** Folding cap/timing into the existing `VISIBILITY_TOOLS` would change its shape and force a migration. A sibling table keeps the existing constant intact, mirrors its key set, and is trivially extensible.

**Constraint:** Every level present in `VISIBILITY_TOOLS` must be present in `VISIBILITY_LIMITS`. A unit test enforces parity to prevent drift.

### D6: No timing during `running` even at verbose/debug

**Chosen:** Slots in state `running` render only `"🔧 <name>"` regardless of visibility. Elapsed-time suffix is added only when the effective state is `ok` / `err` (i.e. `runningCount === 0`).

**Why over alternatives:** Live-ticking elapsed time would force per-second flushes (the throttle floor), defeating the dedupe guard and burning the edit budget. The user can already see *something is running* from the `🔧` icon; the precise duration is a post-hoc summary, not a live indicator.

**Constraint:** The slot's `startedAt` resets on every `onToolStart`, and `endedAt` is overwritten on every `onToolEnd`. Consequence: when a slot has multiple invocations, the timing suffix measures the **most recent** invocation only — not cumulative time, not the first invocation. This is the right summary signal for the at-a-glance status line; the journal in `events.jsonl` retains per-call durations for anyone who wants the full history.

### D7: `onTextDelta` no longer drives a phase transition

**Chosen:** Remove the `working → done` transition currently performed inside [onTextDelta](file:///home/daniel/build/little-goblin/src/tg/buffer.ts#L213-L216) when all tools are done. Text deltas continue to drive the response message and the chat-action; they do not touch the status.

**Why over alternatives:** With per-tool slots, the global "working → done" transition no longer exists, so there is nothing to flip. Keeping the call would force an unnecessary `commitStatus()` on every text-streaming turn.

**Constraint:** The eager-placeholder fallback inside `onTextDelta` (lazy-send if no `onStatusUpdate` fired first) stays.

## File Changes

### `src/tg/buffer.ts` — modified

The bulk of the work. Concrete changes:

1. **Remove fields:** `phase`, `toolsObserved`, `toolsRunning`, `hadError`. Keep `statusFrozen`, `placeholderSent`, `lastRenderedStatusText`, `statusMessageId`, the in-flight promises, the throttle bookkeeping, the chat-action plumbing.

2. **Add fields:**
   - `slots: Map<string, ToolSlot>` (ordered insertion, mutated in place).
   - No new throttle fields needed; existing ones cover the new render.

3. **Add types/constants:**
   - `interface ToolSlot { runningCount: number; completedCount: number; startedAt: number; endedAt?: number; lastCompletedError: boolean }` — exported.
   - `export const VISIBILITY_LIMITS: Record<string, { cap: number; timing: boolean }>` per **D5**. Levels: `none` (cap 0, timing false), `minimal` (cap 8, timing false), `standard` (cap 12, timing false), `verbose` (cap 20, timing true), `debug` (cap 25, timing true).

4. **Remove type:** `StatusPhase` export — see also the `src/tg/mod.ts` change below.

5. **Rewrite `buildStatusLine()`** per **Status renders per-tool slots in observation order**, **Status line caps oldest completed slots**, and **Verbose and debug levels render per-tool elapsed time**:
   - If `visibility === "none"` return `""`.
   - If `!placeholderSent && slots.size === 0` return `""`.
   - Header line: always `"🤔 thinking…"`.
   - For each slot, derive effective state then render `"<icon> <name>[ ×<count>][ (<sec>s)]"`:
     - effective state: `runningCount > 0 → "running"`; else `lastCompletedError → "err"`; else `"ok"`.
     - icon: `"🔧" / "✅" / "❌"`.
     - count = `runningCount + completedCount`. Suffix `" ×<count>"` only when `count > 1`.
     - timing suffix only when effective state is `ok` / `err` AND `endedAt` is defined AND the level's `timing` flag is true. Format: `((endedAt - startedAt) / 1000).toFixed(1) + "s"`.
   - Apply cap: if `slots.size > cap`, walk in insertion order, elide oldest *completed* slots (effective state `ok` / `err`) until the kept count equals the cap, append footer `"… +N earlier"` where `N` is the elided count. Running slots are never elided and may push the kept count above the cap.
   - Join lines with `"\n"`.

6. **Update `onToolStart(name, _input)`** per **Status renders per-tool slots in observation order**:
   - Visibility filter unchanged via `shouldShowTool`.
   - Look up the slot. If absent, create with `{ runningCount: 1, completedCount: 0, startedAt: now(), endedAt: undefined, lastCompletedError: false }`. If present, increment `runningCount`, set `startedAt = now()`, clear `endedAt`.
   - Call `commitStatus()`.

7. **Update `onToolEnd(name, isError)`** per **Status renders per-tool slots in observation order**:
   - Visibility filter unchanged.
   - Look up the slot (must exist). Decrement `runningCount`, increment `completedCount`, set `endedAt = now()`, set `lastCompletedError = isError`. The effective render state is derived per **D1**, so an in-flight parallel sibling keeps the slot in `running` until `runningCount` reaches zero.
   - Call `commitStatus()`.

8. **Update `onTextDelta(delta)`** per **D7**: drop the `phase === "working" && toolsRunning.size === 0` block. Keep delta accumulation, chat-action, lazy placeholder, and `flushResponse`.

9. **Update `onAgentEnd()`**: remove `this.phase = "done"`. Everything else (force flush, `statusFrozen = true`, response force flush, stop chat action) is identical.

10. **Update `_state()`** to expose `slots` (as a serializable snapshot) and drop the removed scalars. Tests will be updated in step 11.

These changes map to spec requirements as follows:
- `Status renders per-tool slots…` → buildStatusLine, onToolStart, onToolEnd
- `Status line caps oldest completed slots` → buildStatusLine cap loop, VISIBILITY_LIMITS
- `Verbose and debug levels render per-tool elapsed time` → buildStatusLine timing branch, VISIBILITY_LIMITS.timing
- `Status line coalesces tool activity` (modified) → unchanged flush/throttle/in-flight code, with new edit budget formula informed by slot count
- `Tool visibility config filters status display` (modified) → `shouldShowTool` unchanged, VISIBILITY_LIMITS added
- `Final status state is a resting summary` (modified) → onAgentEnd unchanged structurally; final flush picks up the multi-line render

### `src/tg/buffer.test.ts` — heavily modified

Most existing assertions assume the old single-line render and need rewriting. Concrete impact:

- The header string stays exactly `"🤔 thinking…"` (with the existing horizontal-ellipsis character) — same byte sequence the buffer renders today. Spec scenarios and tests use this form verbatim. No change to the ellipsis style.
- Assertions of `"🔧 working: <names>"` are deleted; replaced by per-slot assertions on `"🔧 <name>"`, `"✅ <name>"`, `"❌ <name>"` joined with `"\n"`.
- Phase-machine tests (transitions on first `onTextDelta` after tools done; sequential tool re-entering Working) are deleted. They no longer have a referent.
- Edit-count tests (`"4 tools collapse to one Working edit"`) are rewritten to assert the new edit budget — at most `2T + 2` writes for `T` distinct visible tools, with throttle/in-flight coalescing typically pulling the actual count well below.
- New tests added:
  - Multi-line render with header + slots in observation order.
  - Repeat invocations fold to `×N`.
  - Re-entry from `ok` → `running` increments count.
  - Sticky error across folded invocations (one fail then one success → `err`).
  - Parallel invocations: two starts then one end keeps the slot in `running` (`runningCount > 0`).
  - Filtered tool produces no slot.
  - Cap elides oldest completed slots; footer `"… +N earlier"` rendered.
  - Running slots exempt from elision (multi-running scenario beyond the cap).
  - Verbose renders timing on completed slots; standard does not; running has no timing.
  - Visibility = none short-circuits.
  - Zero-tool turn rests on header only.
  - `VISIBILITY_TOOLS` ↔ `VISIBILITY_LIMITS` key parity (build-time guard).

### `src/tg/buffer.ts` — exports

Two new exports for tests and any future inspection:
- `VISIBILITY_LIMITS` (the cap/timing table).
- `ToolSlot` (the slot shape).

The `StatusPhase` type export is removed.

### `src/tg/mod.ts` — modified

The barrel re-exports `StatusPhase` from `./buffer.ts` (currently the only module that does so). The line `export type { MessageBufferOptions, StatusPhase } from "./buffer.ts";` becomes `export type { MessageBufferOptions, ToolSlot } from "./buffer.ts";`. Adding `ToolSlot` keeps the public surface coherent (the slot type may be useful to test helpers and to any future caller that wants to introspect buffer state). Without this update, removing the `StatusPhase` export from `buffer.ts` is a TypeScript build error.

### Other files

None. The change does not touch [src/agent/mod.ts](file:///home/daniel/build/little-goblin/src/agent/mod.ts) (it still emits `"thinking..."` via `onStatusUpdate`, which the buffer treats as a placeholder cue — semantics unchanged), [src/tg/middleware.ts](file:///home/daniel/build/little-goblin/src/tg/middleware.ts), or any session/subagent code.
