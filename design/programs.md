# Programs — goblin design

## Programs (standing orders)

A program is **standing authority for one concern**, borrowing
openclaw's standing-orders shape (`docs/automation/standing-orders.md`):
a charter plus the triggers that wake it.

Its storage, though, is not openclaw's: there standing orders ride the
always-injected AGENTS.md, the shared-file scope its HEARTBEAT.md
leaked. Here the charter is the row — **a program's instructions are the
program's state, never a workspace file** — cache stable by
construction.

Rulings:

- **Authority is granted, never self-issued.** The agent can propose new or
  wider standing instructions, but only the operator's recorded approval
  grants them. The model cannot decide that its own charter edit is "only
  rewording." An approval covers the entire proposed change against the
  config the operator saw, never a subset or a stale base. Keep hook
  credentials out of model history and logs. See the
  [program proposal store](../src/program-proposals.ts) and
  [app approval tests](../src/http/app-approvals.test.ts).
- **Firing is one path for every trigger.** Cron tick, webhook hit, or
  anything later: the charter is submitted as an ordinary user message
  into the program's pinned conversation — one shared core, per-trigger
  entry points, because the accounting is not shared.
- **Post-submit accounting is trigger-owned** (2026-09-28), in the
  firing owner, never a caller: cron advances past the occurrence even
  on a failed submit (occurrences are synthetic and infinite — holding
  one refires and re-delivers the error every tick); a webhook stamps
  `last_run` only on a landed turn (the caller owns retry — a failed hit
  leaves the stamp and the throttle window open); mail holds its
  checkpoint on a failed fire (matches are real events that cannot be
  regenerated — they retry next poll). No caller writes program state.
  One pre-admission exception: a Telegram-targeted occurrence due while
  the channel is unattached is *held* — no fire attempt, no `last_run`,
  no retry burn — so a restarting process does not consume catch-ups it
  cannot deliver; the scan the attach kicks re-evaluates the same due
  row under the normal lateness/coalescing rules. This is not a failed
  submit — the failed-submit accounting above is unchanged.
- **Schedule retry is a bounded in-process ladder** (2026-10-13):
  schedule is the one trigger with no retry middle ground (webhook has
  the caller, mail the checkpoint), so only a fire whose turn died
  before any model call with a transient transport/availability cause
  re-fires the same occurrence, on short fixed delays — never a held
  occurrence. Anything else — model output or spending, a non-transient
  or unknown cause (provider quota exhaustion is non-transient: a
  days-long wall, not a throttle — it fails and notifies, no retry;
  retry-at-reset is deferred; the AI SDK's own `maxRetries` no longer spends attempts on a quota 429 — `resolveModel` marks it non-retryable, design/model.md), a mid-ladder disable or delete (revoked authority
  fences the retry), exhaustion, restart — ends the ladder. The cursor
  advanced at the original fire; the ladder never re-runs the run-mark.
- **Webhooks: one secret address per program.** Served on the loopback
  HTTP server, reachable only through whatever door the configured
  `publicUrl` fronts — `tailscale serve` keeps it tailnet-only, `funnel`
  makes it public. **The token never enters model context**: the hook
  tool DMs the full URL to each operator's private chat — never the
  program's topic (group readers aren't implicitly authorized) —
  outside conversation history, and the model learns only that delivery
  happened. Zero DMs delivered = tool error (hook stays set; rotate
  resends). Unknown and disabled tokens read identically — no existence
  oracle, no body echo. **No log line carries the token** — the route's
  pathname *is* the credential, so a throw anywhere inside it (sender
  dropped mid-body, store read failure) logs `program hook failed` with
  method, error and the matched program, and the server's catch-all
  redacts `/hook/` pathnames so an escaping error still cannot leak it.
  A hook disabled or rotated mid-upload is dead
  (revoked authority fences in flight), and once the runtime stops
  accepting turns the route refuses rather than fake-accepts — a closed
  runtime only records submits. The body rides in fenced as untrusted
  event data to evaluate, never instructions.
- **Recurrence is cron, evaluated in the server's local timezone**
  (operator = admin; `date` via bash agrees): an invalid expression is
  rejected before a row exists, and there are no interval-plus-prose
  hybrids — prose recurrence is where heartbeat bugs came from. Every
  surface that shows a schedule — the app's program view, both approval
  cards, the Telegram card's `triggers:` line — renders the words plus
  the server zone's short label, the raw expression beside it.
- **A program belongs to the conversation where it was created** — the
  tool pins the chat/topic from the live conversation (the model never
  handles chat ids); replies land there, and a fire is delivered like
  any message — no interleaving, no special execution path, epoch
  fencing applies. A program born in the bot DM pins the DM's rolling
  address (Telegram → Rolling DM, 2026-10-03): a fire within the gap
  joins the current conversation; past it, it starts a fresh one without
  the follow-up check — a fire is self-contained, never a follow-up. A
  program born in the app's Rolling chat fires into the newest roll and
  never starts one ([wakes](app.md#rolling-chat-ruling-2026-11-21-840)).
- **Management is the `program` tool** — zod-validated, one tool, not a
  CLI: state mutation belongs behind validation and logging. Firing
  turns may use it too (a program retiring itself when its charter says
  it's done is fine). The direct/staged split above governs every
  action: `list` also surfaces pending proposals, and `review` re-posts
  a pending proposal's approval after a delivery failure — there is no
  model-side approve.
- **The scheduler is an in-process ticker** — systemd covers crashes;
  one owner per store, stop terminal, a restarted owner gets a fresh
  retry generation (late completions from a dead one cannot arm retries
  in it). A schedule's optional lateness grace is measured against the
  latest missed occurrence at or before the scan — "occurrence" meaning
  the scheduler's own forward sequence (ruling 2026-10-12: a backward
  `.prev()` is a *different* sequence across DST — it skips the
  spring-forward landing hour and admits the fall-back repeated hour,
  so catch-up lateness would lie late and on-time respectively). `null`
  (the default) means unlimited lateness: fire once on wake. Missed
  occurrences coalesce — at most one fire per scan, advancing past
  every missed instance to the next future occurrence. Beyond grace:
  skip through the scan, advance, log once; a skip is not a run, and
  occurrences skipped while disabled are skipped, not owed (re-enable
  recomputes from now).
  Submit first, then the run-mark — a landed message is history even if
  the turn never ran; a throwing submit never landed: deliver the
  error, mark anyway — one attempt per occurrence. A failed run-mark
  write fences the occurrence in-process: the write retries with the
  original fire time, never the submit; a restart may re-offer the row
  once — at-least-once, never a duplicate storm.
  Responsibility destinations (`resp:<id>` targets) were removed with
  responsibilities (operator, 2026-11-21, #844). Their rows stay on disk,
  hidden and never fired.

**Programs page:** show only statuses the stored facts support. Run
outcomes are not stored, so a failed status or recent-runs list would
be fiction. Layout lives in design/app.md.

Still out (machinery): proactive monitoring/heartbeat (programs are
authority the operator granted, woken by a clock or an event — not an
agent that wakes itself to decide whether to check things; ruled out
again 2026-09-26), cross-host schedulers, built-in file watchers (a
script that curls the program's hook covers them), run history/audit
tables beyond `last_run` and the log. Mail is the one watcher that
returned (operator ask, 2026-09-26) — as a program trigger, see `Email`:
a mail match is an event the operator's filter asked for, not the agent
deciding to look.
