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
`POST /api/app/conversations/<id>/compact` rides `runtime.compact` the
same way (ruling 2026-10-16): the manual lever lives in the context
gauge's popover, not a composer command grammar — the app channel
parses no slash commands, its controls are routes plus buttons. The
request awaits the lane job, so a running turn completing first shows
up as a slow response; the gauge numbers are the last turn's usage, so
the popover reports the fold as its own line rather than pretending
the readout moved.

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
TS, its own tsconfig program wired into `bun run typecheck`. The client
is the tree's only built artifact (React is the price of the SDK's chat
pieces) — everything else ships as served. `src/http` serves `app/dist`
under `/app/`, and the Telegram door mounts the same bundle under `/t/`
(design/telegram.md → Mini Apps); a missing build is a fail-loud 500
with a log line, never a silent empty page. Tool activity renders as an
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


**Out, explicitly:** mirroring or cross-channel reading of any kind
(revisit needs a ruling here — Spin-off below is the one ruled
crossing, and it is a copy plus a bell, not mirroring), app-side push
(Telegram stays the bell for its own conversations and, since Spin-off,
for app background turns; app-native push waits until demanded),
home-screen widgets, in-app voice mode, iOS. (In-transcript interface
blocks are a different thing — Intelligent UI below.)

## Operator console in the PWA (ruling 2026-10-09)

Operator ask: the PWA becomes the operations surface — full settings,
the memory browser, and read-only delegations/programs/service status —
because Telegram is the wrong client for long reads and state edits.

**One operator surface, two doors.** `src/http/operator.ts` owns the
handlers; the mini app mounts them under `/api/*` behind initData and
the app channel mounts the same tails under `/api/app/*` behind
bearer/trust. Both end at the same validation and persistence — zod
parsing, the If-Match etag, the serialized save queue, the
fresh-from-disk merge — so a write through either door lands
identically. The
one behavioral difference is the self-lockout guard: the mini app
refuses to remove the *requesting* Telegram id from `operators`;
the app door has no requester, so it refuses an empty `operators`
list. Wire types
live in `src/http/operator-wire.ts`, a leaf module both clients
typecheck against (the mini app re-imports them through `mod.ts`; the
React client imports them directly).

**Routes.** `/app/settings`, `/app/memory`, `/app/delegations`,
`/app/programs`, `/app/status` are deep links — `mod.ts` serves them
the app shell, the client routes internally (same mechanism as
`/app/c/<id>`). API tails: `settings` (GET/POST), `thinking-levels`,
`memory/status`, `memory/documents[/id]` (GET/DELETE), `programs`,
`delegations`, `status`.

