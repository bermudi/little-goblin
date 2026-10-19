# App channel — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## App channel (PWA → APK)

Ruling 2026-09-30, operator ask: a second, disjoint channel beside
Telegram — the app.

### Files

`src/http/app-*.ts`: `app-channel.ts` dispatches the door (auth call, the
operator dual-mount, route dispatch, 404) and re-exports the pre-split names
(`handleAppApi`, `resolveAppAuth`, `AppChannelDeps`); `app-auth.ts` resolves
boot mode and runs the per-request gate (bearer, trust mode's browser-origin
line); `app-sse.ts` the SSE wire (writer, heartbeat, stream sink);
`app-shared.ts` the deps contract and both-ends pieces (`NO_STORE`,
`jsonBodyRefusal`, `configView`, `configPatchBody`); route families in
`app-conversations.ts`, `app-projects.ts`, `app-notes.ts`, `app-config.ts`,
`app-chat.ts`, `app-attachments.ts`. Colocated tests over `app-testing.ts`
(real-listener rig, model faked at the provider edge; test-only).

**Why.** Telegram's client is wrong for reading: 4096-chunked replies, topic
lists desyncing between devices (a client cache bug goblin cannot fix), Mini Apps
cold-starting in 4-5s on Android — the WebView container, not our payload.
Arrival is fine; reading moves.

**The shape: disjoint channels.** Two conversation pools, one store; a
conversation is born where it starts and stays there. Telegram delivers to
Telegram exactly as before; app conversations (`app/<id>`) stream to the
app. No mirroring, no fan-out, no cross-surface reading — routing is the
address kind alone. The channels share the turn loop, tools, config,
memories, skills — nothing else. No aliasing: once "where does this answer
appear" has any answer longer than "where you asked", the thinking is the
bug.

**Protocol: the store already speaks it.** History is UIMessage JSON
(envelope v1); the turn loop already produces a UIMessage stream
(`toUIMessageStream`) the Telegram sink consumes. The endpoints pipe what
exists: history reads serve stored UIMessages verbatim, chat requests run a
turn and stream the same shape — store format = wire format, no translation
layer to design, drift, or test twice.
`POST /api/app/conversations/<id>/stop` rides `runtime.stop` — the epoch
bump + abort the Telegram `/stop` owns — so Stop ends the turn server-side,
not just its stream. `POST /api/app/conversations/<id>/compact` rides
`runtime.compact` the same way (ruling 2026-10-16): the manual lever lives
in the context gauge's popover, not a composer command grammar — the app
parses no slash commands, its controls are routes plus buttons. The request
awaits the lane job (a finishing turn reads as a slow response); the gauge
shows last turn's usage, so the popover reports the fold as its own line.

**Auth.** No `initData` exists outside Telegram. The lock is a bearer token
on `/api/app/*` — optional since 2026-09-30 by operator ruling, on the
collie precedent: device-level trust (tailscale proves the device), no
person-level auth. `appToken` names an auth.jsonl record — config stays
secret-free per the Config invariant — and the mode resolves once per
process at boot: boot-pinned, so a mid-run flip applies only after restart
(`onConfigWritten` warns). Set → bearer required; the record resolves per
request through the same `resolve()` every credential rides (pass-keys
`!command` included); a wrong or missing token → 401, an unresolvable
record → 503, both logged. Rotating a value needs a restart (`loadAuth` is
a boot snapshot, `resolve` memoizes per name). Unset → trust mode:
`/api/app/*` serves unauthenticated — the tailnet is the only lock. Boot
logs the mode; trust mode adds the guardrail warn: **funnel is a
misconfiguration** — a `publicUrl` pointing at a funnel address (public
HTTPS) makes a token MANDATORY. The mini app keeps its initData validation
untouched.

