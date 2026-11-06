> Audited 2026-10-23 17:45 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 12 — Mail (send gate, outbox, gws adapter, watcher, injection, wrapper)

Read-and-report hunt per `/tmp/goblin-hunts/hunt-12.txt`. Static reading
only — per the operator override, no suite/typecheck runs were made; the
orchestrator's clean pass (typecheck both programs, 4686/0/86 across 254
files) is taken as given for this unchanged tree. No scratch execution
was needed: every finding below is provable from source plus the
colocated tests that already exercise the paths.

Checklist source: `design/mail.md` (all sections), file headers of
`src/mail-outbox.ts` and `src/injection.ts`, AGENTS.md Guardrails.

## 1. Findings (most severe first)

### P2-1 — Expiry sweep silently swallows lane settle rejections (fail-loud violation)

- **Where:** `src/mail-approval.ts:216-218` —
  `await Promise.allSettled(rows.map((row) => laneFor(row).settle(row, ...)))`
  with the results discarded: no inspection, no log, no rethrow.
- **Violated rule:** AGENTS.md → Guardrails — "**Fail loud.** … Never
  swallow an exception." Every other error path in this module logs.
- **Triggering path:** the production app lane's `settle` throws by
  design when its conversation is gone: `src/app-approvals.ts:52-57`
  (`append` throws `mail draft N is not addressed to an app
  conversation` when `store.get(conversationId) === null`), and
  `index.ts:448` wires `app: makeAppMailLane(store)`. Delete the app
  conversation (project delete) while one of its mail drafts is still
  pending; when the draft lapses, `expireDue` decides the row (state is
  correct) and then `settle` throws into `allSettled` and vanishes. The
  telegram lane catches internally (`src/tg/mail-approval.ts:168-175`),
  so today this is app-lane-only — but the module's own contract says
  lanes are interchangeable, and any lane bug lands in the same hole.
