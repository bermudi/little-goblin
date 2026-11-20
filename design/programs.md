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
  row can fail its own reader. A corrupt stored proposal fails list and
  pending reads with its row identity instead of silently vanishing from
  the operator's approvals or attention view. Posting is fenced by the staging turn's abort
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
  Responsibility-destination fires (ruling 2026-10-20) enqueue the
  occurrence as a durable development keyed by `program:<id>:occ:<iso>`.
  The trigger text rehydrates the responsibility's *current* revision,
  understanding, and attachment health, so a crash-window replay after a
  correction re-recording the same key with drifted text is not an
  identity conflict: flagged `replay`, the store reuses the recorded
  occurrence — the occurrence that fired is the one that delivers, and
  the next occurrence carries the fresher view. Conversation and kind
  are still identity; drift there fails loudly as before.
  **Destination union × canonical target (ruling 2026-10-22, merge of
  the two lines):** a program row carries exactly one destination — a
  conversation address or a `responsibility_id` — and the canonical
  `target` column (NOT NULL) holds a `resp:<responsibility_id>` pseudo-
  address on responsibility rows. That pseudo-address is not a
  conversation: `telegramAddressOf`/`appConversationOf` project it to
  null, and every delivery path branches on `responsibilityId` before
  reading `target`. The program tool on project turns scopes its verbs
  to the handed-over project and mints no hooks (no operator DM exists
  there), but it has no direct grant lane.

  **What a handover authorizes (operator ruling 2026-11-19, #775):** a
  project handover grants Goblin only the responsibility's
  service-owned follow-up clock (`ensureFollowup`, below) — never new
  standing authority. A project-turn `create` bound to a responsibility
  (`responsibilityId`) stages a create proposal like any other: the
  draft carries the responsibility, the proposal's `target` pins the
  staging conversation (where the approval card or app marker posts),
  and only the operator's decision creates the program on the
  `resp:<id>` destination. Widening an existing project program (a cron
  where none existed, a new or changed mail filter, charter text) stages
  through the same gate. Earlier, responsibility-destination creates
  were written directly from the project turn, so a handover could set
  up a cron or mail watch the operator never saw.
  Only staging needs a destination: on an addressless project turn the
  direct verbs still apply (rename, lateness, reschedule, hook disable),
  while a create or a grant-shaped update refuses — its staged row would
  have no lane to pin. The app channel's presentation target is likewise not
  the program's `target` column: a responsibility-destination program's
  approvals post into the responsibility's coordination conversation —
  the route resolves `responsibility_id` → row →
  `coordination_conversation_id` → `targetOf` (canonical; a rolling DM
  pins `dm:<chat>`). The program row itself stays responsibility-
  targeted. Missing responsibility wiring, a missing row, or a missing
  coordination conversation refuses the grant-shaped op with the
  readable no-destination answer — direct edits and hook disable still
  apply, nothing falls back to a fabricated lane. `review` scopes a
  staged proposal by the grant it asks
  for: the program it patches, or, on a create (no program row yet),
  the conversation its draft pins as its destination — a foreign lane's
  pending proposal reads as absent, so one project turn can never
  re-post another conversation's approval card.

  A follow-up program is create-once per responsibility. Its durable
  identity is its `kind` ("followup", service-minted and unpatchable)
  alone. Not its name: a custom program may be named
  `followup:<responsibility_id>`, and the operator approved a custom
  program, not a clock (#776; no store held a pre-kind follow-up, so
  the old name fallback was dropped). NOT the
  `responsibility_id` binding either: independent programs (a mail
  watch, a webhook) legally share a responsibility destination, and
  recovery that matched on the binding adopted the oldest row whatever
  it was, losing the scheduled check-in to a mail-only program. A
  create that committed before its link write (crash, failed write) is
  adopted by the next `ensureFollowup`, never twinned; surplus twins
  from repeated crashed creates are disabled and logged; independent
  programs sharing the destination are neither adopted nor silenced.
  Disabling the linked program can never leave an orphan still firing.

  **Deliberate follow-up (2026-10-30):** a service-owned follow-up's cron
  is a code-only evaluation clock, not an inference heartbeat. New
  follow-ups evaluate every minute; existing/operator-edited cron
  cadences are preserved. An active responsibility persists one next
  review: token, due time, purpose, and commitment/silence kind. Only a
  due review on the currently linked, enabled Program enqueues a
  `scheduled-checkin`. Ordinary custom Programs retain their existing
  occurrence semantics, including custom Programs sharing this destination.

  `responsibility action=followup` with `followup:{dueAt,reason}` replaces
  the next review inside handed-over authority. It requires active work
  and a future, timezone-qualified timestamp. Until a task-specific
  review is planned, a one-hour silence limit is the engineering safety
  default, not a settled operator budget. New meaningful observations
  cover that silence check and move it forward; unchanged polling
  cannot, and an explicit commitment is never discarded by observation.
  A due review enqueues before its plan advances to the next silence
  backstop. The source key is `followup:<responsibility_id>:<token>`,
  independent of cron occurrence: restart between record and advancement
  reuses the same development even after several missed ticks. A
  failed record advances neither plan nor cron cursor; a failed plan
  write retries the same token. Compare-and-set consumption cannot
  overwrite a newer review. Program run accounting measures evaluations;
  the responsibility's wake/run history establishes actual model work.

  Corrections, changed lifecycle status, and deliberate reattachment
  invalidate the old review and establish a fresh silence backstop. A
  `waiting` report's `resumeWhen` is a stronger claim — the reporter
  names when the external condition changes — so it plans the next
  review at that stated time with commitment semantics; a `waiting`
  report whose `resumeWhen` does not parse to a time is refused with a
  steer to `action=followup`, which is the path for a condition that
  has no time.
  Paused, completed, and cancelled work gets no timed inference;
  resumption never resurrects the old promise. While the derived stage
  (below) waits on the operator, the silence backstop is held — not
  consumed — and an explicit commitment still fires: it is the agreed
  reminder. A report that moves the stage off the
  operator re-arms a fresh silence bound, so the overdue check does not
  fire stale. Separately, the scheduler's sweep reminds the operator with
  an app push and no model call: 4 hours after the report the stage
  derives from (`since` — for a question, the oldest open one, so an
  unrelated newer report does not restart the clock), then every 24
  hours until the stage changes. Paused
  work gets none. Downtime rings only the newest step. Payloads stay
  generic. When no subscribed device got it (none exist, or every send failed), it
  goes to the operators on Telegram. With neither path, it is a warn line. Stale disabled/deleted/rescheduled follow-up snapshots
  cannot fire. Already enqueued developments remain historical facts:
  turns must re-read current authority before acting, and existing
  revision/generation/send fences still govern effects. No new generic
  wake revocation or completion-verification protocol is implied.

  **Reports and stages (2026-11-02):** whom a responsibility waits for
  is derived, never stored twice. Stored status is lifecycle only —
  `active | paused | completed | cancelled`; the legacy
  `waiting_for_operator`/`blocked` values migrate on open into `active`
  plus a `migration` report (the column's CHECK still admits them —
  narrowing it means rebuilding an FK-referenced table — but nothing
  writes them). `responsibility_reports` is append-only:
  `progress | waiting | ready | blocked | failed | done | dropped`, a
  reason, an optional single `question` for the operator, a
  `resumeWhen` (required for `waiting`, an external condition — must
  parse to a time, which becomes the next review), evidence
  items `{item, ref, checked}`, the revision it was stated against, and
  the reporter — `goblin` (the coordinating turn's assessment of the
  T3 thread observations), `worker` (a linked delegation or subagent's own claim,
  filed on settlement), or `migration`. A worker's claim and
  goblin's assessment stay distinguishable at the data level.

  **Snapshots and obligations (2026-11-19, #778).** A report plays one
  or both of two roles. The newest non-`worker` report is the
  **status snapshot**: replaceable, the next goblin report supersedes it.
  A report with a `question`, and every `worker` report (a claim), is an
  **obligation**: it owes an answer or an assessment, and a newer report
  never closes it. Its identity is its `reportId`. Before this ruling
  the stage read only the newest report, so any later report silently
  dropped an unanswered question from Attention and an unassessed claim
  from goblin's queue. An obligation stays open until exactly one
  resolution names it, recorded append-only in `responsibility_resolutions`
  (primary key = the obligation's report id, so it resolves once):
  - `resolved` — a goblin report lists it in `resolves` (the operator
    answered, goblin assessed the claim, or the question was withdrawn;
    a re-ask is a new question plus resolving the old one). Only goblin
    resolves; a worker report with `resolves` is refused, and so is any
    id that is not an open obligation of that responsibility.
  - `closed` — the responsibility closed (a `done`/`dropped` report, or
    the operator's cancel): everything still open resolves in the same
    transaction, so a later resume starts clean.
  - `migrated` — the one-time backfill when the table was created: every
    older obligation except the newest report of open work, which
    reproduces the old single-report reading exactly.
  An operator correction resolves nothing (the 2026-11-02 rule below
  stands): it makes an open question goblin's to re-ask or resolve.
  Pause resolves nothing. Reports stay the history; there is no task
  table — the resolution row only records the explicit close.

  `responsibility-stage.ts` is the one derivation, over the snapshot and
  the open set, first match wins: closed → paused (operator) → an
  `uncertain` send (goblin reconciles) → an open question at the current
  revision (operator; the oldest, with a count of the rest) → an open
  question from before a correction (goblin: re-ask or resolve) → an
  open worker claim (goblin `assess`, oldest first) → a snapshot from an
  older revision (goblin `assess`) → snapshot `ready` = review at a task
  checkpoint (operator) → `blocked`/`failed` (operator) → `waiting`
  (nobody, names the condition) → working (worker). Every operator
  correction bumps revision, so a stale snapshot is goblin's move,
  because an unrelated correction must not erase what it said. The
  stage names the report it derives from (`since`). The feed pill,
  Attention and the scheduler's silence hold read this function and
  nothing else; the feed and the agent's `status` also list every open
  obligation (`open`). Attention shows one item per open question to the
  operator, plus the stage item when the stage is a review, block or
  failure (pause excluded — it is the operator's own choice).

  Closing is a report, never a status flip from the agent: `done`
  refuses unless evidence covers every `completionEvidence` entry
  verbatim, naming what was checked; `dropped` (nothing to do —
  superseded, not reproducible) needs at least one evidence item saying
  what was checked, but not the completion entries. Both close in
  the same transaction as the report. Operator pause/resume/cancel stay
  direct lifecycle controls. There is no universal acceptance gate:
  `ready` waits for review only when the task has a checkpoint; verified
  `done` closes on its own.

  **Worker reports:** a delegation or a subagent is linked to a
  responsibility only explicitly — `delegate start responsibility:<id>`
  or `agent spawn responsibility:<id>`, admitted when the
  id is open in the conversation's own project; no matching by topic
  or by "the project's only open one". The link lives on the delegation
  row. Each settlement of a linked delegation files one `worker`
  report before its notice wakes the conversation
  (`fileDelegationReport`, inside the notice retry: a failed write
  leaves the notice pending and the next scan files it): `done` →
  `ready`, `needs input` → `blocked` (a delegation has no structured
  question, so it waits for goblin to read and relay), `failed` →
  `failed`, `stopped` → `blocked`; the key
  `delegation:<id>:<promptedAt>:<baselineSeq>:<verdict>` dedupes
  retried notices while a follow-up or later dialog is a new report.
  A linked subagent files by the same mapping (`needs-input` →
  `blocked`), keyed `agent:<child>:<settlement>:<status>`
  (design/agents.md → Linked workers).
  Stage: a question goes to the operator whoever asked; any other
  open worker claim is goblin's move (`assess`) until goblin resolves
  it by id — a worker's `ready` never closes or reaches the operator as
  review until goblin reports on it, and a second worker's later claim
  does not hide the first. A worker cannot report
  `done`. A delegation's reports carry the revision stamped when it was
  linked, so a correction since then overtakes the claim and it becomes
  goblin's move, even after a steer. A report that can never file (row
  gone, invalid) is logged and the notice still wakes.

  Linked lead delegations additionally carry code-observed GitHub evidence
  (design/delegation.md → PR readiness). Their report keeps the worker
  claim separate from observed readiness; pending CI is `waiting`, missing
  or negative evidence is `blocked`, passing facts are `ready`. All remain
  worker reports for Goblin to assess, never permission to merge. Repeated
  observations do not wake a model; a changed readiness version files one
  new report and notice, including a regression to earlier facts.

  Borrowed from dsh-superagent (deepseek-ai/dsh-superagent-prototype,
  docs/001 and 003): the Report vocabulary incl. `dropped`, the
  first-match stage table labelled by whom it waits for, the
  `human_action`-style structured question forwarded unchanged, the
  Executor that reports only through structured tools, and the rejected concept
  "inferring 'waiting on a person' from a report's free text". Not
  taken: their Mandate/Policy/admission machinery (one operator), and
  completion bound to an external PR close — our evidence items play
  that role per task.

- **Queued authority (2026-11-02).** Developments recorded by
  autonomous recorders (the scheduler's check-ins, the observer, the mail
  watcher) carry a stamp of the authority they acted on: responsibility
  status and revision, plus attachment id and generation for an
  observation. Operator-origin developments (handover, correction) carry
  none, because they are the authority. When the wake carrying a stamped
  development appends its trigger, one predicate (`stillAuthorized`,
  `src/responsibility-authority.ts`) re-checks the stamp in the commit
  transaction. These lapse it: a status change (pause, close), an
  operator correction (revision bump), a detach, or a re-bind (generation
  bump). A lapsed development is never dropped: it happened, so it is
  still delivered, but its line is prefixed `[superseded — <reason>;
  history only, not authority to act]`. The verdict is written to the
  event once, before the append, so the trigger text never changes after
  commit and retries submit the same message. This is not generic wake
  revocation: wakes are pending only while their conversation is busy,
  and suppressing a delivered fact would lose work. A malformed stamp is
  corruption: the commit throws and nothing is appended. Prompt
  operations already carry the same check (`validateForSend`: revision
  and attachment generation). Project archive is visibility only
  (design/app.md → Archiving), not authority: it hides the rail entry and
  does not pause a responsibility, and a delivered wake unarchives the
  coordination conversation as any appended event does. Stopping work
  means pausing or closing the responsibility. Borrowed from
  dsh-superagent: re-checking the original permission before a held
  action resumes.

**Programs page (ruling 2026-11-07, #183, layout per design/app.md →
Non-chat page layout).** A summary strip (awaiting approval, enabled, late),
pending approvals with the reason left and the evidence open right (program
diff, or the mail body; stacked on a narrow pane), then the programs as a
table: program | schedule in words (`src/cron-words.ts`, raw cron when the
shape is not covered; "Webhook" / "On new mail" / "Manual" without a cron) |
max lateness | last run | next run | status. Opening a row replaces the list
with the detail (facts, instructions in a prose block, actions) and a back
link. Status is only what the row can say: disabled, *late* (an enabled
scheduled program whose `next_run` is more than 90 s past — three scheduler
scans — shown as `late N min`), or enabled. A "failed" status and a recent
runs list are not shown: no run outcome is stored (see below), and
inventing one would be fiction.

Still out (machinery): proactive monitoring/heartbeat (programs are
authority the operator granted, woken by a clock or an event — not an
agent that wakes itself to decide whether to check things; ruled out
again 2026-09-26), cross-host schedulers, built-in file watchers (a
script that curls the program's hook covers them), run history/audit
tables beyond `last_run` and the log. Mail is the one watcher that
returned (operator ask, 2026-09-26) — as a program trigger, see `Email`:
a mail match is an event the operator's filter asked for, not the agent
deciding to look.