**Trust mode's browser-origin line (ruling 2026-10-08, #75).**
Reachability proves the device, not the page: any site the operator's
browser visits could fire no-cors POSTs — `text/plain` bodies, no CORS
preflight, response never read — at `/api/app/*`, creating conversations
and submitting turns. Trust mode therefore refuses *mutations* speaking a
foreign browser origin: `Origin` must match the request's own Host (either
scheme — TLS ends at the front; a proxy may preserve or rewrite it) or the
configured `publicUrl`'s origin (`tailscale serve` rewrites Host to the
local upstream, so the public origin is the match that survives the proxy).
`Sec-Fetch-Site` rides alongside (`same-site` refuses too — tailscale
fronts share the ts.net suffix). Browsers always stamp mutations with these
headers; non-browser clients send neither and pass untouched — reachability
stays their whole check. Bearer mode never runs the gate (the token is the
check; a token-holding non-browser client — a future APK's webview — must
not depend on browser headers). JSON-body routes additionally require
`content-type: application/json` in both modes — a claim a cross-origin
page cannot make without a preflight this server never grants.

**Intentional origin trade-off.** The request's own Host is accepted for
proxy compatibility, not as independent proof of a trusted browser origin;
pinning origins solely to `publicUrl` would be a different access policy,
not a free tightening.

Trust mode leaves a **DNS rebinding risk**: an attacker-controlled hostname
resolving to a reachable goblin endpoint while both `Origin` and Host name
it looks same-origin, so neither gate nor JSON preflight blocks it. Tailnet
reachability is the intended outer boundary, but a browser inside it can be
the bridge; private-network protections vary by browser/version and address
class (Safari must not be assumed to enforce Chromium-style Private Network
Access preflights), and prompts are not portable. The gate blocks ordinary
cross-site mutations, not all hostile browser access; trust mode
intentionally accepts this residual risk for proxy/direct-access
compatibility, and operators needing an authentication boundary use bearer
mode. A stricter pinned-origin/Host policy needs its own ruling.

