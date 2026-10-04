# Programs — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Programs (standing orders)

Scheduled jobs arrived on demand (2026-09-20); programs generalize
them on demand (2026-09-26, operator ask: "more proactive"). A
program is **standing authority for one concern**, borrowed from
openclaw's standing orders (`docs/automation/standing-orders.md`):
a charter — scope, what needs the operator's OK, when to escalate,
what not to do, steps — plus the triggers that wake it. "You own the
weekly report; compile it Fridays, only escalate if something looks
off." A job was a program with a cron and a one-line charter; the
`jobs` table and `schedule` tool are superseded, not kept alongside.

What we took from openclaw is the charter *shape*, not its storage:
openclaw puts standing orders in the always-injected AGENTS.md, which
every conversation sees — the same shared-file scope its HEARTBEAT.md
leaked through for years. Here the charter is the row. The design
takes that lesson wholesale: **a program's instructions are the
program's state, never a workspace file.** Rulings:

- **State is rows, not files.** A `programs` table in `goblin.sqlite`
  (own connection in `src/programs.ts`, same WAL file): name,
  charter, optional 5-field cron, optional webhook token hash, the
  pinned Telegram address, enabled, last_run, next_run (null without
  a cron). A program needs at least one trigger. Creating one changes
  nothing in the workspace and nothing in any prompt — cache stable
  by construction. On first open, rows from the legacy `jobs` table
  (if any) copy in once — prompt becomes charter — and the old table
  is left untouched; no general migration framework.
- **Firing is one path for every trigger.** Cron tick, webhook hit,
  or anything later: `runtime.submit` of a user message
  `[program: <name> · trigger: <schedule|webhook|mail>]` + the charter
  (+ the event payload, below) into the pinned conversation. One
  shared format-and-submit core — and one entry point per trigger
  beside it, because the accounting is not shared:
- **Post-submit accounting is trigger-owned** (2026-09-28). What a
  fire costs when delivery fails is the policy, and it lives in the
  firing owner's three entry points, never in a caller: cron advances
  past the occurrence even on a failed submit (occurrences are
  synthetic and infinite — holding one refires and re-delivers the
  error every tick); a webhook stamps `last_run` only when the turn
  landed (the caller owns retry — a failed hit leaves the stamp and
  the throttle window open for it); mail holds its checkpoint on a
  failed fire (matches are real events that cannot be regenerated —
  they retry next poll). The route keeps its HTTP status and throttle
  clock, the watcher keeps polling, but no caller writes program
  state.
- **Authority is granted, never self-issued.** Creating or widening a
  program needs the operator's explicit ask — the agent may *propose*
  one ("want me to own this?"), never grant itself standing
  authority. What a firing turn does is bounded by its charter and
  the same ask-first rule as any operator message.
- **Webhooks: one secret address per program.** `POST
  /hook/<token>` on the existing HTTP server (bound to 127.0.0.1;
  reachable only through whatever door `publicUrl` fronts —
  `tailscale serve` keeps it tailnet-only, `funnel` makes it public
  for GitHub/CI). The token is 32 random bytes, base64url; only its
  sha256 is stored. **The token never enters model context**: the
  tool that enables or rotates a hook DMs the full URL to each
  `allowedUsers` id — never the program's topic, whose group readers
  aren't implicitly authorized — outside conversation history, and
  returns only "hook enabled, URL sent privately" to the model. No DM
  delivered = tool error (hook stays set; rotate resends). The route
  re-resolves the token after reading the body (a hook disabled or
  rotated mid-upload is dead) and answers 503 + `Retry-After` once
  the runtime stops accepting turns — a closed runtime only records
  submits, so a 202 would be a lie. Disable = clear the hash; rotate
  = new token. Body (text or JSON, capped at 32 KiB, larger →
  413) rides into the turn fenced as `<event>…</event>` with a
  standing note that event content is data to evaluate, never
  instructions — a webhook is untrusted input by construction.
  Throttle: one fire per program per 60 s; extra hits get 429 and a
  log line; a refused or failed hit does not consume the window.
  Unknown/disabled token → 404, no body echo.
- **Recurrence is cron, evaluated in the server's local timezone**
  (operator = admin; `date` via bash agrees). The model translates
  natural language → cron inside the tool call; `cron-parser`
  validates it at the boundary — an invalid expression is rejected
  before a row exists. No interval-plus-prose hybrids; prose recurrence
  is where heartbeat bugs came from.
- **A program belongs to the conversation where it was created**
  (chat/topic address pinned by the tool from the live conversation
  — the model never handles chat ids). The fired message gets a sink
  built like any other (voice per conversation setting); replies
  land in that chat/topic. A live turn steers the fire in at its
  next step boundary; otherwise the lane queue orders it into a
  fresh turn — no interleaving, no special execution path, epoch
  fencing applies either way. A program born in the bot DM pins the
  DM's rolling address (Telegram → Rolling DM, 2026-10-03): a fire
  within the gap joins the current conversation; past it, the fire
  starts a fresh one without the follow-up check — a fire is
  self-contained, never a follow-up. Either way the operator can
  follow up on it in the DM.
- **Management is the `program` tool** (list/create/update/delete/
  toggle/hook), zod-validated, one tool not a CLI — state mutation
  belongs behind validation and logging. `hook` takes
  `enable|rotate|disable`. Firing turns may use the tool too (a
  program retiring itself when its charter says it's done is fine);
  every mutation logs. Edits within an existing charter's intent
  (reword, reschedule, toggle) need no go-ahead; new programs and
  widened authority do (above).
- **The scheduler is an in-process ticker** (30s) in the runtime
  process; systemd covers crashes. A fire time missed while the
  process was down fires **once** at the next tick (boot catch-up),
  then advances to the next future occurrence — never a replay of
  every missed instance. Occurrences skipped while a program was
  disabled are skipped, not owed: re-enabling recomputes `next_run`
  from now. Submit first, then markRan: a message that landed is
  history even if the turn never ran. A submit that throws never
  landed — release the sink with the error, deliver it, then
  markRan anyway: one attempt per occurrence, so a persistent
  failure cannot refire (and re-deliver) on every tick.

Still out (machinery): proactive monitoring/heartbeat (programs are
authority the operator granted, woken by a clock or an event — not an
agent that wakes itself to decide whether to check things; ruled out
again 2026-09-26), cross-host schedulers, built-in file watchers (a
script that curls the program's hook covers them), run history/audit
tables beyond last_run and the log. Mail is the one watcher that
returned (operator ask, 2026-09-26) — as a program trigger, see
`Email`: a mail match is an event the operator's filter asked for,
not the agent deciding to look.

