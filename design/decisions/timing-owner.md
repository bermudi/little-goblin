# One owner for timers, deadlines and bounded waits

**Context.** Each module built its own `setTimeout` + `AbortSignal` + flag.
The copies kept the same weak points: a timer that outlives an aborted turn,
cleanup skipped on the error path, and a race between "wake up" and "give
up" (#738; #50, #393/#394, #447, #729). Effect-TS was turned down for this:
it changes the style of the whole tree and moves prompt assembly, which
risks cache stability.

**Decision.** [`src/timing.ts`](../../src/timing.ts) owns the plumbing:

- `sleep(ms, signal)` waits and returns early on abort. It resolves, never
  rejects: the caller re-checks its own signal. That is the retry-delay
  behaviour it replaced. `node:timers/promises` rejects with an `AbortError`,
  which would move the policy into every catch block.
- `deadline(ms, parent)` gives one signal that aborts on the timer or the
  parent. `expired()` tells the two apart, and disposal clears both.
- `within(work, ms, signal)` is the bounded handoff: wait for another party,
  then report `settled`, `timeout` or `aborted`. A failed work still rejects,
  so a crash never reads as a slow stop.
- `after(ms, label, fn)` schedules a callback. A throw or rejection becomes an
  error line with the label. A raw timer callback that throws reaches the
  process's uncaught-exception handler, which exits.
- `every(ms, label, fn)` is the repeating form of `after`, with the same
  error line per failed tick; the ticker keeps going. A ticker's callback
  returns its promise, so a failure outside the module's own catch
  reaches `every` and logs with the label (#903). A catch of its own
  stays only where it says more than the label (the row, the chat, the
  step) or where the failure is deliberately quiet, like a cosmetic
  ping. It does not skip a tick while the previous one still runs: a
  module that must not overlap keeps its own in-flight guard (#830).

Policy stays in its module: retry counts and backoff, the buffer's
one-flush-per-key rule, model fallback after a zero-effect failure.

**Consequences.** [`timers.test.ts`](../../src/timers.test.ts) fails on any
raw `setTimeout`/`setInterval` call in `src/` outside `timing.ts`, with no
allowlist. The last modules moved in #830; each kept its own policy, and a
site whose timer aborts with its own reason or may wait 0 ms uses `after`,
not `deadline` or `sleep`. `every` arrived with the first `setInterval`
user, the wake dispatcher's ticker.
