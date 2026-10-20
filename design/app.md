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

**Out, explicitly:** mirroring or cross-channel reading of any kind (revisit
needs a ruling here — Spin-off is the one ruled crossing: a copy plus a
bell, not mirroring), app-side push (Telegram stays the bell for its own
conversations and, since Spin-off, app background turns; app-native pushes
wait until demanded), home-screen widgets, in-app voice mode, iOS.
(In-transcript interface blocks are a different thing — Intelligent UI
below.)

## Operator console in the PWA (ruling 2026-10-09)

Operator ask: the PWA becomes the operations surface, because Telegram is
the wrong client for long reads and state edits. Two doors onto one surface
share validation and persistence — a write lands identically either way —
and differ only in the self-lockout guard: the mini app refuses to remove
the *requesting* Telegram id from `operators`, the app door (no requester)
an empty list.

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
app channel gains the `delegate` tool; `program`/`mail` stay Telegram-only.

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
  provenance) — name, state, when first written here; proposed rows carry
  install/discard buttons (ruling 2026-10-17 — the sheet mutates now), the
  same buttons as the global Skills view, installed/gone read-only.

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
needs its own ruling.

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
