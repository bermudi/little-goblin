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
Identify the input that actually reached the model by the store's event
sequence, not a client-chosen message id. This also keeps an unrelated queued
message from owning a reply or acknowledging scheduled work. See the
[journal](../src/turn-journal.ts), [crash tests](../src/turn-journal.crash.test.ts)
and [scheduled delivery tests](../src/wake-dispatcher.crash.test.ts).

## Unlanded-turn progress

If work happened, make it visible even when no final reply lands. Record
uncertain outcomes as uncertain. This is evidence, not a tool-call replay.
After cancellation, recording what already happened is allowed; continuing
the cancelled work is not. The app replaces the streamed partial with the
history record rather than showing it twice or losing it on reload. The
display copy is not a successful assistant message in the next model request.
See [`unlanded-progress.test.ts`](../src/turn/unlanded-progress.test.ts) and
[`turn-journal.test.ts`](../src/turn-journal.test.ts).

## The two text projections (#84 / #111)

Both projections keep transcribed operator speech. They differ on purpose:
[conversation summarization](../src/agent/compaction.ts) keeps enough
attachment and tool evidence for the model to continue the work;
[long-term memory](../src/memory/mod.ts) does not export raw tool output or
untranscribed attachments. Share transcript mechanics, not the content rules.
