# Email — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Email (Gmail) + Workspace via gws

On demand (2026-09-26); reads migrated to gws on 2026-09-29 for auth
simplicity: gws owns OAuth — one interactive login, the scopes below,
its own token cache and refresh — so goblin holds no read credential
and never sees a Gmail access token on the read path. Reads go only
through the `goblin-mail` wrapper (whose boot-installed shim never
clobbers a real file); raw `gws gmail +read` is forbidden by the skill,
not by mechanism — the honest limit (below). The `+watch` helper
(Pub/Sub push) was rejected: a GCP project, Pub/Sub resources and 7-day
watch renewal are a second system to keep honest, and the poller
reproduces the checkpoint contract below with no new infrastructure.

- **Scopes: readonly is the wall.** `gmail.readonly` (search needs `q`;
  the metadata scope rejects it), `drive.readonly` (no write — Drive
  deletes are unrecoverable), `calendar` + `spreadsheets` read-write
  (both have undo history). Log in with exactly these four (`--readonly`
  under-grants calendar/sheets; never `--full`; never add a write scope
  beyond calendar/sheets unless the operator names it). `gws gmail +send`
  is impossible by mechanism, not just rule — no `gmail.send` scope is
  in the login.
- **Every read is injection-checked and fenced — including watcher
  events.** The shared System One gate (`design/system1.md`) scores the
  body through two `noul` questions (injection + severity); the verdict
  line rides with the text — `clean`, `suspicious` / `malicious` at
  ≥0.3 / ≥0.7, or `[injection check unavailable]` on any gate outage:
  fail-open, the read still proceeds, and with no gate configured watcher
  events fire unscored. Reads print fenced as untrusted data, with the
  standing note; watcher fires are scored the same way before the turn
  lands. A tricked model could call gws directly and skip the check — no
  skill file can stop it; the readonly Gmail scopes bound the damage to
  reading. The fired event text transits the System One provider at the
  same trust class as any model call; mail bodies are never logged.
- **The `mail` tool is send-only.** Search/read left the tool for the
  wrapper + gws skill — one sanctioned read path, no multi-action union
  left to drift. Its one action queues a draft and never sends.
- **Google OAuth with split authority.** The operator's own Google Cloud
  client (desktop-app flow) covers only the SEND: client id, secret and
  send refresh token live in Pass, resolved through `auth.jsonl` like
  every other secret; send tokens are minted per send, never cached to
  disk. An app password was rejected — it would cover both directions,
  leaving only the send gate between a tricked model and a sent mail. A
  "testing" app's refresh tokens die after 7 days — the client must be
  in production (unverified is fine for one user).
- **Send is operator-gated by mechanism, and one module owns the draft's
  whole life.** `send` never sends: the tool only requests, the watcher
  only polls filters, and the approval gate (`tg/mail-approval.ts`) owns
  the whole draft — row, **Send / Cancel** buttons, taps, expiry sweep.
  Only a callback from an `operators` id sends, via a send token no tool
  path and no skill ever touches; threading resolves at send time from
  the stored reply target over the read credential (the send-only scope
  would 403 it). The row decides *after* Gmail accepts the send — a
  crash between the two leaves a re-tappable pending row (a visible
  duplicate on retry), never a silent loss — and only pending rows can
  send: cancelled, expired, and decided rows never do, while a restart
  keeps pending rows tappable. A Telegram timeout while posting proves
  nothing: keep the row pending, report the uncertainty, never repost
  automatically — a landed button still settles the row, otherwise it
  expires. The operator checks Telegram before requesting a replacement.
  Honest boundary: goblin already holds full-bash same-uid trust, so
  this stops a *tricked* model, not a hostile one.
- **Watcher ownership and shutdown.** One mail watcher per programs
  store; duplicate starts throw until the stop settles, and stop fences
  new scans while joining in-flight work.
- **Mail is a program trigger.** A program may carry a `mail` filter
  (Gmail query) beside cron and webhook; enabled filters poll since
  their stored cursor, and each match set fires through the one firing
  path — metadata event (the body is one wrapper-read away, never
  pushed) + the injection verdict line. A new or changed filter — or an
  expired cursor — baselines at the current head without firing:
  backlog is history, not arrivals, and mail between the old cursor and
  now may fire late or not at all (the honest boundary). Filter changes
  and re-enables bump a revision when clearing the cursor; baselines are
  one conditional CAS, so an in-flight Gmail head cannot survive a
  disable/re-enable ABA (even across DB connections); `created_at`
  stays creation time, not a generation. A poll's matches fire as one
  capped batch, oldest first: the checkpoint advances only to the last
  fired record's boundary, so the unfired remainder refires next poll
  instead of being skipped (a single collapsed record over the cap is
  the one honest skip, and it warns). A fire that does not land holds
  the checkpoint — matches retry next poll — and the write follows the
  submit, so a crash between the two re-fires a batch rather than
  dropping it (at-least-once). An empty poll, or one whose program was
  disabled mid-flight, consumes the checkpoint — skipped, not owed (the
  cron rule). Checkpoint writes are a CAS on the revision (ruling
  2026-10-04): the fire's snapshot carries the revision it scanned, so a
  mid-flight filter edit or re-enable re-baselines and the stale fire's
  checkpoint loses the write, logs, and still stamps `last_run` (the
  fire landed). Final admission re-reads the row after the gate scores
  the event (ruling 2026-10-08, #81): a mid-gate disable or delete
  fences the submit itself — no turn lands on revoked authority — and a
  mid-gate disable consumes the checkpoint under the snapshot CAS;
  filter edits and re-enables deliberately keep landing the old fire,
  and only the checkpoint loses. After each poll the watcher re-reads
  the program row: a mid-poll disable, delete, or filter edit wins over
  the stale snapshot, and an edited filter keeps its re-baseline.
  history.list takes no filter query, so arrivals intersect the filter's
  recent list page; a full page warns older matches may be invisible to
  it. An arrival the search does not show may be a lagging index entry
  rather than a non-match (ruling 2026-10-23): the checkpoint then holds
  at the last seen-consistent boundary — the record before the earliest
  unconfirmed arrival — so the record re-arrives and is offered to the
  search again, bounded by a grace window of mailbox history
  (~50 records, counted as records observed after the candidate —
  history ids are non-contiguous, their numeric distance means nothing)
  after which the arrival is treated as a non-match and
  the cursor advances; the hold never crosses a fired record, so nothing
  already fired refires. Residual loss channels, bounded and owned: a
  match that fires while an earlier unconfirmed arrival sits at or
  before its record (holding earlier would refire the match), matches
  that fall out of a full list page, and unconfirmed arrivals that
  outlast the grace. A dead token or quota error warns
  once per outage episode, never per tick. The notice's destination
  follows the program's destination union (2026-10-22): a chat-pinned
  program notices its Telegram conversation, a responsibility-bound one
  notices its coordination lane as a durable development through the
  wake dispatcher — building the notice from `program.chatId` targeted
  a nonexistent chat 0 every scan, and the failed delivery re-warned
  forever.
- **Approved sends join shutdown (ruling 2026-10-04).** The gate's stop
  clears the sweep timer and joins any in-flight Gmail send in the
  shutdown drain: a SIGTERM mid-send would otherwise land the row
  pending and un-stamped, and a later re-tap (or the expiry stamp) would
  decide on stale information. The crash window (power loss, kill -9)
  stays accepted; graceful shutdown no longer shares it.
