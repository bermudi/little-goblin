# Engine and streaming boundaries

- **Engine types.** Keep vendor model types out of the shared engine
  contract. The serving-model reference takes a structural input so it
  need not import either engine and create a cycle.
  See [`model-ref.ts`](../../src/turn/model-ref.ts) and
  [`import-cycles.test.ts`](../../src/import-cycles.test.ts).
- **Captured model window.** The gauge describes a request the model saw,
  not a prompt built for a call that never dispatched. An error-only step
  does not spend a completed call for fallback; unknown chunks count
  conservatively. Reset active part IDs at each step because some providers
  reuse them. See [`stream.test.ts`](../../src/turn/stream.test.ts).
- **Model view ownership.** Match original message objects to durable
  event sequences, not app-controlled message IDs that can collide. Carry
  ownership by position through attachment conversion. Only owned user
  input can inject skill bodies. Drop malformed context stamps rather than
  sending a placeholder for a hint. Replay reasoning only to its producing
  model; unstamped history has no verifiable origin. See
  [`view.ts`](../../src/turn/view.ts) and
  [`skill-view.test.ts`](../../src/turn/skill-view.test.ts).
- **Provider tool calls.** Remote calls are not local actions and cannot
  supply retry grants or loop evidence. Remove both call and result for a
  provider that cannot replay them; a stranded call can break the next
  request. An SDK input-validation rejection is terminal even without an
  output-error event, so it supplies its own loop evidence. See
  [`view.ts`](../../src/turn/view.ts) and
  [`tool-events.ts`](../../src/turn/tool-events.ts).
- **Checkpoints.** Save streamed text during a step so a crash doesn't lose
  text the operator saw. Limit those writes to once per second, not once
  per delta. Store assistant steps only; tool results come from the journal.
  Both step-end and input-ownership checkpoints use the journal fault
  boundary. See [`attempt-recorder.ts`](../../src/turn/attempt-recorder.ts)
  and [`tool-authority.ts`](../../src/turn/tool-authority.ts).
- **Prompt sizing.** The window gauge apportions reported input usage
  across segments by wire size. The fold trigger instead estimates media
  at a fixed cost: base64 size is a poor predictor of media tokens and
  would make one attachment trigger a fold. Cache schema conversion by tool
  object rather than repeating it every step. See
  [`itemize.ts`](../../src/turn/itemize.ts) and
  [`itemize.test.ts`](../../src/turn/itemize.test.ts).
