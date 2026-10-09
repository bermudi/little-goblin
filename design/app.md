# App channel — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## App channel (PWA → APK)

Ruling 2026-09-30, operator ask. Telegram stops being the only channel:
goblin grows a second, disjoint one — the app.

**Why.** The operator's reading pains live in Telegram's client, not in
goblin: long replies read as 4096-chunked fragments, topic lists desync
between devices (a client cache bug goblin cannot fix), and Mini Apps
cold-start in 4-5s on Android — that is Telegram's WebView container, not
our payload (BotFather's own app is equally slow, which is the proof).
Arrival is fine where it is; reading moves.

**The shape: disjoint channels.** Two conversation pools, one store. A
conversation is born on the surface where it starts and stays there —
Telegram conversations deliver to Telegram exactly as before, app
conversations (`app/<id>`) stream to the app. No mirroring, no fan-out,
no cross-surface reading: routing is decided by the address kind alone.
The channels share the turn loop, tools, config, memories, skills — and
nothing else. Deliberately dumber than the aliasing and mirroring
proposals considered and rejected in the same conversation: the moment
"where does this answer appear" has any answer longer than "where you
asked", the operator has to think before reading, and that thinking is
the bug.

**Protocol: the store already speaks it.** History is UIMessage JSON
(envelope v1); the turn loop already produces a UIMessage stream
(`toUIMessageStream`) that the Telegram sink consumes today. The app
endpoints pipe what exists: history reads serve stored UIMessages
verbatim, chat requests run a turn and stream the same shape. Store
format = wire format — no translation layer to design, drift, or test
twice. `POST /api/app/conversations/<id>/stop` rides `runtime.stop` —
the same epoch bump + abort the Telegram `/stop` command owns — so the
client's Stop button ends the turn server-side, not just its stream.

**Auth.** No Telegram `initData` exists outside Telegram. The app
channel's lock is a bearer token on `/api/app/*` — optional since
2026-09-30 by operator ruling, on the collie precedent: device-level
trust — tailscale proves the device — with no person-level auth.
`appToken` in config names an auth.jsonl record — config stays
secret-free per the Config invariant — and the mode resolves once per
process at boot (boot-pinned: a mid-run `appToken` flip applies only
after restart, `onConfigWritten` warns). Set → bearer required: the
record resolves per request through the same `resolve()` every other
credential rides (pass-keys `!command` records included); a wrong or
missing token → 401, an unresolvable record → 503 — both logged.
Rotating a record's value needs a restart, because `loadAuth` is a
boot-time snapshot and `resolve` memoizes per name. Unset → trust
mode: `/api/app/*` serves unauthenticated — the tailnet is the only
lock. Boot logs the mode either way, and trust mode adds a warn that
is the guardrail: **funnel is a misconfiguration** — if `publicUrl`
ever points at a funnel address (public HTTPS), a token becomes
MANDATORY; the warn line exists to catch it. The mini app keeps its
initData validation untouched.

**Trust mode's browser-origin line (ruling 2026-10-08, #75).**
Reachability proves the device, not the page: any site the operator's
browser visits could fire no-cors POSTs — `text/plain` bodies, no CORS
preflight, response never read — straight at `/api/app/*`, creating
conversations and submitting agent turns. Trust mode therefore refuses
*mutations* that speak a browser origin other than ours: `Origin` must
match the request's own Host (either scheme — TLS ends at the front,
and a proxy may preserve or rewrite it) or the configured `publicUrl`'s
origin — `tailscale serve` rewrites Host to the local upstream, so the
public origin is the match that survives the proxy. `Sec-Fetch-Site`
rides alongside (`same-site` refuses too — tailscale fronts share the
ts.net suffix). Browsers always stamp mutations with these headers;
non-browser clients send neither and pass untouched — reachability
stays their whole check, the model above unchanged. Bearer mode never
runs the gate: the token is the check, and a token-holding non-browser
client (a future APK's webview) must not depend on browser headers.
JSON-body routes additionally require `content-type: application/json`
in both modes — a claim a cross-origin page cannot make without a
preflight this server never grants.

**Intentional origin trade-off.** The Host-derived allowance is proxy
compatibility, not an independent proof that a browser origin is trusted.
Accepting both schemes and the request's Host lets direct/local access and
proxies that preserve or rewrite Host coexist with TLS termination; the
configured `publicUrl` origin also works when the proxy replaces Host with
the upstream address. Pinning browser origins solely to `publicUrl` would
be a different access policy, not a tightening with no operational cost.

This leaves a **DNS rebinding risk** in trust mode: an attacker-controlled
hostname can resolve to a reachable Goblin endpoint while both `Origin`
and Host still name the attacker hostname. That request can look
same-origin, so neither this gate nor JSON preflight blocks it. Tailnet
reachability is the intended outer boundary, but an operator's browser
inside that boundary can be the bridge. Browser private-network protections
vary by browser/version and address classification; Safari in particular
must not be assumed to enforce Chromium-style Private Network Access
preflights, and private-network permission prompts or restrictions are not
a portable defense against rebinding. This gate blocks ordinary cross-site
mutations, not all hostile browser access. Trust mode intentionally accepts
that residual risk for proxy/direct-access compatibility; operators needing
an authentication boundary use bearer mode. A pinned-origin/Host policy
would need a separate ruling here.

**Client.** React + `@ai-sdk/react` (`useChat`) in `app/` — Vite, strict
TS, its own tsconfig program wired into `bun run typecheck`. This is the
recorded amendment to the no-build rule: `src/http/app.js` (the settings
mini app) keeps the ships-as-served treatment forever; the app client is
a built artifact because React is the price of the SDK's chat pieces, and
built artifacts are allowed exactly there and nowhere else. `src/http`
serves `app/dist` under `/app/`; a missing build is a fail-loud 500 with
a log line, never a silent empty page. Tool activity renders as an
expandable "Worked" row (pattern lifted from openclaw's app — mechanism
only, zero code adopted).

**Packaging ladder.** PWA first, on the tailnet URL through the existing
`tailscale serve` door — manifest + service worker make it installable
(home-screen icon, ~1s open, zero APK churn while iterating; the operator
evaluated twenty-APK development and declined). APK via Capacitor when
stable: same build output wrapped, plus the Android share-target intent —
the thing PWAs cannot do (Android's share sheet lists only real installed
apps, observed 2026-09-30) — and later FCM if push is ever demanded. TWA
is rejected on mechanism: Google's assetlinks verification cannot pass on
a tailnet-only domain. PWA and APK are one channel in two shells; nothing
in the server knows which is talking.

**Logging.** The app boundary joins the existing bar: intake (message →
app address), auth failures, stream start/finish, attachment uploads —
each a line with the fields to reconstruct it from `goblin.log`.

**Landing note.** The channel landed in three staged commits behind the
gate "existing telegram tests pass unmodified". The gate means no
pre-existing assertion was modified or removed; additive assertions
inside existing files are allowed (the address round-trip test gained
its `app/` rejection line in place, `src/tg/notify.test.ts`).

**Out, explicitly:** mirroring or cross-channel reading of any kind
(revisit needs a ruling here — Spin-off below is the one ruled
crossing, and it is a copy plus a bell, not mirroring), app-side push
(Telegram stays the bell for its own conversations and, since Spin-off,
for app background turns; app-native push waits until demanded),
widgets, in-app voice mode, iOS.

## Streaming members & resumable streams (ruling 2026-10-04)

The reply belongs to the conversation, not to the connection that
submitted. Two defects shared that root (audit 2026-10-04): a second
client submitting mid-turn received an empty stream — chunks went to
the turn's first member only — and a reload mid-turn showed a
finished-looking chat whose next send steered a ghost turn (#43).

- **Chunk fan-out.** Every *streaming* member of a turn receives the
  chunks; delta-style hooks (text/reasoning/tool) stay the head's —
  Telegram delivery is one message per turn, and the app sink ignores
  them anyway. A throwing streaming sink is detached, never fatal to
  the turn. `claimableCount` is unchanged: a streaming head still
  claims the whole queue — one burst, one reply.
- **Join replay.** A member that attaches mid-turn (steering) first
  receives everything the wire already saw — from sentence one, not
  mid-thought. The turn keeps a wire log (exactly what was emitted,
  held failures excluded), carried across overflow recovery so the
  resumed attempt continues the same wire seamlessly.
- **Attach endpoint.** `GET /api/app/conversations/<id>/stream` serves
  the wire log + a live tail; 204 when no turn is running (the AI
  SDK's `reconnectToStream` contract — the client falls back to
  history). The client runs `useChat({ resume: true })` with
  `prepareReconnectToStreamRequest` pointing here, so a reload
  mid-turn re-watches the in-flight reply (#43 closed by the same
  mechanism). The log is in-memory, live turns only: after a crash
  there is history and no stream, exactly as before.
- **Idle reconnect reconciles (#79).** The 204 is more than "no
  stream": the runtime persists a turn's reply before it retires the
  wire, so an idle answer also promises durable history is final for
  every reply that could have been live when the client snapshotted
  it. A reply completing inside the reload window [history fetch →
  reconnect] used to stay hidden until the next reopen — the SDK
  leaves the stale snapshot standing. The client therefore re-reads
  history once when its resume comes back idle (the transport is the
  only seam that can see the SDK's null) and merges by message id:
  store arrivals slot in, a live local tail — a racing send, the
  streaming assistant — is never dropped. The server-side ordering
  (204 never precedes durability) is pinned by test.
- **Parked, with a trigger.** A *passive* screen (no submit, no
  reload) still doesn't live-update — `resumeStream()` on focus would
  ride the same endpoint as client policy alone. Promote when
  outer-loop usage makes "app open on a screen while turns happen" a
  daily pattern; the server machinery is already in place. Until
  then this stays the deliberate descendant of the "live refresh out
  of scope" ruling in Spin-off.

## Model/thinking scope (ruling 2026-10-06)

Each app conversation snapshots root config `model` and `thinking` when
created and retains both until the operator changes that conversation.
New HTTP conversations, lazy runtime-created rows, and Telegram spin-offs
all use **app defaults**, never Telegram's selection. Spin-off copies
history and memory policy, not the source channel's model settings.
Existing null app settings initialize once from current defaults at boot;
settings/default HTTP saves also initialize missing snapshots before
changing defaults. Values live in the existing SQLite `model`/`thinking`
columns and survive restarts, idempotent creates, and default edits.

`GET/PATCH /api/app/conversations/<id>/config` returns `AppConfigView`
(model, thinking, favorites, supported thinking levels). Patches validate
thinking vocabulary and provider refs, require an existing app row, and
never create rows or expose Telegram settings. Favorites/provider registry
remain shared configuration, not per-conversation copies. Removing a
provider still selected by an app conversation is refused with 422 and
the affected conversation ids; change those conversations' models first.
Validation precedes any snapshot/config mutation. PATCH rereads the live
registry and row after body intake, so a concurrent delete yields 404.

`GET/PATCH /api/app/config` edits root app defaults **only for future
conversations**; POST remains a compatibility alias. The Telegram settings
mini app can edit these defaults and the independent Telegram selection.
Its whole-file writes preserve both scopes and Telegram transport settings.

Changes apply at the **next admitted turn**, not the next model step:
no epoch bump, abort, or interrupted answer. Running turns (including
steered input, overflow retries and their compactions) keep their captured
model/thinking. Queued successors use the latest conversation selection;
manual compaction resolves settings when its lane job runs. Changing model
legitimately makes the next turn's prompt cache cold.

## Spin-off (ruling 2026-10-03)

Operator ask, paired with Rolling DM: the DM is the quick lane, so
durable work — something that runs, reports back later, and gets
followed up on — gets a durable, named home in the app instead of
landing in whatever rolling conversation happens to be current when
the result arrives.

**Trigger: automatic, on delegation launch from the DM.** When the
`delegate` tool launches from a rolling-DM conversation (operator ask
or goblin's own judgment), the spin-off happens — no model choice, no
command. Nothing else triggers it: scheduled programs post into the
DM like any message (a fire is self-contained; see Programs), group
topics keep their delegations, and a delegation launched from an app
conversation stays in that conversation.

**A copy, not a move.** Moving the conversation would strand the
operator's next DM message ("also make it use bun") — either its
answer appears in the app, not where it was asked, or the DM starts
blank. So at launch Goblin creates an app conversation seeded with a
copy of the DM conversation's model view so far (compaction summary +
tail, as stored). The two diverge from that moment and are never
synced. The delegation pins to the app conversation. It is titled
by `titleModel` from the copied exchange (fallback: the delegation's
name), renameable in the app like any other. The tool result hands
the model the title and link, so the DM reply says where the work
went; the DM conversation carries on as the quick lane.

**Background turns.** Delegation notices (done, blocked, a question
from the harness) wake turns in the app conversation with a headless
sink: the turn runs and persists exactly like a client-driven one
(turns already outlive a disconnected client), with nothing streaming.
The app shows them on next open; live refresh of an already-open
conversation is out of scope. The app channel gains the `delegate`
tool for this — the reason it was withheld (results wake a Telegram
sink the app lacks) is what background turns answer. `program` and
`mail` stay Telegram-only.

**Telegram rings.** Every completed background turn sends a DM ping:
`<title>: <head of the reply, ≤200 chars>` plus a link that opens that
conversation. The ping is appended to the *current* DM conversation as
an assistant event — what the operator sees in the chat is history, so
"what was that about?" in the DM is answerable — and it counts as
activity for the gap rule. A swipe-reply to a ping goes to the app
conversation instead (submitted headless, so it rings back when
answered), and the DM acknowledges with `sent to <title>` (delivery
only, logged). The ping → app-conversation mapping is durable
(SQLite, keyed by the ping's message id), so a reply after a restart
still routes.

**Links.** `{publicUrl}/app/c/<appId>` opens one conversation; the
server serves the client for that path. When the APK lands it claims
links under `/app/`. Unverified until then: Android's automatic link
claiming needs Google to verify the domain, which cannot reach a
tailnet-only host (the same wall that rejected TWA), so expect a
one-time "open supported links" toggle in Android settings.

**Logging.** `spin-off` (from DM conversation, to app conversation,
delegation, title); `app background turn` (conversation, trigger,
outcome); `spin-off ping` (app conversation, ping message id);
`ping reply routed` (ping message id → app conversation).


**Landing rulings (stage 2, 2026-10-03).** Settled while building:
- *Who gets rung:* every `allowedUsers` id, as a private chat, the way
  webhook URLs travel (`sendPrivate`). One operator today, so one ping.
- *App-pinned delegation rows* store `chat_id = 0, thread_id = NULL`
  plus `app_conversation`. Notices for them go through `wakeApp`. If
  the operator deleted the conversation, the notice is dropped with a
  warning, so the scan doesn't retry it forever.
- *Naming:* the fork is titled with the delegation's name straight
  away (that name is what the DM reply quotes), then `titleModel`
  retitles it in the background. An operator rename always wins.
- *A launch that doesn't start* (cap reached, failed) deletes the fork.
- *The ack goes once per replying chat* — coalescing can merge
  replies from more than one operator.
- *Deep links:* the client applies `/app/c/<id>` once, after the first
  list load; an unknown id falls back to `/app/`. Selecting a
  conversation keeps the URL in sync.

## The app wire must never idle — SSE heartbeat

Ruling 2026-10-07, from a failed operator turn. Symptom: the app
showed "The turn failed: Error in input stream" mid-turn while the
log insisted `app stream finish: completed` — the turn had actually
finished fine, streamed into a socket the client no longer had.

**Cause, verified on the box (bun 1.4.2).** `Bun.serve` closes
connections that send no bytes for its `idleTimeout` — 10s by
default: a silent SSE response died at exactly +10.0s in a scratch
repro, while one emitting comment pings every 5s survived the full
25s. Tool calls (`git clone`, long diffs) silence the UIMessage
stream for tens of seconds; the first >10s silence of that turn
(06:59:49Z) killed the wire at ~07:00:00Z, 3 minutes before the turn
ended. The writer swallowed every subsequent enqueue failure
(`catch { closed = true }`), so the server logged nothing — the
fail-loud rule broken at exactly the moment it mattered.

**The rules.**

- `appSseWriter` heartbeats: an SSE comment line (`: ping`) pushed
  after 5s of wire silence. Comments are skipped by spec parsers and
  by `eventsource-parser` (the AI SDK client's — it checks
  `firstCharCode === 58`), so the wire stays warm without touching
  the UIMessage stream. The mini app never reads this stream (it
  polls), so nothing else sees them. The silence check samples 4x per
  window — a tick period equal to the threshold phase-locks with
  arriving chunks and never fires.
- `Bun.serve` sets `idleTimeout: 255` (the max) — a ceiling behind
  the heartbeat, not a substitute for it.
- Wire death is loud, turn death is not: `cancel()` (client gone) and
  the enqueue catch (controller closed by Bun) each log a warn with
  the conversation. The turn itself keeps running by design —
  durable history plus the resumable attach stream mean a reload
  re-watches the in-flight turn. Only the wire is lost, and now it
  says so.

## Archiving (ruling 2026-10-09)

Archive replaces delete as the rail's declutter action. An archived
conversation keeps everything — history, FTS hits, settings, pings,
`/app/c/<id>` deep links; `archived_at` on the row is a list-visibility
stamp, nothing more. PATCH on the conversation carries
`{title?, archived?}` (at least one required); the list payload hands
back `archivedAt` per summary and the client splits the pools — active
rail on top, a collapsed "Archived (n)" section below, ordered by
shelf time. Delete keeps its confirm and its endpoint but only exists
on archived rows: the rail offers archive, the archive offers delete.

Two consequences follow from the flag being visibility-only. Archiving
never fences a live turn (unlike DELETE's `runtime.stop`) — the turn
finishes into history either way. And **any appended event
auto-unarchives**: `store.append` clears `archived_at` when set, so a
delegation notice landing in a shelved spin-off or a message sent into
one via its ping link brings the row back to the rail instead of
accumulating replies unseen. Unarchiving through the client writes the
same NULL directly.
