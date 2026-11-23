# Request runtime

Start with [`runtime.ts`](../src/runtime.ts) and the
[runtime tests](../src/runtime.test.ts). These notes explain the choices that
are easy to undo in a refactor.

## State ownership, by lifetime

Use the lifetime of the data to decide where it belongs. The runtime owns
conversation state. An attempt starts with fresh working state; only explicit
recovery data travels to the next attempt. Do not let a half-made decision or
a partially initialized delivery hook leak across that boundary.

## The attempt loop

Keep the failure decision in one place, not in each phase. A persistence fault
must not be mistaken for a model failure and retried on another model. The
classification lives in [`runtime-rails.ts`](../src/runtime-rails.ts), with
tests for [overflow](../src/runtime.test.ts) and
[model fallback](../src/runtime-fallback.test.ts).

## Turn-module boundary

The queue belongs to the runtime, not the model loop. Pass the ability to
claim input, append history or check authority, not the mutable queue itself.
A streaming client becomes a recipient **when** its input is claimed, not
after admission: a failure in that gap used to leave a claimed client hanging
with no way to settle it (#114). See [`runtime-lanes.ts`](../src/runtime-lanes.ts)
and [`stream.ts`](../src/turn/stream.ts).

Keep lane operations synchronous: late stream attachment must not race idle
lane removal. `/stop` captures the current turn's completion, so its caller
can wait for the final history record without waiting for a later turn.

## The authority rule

An action must still be authorized after a successful wait, not only after an
error. A successful input conversion cannot give back authority lost during
that conversion. See the [action-time rule](../DESIGN.md#authority-at-action-time)
and the runtime race tests.

## Engine rules

Goblin owns request policy and its stored and streamed messages. Engines
translate at the vendor boundary; they report only the model-call boundaries
they can actually observe. Do not emulate rules for a vendor that cannot
honor them or drop shared rules simply because one vendor has fewer hooks.
The shared [attempt recorder](../src/turn/attempt-recorder.ts) keeps the
record consistent across engines. See the
[engine contract](../src/turn/engine.ts), [rule tests](../src/turn/engine-rules.test.ts)
and [conformance tests](../src/turn/engine.conformance.test.ts).

A fence settles through the turn's abort on both engines: the bump and the
cancel are one call, so no engine waits for its vendor stream to end before
it reports `fenced`. A bare bump once left a claude-code turn open until the
CLI query ended while ai-sdk settled at once (#820). See the
[epoch rule](../DESIGN.md#epochs-move-only-by-cancellation).

Historical system events stay system events on disk, but reach the model as
bracketed user-role notes. This keeps history out of the system instructions
and avoids passing a system-role message where the SDK rejects it.

## The turn journal

**A killed request is history, not a work item.** Shutdown and process death
use the same recovery policy. A dispatch with no recorded result may already
have acted, so boot does not resume the request and there is no manual resume.
The operator sees what happened and can start a fresh request. Boot may still
deliver an already-persisted reply; that delivers existing work, it does not
re-run it. The mechanism is borrowed from pi's message-granular history and
missing-tool-result repair, not automatic continuation.

Overflow and model fallback within the running process are different:
recorded effects must travel with the continuation so it cannot repeat them.
Reuse memory recall as well, so a continuation does not spend the quota twice.
Identify the input that actually reached the model by the store's event
sequence, not a client-chosen message id. This also keeps an unrelated queued
message from owning a reply or acknowledging scheduled work. See the
[journal](../src/turn-journal.ts), [crash tests](../src/turn-journal.crash.test.ts)
and [scheduled delivery tests](../src/wake-dispatcher.crash.test.ts).

Announce a scheduled turn's failure before it has a run record. Without a
record or a failure notice, the dispatcher can re-admit the same trigger.
Store the reply and its landed flag atomically, so a crash cannot leave a
durable reply that recovery treats as unlanded.

Both lanes journal a `planned` row when the model asks for a tool, so a crash
before dispatch leaves the same row and crash notice on either lane. The
Claude Code lane writes that row before its bridge checks the args, so a call
the bridge rejects or the CLI denies settles its row as `failed`; otherwise it
would stay `planned` and inflate a later crash notice. The API lane writes no
row for a rejected call. The unlanded-turn progress note therefore can show a
"failed: invalid arguments" line on the Claude Code lane only. Keep it: it is
true (operator, 2026-11-22, #888). See
[`attempt-recorder.ts`](../src/turn/attempt-recorder.ts).

## Unlanded-turn progress

If work happened, make it visible even when no final reply lands. Record
uncertain outcomes as uncertain. This is evidence, not a tool-call replay.
After cancellation, recording what already happened is allowed; continuing
the cancelled work is not. The app replaces the streamed partial with the
history record rather than showing it twice or losing it on reload. The
display copy is not a successful assistant message in the next model request.
If recording it fails, log that failure without replacing the error or fence
that ended the turn. At boot, record progress in the same transaction that
reclassifies the interrupted run, so an append failure leaves it recoverable.
See [`unlanded-progress.test.ts`](../src/turn/unlanded-progress.test.ts) and
[`turn-journal.test.ts`](../src/turn-journal.test.ts).

## The two text projections (#84 / #111)

Both projections keep transcribed operator speech. They differ on purpose:
[conversation summarization](../src/agent/compaction.ts) keeps enough
attachment and tool evidence for the model to continue the work;
[long-term memory](../src/memory/mod.ts) does not export raw tool output or
untranscribed attachments. Share transcript mechanics, not the content rules.
