# Email — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Email (Gmail) + Workspace via gws

On demand (2026-09-26); reads migrated to gws on 2026-09-29. Goblin reads
the operator's Gmail through the `gws` CLI, sends only on the operator's
tap, and can be woken by mail matching a filter. Auth simplicity forced
it: gws owns OAuth — one `gws auth login`, the scopes below, no token code
in goblin.

- **Reads ride gws; goblin holds no read credential.** `gws auth login`
  (one-time, interactive) grants the four Workspace scopes; every read is
  a `gws` subprocess with JSON output. The watcher polls raw Discovery
  calls (`gmail users history list` / `messages list|get` / `getProfile`,
  `src/mail-gws.ts`); the model reads through the `goblin-mail` wrapper
  (`scripts/goblin-mail`: `gmail +triage` for search, `gmail +read --headers`
  for bodies). Raw `gws gmail +read` is forbidden by the skill, not by
  mechanism — the honest limit (below). gws owns its token cache and
  refresh; goblin never sees a Gmail access token on the read path. The
  `+watch` helper (Pub/Sub push) was rejected: a GCP project, Pub/Sub
  resources and 7-day watch renewal are a second system to keep honest,
  and the 5-minute history-list poller reproduces the checkpoint contract
  below with no new infrastructure.
- **The adapter's wire contract is pinned against the real CLI, not just
  fakes (2026-10-11).** `mail-gws.test.ts` fakes the runner — hermetic, but
  blind to upstream drift. `src/mail-gws.live.test.ts` is the gated drift
  check: `GOBLIN_GWS_LIVE=1 bun test src/mail-gws.live.test.ts` drives the
  adapter's verbs against the real CLI (read-only: no auth, no sends, ids
  and cursor strings only, never bodies) and asserts the shapes the zod
  schemas pin, including the stdout error envelope and the
  absent-message 404→null mapping the poller's re-baseline rides on. Run
  it after any gws upgrade; red means the CLI moved: re-pin with one
  read-only probe, fix the adapter, never discover it live.
- **Scopes: readonly is the wall.** `gmail.readonly` (triage + read need
  `q` search; the metadata scope rejects it), `drive.readonly` (files
  list/get without write — Drive deletes are unrecoverable), `calendar` +
  `spreadsheets` read-write (both have undo history). Log in with exactly
  these four (`--readonly` under-grants calendar/sheets; never `--full`;
  never add a write scope beyond calendar/sheets unless the operator names
  it). The auth bounds a skipped check's damage: with readonly Gmail
  scopes a bypass can read, never send, delete, or widen access.
  `gws gmail +send` is forbidden — no `gmail.send` scope is in the login,
  so sending is impossible from gws by mechanism, not just by rule.
- **Every read is injection-checked and fenced — including watcher
  events.** The shared System One gate (`design/system1.md`) scores the
  body through two `noul` questions (injection + severity); the verdict
  line rides with the text: `[injection check: clean p=0.02 sev=0.01]` (or
  `suspicious` / `malicious` at ≥0.3 / ≥0.7), or `[injection check
  unavailable]` on any gate outage — fail-open, the read still proceeds.
  The wrapper (`goblin-mail read`) scores through the loopback endpoint
  (`POST 127.0.0.1:<http.port>/api/check-injection`, same box, Host check
  is the auth) and prints `<mail>…</mail>` + verdict + the standing
  untrusted-data note, neutralizing any `</mail` in the body first.
  Watcher fires score the whole formatted event through the same shared
  gate instance before the turn lands (`scoredMailEvent` in
  `scheduler.ts`: one call, the event is what the model sees) — same
  verdict-line contract, same fail-open. A tricked model could call gws
  directly and skip the check — no skill file can stop that; readonly
  scopes bound it. The fired event text transits the System One provider
  like any model call (same trust class as the model provider); mail
  bodies are never logged, only ids and counts.
- **The `mail` tool is send-only.** Search/read left the tool for the
  wrapper + gws skill (the sanctioned read path above; no multi-action
  union is left to drift). The tool's one action queues a draft;
  attachments ride the same door (gws fetch to a workspace file). Its
  description points the model at `$GOBLIN_HOME/goblin-mail` for reads.
  `mail.ts` owns only the send client plus the shared shapes (`MailHit`,
  `HistoryExpiredError`, `ThreadContext`, the `MailPoller` seam).
- **Google OAuth with split authority.** The operator's own Google Cloud
  OAuth client (one-time setup, desktop-app flow) covers only the SEND:
  client id (public) + client secret + send refresh token live in Pass,
  granted to goblin's token, resolved through `auth.jsonl` like every
  other secret; send access tokens are minted in-process per send, never
  cached to disk. An app password was rejected: one credential would
  cover both, and the send gate would be the only thing between a tricked
  model and a sent mail. Open before build: the consent-screen publishing
  status — a "testing" app's refresh tokens die after 7 days, so the
  client must be in production (unverified is fine for one user).