**State viewer (ruling 2026-10-11, operator ask).** The console gains a
read-only view over the rest of `$GOBLIN_HOME` — the human-meaningful
set: skills (installed and proposed), workspace files (SOUL/USER/AGENTS),
attachments, and the log. Deliberately out, forever: `auth.jsonl` (no
route may ever render it, structure included) and any editing surface
beyond what the console already has — the viewer reads state; writes
stay where they are. The wall is two layers that each hold alone: the
router zod-validates every name/path/param — a name is one segment and
a skill-relative path is a `/`-joined run of segments, where a segment
is any non-empty run without separators or controls and not exactly
`.` or `..` (spaces, parens, dots and Unicode are ordinary names) —
and `src/stateview.ts`
re-verifies containment in **realpath space** (every component —
including symlinked files and linked parent directories — resolves to
its target before the prefix check), so neither lexical traversal nor
symlink indirection can carry a read outside the tree. Ruling on
symlinks: symlinked skill dirs don't list and can't be read (the agent
catalog's sanctioned link-following in design/skills.md is a different
consumer and untouched). The named directory must be a real directory
contained by the catalog root before it becomes the file read's base;
realpathing a linked skill as the base would otherwise trust its outside
target. A file or nested-directory link resolving back inside its skill
base serves, because the bytes never leave the tree. Listed file paths
are skill-relative and pass unchanged to the file reader. The log is a
bounded server-side tail —
512 KiB window from the end, ≤1000 lines, level and substring filters
applied server-side — so the client never pulls the whole file and a
raw-log dump cannot ride a wide-open query. Attachment bytes ride their
own route with a conservative content-type map (svg deliberately
absent — it downloads instead of rendering same-origin), a serve cap
equal to the upload cap, and the read-back route's inert-byte headers
(nosniff, sandbox CSP, attachment disposition for non-media). Client
side, an attachment's object URL is owned by the row's lifecycle, not
by render state (ruling 2026-10-13, finding #19): a fetch resolving
after unmount mints nothing, unmount revokes whatever was minted
whether it rendered or not, and an in-flight click can't start a
second fetch. Tails:
`skills`, `skills/file`, `attachments`, `attachments/file`, `identity`,
`log`; pages `/app/skills`, `/app/files`, `/app/log`. The tails mount
on both doors like the rest of the console — `/api/app/attachments` is
dual-mounted method-aware (GET → viewer, POST → the composer's upload);
the mini app does not get the pages (`TELEGRAM_PAGES` stays
settings/memory). Mount points are pinned by door-level tests in
`app-channel.test.ts`, because handler-level tests pass even when a
tail is mounted nowhere. The settings editor lives in `app/src`
(`settingsDraft.ts`, `SettingsView.tsx`) and is the only settings UI —
the Telegram door renders this client's telegram mode
(design/telegram.md → Mini Apps, ruling 2026-10-10). The contract is
`ConfigPostBody`
(`operator-wire.ts`) plus the server's zod validation; the shared
`operator.ts` handlers keep the doors from drifting, not client-side
mirroring. Leaving dirty settings asks before discarding, including browser
Back/Forward; declining restores the history position without adding
an entry, using native Navigation API keys or our indexed history.
For legacy unindexed entries or gaps in a browser without Navigation
API, direction/distance cannot be recovered: retain the draft and show a warning,
never overwrite history or guess a traversal direction. A dirty-only
`beforeunload` guard covers cross-document departures. "Dirty" for all
of these is the departure flag, not the serialized diff alone (ruling
2026-10-13, finding #15): a provider name still sitting in its card's
blur-commit field is draft state no serialized field can see, so each
card reports its divergence up and the flag is `serialized dirty OR
any pending name`, keyed by the provider's render id and discharged on
commit, invalid/no-op restore, or card unmount. While any name is
pending the autosave is held — a write would land everything except
the half-typed name yet announce "Saved" — and the explicit Save
refuses for the same reason; the savebar discloses the pending name.
Committing a valid rename is ordinary serialized dirty: it autosaves
and the guard clears on the ack.
Async creation does not retain navigation authority after its dialog or
page is dismissed: project creation and both note indexes fence late
completion, while navigation guards consult the currently mounted page
rather than a captured page. Conversation starts have a synchronous
single-flight guard before advancing their sequence; "Chat with this
note" awaits that start and keeps its busy guard until it settles.
A start fenced by navigation deletes its unselected server row; cleanup
failure is visible. Composer sends restore only into their originating
composer, never over newer text. Note-originated starts restore no draft
or chips: attaching that note was an action, not a composer draft.
Memory pagination belongs to the loaded filter, not the
search box's pending text, and waits for replacement loads to finish.
The memory view is the Memories tab's browser plus status polling;
forget asks `window.confirm` then rides the server's centralized
forget protocol (`channel: "app"`).

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
- **The composer steers (2026-10-16).** Send never locks mid-turn —
  it posts beside Stop, and the lane steers or queues the message
  exactly like Telegram. The client drops its reader first
  (`stop()` locally, never the `/stop` endpoint), so the new POST's
  join replay is the only writer and lands on the same assistant
  message id — a handoff, not a forked transcript. An aborted reader
  is not a finished reply: it doesn't ring the done bell.

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
- *Who gets rung:* every `operators` id, as a private chat, the way
  webhook URLs travel (`sendPrivate`) — one ping per operator account.
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
`{title?, archived?, pinned?}` (at least one required); the list payload hands
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

## Pinning (ruling 2026-10-10)

Pin is the rail's anchor action, the complement to archive's
declutter: `pinned_at` on the row floats a conversation above the
activity stream, so a slow thread the operator always wants reachable
stops sinking. The PATCH carries `pinned?` and the list payload hands
back `pinnedAt` per summary; `listAppConversations` sorts pinned rows
first and the client partitions the active rail the same way — pinned
group on top, activity order preserved within each group, so pinning
changes which group a row is in, never its position inside it.

The flag's two rules mirror archive's, inverted. **Pins survive
activity** — an appended event never clears one, the anchor being the
point (the exact opposite of archive's auto-unarchive). And
**archiving clears the pin** (store-side, in `setMeta`): a row hidden
from the rail can't be anchored above it, and unarchive must not
resurrect a stale pin.

The row affordances are three icon actions — pin · rename · archive
on active rows, rename · unarchive · delete on archived ones
(icons, not labels — the 15.5rem rail cannot fit labeled buttons,
ruling 2026-10-10; the glyphs carry aria-label and title so the
accessible contract holds). The icons share the row's
preview line, and the line resolves the collision spatially: on hover
the text itself fades out just before the icons' stretch — a mask on
the text, never a backdrop behind the icons — while the rest of the
line stays full-contrast. Untitled rows fade their head line the same
way. Touch screens never hover, so the current row keeps its actions
showing over the faded line. A persistent pushpin marker on pinned
rows still keeps the top slot explaining itself. Pinning never fences
a turn and never touches selection: it is list order, nothing more.

## Thread sources (ruling 2026-10-16, operator ask)

On a conversation, everything that conversation produced — visible
in place, not by digging through global tabs. The chat header gains
one action (icon + aria-label; the header's first) opening a sheet
with two sections:

- **Retained exchanges** — `GET
  /api/memory/documents?conversation=` (the filter ruling in
  design/memory.md → Memories browser), the same paginated rows and
detail/facts/forget affordances as the Memories tab, from components
shared with it, not duplicated.
- **Skills from this thread** — `GET /api/skills/from?conversation=`
  (provenance ruling in design/skills.md → Skill provenance),
  read-only: name, state (installed / proposed / gone), when first
  written here. Approve/discard stays conversational/Telegram; the
  sheet never mutates skills.

App conversations only, by the channel rule: Telegram threads keep
the global Memories tab — per-thread views of them would be
cross-surface reading. A spin-off fork shows only what it retained
itself; the copied history retains under its source conversation.

## Intelligent UI (ruling 2026-10-09)

Operator ask, after OpenAI's GPT-6 "Intelligent UI" launch (2026-10-07):
answers that are interfaces — a comparison side by side, a timeline, a
chart, a tappable choice, a small calculator — rendered in the
transcript instead of described in prose. Classified **chat-native for
the app channel**: it is how an answer renders, not a second system.
It stays chat-native only while it is stateless — no saved or
re-openable "apps", no artifact store, no state that outlives the
message. That line is machinery and needs its own ruling.

**Mechanism: a component tree, not HTML.** One tool, `ui`, mounted on
app conversations only (Telegram never sees it; guests never see it).
The model's tool *input is the interface*: `{title?, blocks[]}`,
zod-validated, from a fixed library of native components rendered by
the app with its own design tokens. `execute` validates and returns a
one-line ack — nothing runs. Store format = wire format holds: the
tool part already persists in UIMessage history, so reload, resume,
spin-off copies and history all carry the UI for free, and the model
sees its own past interface as its own past tool call.

- **Library (v1):** leaves — `text` (markdown), `callout`, `stats`,
  `table`, `steps`, `chart` (bar/line/pie, hand-drawn SVG with native
  `<title>` tooltips; a pie's slices are the first series' values
  labelled by `x` — extra series ignored, values non-negative),
  `choices`, `form` (fields `text`, `number`, `select`, `checkbox`,
  `textarea`, `date` — every value serializes into the `[ui]` submit
  line; checkboxes submit `true`/`false`), `html`; containers — `tabs`,
  `columns`, whose children are
  leaves only. **Two levels, no recursion**: a recursive zod schema
  emits `$ref`/`$defs` in the tool's JSON Schema, which
  OpenAI-compatible providers handle unevenly, and a schema a
  provider rejects breaks every app turn. A test pins "no `$ref`".
- **Progressive render.** The AI SDK surfaces partially parsed tool
  input in the `input-streaming` state; the client renders every
  block that already validates and a skeleton for the one still
  arriving — the "compiler" from OpenAI's post, for free. This needs
  the provider to stream tool-input deltas; without them the UI
  lands whole when the call completes, which is a degraded mode, not
  a failure.
- **Placement.** `ui` parts render inline in the message flow, never
  inside the Worked fold; a validation failure renders as the normal
  tool error row.
- **Type repair, both sides.** Probed live, `zai/glm-5.3-flash` broke
  9 of 22 comparison-style answers, mostly by dropping a block's `type`
  discriminator (typically the last `choices`, sometimes followed by a
  stray bare `{type}` fragment); after repair 3 of 22 still failed.
  `normalizeUiInput` (shared, in `ui-schema.ts`) re-types a typeless
  object by exact key-set match — every key declared by the
  candidate, and the candidate parsing — with "fewest declared keys"
  as the tiebreak and a tie meaning no repair; bare `{type}`
  fragments drop. The server validates the repaired value (the wire
  JSON Schema stays the SDK's verbatim zod conversion), and the client
  renders through the same function, so history renders exactly as
  the server accepted it. Invented key names (`callout_md`) are not
  repaired — they fail validation, the model sees the tool error and
  may retry. Repairs log `ui input repaired`, failures `ui input
  invalid`.
- **Judgment lives in the description.** Goblin's models are prompted,
  not trained for this: the tool description says text is the
  default and names when layout carries meaning. One environment line
  in the system prompt points at it when the tool is in the set.

**Interaction, two tiers.** Local state (tabs, form inputs) stays in
React and never reaches the server. Actions — a `choices` button, a
`form` submit — post an ordinary, *visible* user message
(`[ui] <label>` / `[ui] <submit>: field=value, …`) through the same
`sendMessage` the composer uses, so the transcript never lies about
what was chosen and the reply rides the normal turn. Actions are
disabled while a turn is running. No client-side tools: turns run
server-side and outlive the client, and a turn parked on a browser
round-trip would hang with the tab closed.

**Escape hatch: `html`.** For answers that need computation — a bill
splitter, a savings calculator, a small game — the `html` leaf
renders model-written HTML in `<iframe sandbox="allow-scripts"
srcdoc>`, never `allow-same-origin`, with an injected CSP meta
(`default-src 'none'; script-src 'unsafe-inline'; style-src
'unsafe-inline'; img-src data:; base-uri 'none'`) and a minimal base
stylesheet from the app's tokens. `base-uri 'none'` keeps a static or
script-inserted `<base href>` inert, so no URL-resolution path in the
document can ever be retargeted. The opaque origin cannot read the app's token,
storage or DOM; its mutations reach `/api/app/*` as `Origin: null` /
cross-site and the trust-mode gate refuses them; reads lack CORS.
Height is reported by an injected resize script via `postMessage`,
accepted only from that iframe's own window and clamped. Rendered
only once the input is complete — HTML does not stream usefully.
Navigations out of the frame are neutralized at the source (ruling
2026-10-10): CSP governs fetches, never navigations, and a navigated
frame sheds the injected CSP while keeping `allow-scripts` — network
egress plus rendering inside the app's trusted chrome. Meta refresh
is stripped in `srcdoc()` and the injected capture-phase click guard
cancels every anchor click — a `#fragment` href is re-expressed as the
document's own `location.hash`, an in-place update that never resolves
through `<base>` or the embedding URL; popups and forms are
already dead under the sandbox flags. **Accepted residual:** a
direct `location` assignment from script can still navigate the
frame — un-interceptable from inside the document — so the `html`
leaf stays a prompt-injection surface; the operator treats any frame
that suddenly renders a foreign page as a signal the model was
injected, same as any odd message text.

**Cache.** The tool joins app conversations' tool sets at deploy:
one cold prefix per live app conversation, same as any new tool.
Their frozen prompt snapshots keep the old "Tools:" line until the
next boundary (roll, compaction); the tool's own description carries
the guidance meanwhile.

**Logging.** The tool call line carries block count and kinds; an
`html` block logs its byte size.
