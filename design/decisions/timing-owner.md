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
  error line per failed tick; the ticker keeps going. It does not skip a
  tick while the previous one still runs: a module that must not overlap
  keeps its own in-flight guard (#830).

Policy stays in its module: retry counts and backoff, the buffer's
one-flush-per-key rule, model fallback after a zero-effect failure.

Every helper holds a wait of 2^31 ms or more for its full length, and
cancel or abort still ends it. A raw timer fires such a wait after 1 ms,
so `timing.ts` re-arms in steps of 2^31-1 ms (#900). No caller caps its
own delay for the timer's sake; a caller with its own deadline, like the
codex login poll, stops at that deadline.

**Consequences.** [`timers.test.ts`](../../src/timers.test.ts) fails on any
raw `setTimeout`/`setInterval` call or `Bun.sleep` in `src/` outside
`timing.ts`, with no allowlist (`Bun.sleep` since #900). The last modules
moved in #830; each kept its own policy, and a site whose timer aborts
with its own reason or may wait 0 ms uses `after`, not `deadline` or
`sleep`: `sleep(0)` resolves at once, where `Bun.sleep(0)` yields a timer
turn first. `every` arrived with the first `setInterval` user, the wake
dispatcher's ticker.
