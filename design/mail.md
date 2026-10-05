# Email — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Email (Gmail) + Workspace via gws

On demand (2026-09-26); reads migrated to gws on 2026-09-29. The
operator's Gmail: goblin reads it through the `gws` CLI, sends only
on the operator's tap, and a program can be woken by mail matching a
filter. The migration's forcing function was auth simplicity: OAuth
token plumbing in-process was a pita, and gws owns it instead — one
`gws auth login`, scopes below, no token code in goblin.

- **Reads ride gws; goblin holds no read credential.** `gws auth
  login` (one-time, interactive) grants the four Workspace scopes;
  every read is a `gws` subprocess with JSON output — the watcher
  polls raw Discovery calls (`gmail users history list` /
  `messages list|get` / `getProfile`, `src/mail-gws.ts`), the model
  reads through the `goblin-mail` wrapper (`scripts/goblin-mail`:
  `gmail +triage` for search, `gmail +read --headers` for bodies).
  Raw `gws gmail +read` is forbidden by the skill, not by mechanism
  — and that is the honest limit (below). gws owns its token cache
  and refresh; goblin never sees a Gmail access token on the read
  path. The `+watch` helper (Pub/Sub push) was rejected: it needs a
  GCP project with Pub/Sub resources and a 7-day watch renewal — a
  second system to keep honest — while the 5-minute history-list
  poller reproduces the exact checkpoint contract below with no new
  infrastructure.
- **Scopes: readonly is the wall.** `gmail.readonly` (triage + read
  need `q` search; the metadata scope rejects it), `drive.readonly`
  (files list/get without write — Drive deletes are unrecoverable),
  `calendar` + `spreadsheets` read-write (both have undo history).
  Login with exactly these four (`--readonly` under-grants
  calendar/sheets; never `--full`, never add a write scope beyond
  calendar/sheets, unless the operator names it). What bounds the
  damage of a skipped check is the auth: with readonly Gmail scopes
  the worst a bypass can do is read, never send, delete, or widen
  access. `gws gmail +send` is forbidden — there is no `gmail.send`
  scope in the login, so sending is impossible from gws by
  mechanism, not just by rule.
- **Every read is injection-checked and fenced — including watcher
  events.** The System One gate (below) scores the body through two
  `noul` questions (injection + severity) and the verdict line rides
  with the text: `[injection check: clean p=0.02 sev=0.01]` (or
  `suspicious` / `malicious` at ≥0.3 / ≥0.7) or `[injection check
  unavailable]` on any gate outage — fail-open, the read still
  proceeds. The wrapper (`goblin-mail read`) scores through the
  loopback endpoint (`POST 127.0.0.1:<http.port>/api/check-injection`,
  same box, Host check is the auth) and prints `<mail>…</mail>` +
  verdict + the standing untrusted-data note, neutralizing any
  `</mail` in the body first. Watcher fires score the whole formatted
  event through the same shared gate instance before the turn lands
  (`scoredMailEvent` in `scheduler.ts`: one call, the event is what
  the model sees) — same verdict-line contract, same fail-open. A
  tricked model could call gws directly and skip the check — nothing
  in a skill file can stop that; readonly scopes are what bound it.
  The fired event text transits the System One provider like any
  model call does (same trust class as the model provider); mail
  bodies are never logged, only ids and counts.
- **The `mail` tool is send-only.** Search/read left the tool for the
  wrapper + gws skill (the sanctioned read path, above — which also
  killed the old flat-schema bug for free: there is no multi-action
  union left to drift). The tool's one action queues a draft;
  attachments ride the same door (gws fetch to a workspace file).
  Its description points the model at `$GOBLIN_HOME/goblin-mail` for
  reads. The old REST reader (`makeReader`, search/read/attachment/
  poll/profile over in-process OAuth) is deleted; `mail.ts` owns only
  the send client plus the shared shapes (`MailHit`,
  `HistoryExpiredError`, `ThreadContext`, the `MailPoller` seam).
