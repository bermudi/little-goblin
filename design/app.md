# App channel — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## App channel (PWA → APK)

Ruling 2026-09-30, operator ask: a second, disjoint channel beside
Telegram — the app.

**Why.** Telegram's client is wrong for reading: 4096-chunked replies, topic
lists desyncing between devices (a client cache bug goblin cannot fix), Mini Apps
cold-starting in 4-5s on Android — the WebView container, not our payload.
Arrival is fine; reading moves.

**The shape: disjoint channels.** Two conversation pools, one store; a
conversation is born where it starts and stays there. No mirroring, no
fan-out, no cross-surface reading — routing is the address kind alone; the
channels share the turn loop, tools, config, memories, skills and nothing
else. No aliasing: once "where does this answer appear" has any answer
longer than "where you asked", the thinking is the bug.

**Protocol.** Store format = wire format — no translation layer to design,
drift, or test twice. Stop ends the turn server-side, not just its stream.
Compact (ruling 2026-10-16) puts the manual lever in the context gauge's
popover, not a composer command grammar — the app parses no slash commands —
and awaits the lane job (a finishing turn reads as a slow response). The
gauge reads the final step's prompt (`usage.lastInput`), never the turn's
billed sum across the tool loop (ruling 2026-10-19: the two differ by the
step count, and the sum once read as a 223k window on a 37k one); its
itemization scales `promptChars` to that number — per-segment figures are
estimates, exact in aggregate only.
Final-step counts fall back to billed totals only on legacy metadata with
neither final-step field. Explicit nulls (or a missing companion field) stay
unavailable, including cache-hit ratios and segment estimates.
The gauge's denominator never stalls
on the network: a cold models.dev memory falls back to a one-time
disk-cache parse (`contextLimitCached`), memory wins once a turn warms it.
While a turn streams the settled view is a turn behind (ruling 2026-10-21:
a visibly streaming first turn must never read "no turns yet"): each
model step pushes its window occupancy to the chat wire as a transient
`data-context` part — `useChat`'s `onData` sees it, message parts and
durable history never do, and the live-stream replay hands the last
figure to a late joiner. A step the provider didn't meter reads "ctx ?",
and before the first report lands the label names the turn in flight.

**Auth.** No `initData` exists outside Telegram; the lock is a bearer token,
optional since 2026-09-30 by operator ruling, on the collie precedent:
device-level trust (tailscale proves the device), no person-level auth —
and unset means trust mode, the tailnet the only lock. The token is an
auth.jsonl record (config stays secret-free). Boot-pinned: a mid-run flip or
a rotation applies only after restart. Guardrail warn: **funnel is a
misconfiguration** — a funnel-address `publicUrl` (public HTTPS) makes a
token MANDATORY.

**Trust mode's browser-origin line (ruling 2026-10-08, #75).** Reachability
proves the device, not the page: any site the browser visits could fire
no-cors POSTs (`text/plain` bodies, no CORS preflight, response never read)
at `/api/app/*`, creating conversations and submitting turns. Trust mode
therefore refuses *mutations* speaking a foreign browser origin: `Origin`
must match the request's own Host (either scheme — TLS ends at the front)
or the configured `publicUrl`'s origin — `tailscale serve` rewrites Host,
so only the public origin survives it. `Sec-Fetch-Site: same-site` refuses
too (tailscale fronts share the ts.net suffix). Non-browser clients send
neither header and pass; bearer mode never runs the gate — a token-holding
non-browser client (a future APK webview) must not depend on browser
headers. JSON-body routes require `content-type: application/json` in both
modes — a claim a cross-origin page cannot make without a preflight this
server never grants.

**Intentional origin trade-off.** The request's own Host is accepted for
proxy compatibility, not as independent proof of a trusted browser origin;
pinning origins solely to `publicUrl` would be a different access policy,
not a free tightening.

Trust mode leaves a **DNS rebinding risk**: an attacker-controlled hostname
resolving to a reachable goblin endpoint looks same-origin to both `Origin`
and Host, so neither gate nor JSON preflight blocks it. Tailnet
reachability is the intended outer boundary, but a browser inside it can be
the bridge — Safari must not be assumed to enforce Chromium-style Private
Network Access preflights. The residual is accepted for proxy/direct-access
compatibility; an operator needing an authentication boundary uses bearer
mode, and a stricter pinned-origin policy needs its own ruling.

**Client.** A missing build is a fail-loud 500 plus log line, never a
silent empty page; the transcript's single "Worked" fold is openclaw's
mechanism, zero code.

**Packaging ladder.** PWA first, on the tailnet URL through `tailscale serve`
(installable, ~1s open; zero APK churn — the operator evaluated twenty-APK
development and declined). APK via Capacitor when stable: the same build wrapped, plus
the Android share-target intent — what PWAs cannot do (the share sheet
lists only installed apps, observed 2026-09-30) — and later FCM if push is
demanded. TWA is rejected on mechanism: assetlinks verification cannot pass
on a tailnet-only domain. PWA and APK are one channel in two shells; the
server can't tell which talks.

