# Programs — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Programs (standing orders)

Scheduled jobs arrived on demand (2026-09-20); programs generalize them
(2026-09-26, operator ask: "more proactive"). A program is **standing
authority for one concern**, borrowing openclaw's standing-orders shape
(`docs/automation/standing-orders.md`): a charter plus the triggers that
wake it. The `jobs` table and `schedule` tool are superseded, not kept
alongside; the one-off legacy purge leaves no general migration
framework behind: beside an existing programs table it never reactivates
legacy rows (programs is the operator's truth, deletions included), and
unparsable rows are preserved verbatim for recovery.

Its storage, though, is not openclaw's: there standing orders ride the
always-injected AGENTS.md, the shared-file scope its HEARTBEAT.md
leaked. Here the charter is the row — **a program's instructions are the
program's state, never a workspace file** — cache stable by
construction.

Rulings:

- **Authority is granted, never self-issued.** Creating or widening a
  program needs the operator's explicit ask — the agent may *propose*
  one ("want me to own this?"), never grant itself standing authority.
  What a firing turn does is bounded by its charter and the same
  ask-first rule as any operator message. **The ask is now a durable
  approval, not a conversational one** (2026-10-20): a grant-shaped
  change — `create`, any nonidentical charter text, a new trigger kind
  (a cron where none existed, a hook on a program that lacks one), a
  new or changed non-null mail filter — is staged as a
  `program_proposals` row, and only the operator's Telegram tap
  activates it. Deliberate conservative tightening of the earlier
  "reword within intent" rule: the model never classifies whether its
  own authority is widening — identical text is the only free charter
  write. What stays direct inside granted authority: rescheduling an
  existing cron, name and lateness edits, toggling, deleting,
  removing a trigger (the last one still refuses), rotating an
  existing hook. Any approval-required component stages the *entire*
  requested patch — no partial application. Approval binds an
  immutable base fingerprint (id, pinned address, charter, triggers,
  enabled — run/checkpoint/cursor accounting deliberately excluded),
  so a landed fire or mail checkpoint never stales a proposal, but any
  real configuration change does; a newer pending update for the same
  target supersedes older ones, and the decision — activation through
  the store's own create/update plus the stamp — is one immediate
  SQLite transaction, so a repeated tap or a crash can never grant
  twice. The update row also stores the renderable snapshot of its
  base (`base_snapshot`, NULL on pre-column legacy rows): approval
  cards always render that immutable candidate — a re-post after the
  live program moved shows what the original card showed plus a stale
  warning, never a merge onto today's row, and a drifted legacy row
  with nothing immutable left names the coming refusal instead of
  guessing a candidate. The snapshot's bounds are the trusted
  store's, never proposal-input limits — a grandfathered or pre-limit
  charter beyond the input cap still stages and reads, and the stored
  payload is validated inside the staging transaction so no committed
  row can fail its own reader. Posting is fenced by the staging turn's abort
  signal chunk by chunk — a stopped turn sends no further chunks and
  never the buttons; the durable row stays pending for
  `program/review`. A hook the proposal requests is minted only at
  approval and travels only to operator DMs — no credential exists to
  leak before the grant, and without `publicUrl` the tap refuses
  pending; the token's plaintext exists only inside the tap handler,
  so in-flight posts and taps are tracked and shutdown joins them
  under the drain budget before the store closes. Existing
  programs were never proposals: grandfathered rows activate nothing,
  ask nothing, migrate nothing.
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
- **Schedule retry is a bounded in-process ladder** (2026-10-13):
  schedule is the one trigger with no retry middle ground (webhook has
  the caller, mail the checkpoint), so only a fire whose turn died
  before any model call with a transient transport/availability cause
  re-fires the same occurrence, on short fixed delays — never a held
  occurrence. Anything else — model output or spending, a non-transient
  or unknown cause, a mid-ladder disable or delete (revoked authority
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
  oracle, no body echo. A hook disabled or rotated mid-upload is dead
  (revoked authority fences in flight), and once the runtime stops
  accepting turns the route refuses rather than fake-accepts — a closed
  runtime only records submits. The body rides in fenced as untrusted
  event data to evaluate, never instructions.
- **Recurrence is cron, evaluated in the server's local timezone**
  (operator = admin; `date` via bash agrees): an invalid expression is
  rejected before a row exists, and there are no interval-plus-prose
  hybrids — prose recurrence is where heartbeat bugs came from.
- **A program belongs to the conversation where it was created** — the
  tool pins the chat/topic from the live conversation (the model never
  handles chat ids); replies land there, and a fire is delivered like
  any message — no interleaving, no special execution path, epoch
  fencing applies. A program born in the bot DM pins the DM's rolling
  address (Telegram → Rolling DM, 2026-10-03): a fire within the gap
  joins the current conversation; past it, it starts a fresh one without
  the follow-up check — a fire is self-contained, never a follow-up.
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

Still out (machinery): proactive monitoring/heartbeat (programs are
authority the operator granted, woken by a clock or an event — not an
agent that wakes itself to decide whether to check things; ruled out
again 2026-09-26), cross-host schedulers, built-in file watchers (a
script that curls the program's hook covers them), run history/audit
tables beyond `last_run` and the log. Mail is the one watcher that
returned (operator ask, 2026-09-26) — as a program trigger, see `Email`:
a mail match is an event the operator's filter asked for, not the agent
deciding to look.