- **Send is operator-gated by mechanism, not by prompt — and one module
  owns the draft's whole life.** `send` never sends: the tool hands the
  draft to the approval gate (`tg/mail-approval.ts`), which issues it —
  writes the pending row (`mail_outbox` in goblin.sqlite: draft, pinned
  address, created, expires +24h, status), posts it with **Send /
  Cancel** inline buttons, binds their message id — then decides the taps
  and sweeps the expiry on its own 5-minute ticker (boot catch-up
  included). The tool only requests; the mail watcher only polls filters
  and holds no outbox seam; the gate returns "awaiting operator
  approval". Only the callback from an `operators` id sends — with the
  send token, which no tool path and no skill ever touches. Threading
  resolves at send time from the stored reply target — the lookup is a
  read, so it rides the read credential (the send credential still never
  leaves the approval path, and under the send-only scope Google would
  403 the read anyway). The row decides *after* Gmail accepts the send,
  so a crash between the two leaves a re-tappable pending row (a visible
  duplicate on retry) rather than a silent loss. Expired or cancelled
  rows never send; a restart keeps pending rows (the buttons still work).
  Honest boundary: goblin runs with full bash as the same uid, so this
  stops a *tricked* model (the read path holds a token that cannot send),
  not a deliberately hostile one — the trust level `bash` already
  granted. A Telegram timeout while posting the draft is not proof it
  failed: keep its row pending, report the uncertainty with its draft id,
  and do not post it again automatically. If the buttons landed, their
  callback can settle the row even without a bound message id; if they
  did not land, the pending row expires after 24 hours. The operator
  checks Telegram before requesting a replacement draft.
- **Watcher ownership and shutdown.** One mail watcher may own a programs
  store object at a time. Stop fences new scans immediately and joins
  existing work; later ticks only join that work or do nothing. Duplicate
  starts throw until the stop promise settles, when a new owner is legal.
- **Mail is a program trigger.** A program may carry a `mail` filter
  (Gmail query, e.g. `from:bank is:important`) beside its cron and
  webhook. An in-process ticker (the scheduler's twin, 5 min) runs each
  enabled filter through gws since the program's last seen history id
  (stored on the row); each new match fires the program through the one
  firing path — `[program: <name> · trigger: mail]` + charter + `<event>`
  (from, subject, date, snippet, id; the body is one wrapper-read away,
  never pushed) + the injection verdict line. A new or changed filter
  baselines at the current head without firing — the mailbox's backlog is
  history, not arrivals; an expired cursor re-baselines the same way. The
  row has a dedicated `mail_revision INTEGER NOT NULL DEFAULT 0`: filter
  changes and re-enables increment it when clearing the cursor. Baselines
  compare the original revision, filter, cursor and enabled state in one
  conditional SQL update, so an in-flight Gmail head cannot survive a
  disable/re-enable ABA (even across DB connections). Existing rows gain
  the column additively; `created_at` remains creation time, not a
  generation. The 60 s per-program throttle is a batch: matches inside
  one tick fire once with all of them, capped at 10 oldest-first per tick
  — the checkpoint advances only to the last fired record's boundary, so
  the unfired remainder refires next tick instead of being skipped (a
  single collapsed record over the cap is the one honest skip, and it
  warns). A fire that does not land holds the checkpoint the same way —
  its matches retry next poll, and the write follows the submit, so a
  crash between the two re-fires a batch rather than dropping it
  (at-least-once). An empty poll,
  or one whose program was disabled mid-flight, consumes the checkpoint —
  that mail is skipped, not owed (the cron rule). The checkpoint write is
  a CAS on `mail_revision` (ruling 2026-10-04): the fire's snapshot
  carries the revision it scanned, and a filter edit or re-enable that
  lands mid-flight bumps the revision and re-baselines — the stale fire's
  checkpoint loses the write, logs, and still stamps `last_run` (the fire
  itself landed). The write-time half of the read-time re-read rule
  below. Final admission re-reads the row after the gate scores the
  event (ruling 2026-10-08, #81): a disable or delete that lands mid-gate
  fences the submit itself — no turn lands on revoked authority — and a
  mid-gate disable consumes the checkpoint under the snapshot CAS
  (skipped, not owed). Filter edits and re-enables deliberately keep
  landing the old fire; only the checkpoint loses that race. The filter's
  50-entry list page is the intersection window; a full page warns that
  older matches may be invisible to it. After each poll the watcher
  re-reads the program row — a disable, delete, or filter edit that lands
  mid-poll wins over the stale snapshot, and an edited filter keeps its
  re-baseline. A dead token or quota error warns once per outage episode,
  never per tick.
- **Approved sends join shutdown (ruling 2026-10-04).** The approval gate's
  stop clears the sweep timer and awaits any in-flight Gmail send, inside
  the process shutdown's drain budget — a SIGTERM mid-send would otherwise
  kill the send before its verdict lands, leaving the row pending and
  un-stamped, so a later re-tap (or the sweep's expiry stamp, after the
  fuse) decides on stale information. The crash window (power loss,
  kill -9) remains accepted; graceful shutdown no longer shares it.
- **Mail's reads ride the shared System One gate** (`design/system1.md`) —
  one client, its models, retry policy, config block and loopback endpoint
  live there; the read-path injection checker is one of its consumers.
  When no client exists (see the config coupling there), the loopback
  route 503s and watcher events fire unscored. The wrapper follows
  `goblin.json5`'s `http.port` automatically (`GOBLIN_MAIL_PORT`
  overrides; a wrong override warns and reads fail open). The `goblin-mail`
  shim (`$GOBLIN_HOME/goblin-mail` → `scripts/goblin-mail`, boot-repointed
  symlink, never clobbers a real file) and the `gws` skill
  (`deploy/skills/gws/SKILL.md`, seeded write-if-absent) are the model's
  contract: reads ONLY through the wrapper, never raw `+read`; `gws`
  discovery beyond mail (drive / calendar / sheets) rides the same CLI and
  scopes.
- **Logging**: every gws/Gmail call (action, query or id, exit code or
  status, ms — never bodies); every injection check (verdict,
  probabilities, ms) and every served loopback check (verdict, ms); every
  outbox transition (queued, sent, cancelled, expired — recipient domain,
  never the body).