**App-native Web Push (ruling 2026-10-22, operator ask: closed-app app
turns must ring without Telegram).** Enablement is explicit per browser on
the Attention page — it is device state, not server-wide configuration.
The VAPID pair is generated lazily and lives only in `auth.jsonl`;
subscriptions and sent markers live in SQLite; API state exposes endpoint
hashes, never endpoints or subscription keys. Payloads are generic
(title/body + `/app/c/<id>`) and contain no reply text or authority.
Background app turns notify on terminal success or failure; fenced turns
stay silent. An interactive turn notifies only if its SSE wire died before
the terminal callback — a live app reply never double-rings. `404`/`410`
prune an endpoint; transient send failures keep it retryable. Telegram
stays the bell for its own conversations and still rings app turns as the
companion channel; Web Push is the app-owned path, not a replacement.

**Out, explicitly:** mirroring or cross-channel reading of any kind (revisit
needs a ruling here — Spin-off is the one ruled crossing: a copy plus a
bell, not mirroring), home-screen widgets, in-app voice mode, iOS.
(In-transcript interface blocks are a different thing — Intelligent UI
below.)

## Operator console in the PWA (ruling 2026-10-09)

Operator ask: the PWA becomes the operations surface, because Telegram is
the wrong client for long reads and state edits. Two doors onto one surface
share validation and persistence — a write lands identically either way —
and differ only in the self-lockout guard: the mini app refuses to remove
the *requesting* Telegram id from `operators`, the app door (no requester)
an empty list while Telegram is enabled. With `telegram.enabled: false`,
the app door may save `operators: []`.

**Boot independence (ruling 2026-10-22).** The app channel is the primary
door and never waits on Telegram: boot stands HTTP and every `/api/app/*`
surface before the deferred Telegram init task even resolves the bot
token — a held or rejected `getMe`, or a poll that dies mid-run, leaves
the PWA fully usable. The mini-app door (`/t/`, initData validation)
fails closed with 503 until a live `botToken` attaches.