- **Google OAuth with split authority.** The operator's own Google Cloud
  OAuth client (one-time setup, desktop-app flow) covers only the
  SEND: client id (public) + client secret + send refresh token live
  in Pass, granted to goblin's token, resolved through `auth.jsonl`
  like every other secret; send access tokens are minted in-process
  per send, never cached to disk. An app password was rejected: one
  credential would cover both, and the send gate would be the only
  thing between a tricked model and a sent mail. Open before build:
  the consent-screen publishing status — a "testing" app's refresh
  tokens die after 7 days, so the client must be in production
  (unverified is fine for one user).
- **Send is operator-gated by mechanism, not by prompt — and one module
  owns the draft's whole life.** `send` never sends: the tool hands the
  draft to the approval gate (`tg/mail-approval.ts`), which issues it —
  writes the pending row (`mail_outbox` in goblin.sqlite: draft, pinned
  address, created, expires +24h, status), posts it with **Send /
  Cancel** inline buttons, and binds the buttons' message id — then
  decides the taps and sweeps the expiry on its own 5-minute ticker
  (boot catch-up included). The tool only requests; the mail watcher
  only polls filters and holds no outbox seam; the gate returns
  "awaiting operator approval". Only the callback from an
  `allowedUsers` id sends — with the send token, which no tool path
  and no skill ever touches. Threading resolves at send time from the
  stored reply target — the lookup is a read, so it rides the read
  credential (the send credential still never leaves the approval
  path, and under the send-only scope Google would 403 the read
  anyway); the row decides *after* Gmail accepts the send,
  so a crash between the two leaves a re-tappable pending row (a
  visible duplicate on retry) rather than a silent loss. Expired or
  cancelled rows never send; a restart keeps pending rows (the buttons
  still work). Honest boundary: goblin runs with full bash as the same
  uid, so this stops a *tricked* model (the read path holds a token
  that cannot send), not a deliberately hostile one — the trust level
  `bash` already granted.
  A Telegram timeout while posting the draft is not proof it failed:
  keep its row pending, report the uncertainty with its draft id, and
  do not post it again automatically. If the buttons landed, their
  callback can settle the row even without a bound message id; if they
  did not land, the pending row expires after 24 hours. The operator
  checks Telegram before requesting a replacement draft.