**Client.** React + `@ai-sdk/react` (`useChat`) in `app/` — Vite, strict TS,
its own tsconfig program wired into `bun run typecheck`; the tree's only
built artifact (React is the price of the SDK's chat pieces). `src/http`
serves `app/dist` under `/app/`, the Telegram door the same bundle under
`/t/` (design/telegram.md → Mini Apps); a missing build is a fail-loud 500
plus log line, never a silent empty page. Tool calls and thoughts render as
one expandable "Worked" row per contiguous run — folded by default, opening
while a call is live (openclaw's mechanism only, zero code).

**Packaging ladder.** PWA first, on the tailnet URL through `tailscale serve`
— manifest + service worker make it installable (home-screen icon, ~1s open,
zero APK churn; the operator evaluated twenty-APK development and declined).
APK via Capacitor when stable: same build wrapped, plus the Android
share-target intent — what PWAs cannot do (the share sheet lists only
installed apps, observed 2026-09-30) — and later FCM if push is demanded.
TWA is rejected on mechanism: assetlinks verification cannot pass on a
tailnet-only domain. PWA and APK are one channel in two shells; the server
can't tell which talks.

**Logging.** The app boundary joins the existing bar: intake (message → app
address), auth failures, stream start/finish, attachment uploads — each a
line with the fields to reconstruct it from `goblin.log`.


**Out, explicitly:** mirroring or cross-channel reading of any kind (revisit
needs a ruling here — Spin-off is the one ruled crossing: a copy plus a
bell, not mirroring), app-side push (Telegram stays the bell for its own
conversations and, since Spin-off, app background turns; app-native push
waits until demanded), home-screen widgets, in-app voice mode, iOS.
(In-transcript interface blocks are a different thing — Intelligent UI
below.)

## Operator console in the PWA (ruling 2026-10-09)

Operator ask: the PWA becomes the operations surface — full settings, the
memory browser, read-only delegations/programs/service status — because
Telegram is the wrong client for long reads and state edits.

**One operator surface, two doors.** `src/http/operator.ts` owns the
handlers; the mini app mounts them under `/api/*` behind initData, the app
channel the same tails under `/api/app/*` behind bearer/trust. Both end at
the same validation and persistence — zod parsing, the If-Match etag, the
serialized save queue, the fresh-from-disk merge — so a write through either
door lands identically. One behavioral difference, the self-lockout guard:
the mini app refuses to remove the *requesting* Telegram id from
`operators`; the app door has no requester, so it refuses an empty
`operators` list. Wire types live in `src/http/operator-wire.ts`, a leaf
both clients typecheck against (the mini app re-imports through `mod.ts`;
the React client imports directly).

**Routes.** `/app/settings`, `/app/memory`, `/app/delegations`,
`/app/programs`, `/app/status` are deep links — `mod.ts` serves them the app
shell, the client routes internally (same mechanism as `/app/c/<id>`). API
tails: `settings` (GET/POST), `thinking-levels`, `memory/status`,
`memory/documents[/id]` (GET/DELETE), `programs`, `delegations`, `status`.

**State viewer (ruling 2026-10-11, operator ask).** A read-only view of
`$GOBLIN_HOME` beyond the console: skills (installed and proposed),
workspace files (SOUL/USER/AGENTS), attachments, the log. Out, forever:
`auth.jsonl` (no route may ever render it, structure included) and editing
beyond the console's own — reads, never writes. Two layers, each sufficient:
router zod validation of every name/path/param (a name is one segment; a
skill-relative path `/`-joined segments, each non-empty without separators
or controls, not `.` or `..` — spaces, parens, dots, Unicode ordinary), then
`src/stateview.ts` containment in **realpath space** (every component,
symlinks and linked parents included, resolved before the prefix check), so
neither lexical traversal nor symlink indirection escapes. Symlinked skill
dirs don't list and can't be read (design/skills.md's catalog link-following
is a different consumer); the base directory must be a real directory
contained by the catalog root (realpathing a linked skill as base would
trust its outside target). A file or nested-directory link resolving back
inside its skill base serves — the bytes stay in the tree. Listed paths are
skill-relative, passed unchanged to the reader. The log is a bounded
server-side tail: 512 KiB from the end, ≤1000 lines, level and substring
filters server-side (no whole-file pull; no wide-open dump). Attachments
ride their own route: conservative content-type map (svg absent — it
downloads rather than renders same-origin), serve cap equal to upload cap,
read-back route's inert-byte headers (nosniff, sandbox CSP, attachment
disposition for non-media). Client-side, an attachment's object URL belongs
to the row's lifecycle, not render state (ruling 2026-10-13, finding #19):
a fetch resolving after unmount mints nothing; unmount revokes whatever was
minted; an in-flight click can't start a second fetch. Tails: `skills`,
`skills/file`, `attachments`, `attachments/file`, `identity`, `log`; pages
`/app/skills`, `/app/files`, `/app/log`. Tails mount on both doors —
`/api/app/attachments` dual-mounted method-aware (GET → viewer, POST → the
composer's upload); the mini app gets no pages (`TELEGRAM_PAGES` stays
settings/memory); mount points are pinned by door-level tests in
`app-channel.test.ts`, since handler-level tests pass with a tail mounted
nowhere. Settings editor: `app/src` (`settingsDraft.ts`, `SettingsView.tsx`),
the only settings UI — the Telegram door renders its telegram mode
(design/telegram.md → Mini Apps, ruling 2026-10-10); contract
`ConfigPostBody` (`operator-wire.ts`) + server zod, shared `operator.ts`
handlers preventing drift. Dirty settings ask before discarding, browser
Back/Forward included; declining restores the position without an entry
(native Navigation API keys or indexed history). Legacy unindexed entries or
gaps without Navigation API can't recover direction/distance: retain the
draft and warn, never overwrite history or guess. A dirty-only
`beforeunload` guard covers cross-document departures. "Dirty" is the
departure flag, not the serialized diff (ruling 2026-10-13, finding #15): a
blur-commit provider name is draft state no serialized field sees, so cards
report divergence and the flag is `serialized dirty OR any pending name`,
keyed by render id, discharged on commit, invalid/no-op restore, or card
unmount. Pending name holds autosave (a write would land everything but the
half-typed name yet say "Saved") and refuses explicit Save; the savebar
discloses it. A valid rename autosaves; the guard clears on the ack. Async
creation retains no navigation authority after dismissal: project creation
and both note indexes fence late completion; guards consult the mounted
page, not a captured one. Conversation starts single-flight before
advancing their sequence; "Chat with this note" awaits the start, busy
until it settles. A fenced start deletes its unselected server row; cleanup
failure is visible. Composer restores go only into their originating
composer, never over newer text; note-originated starts restore no draft or
chips (attaching was an action, not a draft). Memory pagination belongs to
the loaded filter, not pending search text, and waits for replacement
loads. The memory view is the Memories tab's browser plus status polling;
forget asks `window.confirm` then rides the server's centralized protocol
(`channel: "app"`).

## Streaming members & resumable streams (ruling 2026-10-04)

The reply belongs to the conversation, not the connection that submitted.
Two defects shared that root (audit 2026-10-04): a second client submitting
mid-turn received an empty stream — chunks went to the turn's first member
only — and a reload mid-turn showed a finished-looking chat whose next send
steered a ghost turn (#43).

- **Chunk fan-out.** Every *streaming* member of a turn receives the chunks;
  delta-style hooks (text/reasoning/tool) stay the head's — Telegram delivery
  is one message per turn and the app sink ignores them. A throwing streaming
  sink is detached, never fatal. `claimableCount` is unchanged: a streaming
  head claims the whole queue — one burst, one reply.
- **Join replay.** A member attaching mid-turn (steering) first receives
  everything the wire already saw — from sentence one. The turn keeps a wire
  log (exactly what was emitted, held failures excluded), carried across
  overflow recovery so the resumed attempt continues the same wire.
- **Attach endpoint.** `GET /api/app/conversations/<id>/stream` serves the
  wire log + a live tail; 204 when no turn is running (the AI SDK's
  `reconnectToStream` contract — the client falls back to history). The
  client runs `useChat({ resume: true })` with
  `prepareReconnectToStreamRequest` pointing here, so a reload mid-turn
  re-watches the in-flight reply (#43). The log is in-memory, live turns
  only: after a crash there is history and no stream.
- **Idle reconnect reconciles (#79).** The 204 is more than "no stream": the
  runtime persists a turn's reply before it retires the wire, so an idle
  answer promises durable history is final for every reply that could have
  been live at snapshot — a reply completing inside the reload window
  [history fetch → reconnect] would otherwise stay hidden, the SDK leaving
  the stale snapshot standing. So the client re-reads history once on an
  idle resume (the transport is the only seam that sees the SDK's null) and
  merges by message id: store arrivals slot in, a live local tail (racing
  send, streaming assistant) is never dropped. Server ordering — 204 never
  precedes durability — is pinned by test.
- **Parked, with a trigger.** A *passive* screen (no submit, no reload)
  still doesn't live-update; `resumeStream()` on focus would ride the same
  endpoint as client policy alone. Promote when outer-loop usage makes "app
  open while turns happen" a daily pattern — the server machinery is already
  in place. Until then this stays the descendant of Spin-off's "live refresh
  out of scope".
- **The composer steers (2026-10-16).** Send never locks mid-turn — it posts
  beside Stop, and the lane steers or queues exactly like Telegram. The
  client drops its reader first (`stop()` locally, never the `/stop`
  endpoint), so the new POST's join replay is the only writer and lands on
  the same assistant message id — a handoff, not a forked transcript. An
  aborted reader doesn't ring the done bell.

## Model/thinking scope (ruling 2026-10-06)

Each app conversation snapshots root config `model` and `thinking` at
creation and retains both until the operator changes that conversation. New
HTTP conversations, lazy runtime-created rows, and Telegram spin-offs all
use **app defaults**, never Telegram's selection; Spin-off copies history
and memory policy, not the source channel's model settings. Existing null
app settings initialize once from current defaults at boot; settings/default
HTTP saves also initialize missing snapshots before changing defaults.
Values live in the existing SQLite `model`/`thinking` columns and survive
restarts, idempotent creates, and default edits.

`GET/PATCH /api/app/conversations/<id>/config` returns `AppConfigView`
(model, thinking, favorites, supported thinking levels). Patches validate
thinking vocabulary and provider refs, require an existing app row, and
never create rows or expose Telegram settings. Favorites/provider registry
remain shared configuration, not per-conversation copies. Removing a
provider still selected by an app conversation is refused with 422 and the
affected conversation ids; change those conversations' models first.
Validation precedes any snapshot/config mutation. PATCH rereads the live
registry and row after body intake, so a concurrent delete yields 404.

`GET/PATCH /api/app/config` edits root app defaults **only for future
conversations**; POST remains a compatibility alias. The Telegram settings
mini app can edit these defaults and the independent Telegram selection;
its whole-file writes preserve both scopes and Telegram transport settings.

Changes apply at the **next admitted turn**, not the next model step: no
epoch bump, abort, or interrupted answer. Running turns (steered input,
overflow retries, their compactions) keep their captured model/thinking;
queued successors use the latest conversation selection; manual compaction
resolves settings when its lane job runs. Changing model legitimately makes
the next turn's prompt cache cold.

## Spin-off (ruling 2026-10-03)

Operator ask, paired with Rolling DM: the DM is the quick lane, so durable
work — something that runs, reports back later, gets followed up on — needs
a durable, named home in the app.

**Trigger: automatic, on delegation launch from the DM.** A `delegate` call
launched from a rolling-DM conversation (operator ask or goblin's judgment)
spins off — no model choice, no command. Nothing else triggers it: scheduled
programs post into the DM like any message (a fire is self-contained; see
Programs), group topics keep their delegations, and an app-conversation
delegation stays put.

**A copy, not a move.** Moving would strand the operator's next DM message
("also make it use bun") — its answer appearing in the app, not where it
was asked, or the DM starting blank. At launch goblin seeds an app
conversation with a copy of the DM's model view so far (compaction summary
+ tail, as stored); the two diverge and are never synced. The delegation
pins to the app conversation, titled by `titleModel` from the copied
exchange (fallback: the delegation's name), renameable like any other. The
tool result hands the model the title and link, so the DM reply says where
the work went; the DM carries on as the quick lane.

**Background turns.** Delegation notices (done, blocked, a question from the
harness) wake turns in the app conversation with a headless sink: the turn
runs and persists like a client-driven one, nothing streaming. The app
shows them on next open; live refresh of an open conversation is out of
scope. The app channel gains the `delegate` tool — the reason it was
withheld (results wake a Telegram sink the app lacks) is what background
turns answer. `program` and `mail` stay Telegram-only.

**Telegram rings.** Every completed background turn sends a DM ping —
`<title>: <head of the reply, ≤200 chars>` plus a link — appended to the
*current* DM conversation as an assistant event (what the operator sees in
the chat is history, so "what was that about?" is answerable) and counted
as activity for the gap rule. A swipe-reply goes to the app conversation
instead (submitted headless, so it rings back when answered) and the DM
acknowledges with `sent to <title>` (delivery only, logged). The ping →
app-conversation mapping is durable (SQLite, keyed by the ping's message
id), so a reply after a restart still routes.

**Links.** `{publicUrl}/app/c/<appId>` opens one conversation (the server
serves the client for that path); the APK will claim links under `/app/`.
Unverified until then: Android's automatic link claiming needs Google domain
verification, which cannot reach a tailnet-only host (the same wall as
TWA), so expect a one-time "open supported links" toggle.

**Logging.** `spin-off` (from DM conversation, to app conversation,
delegation, title); `app background turn` (conversation, trigger, outcome);
`spin-off ping` (app conversation, ping message id); `ping reply routed`
(ping message id → app conversation).

**Landing rulings (stage 2, 2026-10-03).** Settled while building:
- *Who gets rung:* every `operators` id, as a private chat, the way webhook
  URLs travel (`sendPrivate`) — one ping per operator account.
- *App-pinned delegation rows* store `chat_id = 0, thread_id = NULL` plus
  `app_conversation`; notices go through `wakeApp`. If the operator deleted
  the conversation, the notice is dropped with a warning, so the scan
  doesn't retry forever.
- *Naming:* the fork is titled with the delegation's name straight away
  (what the DM reply quotes), then `titleModel` retitles it in the
  background; an operator rename always wins.
- *A launch that doesn't start* (cap reached, failed) deletes the fork.
- *The ack goes once per replying chat* — coalescing can merge replies from
  more than one operator.
- *Deep links:* the client applies `/app/c/<id>` once, after the first list
  load; an unknown id falls back to `/app/`. Selecting a conversation keeps
  the URL in sync.

## The app wire must never idle — SSE heartbeat

Ruling 2026-10-07, from a failed operator turn: the app showed "The turn
failed: Error in input stream" mid-turn while the log insisted
`app stream finish: completed` — the turn had finished, streamed into a
socket the client no longer had.

**Cause (probe-verified on the box, bun 1.4.2).** `Bun.serve` closes
connections that send no bytes for its `idleTimeout` — 10s by default: a
silent SSE died at exactly +10.0s in a scratch repro, while comment pings
every 5s survived the full 25s. Tool calls (`git clone`, long diffs) silence
the UIMessage stream for tens of seconds; the turn's first >10s silence
killed the wire 3 minutes before it ended. The writer swallowed every later
enqueue failure (`catch { closed = true }`) — fail-loud broken.

**The rules.**

- `appSseWriter` heartbeats: an SSE comment line (`: ping`) after 5s of
  wire silence. Comments are skipped by spec parsers and by
  `eventsource-parser` (the AI SDK client's — it checks
  `firstCharCode === 58`), so the wire stays warm without touching the
  UIMessage stream; the mini app polls and never reads it. The silence check
  samples 4x per window — a tick period equal to the threshold phase-locks
  with arriving chunks and never fires.
- `Bun.serve` sets `idleTimeout: 255` (the max) — a ceiling behind the
  heartbeat, not a substitute.
- Wire death is loud, turn death is not: `cancel()` (client gone) and the
  enqueue catch (controller closed by Bun) each log a warn with the
  conversation. The turn keeps running by design — durable history plus the
  resumable attach stream mean a reload re-watches it; only the wire is
  lost, and now it says so.

## Interrupted turn recovery (ruling 2026-10-17)

A crash leaves a turn `interrupted` in the journal (design/runtime-turn.md →
The turn journal). The app surfaces those runs where they died —
`InterruptedTurns` at the transcript tail (scrolls with history, never eats
composer height), fed by `GET /api/app/conversations/<id>/interrupted` on
mount and on the busy→idle transition.

The contract mirrors the Telegram `/decide` / `/resume` surface:

- **Decisions are explicit.** Each `dispatched` call shows its tool name, a
  bounded args preview (journal text, long inputs truncated), and three
  buttons: Record result (asserts an outcome the operator already knows — it
  becomes the replayable result), Authorize retry (re-executes; effects may
  repeat), Skip (the call never runs; a re-ask reads back the refusal). An
  optional note rides `record-result` as the asserted output and
  `authorize-retry`/`skip` as free context. Settled calls render read-only
  with their recorded result/error/decision note.
- **Resume is gated server-side.** The button stays disabled while any call
  is `dispatched`; `POST .../resume` 409s with the undecided calls and the
  client refetches rather than trusting its copy. A 200 admits a FRESH run;
  the client drops the acknowledged source locally and calls `resumeStream()`
  — the attach endpoint's 204 path reconciles durable history by message id,
  so fast completions appear and live turns re-watch.
- **No optimistic mutation.** Nothing is marked decided before the server's
  ack; errors show the server's reason verbatim.

## Archiving (ruling 2026-10-09)

Archive replaces delete as the rail's declutter action. An archived
conversation keeps everything — history, FTS hits, settings, pings,
`/app/c/<id>` deep links; `archived_at` on the row is a list-visibility
stamp, nothing more. PATCH carries `{title?, archived?, pinned?}` (at least
one required); the list payload hands back `archivedAt` per summary and the
client splits the pools — active rail on top, a collapsed "Archived (n)"
section below, ordered by shelf time. Delete keeps its confirm and endpoint
but only on archived rows: the rail offers archive, the archive offers
delete.

Two consequences follow from visibility-only. Archiving never fences a live
turn (unlike DELETE's `runtime.stop`) — the turn finishes into history
either way. And **any appended event auto-unarchives**: `store.append`
clears `archived_at` when set, so a delegation notice landing in a shelved
spin-off or a message sent via its ping link brings the row back to the rail
instead of accumulating replies unseen. Unarchiving writes the same NULL
directly.

## Pinning (ruling 2026-10-10)

Pin is the rail's anchor action, archive's complement: `pinned_at` floats a
conversation above the activity stream, so a slow thread the operator always
wants reachable stops sinking. The PATCH carries `pinned?` and the list
payload hands back `pinnedAt` per summary; `listAppConversations` sorts
pinned first and the client partitions the active rail the same way — pinned
group on top, activity order preserved within each group, so pinning changes
a row's group, never its position inside it.

The flag's two rules mirror archive's, inverted. **Pins survive activity** —
an appended event never clears one, the anchor being the point (the exact
opposite of archive's auto-unarchive). **Archiving clears the pin**
(store-side, in `setMeta`): a row hidden from the rail can't be anchored
above it, and unarchive must not resurrect a stale pin.

The row affordances are three icons — pin · rename · archive on active rows,
rename · unarchive · delete on archived ones (icons, not labels — the
15.5rem rail cannot fit labeled buttons, ruling 2026-10-10; glyphs carry
aria-label and title). The icons share the row's preview line: on hover the
text fades out just before the icons' stretch — a mask on the text, never a
backdrop behind them — while the rest of the line stays full-contrast;
untitled rows fade their head line the same way. Touch screens never hover,
so the current row keeps its actions over the faded line; a persistent
pushpin marker keeps the top slot explaining itself. Pinning never fences a
turn and never touches selection: list order, nothing more.

## Thread sources (ruling 2026-10-16, operator ask)

On a conversation: everything that conversation produced, visible in place,
not by digging through global tabs. The chat header gains its first action
(icon + aria-label) opening a sheet with two sections:

- **Retained exchanges** — `GET /api/memory/documents?conversation=` (the
  filter ruling in design/memory.md → Memories browser), the same paginated
  rows and detail/facts/forget affordances as the Memories tab, from
  components shared with it, not duplicated.
- **Skills from this thread** — `GET /api/skills/from?conversation=`
  (provenance ruling in design/skills.md → Skill provenance), name, state
  (installed / proposed / gone), when first written here. Proposed rows
  carry install/discard buttons (ruling 2026-10-17 — the sheet mutates now):
  they POST the shared `skills/decide` route and refetch; installed/gone
  rows stay read-only. The same buttons sit on the global Skills view's
  proposed cards.

App conversations only, by the channel rule: Telegram threads keep the
global Memories tab — per-thread views of them would be cross-surface
reading. A spin-off fork shows only what it retained itself; the copied
history retains under its source conversation.

## Intelligent UI (ruling 2026-10-09)

Operator ask, after OpenAI's GPT-6 "Intelligent UI" launch (2026-10-07):
answers that are interfaces — a comparison side by side, a timeline, a
chart, a tappable choice, a small calculator — rendered in the transcript,
not described in prose. **Chat-native for the app channel** (how an answer
renders, not a second system), only while stateless: no saved or re-openable
"apps", no artifact store, no state outliving the message; that line is
machinery and needs its own ruling.

**Mechanism: a component tree, not HTML.** One tool, `ui`, app conversations
only (Telegram never sees it; guests never). The tool *input is the
interface*: `{title?, blocks[]}`, zod-validated, from a fixed library of
native components rendered with the app's design tokens. `execute` validates
and returns a one-line ack — nothing runs. Store format = wire format: the
tool part persists in UIMessage history, so reload, resume, spin-off copies
and history carry the UI, and the model sees its past interface as a past
tool call.

- **Library (v1):** leaves — `text` (markdown), `callout`, `stats`, `table`,
  `steps`, `chart` (bar/line/pie, hand-drawn SVG, native `<title>` tooltips;
  pie slices are the first series' values labelled by `x`, extras ignored,
  values non-negative), `choices`, `form` (fields `text`, `number`, `select`,
  `checkbox`, `textarea`, `date` — every value serializes into the `[ui]`
  submit line; checkboxes submit `true`/`false`), `html`; containers —
  `tabs`, `columns`, children leaves only. **Two levels, no recursion**: a
  recursive zod schema emits `$ref`/`$defs`, which OpenAI-compatible
  providers handle unevenly, and a rejected schema breaks every app turn; a
  test pins "no `$ref`".
- **Progressive render.** The AI SDK surfaces partially parsed input in
  `input-streaming`; the client renders every block that validates plus a
  skeleton for the arriving one. Without provider tool-input deltas the UI
  lands whole at completion — degraded, not failed.
- **Placement.** `ui` parts render inline, never inside the Worked fold;
  validation failures render as the normal tool error row.
- **Type repair, both sides.** Probed live, `zai/glm-5.3-flash` broke 9 of
  22 comparison-style answers, mostly by dropping a block's `type`
  discriminator (typically the last `choices`, sometimes a stray bare
  `{type}` fragment); after repair 3 of 22 still failed. `normalizeUiInput`
  (shared, `ui-schema.ts`) re-types a typeless object by exact key-set match
  — every key declared by the candidate, the candidate parsing — fewest
  declared keys as tiebreak, a tie meaning no repair; bare `{type}`
  fragments drop. Server and client both validate/render through it (the
  wire JSON Schema stays the SDK's verbatim zod conversion), so history
  renders as accepted. Invented keys (`callout_md`) are not repaired —
  validation fails, the model sees the tool error and may retry. Repairs
  log `ui input repaired`, failures `ui input invalid`.
- **Judgment lives in the description.** Goblin's models are prompted, not
  trained: the description says text is the default and names when layout
  carries meaning; one environment line points at it when the tool is in the
  set.

**Interaction, two tiers.** Local state (tabs, form inputs) stays in React,
never server. Actions — a `choices` button, a `form` submit — post an
ordinary, *visible* user message
(`[ui] <label>` / `[ui] <submit>: field=value, …`) through the composer's
`sendMessage`, so the transcript never lies and the reply rides the normal
turn; actions disable while a turn runs. No client-side tools: turns run
server-side and outlive the client, so a turn parked on a browser
round-trip would hang with the tab closed.

**Escape hatch: `html`.** Computation answers — a bill splitter, a
calculator, a small game — render model-written HTML in
`<iframe sandbox="allow-scripts" srcdoc>`, never `allow-same-origin`, with
an injected CSP meta (`default-src 'none'; script-src 'unsafe-inline';
style-src 'unsafe-inline'; img-src data:; base-uri 'none'`) and a minimal
base stylesheet from the app's tokens. `base-uri 'none'` keeps any
`<base href>` inert — no URL-resolution path can be retargeted. The opaque
origin reads no app token, storage or DOM; mutations reach `/api/app/*` as
`Origin: null` / cross-site and the trust-mode gate refuses; reads lack
CORS. Height rides an injected resize script via `postMessage`, accepted
only from that iframe's window, clamped. Rendered only when input is
complete — HTML doesn't stream usefully. Navigations are neutralized at the
source (ruling 2026-10-10): CSP governs fetches, never navigations, and a
navigated frame sheds the CSP while keeping `allow-scripts` — egress plus
rendering inside trusted chrome. Meta refresh is stripped in `srcdoc()`; a
capture-phase click guard cancels anchor clicks — a `#fragment` href becomes
the document's own `location.hash`, in-place, never through `<base>` or the
embedding URL; popups and forms are dead under the sandbox flags. **Accepted
residual:** a direct `location` assignment can still navigate the frame —
un-interceptable from inside — so `html` stays a prompt-injection surface; a
frame suddenly rendering a foreign page signals the model was injected.

**Cache.** The tool joins app conversations' tool sets at deploy: one cold
prefix per live app conversation. Frozen prompt snapshots keep the old
"Tools:" line until the next boundary (roll, compaction); the description
carries the guidance meanwhile.

**Logging.** The tool call line carries block count and kinds; an `html`
block logs its byte size.