- **Impact:** small blast radius (the stamp goes to a conversation that
  no longer exists), but the swallow is structural: an entire error path
  with zero observability, which the log bar ("a screenshot of weird
  behavior plus the log file must fully reconstruct what the process
  did") fails.
- **Test sketch:** expired pending row + app lane whose store `get`
  returns null → run `sweep()` → currently no error surfaces anywhere;
  expected a `log.warn/error("mail expiry settle failed", …)` line (or
  per-row settle error logging like `requestDraft` does for present).

### P2-2 — Search-index lag permanently skips arrivals the checkpoint advances past (design's loss-channel inventory is incomplete)

- **Where:** `src/mail-gws.ts:332-372` — `matched = matching.filter(id =>
  added.has(id))`; when the batch is not truncated the checkpoint
  returns `latest` (the mailbox head), past every history record —
  including records whose arrivals the filter's `messages.list?q=`
  never showed.
- **Violated rule:** `design/mail.md` → "Mail is a program trigger":
  "the checkpoint advances only to the last fired record's boundary, so
  the unfired remainder refires next poll instead of being skipped …
  (at-least-once)", and "A fire that does not land holds the checkpoint
  — matches retry next poll". An arrival present in `history.list` but
  not yet visible to the `q` search (Gmail's search index lags history
  by seconds to minutes) is excluded from `matched`, never fires, and
  the head checkpoint then advances past its record — the next poll's
  `startHistoryId` excludes it forever. Silent, permanent loss.
- **Honest framing:** the doc names the intersection blindness itself
  and sanctions one flavor — "a full page warns older matches may be
  invisible to it (the one remaining loss channel)" — but index lag is
  the *same* blindness with a different cause, and it is neither warned
  nor documented. Code cannot distinguish lag from a genuine non-match
  (`added.size > 0 && matched empty` is the normal noise-arrival case,
  so a naive warn would fire constantly), which is exactly why this
  belongs in the doc's honest-boundary list rather than a code patch.
- **Unverified premise (labeled):** the actual magnitude/frequency of
  Gmail `q`-search index lag vs the 5-minute poll spacing — not
  measurable from this tree; the mechanism makes the loss possible
  whenever lag crosses one poll.
- **Test sketch:** `makeGwsReader` fake where history returns one
  record (message `m`) with head `H`, and `messages.list` returns `[]`
  (lag) → `poll()` returns `{hits: [], historyId: H}` with no warn —
  assert the gap is at least surfaced (or the doc updated to own it).

### P3 findings (invariant hygiene)

1. **`src/mail-approval.ts:148`** — `deps.outbox.decide(row.id,
   "cancelled", new Date())` uses wall clock while `decide`/`sweep`
   use `deps.now?.() ?? new Date()` (lines 168, 208). Test-seam
   inconsistency only; no behavior bug.
2. **`src/mail.ts:171-174`** — the OAuth token response (external
   boundary) is parsed via `(data as Record<string, unknown>)` +
   `str()` + empty check, not zod (AGENTS Guardrail: "Validate external
   input with zod at boundaries"). Fails loud today on a missing
   token, but the cast survives shape drift an `access_token: 123`
   (numeric) would pass `str()`… would return "" and throw — still
   loud. Hygiene only.
3. **Empty-string drift class in `src/mail-gws.ts`** — load-bearing
   leaves accept `""` and then collapse silently, the exact
   "masquerade as success" class the file header (lines 48-52) says
   must throw: `historyPageSchema.historyId` is `z.string()` (line 70)
   so `historyId: ""` passes and `latest = body.historyId || latest`
   (line 276) treats it as absent — an empty first page yields
   checkpoint `""`; `m.message.id === ""` is skipped from the batch
   (lines 280-282) with the record's boundary still crossed;
   `threadFor` maps `threadId: ""` to `null` = "message gone" (lines
   424-425), a false operator-facing verdict on drift. `.min(1)` on the
   three leaves closes the class.
4. **`src/mail-gws.ts:36-42`** — `defaultRunner` drops
   `truncated`/`outputCapped` from `boundedRun`'s result: a 1 MiB
   stdout cap kill surfaces as `failed — exit -1` or `returned
   non-JSON` instead of naming the cap. Loud but misdiagnosed;
   `timedOut` gets exactly this treatment one line below.
5. **`src/mail-gws.ts:148-158`** — `apiCode()` hand-parses gws stdout
   (external boundary) without zod. Deliberately tolerant with a safe
   `""` fallback (callers match only exact codes); hygiene note only.
6. **`scripts/goblin-mail:152-154`** — max validation rejects
   non-digits but accepts `0`, while the message says "positive
   integer"; `search q 5 extra` / `read id extra` silently ignore
   extra argv (lines 148-162). No quoting hazard found anywhere in the
   script.
7. **`src/mail.ts:285-300`** — `buildRaw` performs no CRLF defense at
   the MIME boundary (`Subject: ${…}`, `To: ${draft.to.join(", ")}`,
   `In-Reply-To: ${draft.inReplyTo}`). The model-facing path is closed
   upstream — `src/agent/tools/mail.ts:4-10` rejects `[\r\n]` in
   subjects and `z.email()` for to/cc (hunt 10's file, checked only
   for exploitability) — and the app channel never queues drafts
   (only `pending()`/`decide`, `src/http/app-shared.ts:49`). Residual
   lead (unverified): `inReplyTo` is sourced from the replied mail's
   `Message-ID` header (`mail-gws.ts:426`) and interpolated unvalidated;
   if Gmail's API ever returns a value carrying CR/LF, that is header
   injection from untrusted mail content at send time. Assumed
   canonicalized by Google; not verifiable from here.
8. **`src/mail-approval.ts:173`** — the `busy` branch returns the
   stale pre-send `row` snapshot; cosmetic (transports render a
   "busy" notice from it).

## 2. Checked and clean (later passes can skip)

- **Send is operator-gated by mechanism.** `requestDraft` only
  queue+present (`mail-approval.ts:120-157`); only `decide` reaches
  `sendApproved`; `outbox.decide` is a pending-only CAS
  (`mail-outbox.ts:178-179`, tested `mail-outbox.test.ts:108-119`);
  the row is decided *after* Gmail accepts (`mail-approval.ts:306`),
  matching the accepted crash window in design/mail.md → "Send is
  operator-gated by mechanism". Authorization of the actor lives in the
  callers (tg door / app-shared), out of scope by pointer.
- **No send/tap/sweep race window.** The whole preamble of `decide`
  (get → status → inFlight → expiry → cancel CAS) to `inFlight.set`
  (`mail-approval.ts:165-204`) contains no event-loop yield, so the
  sweep timer can never observe a pending-but-unregistered in-flight
  send; `expireDue`'s exclude callback is exactly `inFlight.has(id)`,
  tested (`mail-outbox.test.ts:140-154`).
- **Rows survive restarts; pending stays tappable.** SQLite WAL +
  reopen test (`mail-outbox.test.ts:83-106`); pre-target migration
  preserves undecided rows (`:41-81`); Telegram buttons keep working
  post-restart via `draftMessageId`, app via `pending()` card.
- **Token minted per call, never cached, never logged**
  (`mail.ts:135-177`); log lines carry action/domains/counts/ms only.
  Audited every `log.*` call in all six source files: no bodies,
  subjects, or addresses beyond sanctioned recipient domains
  (`domainOf`) and filter queries (`mail-gws.ts` header sanctions
  `filter`). The settle/draft *messages* carrying to/subject go to the
  operator's own approval surface, which is the sanctioned UI.
- **Injection checker never grants or exercises write scope.**
  `injection.ts` only calls `gate.decide` on already-fetched text;
  `http/check.ts` is a loopback-only, POST, no-store endpoint with a
  503-unconfigured arm and 64 KiB/64 k caps — exactly matching the
  wrapper's comments. `gws` is never invoked from the checker path.
- **Fail-open is narrow.** `checkInjection` returns "unavailable" only
  on `System1Error`, everything else propagates (`injection.ts:74-79`,
  tested); thresholds 0.3/0.7 and all verdict strings match
  design/mail.md → "Every read is injection-checked and fenced"
  (tested in `injection.test.ts` and `mail-watcher.test.ts:294-329`
  through the real `fireMail`). The *script's* broader fail-open
  (curl/HTTP/unparsable → unavailable) is design-sanctioned ("on any
  gate outage: fail-open").
- **gws wire parsing.** Every success surface is zod-parsed through
  `parseOrThrow` → `ProviderError`; non-zero exits carry the *parsed*
  API code, and a failure that merely mentions "404" in stderr is
  correctly NOT treated as expiry (`mail-gws.ts:270-274` + tests
  `mail-gws.test.ts:274-289`); 404-only re-baseline for history and
  reply-target; pagination loop guard; whole-record batching at the cap
  with record-boundary checkpoint; collapsed-record burst fires
  cap-many, skips, and warns (tested, matching design's "one honest
  skip"); empty poll advances the checkpoint with no list call
  (matches the cron rule).
- **Watcher loop resilience and ownership.** Scan preamble guarded
  (reader/withMailFilter throws → `mail scan failed` error line, not a
  bare rejection); per-program episodes warn once per error message,
  recover silently, re-warn on change (tested
  `mail-watcher.test.ts:357-387`); single-flight latch cannot wedge
  (the synchronous-completion bug is documented at
  `mail-watcher.ts:116-121` and regression-tested); duplicate starts
  throw until stop settles (WeakSet, `:95-101`, tested); stop fences
  new scans and joins in-flight work (tested `:604-631`); mid-poll
  delete/edit/disable and expired-cursor re-baseline all match the
  design's CAS/revision rulings (tested extensively).
- **Outage notice routing follows the destination union**
  (2026-10-22 ruling): responsibility-bound → coordination lane as a
  durable development via the wake dispatcher record; chat-pinned →
  Telegram (`mail-watcher.ts:61-91`, tested `:663-760`); missing
  responsibility skips loudly.
- **Approved sends join shutdown** (2026-10-04 ruling):
  `stop()` clears the sweep timer and `Promise.allSettled`-joins
  in-flight sends (`mail-approval.ts:232-241`).
- **The shell script.** All expansions quoted; the query/max/id ride
  single argv entries; the fence neutralizes case-insensitive `</mail`
  (tested with a `</MAIL>` payload); failure paths echo gws's stderr
  and exit codes but never the body (asserted
  `goblin-mail.test.ts:149,161`); checker port resolution
  (GOBLIN_MAIL_PORT → goblin.json5 http.port → 8787) matches the
  server default (`config.ts:970-972`) with skew/parse warnings; the
  verdict wire field (`.verdict`) matches
  `http/check.ts`'s `InjectionCheckResponse`.

## 3. Couldn't verify / leads without a written source

- **Gmail search-index lag magnitude** (P2-2's premise) — not
  measurable from this tree; labeled as such above.
- **Whether Gmail's API can return header values containing CR/LF**
  (P3-7's `inReplyTo` lead) — Google-side canonicalization assumed,
  no source found in-repo.
- **Operator-authorization of the send tap** lives in
  `src/tg/mail-approval.ts` (hunt 1) and the app approvals door
  (`app-shared.ts`, `app-auth.ts`) — pointers only per the brief.
  In-scope modules take `actor` as a neutral parameter, correctly.
- **Final admission re-read after the gate scores the event**
  (design ruling 2026-10-08, #81) lives in `scheduler.fireMail` — out
  of scope; the watcher tests exercise the real `fireMail` and the
  verdict-line behavior holds there.
- **1 MiB gws output cap vs real mailbox history pages** — live-only
  question; the failure mode is loud (see P3-4) either way.
- **SQLite WAL synchronous mode vs power loss** for "rows survive
  restarts": process restart/kill -9 durability is solid; OS-crash
  durability depends on SQLite's sync mode, which the AGENTS
  durable-writes guardrail (whole-file/JSONL) does not address — no
  written ruling found either way; not counted as a finding.
- **`bun test` / typecheck** not run per the operator override;
  findings rest on static reading plus the suite's green pass as
  reported by the orchestrator.

## Simplifications & code smells (P3-level, evidence-backed)

1. **Duplicated `MailPoller` interface** — `src/mail-watcher.ts:15-19`
   re-declares verbatim what `src/mail.ts:55-66` already exports
   (doc comments included), while the watcher *already* imports
   `MailHit`/`ThreadContext` from `mail.ts` (line 6) and the test
   file imports `MailPoller` from `./mail.ts` itself
   (`mail-watcher.test.ts:12`). The "structural, not nominal" seam is
   unaffected by importing the type — mail.ts is not the adapter
   module (mail-gws.ts is). **Most valuable simplification.**
2. **Stale stacked doc comment on `GwsApiError`** —
   `src/mail-gws.ts:130-137` carries two full JSDoc blocks back to
   back; the first ("The API error code gws carried on stdout, if
   any…") is a leftover draft superseded by the second. Dead text on
   the boundary's most subtle type.
3. **`parseOrThrow` duplicated** — `src/mail.ts:242-251` and
   `src/mail-gws.ts:107-116` are the same function modulo the provider
   tag; one shared helper (or moving it next to `ProviderError` in
   `agent/tools/web.ts`, which both already import) removes the twin.
4. **`HistoryExpiredError` lives in the send module** —
   `src/mail.ts:74-79` defines a read-side signal that is thrown only
   by `mail-gws.ts:271` and caught only by `mail-watcher.ts:207`; its
   home in the OAuth send client misdirects readers (it also forces
   the watcher to import from the send path).
5. **Dual destination representation in `OutboxEntry`** — `target`
   plus the derived `chatId`/`threadId` projection
   (`mail-outbox.ts:30-32,121-122`); documented as legacy transport
   projection, but nothing in the scoped files needs the projection —
   the two lanes both re-derive from `target`.
6. **`makeSender` one-method facade** — `src/mail.ts:81-86` wraps the
   `Gmail` class solely to expose `send`; a plain async function (or
   exporting the class method) would do without the wrapper object.
7. **Misleading validation message** — `scripts/goblin-mail:153` says
   "positive integer" while accepting `0` (also P3-6): the message
   promises a constraint the code doesn't enforce.