- **Mail is a program trigger.** A program may carry a `mail` filter
  (Gmail query, e.g. `from:bank is:important`) beside its cron and
  webhook. An in-process ticker (the scheduler's twin, 5 min) runs
  each enabled filter through gws since the program's last seen
  history id (stored on the row), and each new match fires the
  program through the one firing path — `[program: <name> · trigger:
  mail]` + charter + `<event>` (from, subject, date, snippet, id; the
  body is one wrapper-read away, never pushed) + the injection verdict
  line. A new or changed filter
  baselines at the current head without firing — the mailbox's backlog
  is history, not arrivals; an expired cursor re-baselines the same
  way. The row has a dedicated `mail_revision INTEGER NOT NULL DEFAULT 0`:
  filter changes and re-enables increment it when clearing the cursor.
  Baselines compare the original revision, filter, cursor and enabled state
  in one conditional SQL update, so an in-flight Gmail head cannot survive
  a disable/re-enable ABA (even across DB connections). Existing rows gain
  the column additively; `created_at` remains creation time, not a generation.
  The 60 s per-program throttle becomes a batch: matches inside
  one tick fire once with all of them, capped at 10 oldest-first per
  tick — the checkpoint advances only to the last fired record's
  boundary, so the unfired remainder refires next tick instead of
  being skipped (a single collapsed record over the cap is the one
  honest skip, and it warns). A fire that does not land holds the
  checkpoint the same way — its matches retry on the next poll
  instead of being silently skipped, and the checkpoint write
  follows the submit, so a crash between the two re-fires a batch
  rather than dropping it (at-least-once). An empty poll, or one
  whose program was disabled mid-flight, consumes the checkpoint —
  that mail is skipped, not owed (the cron rule). The checkpoint
  write itself is a CAS on `mail_revision` (ruling 2026-10-04): the
  fire's snapshot carries the revision it scanned, and a filter edit
  or re-enable that lands while the fire was mid-flight bumps the
  revision and re-baselines — the stale fire's checkpoint loses the
  write, logs, and still stamps `last_run` (the fire itself landed).
  This is the write-time half of the read-time re-read rule below.
  The filter's
  50-entry list page is the intersection window; a full page warns
  that older matches may be invisible to it. After each poll the watcher re-reads the program
  row — a disable, delete, or filter edit that lands mid-poll wins
  over the stale snapshot, and an edited filter keeps its
  re-baseline. A dead token or quota error warns once per outage
  episode, never per tick.
- **Approved sends join shutdown (ruling 2026-10-04).** The approval
  gate's stop clears the sweep timer and awaits any in-flight Gmail
  send, inside the process shutdown's drain budget. A SIGTERM
  mid-send otherwise kills the send before its verdict lands — the
  row stays pending and un-stamped, so a later re-tap (or the sweep's
  expiry stamp, after the fuse) decides on stale information. The
  crash window (power loss, kill -9) remains accepted as before;
  graceful shutdown no longer shares it.
- **System One (`system1` block + Jev gate) feeds the shared gates.**
  The optional hand-edited `system1` block (`{auth, model?,
  baseUrl?}` — a decision model id like `typesafe/jev-1.13`, NOT a
  `<provider>/<model>` chat ref, so never provider-validated) rides
  the reviewer's single `JevClient`: `auth` resolves live per call
  (falling back to `reviewer.auth`), `model`/`baseUrl` are
  boot-captured with the reviewer's gate auth/thresholds (a hand edit
  applies on restart). The built-in default and backup model are
  **`typesafe/jev-1.13`** (operator ruling, 2026-10-05); the operator's
  configured primary is `inception/mercury-decide:free`. A failed
  configured-model call retries the identical state/questions once
  against the backup on the same endpoint, except auth failures and
  HTTP 401/403 (the same credential cannot fix those). No duplicate
  attempt when primary and backup are the same; no retry of a valid
  low-probability answer. Primary gets half the call's time budget to
  reserve room for the backup; both attempts share the original total
  deadline (30s normally, 3s for Rolling DM). If both fail, the
  existing consumer-specific failure behavior remains. Attempt,
  selected model, probabilities, usage, latency, and sanitized failure
  kind/status are logged with one request id; never state text,
  credentials, response bodies, or endpoint URLs.
  `reviewer` stays the on/off switch — no
  reviewer block means no gate at all (the loopback endpoint 503s,
  watcher events fire unscored, reads report unavailable). Consumer
  one: the skill-review gate (below). Consumer two: the injection
  checker above — `checkInjection` in `src/injection.ts` (head-cut
  8000 chars, verdicts at ≥0.7/≥0.3, fail-open ONLY on `JevError`,
  anything else propagates loud) via the loopback route
  (`POST /api/check-injection`: loopback Host check, 64 KiB body cap,
  never logs the text) for wrapper reads and directly through the
  shared instance for watcher fires. The wrapper follows
  `goblin.json5`'s `http.port` automatically (`GOBLIN_MAIL_PORT`
  overrides; a wrong override warns and reads fail open — the old
  env-dance default of 8787 died with the first box-local port
  override). The `goblin-mail` shim (`$GOBLIN_HOME/goblin-mail` →
  `scripts/goblin-mail`, boot-repointed symlink, never clobbers a
  real file) and the `gws` skill (`deploy/skills/gws/SKILL.md`, seeded
  write-if-absent) are the model's contract: reads ONLY through the
  wrapper, never raw `+read`; `gws` discovery beyond mail (drive /
  calendar / sheets) rides the same CLI and scopes.
  Consumer three: Rolling DM's follow-up check (see
  `design/telegram.md`), with its 3s total check budget.
- **Logging**: every gws/Gmail call (action, query or id, exit code or
  status, ms — never bodies); every injection check (verdict,
  probabilities, ms) and every served loopback check (verdict, ms);
  every outbox transition (queued, sent, cancelled,
  expired — recipient domain, never the body).