**State viewer (ruling 2026-10-11, operator ask).** Read-only view of
`$GOBLIN_HOME` beyond the console — reads, never writes; `auth.jsonl` is out
forever (no route may ever render it, structure included). Two layers, each
sufficient: zod validation of every name/path/param, then containment in
**realpath space**, so neither lexical traversal nor symlink indirection
escapes; symlinked skill dirs don't list or read, the base must be a real
directory inside the catalog root, and a link resolving back inside its
base serves. The log is a bounded server-side tail (no whole-file pull, no
wide-open dump). Attachments: svg absent from the content-type map (it
downloads rather than renders same-origin), read-back serves inert bytes.
An attachment's object URL belongs to the row's lifecycle, not render state
(ruling 2026-10-13, #19): a fetch resolving after unmount mints nothing,
unmount revokes. Tails mount on both doors; the mini app gets no pages. The
app settings editor is the only settings UI; the Telegram door renders its
telegram mode (design/telegram.md → Mini Apps, ruling 2026-10-10). Dirty
settings ask before discarding, browser Back/Forward included; unrecoverable
direction/distance retains the draft with a warning — never overwrite
history or guess. "Dirty" is the departure flag, not the serialized diff
(ruling 2026-10-13, #15): a blur-commit provider name is draft state no
serialized field sees; a pending name holds autosave and refuses explicit
Save. Async creation retains no navigation authority after dismissal;
composer restores go only into their originating composer, never over
newer text; memory pagination belongs to the loaded filter.

**Composer drafts are durable (ruling 2026-10-20, operator ask: the
Ctrl+W emacs habit closes the tab mid-composition).** The composer's
text persists per scope — the conversation, the project page, the
empty start state — in same-origin localStorage beside the note draft:
restored on mount, stored on every change (no debounce — a close at
any instant has the last keystroke), removed by an accepted send; a
declined or fenced send keeps it, so it survives navigation and
remount until sent or typed over. No close guard rides on it: closing
costs nothing once nothing can be lost, and the settings/note
beforeunload prompts exist precisely because those edits have no such
persistence. Storage always holds the latest local draft, so a restore
can never land over newer text; the one-shot restore rulings stand
unchanged beside it. An unreadable record stays in place behind an
error line until the first write replaces it. Text only — staged
chips are uploads, not prose.

**Transcript rendering (ruling 2026-10-21, operator ask: tables blow out
the column, the column wastes the desktop, machinery tags read as
prose).** Three transcript fixes, all render-side — history text is
never rewritten. Pipe tables render inside a scroll wrapper whose cells
carry `overflow-wrap: anywhere`, so an unbreakable cell (a sha256 in
code) shrinks the table's min-content and fits, and a genuinely wide
table scrolls instead of pushing the transcript column past its width —
the ui tool's tables already had the wrapper. The chat column width is
a selector, not a fixed cap: narrow (46rem, the default) and wide
(72rem) in the chat header, persisted per device in localStorage — a
phone and the desktop PWA legitimately want different columns; the mini
app door honors the stored choice read-only and the selector hides on
phone widths. A machinery tag line (`[delegation: …]`, `[program: …]`,
spellings owned by src/tags.ts) at a block start renders fenced as
`status`, not as a transcript paragraph — it is the event envelope, and
the prose after it in the same paragraph continues as text.

## Streaming members & resumable streams (ruling 2026-10-04)

The reply belongs to the conversation, not the connection that submitted
it. Two defects shared that root (audit 2026-10-04): a second client
submitting mid-turn received an empty stream; a reload mid-turn showed
a finished-looking chat whose next send steered a ghost turn (#43).

- **Chunk fan-out.** Every *streaming* member receives the chunks; a
  throwing streaming sink is detached, never fatal; a streaming head
  claims the whole queue — one burst, one reply.
- **Join replay.** A member attaching mid-turn first receives everything
  the wire already saw, from sentence one; the wire log survives overflow
  recovery, so the resumed attempt continues the same wire.
- **Attach/reconnect.** The endpoint serves the wire log + a live tail, 204
  when idle (the AI SDK's `reconnectToStream` contract — client falls back
  to history), so a reload re-watches the in-flight reply; the log is
  in-memory, live turns only — after a crash, history and no stream.
- **Idle reconnect reconciles (#79).** An idle 204 promises durability: the
  runtime persists a reply before retiring the wire, so history is final
  for every reply that could have been live at snapshot; the client
  re-reads history once on idle resume and merges by message id, never
  dropping a live local tail.
- **Parked, with a trigger.** A *passive* screen (no submit, no reload)
  still doesn't live-update; promote when "app open while turns happen"
  becomes a daily pattern — the server machinery is ready. Until then it
  stays Spin-off's "live refresh out of scope".
- **The composer steers (2026-10-16).** Send never locks mid-turn — it
  posts beside Stop and the lane steers or queues exactly like Telegram;
  the client drops its reader first (locally, never `/stop`), so the new
  join replay is the only writer and lands on the same assistant message
  id — a handoff, not a forked transcript. An aborted reader doesn't ring
  the done bell.

## Model/thinking scope (ruling 2026-10-06)

Each app conversation snapshots root `model` and `thinking` at creation and
retains both until the operator changes that conversation; new conversations
and Telegram spin-offs use **app defaults**, never Telegram's selection, and
Spin-off copies history and memory policy, not model settings. Patches never
create rows or expose Telegram settings and precede any snapshot/config
mutation; favorites and the provider registry stay shared, not
per-conversation. Removing a provider still selected is refused, naming the
affected ids — change those first. App-default edits change only future
conversations (the Telegram mini app can edit both scopes; whole-file writes
preserve both).

Changes apply at the next admitted turn, not the next model step — no epoch
bump, abort, or interrupted answer. Running turns keep their captured
settings, queued successors use the latest, manual compaction resolves at
its lane job; a model change legitimately makes the next turn's cache cold.

**Model picker (ruling 2026-10-21).** The settings sheet lists the
models.dev catalog for every configured provider — matched by exact
provider name, the openrouter kind, else the catalog provider's API host —
with favorites and the current ref pinned, newest release first and the
friendly name above its exact ref. One search field filters favorites and
catalog across id, name, and full ref; Enter picks the exact match or the
first hit. The typed `provider/model-id` path survives as the fallback for
anything the catalog doesn't know or when it is cold. The catalog is a
memory-or-disk read served on the settings response, never waited on:
opening settings cannot stall on models.dev (the boot warm refreshes the
catalog like it already does for openrouter), and a failed or stale
catalog degrades to the typed fallback rather than blocking a save.

**Favorites are stars (ruling 2026-10-23).** The shared `ModelPicker`
sheet (Settings and composer) carries a star on every model row; a star
never picks. The composer's model knob is a menu — current model,
favorites by friendly name, then "All models…" opening the sheet — so
switching to an unfavorited model never needs a Settings round-trip.
Composer stars write one ref through `POST /api/app/favorites`
(`{ref, on}`, idempotent; adding requires a configured provider,
removing accepts anything so a stale entry can always leave). Settings
stars edit the draft instead, so its autosave never races its own etag.
The app config view carries the cached catalog for friendly names.

## Settings shape (ruling 2026-10-23)

Supersedes the form-mirrors-the-file layout. Operator rule: **anything
changed in normal use gets a form; everything else is goblin-managed** —
not shown as an input, round-tripped untouched by every save, and edited
in `goblin.json5` only by advanced operators. Managed values may appear
as read-only text (System, the memory card).

- **No credential plumbing in the UI.** Record names (`auth` fields) never
  render as inputs; each service shows key status instead — no key
  needed / from pass-keys (command records, never replaced from the UI) /
  key saved / key missing, with paste-to-store. Kind ids render through
  the server-served `serviceNames`. The naming discipline in
  `design/auth.md` still decides what a blank derives to; it just stops
  being visible.
- **Model services come from presets** (`providerPresets`, base URLs the
  docs already carry); "custom endpoint" is the only place protocol and
  base URL appear. ChatGPT is an account, not a provider type.
- **ChatGPT sign-in is in-app** — the Codex CLI's device-code flow
  (`src/agent/codex/login.ts`, wire pinned from codex-rs
  `device_code_auth.rs`/`server.rs`; `login.live.test.ts` is its drift
  check). Tokens land in goblin's own `state/codex-auth.json` (0600);
  `~/.codex/auth.json` stays the CLI's. Resolution: explicit `authFile`
  (pinned — in-app sign-in refused) > goblin's file > the CLI's file (the
  legacy path keeps an existing install working until its first in-app
  sign-in). Sign-out removes only goblin's file. A first sign-in adds
  a codex provider under the first unused name (`codex`, `codex-2`, …)
  when none exists; an existing service named `codex` is never replaced.
  A sign-in action returning pending starts status polling immediately;
  completion reloads clean settings so the new provider is visible.
- **Off parks, never deletes.** Switching off memory, transcription,
  vision, image, sandbox, subagents, scripting, delegation, guest or
  reviewer moves the block under `parked`; on restores it whole, file-only
  fields included. Runtime consumers and `authReferences` never read
  `parked`. A block with no parked copy and no safe default reports
  `needs-setup` with its hint; a bare switch cannot invent config. A save
  may supply the block together with its enable switch (including a
  first-time vision, image or transcription setup). Supplied blocks win
  over parked copies and defaults; the whole resulting config, including
  provider changes in that save, must validate before anything is written.
  The editor hydrates its restoration stash from parked content on load;
  enabling transcription or memory restores that content into the draft,
  so its switch and subsequent saves reflect the requested state.
- Sections: Models · Accounts & keys · Web · Voice · Memory · Telegram ·
  Access · Capabilities · System. Boot-pinned changes surface as one
  restart banner from the config-pins restart hints, not per-field
  captions. This includes all reviewer changes: its switch persists and
  parks/restores config, but the reviewer itself is wired only at boot;
  enabling or disabling it takes an approved restart (design/skills.md →
  Skill reviewer). Failed status checks preserve last-known restart hints
  and show explicit uncertainty; unavailable status never confirms that
  a saved change needs no restart.

## Spin-off (ruling 2026-10-03)

Operator ask, paired with Rolling DM: durable work — something that runs,
reports back later, gets followed up on — needs a durable, named home in
the app; the DM stays the quick lane.

**Trigger: automatic, on delegation launch from the DM.** A `delegate` call
launched from a rolling DM (operator ask or goblin's judgment) spins off —
no model choice, no command. Nothing else triggers it: scheduled programs
post into the DM like any message, group topics keep their delegations,
app-conversation delegations stay put.

**A copy, not a move.** Moving would strand the operator's next DM message
("also make it use bun") — its answer appearing in the app, not where it
was asked. At launch goblin seeds an app conversation with a copy of the
DM's model view so far (summary + tail); the two diverge and are never
synced. The delegation pins to the app conversation, titled from the copied
exchange (fallback: the delegation's name); the tool result hands the model
the title and link, so the DM reply says where the work went.

**Background turns.** Notices (done, blocked, a question) wake headless
turns in the app conversation — they run and persist like client-driven
ones, nothing streaming; the app shows them on next open. For this, the
app channel mounts `delegate`; `program` and configured `mail` mount too,
with their decisions routed through the shared approval owners.

**Telegram rings.** Every completed background turn pings the *current* DM
— `<title>: <head of the reply>` plus a link, appended as an assistant
event (answerable in chat) and counted for the gap rule. A swipe-reply
routes to the app conversation (headless, so it rings back); the DM
acknowledges `sent to <title>` (delivery only). The ping → conversation
mapping is durable by the ping's message id, so replies after a restart
still route.

**Links.** `{publicUrl}/app/c/<appId>` opens one conversation; the APK will
claim links under `/app/`. Unverified until then: Android's automatic link
claiming needs Google domain verification, which cannot reach a tailnet-only
host (the same wall as TWA) — expect a one-time "open supported links"
toggle.

**Landing rulings (stage 2, 2026-10-03).** Every operator id gets the ping
as a private chat, one per account. A deleted app conversation drops the
notice with a warning (no retry loop). The fork takes the delegation's name
first (what the DM reply quotes), then the title model retitles; operator
renames always win. A launch that doesn't start (cap reached, failed)
deletes the fork. The ack goes once per replying chat (coalescing can merge
replies). Deep links apply once after the first list load; an unknown id
falls back to `/app/`.

## The app wire must never idle — SSE heartbeat

Ruling 2026-10-07, from a failed operator turn: the app showed "The turn
failed: Error in input stream" mid-turn while the log insisted
`app stream finish: completed` — the turn had finished, streamed into a
socket the client no longer had.

**Cause (probe-verified on the box, bun 1.4.2).** `Bun.serve` closes
connections that send no bytes for its `idleTimeout` — 10s by default: a
silent SSE died at exactly +10.0s in a scratch repro, while comment pings
every 5s survived the full 25s. A `git clone` or long diff silences the
stream for tens of seconds; the first >10s silence killed the wire 3 minutes
before the turn ended — and the writer swallowed the enqueue failure,
fail-loud broken.

**The rules.**

- Heartbeat: an SSE comment (`: ping`) after 5s of wire silence — comments
  are skipped by parsers and by the SDK client's `eventsource-parser`
  (firstCharCode 58), warming the wire without touching the stream; the
  silence check samples well under the threshold period, since an equal
  tick period phase-locks with arriving chunks and never fires.
- `Bun.serve` sets `idleTimeout: 255` (the max) — a ceiling behind the
  heartbeat, not a substitute.
- Wire death is loud, turn death is not: client-gone and controller-closed
  log warns with the conversation; the turn keeps running — durable history
  plus the resumable attach stream mean a reload re-watches it. Only the
  wire is lost, and now it says so.

## Context window view (ruling 2026-10-22, operator ask)

Operator ask, after pi-mono's `/share` session viewer: a per-conversation
view of everything that hits the context window — system prompt, tool
schemas, every message — with toggles and filters, one button away from
the chat.

**Captured at the source, never reconstructed.** The shareable artifact
in pi is the session log plus a trailing entry carrying the system
prompt and tool schemas; the viewer renders what *was*, never a
re-derivation. Goblin takes the same mechanism one seam deeper:
`prepareStep` already holds the exact outbound prompt of every model
call (the gauge's `promptChars` itemization reads the same capture), so
the final step's prompt — system, tool definitions, every
`ModelMessage` — is serialized once and stored per conversation
(`context_windows`, latest wins, gzip). The record is the last model
call's input, verbatim. A parallel assembler in an HTTP handler would
have drifted from admission's pipeline the first time either changed;
there is no reconstruction path, so none can drift.

- **Media bytes are stubbed to counts at capture** (`{omitted: bytes,
  count}`); the transcript already shows the media, and a second
  megabyte store per turn buys nothing. Everything textual is verbatim.
- **The record rides both outcome rails** — an ok turn stores its final
  step, a failed one its last completed step; gated on completed steps,
  so a call that never finished a step records nothing (`steps: 0`
  reads as no window, never as a prompt nothing saw). A failed record
  write is logged and the turn proceeds — observability, never turn
  state; the journal owns what must be honest.
- **The window is the model's input, not the transcript.** It ends
  where the final call's prompt ended — a single-step turn's window
  holds the operator message only; steers, warnings and landing nudges
  appear exactly when they rode the captured step. The reply is never
  in its own prompt.
- **Staleness is stated, not hidden.** The view carries the captured
  model beside the conversation's current one; a mismatch reads "the
  next turn rebuilds the window" — true by the frozen-snapshot and
  model-edit rulings, not an error.
- **The call lineage is the historical half.** `model_cache_calls`
  already records every call (usage, cache split, prefix relation); the
  window route serves that lineage per conversation, bounded, newest
  first. Together they answer "what hit the window" for every call,
  not just the newest.
- **A forget purges every capture, globally.** Stored windows embed
  recall bytes with no reliable source attribution, so the forget
  boundary clears `context_windows` and bumps a singleton
  `recall_version` in the same transaction as the recall-context
  redaction. Attempts read the version before their memory/view/model
  preparation and write the record only when it still matches — a
  turn in flight across the boundary is fenced, never served back a
  projection of forgotten evidence. An overflow continuation reuses
  its failed attempt's version, matching the memory it carried; an
  operator resume reads the current one.

**Surface.** `GET /api/app/conversations/<id>/window` (read-only, same
bearer/trust gate as every `/api/app/*` route; the window is
operator-private like the transcript and never leaves the process). In
the PWA, the chat header's context-window action opens
`/app/c/<id>/window` — a full page, linkable like pi's share URL, not a
sheet. Filters are client-side: role chips, a substring filter,
thinking/tool-body expansion, a raw-JSON mode. App conversations only;
the mini app door has no chat and gets no pages. A conversation with no
captured window says so — the view never fabricates one.

The row dies with the conversation: `context_windows` carries no FK, so
it rides `deleteConversation`'s sweep — a re-minted id starts empty and
never inherits the last generation's prompt (operator-chosen app ids
re-mint freely; an inherited row would claim a capture that predates
the conversation, the fabrication the view refuses).

## Reply ratings (ruling 2026-10-22)

Assistant action bars carry record-only **helpful** / **bad** votes. The
store is channel-neutral `reply_ratings`: Telegram callback rows keep
chat/message identity; app rows key the durable assistant event's `seq`.
Votes append and reads are latest-wins. Nothing consumes the rows — model
view, history, FTS, memory, reviewer — matching the Telegram ruling; a
consumer needs a new ruling.

An app turn can persist several assistant events for one user anchor
(generated media, then its prose reply). The server, not the client,
chooses the voteable event: the last assistant event for each anchor, and
the last event in each contiguous unanchored assistant run. `/messages`
returns that list with the ratings, and POSTing any other id is refused.
The action bar refreshes the list after reconnect reconciliation and turn
finish, so a newly committed reply gets controls without a manual reload.

## Interrupted turn recovery (ruling 2026-10-17)

A crash leaves a turn `interrupted` in the journal (design/runtime-turn.md →
The turn journal); the app surfaces those runs where they died. Contract,
mirroring the Telegram `/decide` / `/resume` surface:

- **Decisions are explicit.** Each `dispatched` call shows its tool name, a
  bounded args preview, and three buttons — Record result (asserts an
  outcome the operator already knows; it becomes the journaled outcome the
  resumed attempt sees as evidence), Authorize retry (re-executes; effects
  may repeat), Skip (never runs; a re-ask reads the refusal) — plus an
  optional note. Settled calls show their recorded outcome and one more
  button — Authorize another execution — granting a single deliberate
  re-run of a known effect by call id; granted or skipped calls render
  read-only.
- **Resume is gated server-side.** Disabled while any call is `dispatched`;
  a refusal names the undecided calls and the client refetches rather than
  trusting its copy; success admits a FRESH run — the client drops the
  acknowledged source and reconnects, the attach endpoint's idle path
  reconciling by message id.
- **No optimistic mutation.** Nothing is decided before the server's ack;
  errors show the server's reason verbatim.

## Archiving (ruling 2026-10-09)

Archive replaces delete as the rail's declutter action; an archived
conversation keeps everything (history, FTS hits, settings, pings,
`/app/c/<id>` links) — the stamp is list visibility, nothing more. Delete
keeps its confirm but only on archived rows: the rail offers archive, the
archive offers delete.

Archiving never fences a live turn (unlike DELETE's `runtime.stop`) — the
turn finishes into history either way. And **any appended event
auto-unarchives**: a delegation notice or a message sent via the ping link
brings a shelved spin-off back to the rail instead of accumulating replies
unseen.

## Deletion's dependents (ruling 2026-10-19)

`deleteConversation` must sweep every FK child or the row delete throws a
bare constraint error — the app rail's delete was unreachable for any
conversation that had ever carried a wake. Two shapes, two rulings:

- **Wake rows ride the delete** (same transaction): deliveries, work
  events, and their joins are the conversation's delivery bookkeeping;
  they mean nothing without it. `openStore` ensures the wake and
  responsibilities schemas alongside projects/notes so the sweep and the
  anchor check always find their tables.
- **A coordination surface outlives its responsibility, never the reverse.**
  While any responsibility (open or closed) anchors the conversation,
  delete refuses, naming them — the handover loop and wake delivery stand
  on that surface, and closed records keep their history. The refusal is
  the operator's to resolve, not the delete's to cascade.

Reconcile treats a wake whose conversation row is gone (out-of-band
surgery only — the FK chain and the sweep keep them together) exactly
like a ghost run link: that wake fails loudly and terminally;
classification continues for every other wake.

The feed consequence (2026-10-19): unprunable history means the wire,
not the table, carries the bound. `feedEvents` serves each
responsibility's newest `FEED_EVENT_WINDOW` (50) developments ascending
plus `eventsTruncated` — the count of older durable rows omitted —
while the app polls the read model every 15s. Durable rows are never
pruned by the feed; `work_events (responsibility_id, event_id DESC)`
is the index the window walks.

## Delivery and arm truth (ruling 2026-10-20)

Three fences close the gaps review found in the handover loop's
delivery edges:

- **Wake ownership is gate-or-fail-closed, never optimistic.** The
  runtime's ownership hooks observe turns and never gate them, so a
  `begin` hook that cannot persist the wake→run link cannot abort the
  run — but an unlinked claim is indistinguishable from a
  never-admitted one, and reconcile would resubmit a trigger the live
  or finished run already processed. A failed link therefore fails the
  *wake* closed (`failUnlinked`: CAS on claimed AND run_id IS NULL) and
  the dispatcher fences that wake's submit for the process lifetime,
  retrying the durable closure every pump. The turn always completes;
  only the resubmission is impossible. The same closure+fence covers
  every terminal failure *before* `begin` (refused admission,
  makeTools, the journal row itself): the runtime announces it through
  `preRunFailure`, because no run row exists for reconcile to read —
  and while even the closure write refuses, the process-local fence
  holds the resubmission and each pump retries the write.
- **The unresolved-delivery fence binds to dispatch identity, not row
  identity.** Prepare, claim, and fresh `attach` all fence per dispatch
  identity — server, session, terminal, harness session, kind, within
  one responsibility — never per (attachment, generation) alone, which
  a duplicate binding of the same agent could have walked around:
  after A's send went `uncertain`, a prepare or claim via B would have
  reached the same agent without reconciliation. `attach` additionally
  refuses a second live binding of one identity outright (plain error;
  detach it or reattach), so the duplicate state stops being minted;
  the prepare/claim fence still covers rows that predate the refusal.
  The identity an operation answers for is persisted **on the
  operation** at prepare: reattach rewrites the attachment row's
  copies, so joining it would re-key an unresolved send onto whatever
  destination the row holds now — fencing the replacement that never
  received it and freeing the agent that did. A genuinely changed
  identity remains a deliberate adoption, same as reattach's ruling;
  the fence never reaches across responsibilities.
- **Arm truth is the linked program.** The persisted `armed` flags are
  a cache `ensureFollowup` writes; the `program` tool can disable or
  delete the follow-up behind the responsibility's back. Every armed
  reader — the app feed and the agent-facing `status` action alike —
  recomputes from the linked program row (armed = exists ∧ enabled ∧
  active), sharing one `armedView`.
  The app feed additionally keeps its polls honest (2026-10-20): a
  refresh failure alongside loaded rows renders a stale-state banner
  instead of standing mute, and each response carries the refresh's
  sequence — an older poll resolving after a mutation's refresh is
  dropped, never restored to obsolete state. Ordinary polls also
  serialize (2026-10-22): the interval skips while a fetch is in
  flight, so sustained latency above the interval degrades the cadence
  instead of stacking requests whose every response arrives stale by
  sequence and gets discarded — the feed would never have rendered.

## Pinning (ruling 2026-10-10)

Pin is the rail's anchor action, archive's complement: a pinned conversation
floats above the activity stream, so a slow thread the operator always
wants reachable stops sinking. Pinning changes a row's group, never its
position inside it; **pins survive activity** (the exact opposite of
archive's auto-unarchive), and **archiving clears the pin** — a row hidden
from the rail can't be anchored above it, and unarchive must not resurrect
a stale pin. Row affordances are icons, not labels — the rail cannot fit
labeled buttons (ruling 2026-10-10; glyphs carry aria-label and title).
Pinning never fences a turn and never touches selection: list order,
nothing more.

## Thread sources (ruling 2026-10-16, operator ask)

On a conversation: everything that conversation produced, visible in place,
not by digging through global tabs. The chat header gains its first action
opening a sheet with two sections:

- **Retained exchanges** (filter ruling: design/memory.md → Memories
  browser) — the Memories tab's rows and detail/facts/forget affordances,
  from shared components, not duplicated.
- **Skills from this thread** (provenance ruling: design/skills.md → Skill
  provenance) — name, state, when first written here; rows with a parked
  proposal carry install/discard buttons (ruling 2026-10-17 — the sheet
  mutates now), the same buttons as the global Skills view; plain
  installed/gone are read-only. A parked proposal on an installed skill —
  an update awaiting a decision — shows both chips and keeps its buttons
  (amended 2026-10-20: `pending` rides beside the installed-wins state
  word; the collapse had hidden the decide row entirely).

App conversations only, by the channel rule: Telegram threads keep the
global Memories tab — a per-thread view would be cross-surface reading. A
spin-off fork shows only what it retained; copied history retains under its
source conversation.

## Intelligent UI (ruling 2026-10-09)

Operator ask, after OpenAI's GPT-6 "Intelligent UI" launch (2026-10-07):
answers that are interfaces — a comparison, a timeline, a chart, a tappable
choice, a small calculator — rendered in the transcript, not described in
prose. **Chat-native for the app channel** (how an answer renders, not a
second system), only while stateless: no saved or re-openable "apps", no
artifact store, no state outliving the message; that line is machinery and
needs its own ruling. (The file-presentation half of that line arrived as
`artifact` + the document reader — see the 2026-10-21 ruling below; the
bytes persist in the attachment store, the presentation stays
message-scoped.)

**Mechanism: a component tree, not HTML.** One tool, `ui`, app conversations
only (Telegram never sees it; guests never). The tool *input is the
interface*: a fixed library of native components, zod-validated, rendered
with the app's design tokens; `execute` validates and returns a one-line
ack — nothing runs. Store format = wire format: the tool part persists in
UIMessage history, so reload, resume, and spin-off copies carry the UI, and
the model sees its past interface as a past tool call.

- **No recursion, two levels** (containers hold leaf children only): a
  recursive zod schema emits `$ref`/`$defs`, which OpenAI-compatible
  providers handle unevenly, and a rejected schema breaks every app turn.
- **Progressive render.** The AI SDK surfaces partially parsed tool input;
  the client renders every block that validates plus a skeleton for the
  arriving one. Without provider tool-input deltas the UI lands whole at
  completion — degraded, not failed.
- **Placement.** `ui` parts render inline, never inside the Worked fold;
  validation failures render as the normal tool error row.
- **Type repair, both sides.** Probed live, `zai/glm-5.3-flash` broke 9 of
  22 comparison-style answers, mostly by dropping a block's `type`
  discriminator; after repair 3 of 22 still failed. A typeless object is
  re-typed by exact key-set match (a tie meaning no repair); invented keys
  are not repaired — the model sees the tool error and may retry. Server and
  client both validate/render through the same repair, so history renders
  as accepted.
- **Judgment lives in the description.** Goblin's models are prompted, not
  trained: the description says text is the default and names when layout
  carries meaning.

**Interaction, two tiers.** Local state (tabs, form inputs) stays in React,
never server. Actions — a choice button, a form submit — post an ordinary,
*visible* user message through the composer, so the transcript never lies;
actions disable while a turn runs. No client-side tools: turns run
server-side and outlive the client, so a turn parked on a browser
round-trip would hang with the tab closed.

**Escape hatch: model-written HTML.** Computation answers — a bill splitter,
a calculator, a small game — render in an iframe sandboxed with
`allow-scripts`, never `allow-same-origin`, with an injected CSP and a
minimal base stylesheet from the app's tokens; `base-uri 'none'` keeps any
`<base href>` inert. The opaque origin reads no app token, storage or DOM;
mutations reach `/api/app/*` as `Origin: null` / cross-site and the
trust-mode gate refuses; reads lack CORS. Height reports via `postMessage`,
accepted only from that frame's window, clamped; rendered only when input
is complete — HTML doesn't stream usefully. Navigations are neutralized at
the source (ruling 2026-10-10): CSP governs fetches, never navigations, and
a navigated frame sheds the CSP while keeping `allow-scripts` — egress plus
rendering inside trusted chrome. Meta refresh is stripped; a capture-phase
click guard cancels anchor clicks (`#fragment` hrefs become the document's
own `location.hash`, in-place, never through `<base>` or the embedding URL);
popups and forms are dead under the sandbox flags. **Accepted residual:** a
direct `location` assignment can still navigate the frame —
un-interceptable from inside — so the escape hatch stays a prompt-injection
surface; a frame suddenly rendering a foreign page signals the model was
injected.

**Cache.** The tool joins app conversations' tool sets at deploy: one cold
prefix per live app conversation. Frozen prompt snapshots keep the old
"Tools:" line until the next boundary (roll, compaction); the description
carries the guidance meanwhile.

## Artifacts & the document reader (ruling 2026-10-21)

Operator ask (Mario's Pi codemode thread): files the agent makes should be
openable in the PWA, and composition should end in a card, not a prose
summary. Two doc kinds ride one modal:

- **An artifact is an immutable snapshot.** The `artifact` tool copies the
  bytes once into the attachment store; editing or deleting the source
  afterwards never rewrites history — a reload renders the snapshot, not
  the file's future. The wire carries only `{path, name, title?, mediaType,
  size, source}`: bytes travel file → attachment store → HTTP → render,
  never through model context. Cards hoist out of the Worked fold beside
  the fold that ran them — a direct `artifact` call and a script's
  collected `output.presentations` land the same way. The Intelligent UI
  ruling's "no artifact store" line moved exactly this far: the store is
  the existing attachment directory serving by basename, presentation is
  still message-scoped (a card in history), and no separate registry was
  built.
- **A file read is live and mutable.** Clicking a path chip opens the file
  as it is *now* — same semantics as `read_file`, deliberately not the
  immutable kind. `GET /api/app/conversations/:id/file?path=` resolves
  inside that conversation's workdir (the workspace, or the bound
  project's dir via `projectWorkdir`) with the box-files realpath
  containment: `..`, absolute escapes, symlink escapes, directories and
  over-cap reads all refuse. On top of the import boundary the reader
  refuses `auth.jsonl` anywhere (the State viewer ruling applies — a
  linked project dir can sit outside `$GOBLIN_HOME`, so the deny rides on
  the resolved path, not the home) and anything inside `.git` (remote URLs
  carry credentials). The reader cap is the app byte budget (32 MiB), not
  the 100 MiB transfer bound. Served `content-disposition: attachment` +
  `content-security-policy: sandbox` + `nosniff`: direct navigation can
  never render a stored document in the app origin; the reader pulls it
  through fetch and renders it itself.

Rendering is by kind: markdown through the shared renderer (relative
`[t](path)` links are live only inside the viewer — they resolve against
the doc's own directory and push onto the modal's back stack; in the
transcript they stay literal syntax), HTML inside the same sandboxed
srcdoc frame as ui leaves, raster images/audio/video/pdf over object
URLs, plain text for the rest of the text kinds past a decode cap, and a
download affordance for binaries (SVG included — it never renders
same-origin). The frame CSP grew `media-src data: blob:` so a generated
document can embed or build media — still no network, still an opaque
origin.

App-channel only, like `ui`: the tool mounts on app turns, the routes sit
behind app auth, and Telegram/guests get neither.

**Parked candidate (2026-10-22): json-render.** Vercel Labs' framework for
this same idea (`@json-render/core`, `@json-render/react`), layered on the AI
SDK. Not adopted — see the pin and the reviewer criteria at the bottom of
`docs/generative-ui.md`. Operator-facing plain-language walkthrough of this
section: same file.

## Coordination fences & delivery evidence (ruling 2026-10-20)

- **Corrections fence the whole project, not one lane.** Every
  conversation bound to the project can reach the coordination tools,
  so `service.correct()` bumps the epoch of every bound lane plus the
  coordination conversation inside the same commit as the revision and
  the durable event — one commit, one rollback unit. The commit hook
  (`onCorrectionCommitted`, wired to `runtime.cancelFenced`) then
  cancels each fenced lane before the correction wake is pumped; a hook
  failure on one lane never skips the rest and never undoes the commit.
- **Unresolved delivery fences the attachment generation.** While any
  operation on an attachment generation is `sent`/`uncertain`, no new
  operation prepares (check+insert atomic) and no sibling prepared op
  can claim — regardless of brief, revision, tool-call id, or restart.
  The only way out is `reconcile {operation, delivery, evidence}`:
  inspected evidence closes the op `acknowledged`/`refused`, records
  verdict+evidence+prior outcome, is idempotent on identical replay,
  and conflicts by name. A live in-process dispatch refuses reconcile;
  a crashed `sent` row reconciles freely. Settlements CAS from `sent`
  so a reconciled row is never overwritten.
- **Same-identity reattach skips reconciliation — refused.** A reattach
  whose target equals the bound dispatch identity (server, session,
  terminal, agent_session, kind) while a delivery is unresolved throws
  `ReconciliationConflict` naming the op (tool: `delivery-uncertain`;
  HTTP: 409). A genuinely changed identity is a deliberate adoption and
  bumps generation normally.
- **Reattach is conditional on the caller's snapshot.** The app route
  and the coordination tool both snapshot the attachment before
  awaiting the live-agent listing; `resps.reattach` compares that
  snapshot's binding fields — generation, health, `detachedAt` —
  against the current row inside the same immediate transaction as the
  write. Any drift throws `StaleAttachmentError` (HTTP: 409; tool:
  `refused:"stale-attachment"`) and writes nothing — a detach, a
  competing reattach's generation bump, or a health write that landed
  mid-listing wins whole instead of being overwritten. An observer
  cursor refresh alone is not a binding change and never conflicts;
  callers without a snapshot keep the unconditional behavior.
- **Responsibility-destination programs are durable enqueues.** If the
  `recordDevelopment` write throws, `fireScheduled` does not `markRan` —
  the occurrence stays due and the next scan retries the same source
  key onto the same work event. Generic Telegram fires keep
  attempt-once.


## Skill picker & temp skills (ruling 2026-10-21)

Composer skill button → sheet with the catalog (every valid entry,
manual-only included, description + body size) and a from-link field.
A link runs the fetch pipeline server-side
(`POST /api/app/skills/preview`) and renders a preview card — name,
description, body size, source repo, System One injection verdict —
where yes stages the chip and no drops it; nothing is fetched into a
send the card didn't approve. The staged chip rides the composer's
existing staged-chip rows; send appends the `data-skill` part
(ruling: design/skills.md → Skill invocation), and the transcript
renders it as a chip on the user message, like attachments and notes.
Drafts stay text-only — staged skills are references, not prose
(Composer drafts, above). The listing endpoint's response gains the
picker's catalog view; the operator Skills page is unchanged.
