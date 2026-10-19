# Telegram — goblin design

Part of the goblin design spec; the core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md), read first.

## Shared model/thinking selection (ruling 2026-10-06)

All Telegram conversations (rolling DMs, group topics) share one
`telegram.model`/`telegram.thinking` selection, edited in the Settings mini
app separately from root `model`/`thinking` (defaults for future **app**
conversations). Telegram never reads retired conversation overrides; an
absent selection in legacy config normalizes to the root values, and config
saves pin it explicitly.

Changes apply next turn without interrupting the current answer. Manual
`/compact` uses Telegram's selection at job execution; automatic/overflow
compaction uses the active turn's captured selection. Delegation spin-offs
snapshot app defaults, not Telegram's model/thinking (history still copies,
per design/app.md).

## Telegram intake & delivery

- grammy long polling; access gated by the two-list model — `operators` and
  `allowedUsers` (Roles and permissions, below) — with guest surfaces
  registering ahead of the gate so summons traffic never hits it (Guest
  mode, below).
- **Coalescing buffer**: rapid-fire messages in one conversation merge into
  one turn. Quiet window **500ms** (ruling 2026-09-25; measured on a live
  7-chunk paste: worst inter-chunk gap 167ms ≈ one public-API long-poll RTT
  of ~185ms — 3× the observed worst); 200–300ms is safe only LAN-side
  (self-hosted bot-api); the 10s dribble ceiling stands. An allowed
  non-command message lands in a SQLite inbox by update id before async
  media work or polling ack; a duplicate never makes a second turn. Boot
  replays pending rows before polling; same-conversation new messages wait
  behind recovered ones (media resolution never blocks polling). A resolved
  batch enters history as one combined user event, and the rows become
  compact tombstones in one transaction, so a failed history write stays
  replayable after a crash. A history-committed turn doesn't rerun after a
  model crash (the half-run rule); a journal failure stops polling rather
  than acking input held only in RAM; WAL/FULL survives power loss. This
  protects future updates, not input lost before the inbox existed. An
  `edited_message` is not a second message (ruling 2026-10-13): while the
  original coalesces, the edit amends buffered text in place — journaled
  `payload_json` included — in the lane chain behind the original's media
  push, bounded by the row's pending state; after commit it's ack-and-log,
  the landed turn's history being the record. A media swap
  (`file_unique_id` moved) is a different message.
- **Delivery**: `streamText` deltas → throttled edits (~1/s), final flush on
  completion, typing while the turn runs; errors post a short message and
  log detail. Flood control once, at the api layer: one transformer waits
  out a 429's `retry_after` (bounded wait, capped retries) and retries the
  same call; the drain awaits its in-flight send chain, so a resolved wait
  never ticks its stagnant ladder — past the cap the 429 propagates. A
  definite send failure may retry/fall back; a sendMessage timeout is
  ambiguous (the request may still land) — never resend: stop chunks/drain
  and completion reaction, log address and uncertainty, best-effort send
  "delivery uncertain—check Telegram before retrying" only while the turn
  holds authority. Never retry the notice; fencing suppresses it. A
  sendVoice timeout likewise stops voice with no text fallback, same
  notice.
- **Reply ratings**: a clean-completed reply's last bubble carries 👍/👎
  with the 🔊 in one `editMessageReplyMarkup` (whole-keyboard replacement).
  Same gate as the 🫡: errors, fenced, voice-mode, and guest replies get
  none (a guest tap can't pass the allowed-user gate — the button would
  spin forever). A tap appends a `reply_ratings` row — conversation id,
  reply anchor seq, chat/message ids, vote, timestamp; changes append,
  reads latest-wins; the payload self-describes the target
  (`rate:<vote>|<conversation>|<anchor>`), so a pre-restart tap still
  records. **Record-only by ruling**: nothing consumes the rows — model
  view, history, FTS, memory, reviewer; a consumer needs a ruling first.
- **TTS**: default-on — absent config means
  `tts: {kind: "edge", voice: "en-US-AriaNeural"}`; `tts: ""` is
  explicit off (parses to `false`; a whole-file rewrite can't lose it).
  Kinds: `edge` (read-aloud websocket —
  no auth, unofficial, can break); `openrouter` (`POST /api/v1/audio/speech`
  — JSON `model`, `input`, `voice?`, `response_format`; raw mp3; via its
  `auth` record); `logfare` (same call at `logfare.ai/v1/audio/speech`
  minus `response_format` — mp3 default; Deepgram Aura catalog,
  `aura-2-en` default; doc-pinned, unverified live); `mimo` (Xiaomi's
  `api.xiaomimimo.com/v1/chat/completions`, `api-key` header — target text
  as an `assistant` message, `audio:{format:"mp3", voice?}` a built-in id:
  `mimo_default`, Mia, Chloe, Milo, Dean, 冰糖, 茉莉, 苏打, 白桦 — blank
  takes the model default; base64 in
  `choices[0].message.audio.data`; doc-pinned, unverified live —
  voice-design/voice-clone roles not exercised). Failures warn + a short
  chat message, never a turn failure; the tap answers immediately
  (callbacks expire in seconds). Three doors into one `synthesizeSpeech`:
  the `speak` tool (text or file path, in-stream via the sink; `tts.voices`
  alternates get a per-call `voice` zod-validated against the allowlist —
  Edge derives language from the voice name, so alternates are alternate
  languages), a 🔊 button on a completed reply's last bubble, and `/voice`
  mode (below). Over ~10k chars chunks at sentence boundaries inside the
  module — a sanity guard, never control flow. Button text strips the
  tool-status tail, code blocks, long URLs, and markdown (`speakable`).
  One ffmpeg pipe to ogg/opus — Edge WebM/Opus losslessly, cloud mp3
  re-encoded — a real voice-note bubble; the probe runs at boot (always),
  plus libopus for cloud kinds (re-encode dies per chunk without it); a
  failed probe takes TTS down for the run with a boot warning (install
  ffmpeg, restart), never per-message failures. `record_voice` during
  synthesis. The button voices the *whole* reply (bounded in-memory send
  map; a miss degrades to the bubble's text, warn-logged); no button in
  voice mode. `speak` picks per call; `/voice` and the 🔊 sniff speakable
  text and cast from `voice` + `voices` (one cast list, three consumers;
  `voice` when unclear/unmatched); edge-only cast — cloud ids carry no
  language, so those arms speak their one configured voice (or the model
  default) regardless of language.
- **Files**: `send_file` names, it does not send: the tool hands a
  workspace path (+ optional caption) to the turn's delivery sink
  (`sink.onFile`), which owns the Telegram call, so "Telegram send is
  delivery, not a tool" holds and sends ride the same chain and fencing as
  text — a `/stop`'d turn can't emit one. Magic bytes decide, never the
  extension: images as photo previews, everything else as documents;
  `as_file` forces the document path (sendPhoto re-encodes; documents are
  byte-exact); GIFs always ride it (sendPhoto strips animation). From disk
  (no whole-file buffering), capped at the local bot-api's 2GB upload
  ceiling.
- **Voice mode**: `/voice` toggles voice-note replies per conversation — a
  settings command like `/memory on|off` (epoch bump and all), so a turn
  never switches medium mid-flight. On, delivery skips streamed text:
  typing, `record_voice` during synthesis, the reply as voice notes; the
  record keeps the text, so toggling off loses nothing and "what did you
  say verbatim" stays answerable. Code blocks and long URLs are sent as a
  plain text message alongside the audio. A voice-mode topic plus
  voice-note transcription is fully ears-in-ears-out.
- **Mini Apps**: HTTP on localhost; pages linked via `web_app` buttons.
  Telegram requires HTTPS and the *client device* fetches the page, so the
  door is config (`publicUrl`) and nothing assumes a public IP. Zero-open-
  port reference doors: `tailscale serve` (tailnet HTTPS, auto cert),
  `tailscale funnel` (public HTTPS via Tailscale's edge), or any reverse
  proxy with a cert — NAT-first by construction. **One client, two doors
  (ruling 2026-10-10):** the Telegram door serves the same `app/dist`
  bundle the PWA runs at `/t/settings` and `/t/memory`, in **telegram
  mode** — operator surface only: no conversation rail, no chat, no
  composer. The plain-JS page it replaced is gone; git owns that history.
  Auth is unchanged — initData per request via `x-init-data`, the same
  `validateInitData`, the same `via: "mini-app"` actor — so the
  self-lockout guard (the door refuses to drop the *requesting* Telegram id
  from `operators`) works where the app door's empty-list guard cannot.
  Tails mirror the app door — `/api/settings` ↔ `/api/app/settings`,
  `/api/memory/status` ↔ `/api/app/memory/status`; only prefix and auth
  header differ (legacy `/api/config` and `/api/memory-status` died with
  the old page). Settings writes keep the ETag/If-Match stale-save refusal
  (design/app.md → Operator console). The menu button points at
  `{publicUrl}/t/settings`; `/` redirects to `/app/` with a *relative*
  Location — the #105 rule: never bounce off a Host the backend guessed.
  Telegram mode never touches the app door (no token probe, no conversation
  calls), and opened outside Telegram (empty initData) shows a notice, not
  a form that cannot save. `telegram-web-app.js` is never fetched: both
  doors are one origin, the app token lives in that origin's
  sessionStorage (dies with the tab), and no third-party script — live,
  and per ruling 2026-10-13 not even a pinned copy — executes there.
  Injected `window.Telegram` is used as-is; Telegram Desktop does not
  inject, so `app/src/telegram.ts` stands in when the object is absent
  (ruling 2026-10-13), parsing `tgWebAppData` from the URL hash — the
  transport the official script reads — and posting `web_app_ready`/
  `web_app_expand` through the bridges in official precedence
  (TelegramWebviewProxy → external.notify → parent-frame postMessage); a
  hash without it keeps initData empty — same notice. In-door navigation is
  component state with no history entries; the back gesture closes the mini
  app natively. Draft protection: the in-door confirm guards page switches,
  and the draft arms `WebApp.enableClosingConfirmation` — disarmed on save,
  approved discard, and unmount, so the guard never outlives its draft. A
  missing build fail-louds a 500 + log line exactly like `/app/*`;
  settings-from-Telegram depends on the app build (deploy.sh gates it,
  rollback rebuilds it; accepted by ruling). Widening the page set later
  (status, delegations) is one server route line plus the client's page
  filter — deliberately not claimed now.
- **Commands** are few on purpose: `/voice` `/memory` `/forget` `/stop`
  `/compact`. `/model` and `/think` are retired — the mini app owns model
  and thinking settings. No conversation-lifecycle commands — group topics
  and the DM's gap rule own that. `/start`, the one exception, gets a
  canned greeting (consumed before intake, never a model turn) and stays
  hidden from the command menu.
- **Large files**: self-hosted `telegram-bot-api` on the prod box,
  `--local` mode, grammy `apiRoot` → `http://127.0.0.1:8081`. Needs
  `api_id`/`api_hash` from a my.telegram.org app registration (operator
  account, secrets — "Little Goblin", api_id 955258, minted for the v1 e2e
  harness, in `little-goblin/e2e/.env`); one app-platform cred for all
  instances, dev/prod split on bot token + server instance. No inbound
  ports — long-poll only; its only client is goblin on the same box.
  `getFile` returns an absolute local path — intake reads it off disk, no
  HTTP fetch; uploads ≤2GB; `file://` sends. The working dir is a staging
  cache, not storage — Telegram owns the files; periodic clean is safe
  (worst case = re-fetch via `file_id`). Deploy: static binary + systemd
  unit (no docker), built off-box — the TDLib compile is heavy. **Status:
  designed, not deployed.** No `telegram-bot-api` runs anywhere — goblin
  polls the cloud Bot API, 20 MB cap in effect. `telegram.apiRoot` and the
  intake path exist and work; the rest is the server, its unit, and fresh
  `api_id`/`api_hash` (the v1 `e2e/.env` copy died with v1's tree — mint
  at my.telegram.org).

## Rolling DM (ruling 2026-10-03)

The app holds deliberate, named conversations (the chatgpt.com shape); the
DM is the quick lane — one-off questions, web lookups, small chats — one
long chat, no topics. A forever-conversation drags stale, expensive context
into unrelated questions, so the DM is a **rolling address**: a sequence of
conversations, one current, split by quiet gaps. It rolls for every
admitted class (2026-10-11): operators personal, `allowedUsers` standing
sandbox (`persona: guest`, memory-excluded, `search` only — Roles and
permissions); the gap check is routing machinery, the same for both.

**Why gaps, and why not just a timer.** Caching moots it — z.ai's prefix
cache is mostly gone by ~8 minutes and fully cold past ~13 (measured
2026-10-03, small sample) — so a long gap re-reads 30–40k tokens at full
price and drags the old subject along. Hermes's idle (24h) + daily (4am)
resets were defaulted off ("surprise context loss hurts more than it
helps") then removed after resurrected sessions — surprise was the failure.
Goblin recovers better: recall plus `history_search` makes a wrong fresh
start a "no, the earlier thing" away, not amnesia; the rules below keep it
unsurprising.

**The rule.** Per DM burst (post-coalescing, pre-admission):

1. **Within the gap** — last event (either side: message, reply, program
   fire, spin-off ping) younger than `telegram.dmGapMinutes` (config,
   default 45, on the settings page): join, no check; mid-turn bursts
   steer.
2. **Swipe-reply** — `reply_to_message` joins the current conversation, no
   check, carrying the replied-to text as a quoted part (head-cut, like the
   check's state) — a reply from an older conversation must still say what
   "this" is. (A reply to a spin-off ping routes to the app conversation —
   App channel → Spin-off.)
3. **Past the gap** — no assistant reply yet (a `/new` nobody spoke into, a
   first burst awaiting its answer): join — nothing to weigh, and rolling
   would orphan a fragment behind a second boundary marker. Else the
   follow-up check: follow-up → current; new subject → fresh current.
4. **No current conversation** (first message ever, or after cutover) →
   fresh, no check.

A fresh conversation starts empty — system prompt, admission-time recall,
the burst; memory and `history_search` are the bridge, by design.

**The follow-up check.** One System One `noul` call on the shared client
(`design/system1.md`; exists with `system1` or `reviewer` configured).
State: `{gapMinutes, previous: {user, assistant}, next}` — last user
message, last assistant reply, incoming burst; text only (attachments as
`[photo]`, `[voice: <transcript>]`, `[file: <name>]`), head-cut at 2000
chars. Question (id `follow_up`):

- instructions: "The operator messaged their personal assistant after
  a quiet gap. Decide whether the new message continues the previous
  exchange or starts a new subject."
- true: "The new message continues the previous exchange: it refers
  back to it (a pronoun, ellipsis, or 'and also' that only makes sense
  with it), answers a question the assistant asked, or asks more about
  the same subject."
- false: "The new message starts a new subject: it is understandable
  on its own and is not about the previous exchange."

Fresh only when `p(follow_up) < 0.3` — a wrong continuation costs one cold
read, while a wrong fresh start is the surprise above; every check logs its
probability. **Failure** (no client, `System1Error`, timeout) →
follow-up, warn-logged; the shared client retries once on its backup model
inside the same 3 s budget (`design/system1.md` → common retry policy), and
the original deadline bounds fake gates — no abandoned 30 s request
continues.

**The marker.** Fresh-conversation delivery sends `— new conversation —`
before admission work (recall, thinking) — first, so the boundary shows
before the answer. Delivery, not history (in neither conversation's
events); the `dm rolled` line records it.

**Settings stay per conversation** (operator ruling): `/voice` and
`/memory` belong to the conversation they were set in; a fresh one starts
at the defaults. A settings command arriving past the gap rolls first (no
check — a command is not a follow-up), landing on the conversation about to
happen. `/stop` and `/compact` act on the current conversation and never
roll.

**Manual DM navigation (operator ruling, 2026-10-05).** `/new` stops the
current turn and queued reviews, then creates a fresh current conversation
immediately — no check, even while busy. `/back` stops the turn and returns
to the conversation it was started from; repeated `/back` walks further
back; at the first conversation or with no current one, it reports there
is no earlier conversation and changes nothing.
DM-only; group topics get an explanatory reply; both appear in the slash
menu.

Histories, settings, compactions, and recall contexts stay intact; nothing
replays or copies — the operator resends after navigating. A new
conversation records its predecessor (existing ones get creation-order
links at migration). `/back` follows that link, not the id counter —
`/back` → `/new` → `/back` returns to the source, and ids never reuse an
abandoned conversation. Deleted ordinals aren't re-minted either: the epoch
tombstone (`conversation_epoch_hwm`) outlives the row, so a pointer-less
roll (demotion reset, reinstall) recovers the high-water mark from extant
rows plus tombstones and mints `hwm + 1`. Selecting an old conversation
resets the quiet-gap clock without rewriting historical timestamps;
selection and creation/link writes are atomic.

Commands bypass slow media intake, as `/stop` does. Pending input is
durably assigned to the outgoing conversation as history-only — it may
finish later but never starts a turn or enters the new selection;
post-command input follows the pin. Admission re-reads the assignment after
every routing/delivery await, including a held check or marker send, so
archived input can't roll the pin. Navigation commands dedupe by update and
chat/message identity; assignments, receipt, selection, and the outgoing
epoch fence commit together, with aborts, queued-work cleanup, and review
cancellation synchronous after the commit — never inside a rollback-able
transaction. A persistence failure stops acknowledgement, not silent loss;
a command addressed to another bot routes nothing.

A coalesced batch can hold multiple archive destinations and normal input.
If a later append fails after an earlier group commits, retry filters
already-committed inbox identities first — never re-appending archived
input or blocking the lane on a completed row.

Delivery acknowledges `/new` with `— new conversation —` and `/back` with
`— previous conversation —`; markers aren't model history. Every manual
transition logs chat address, from/to conversation, command, and whether a
turn/review was stopped.

**DM topics are retired.** Old DM-topic conversations stay in the store —
readable, searchable by `history_search` — never routed to again; any DM
message, thread id or not, resolves to the rolling address, replies to the
main chat. Programs pinned to DM topics were re-pinned at cutover (one-off,
logged per program); group topics untouched. **Unverified:** whether
BotFather's threaded mode must be off for the DM to render as a plain chat,
and whether a threadless send behaves while it's on.

**Logging.** `dm rolled` (address, from → to conversation, gap, decided by
`gap|unanswered|busy|reply|command|fire|first|check|fallback`, probability
when checked); `follow-up check` (probability, ms, cost, outcome — never
message text); `dm cutover re-pin` per program.

**Landing rulings (stage 1, 2026-10-03).**
- *Which chats roll:* private chats only, `chatId > 0` (users positive,
  groups negative) — the one test call sites holding a bare id (program
  pins, lane keys) can use.
- *Lanes:* the private-chat intake lane (inbox row, buffer, chain) is keyed
  `dm:<chat>`, routed at flush after coalescing; rolling conversations are
  `dm:<chat>:<n>`; the pre-ruling `dm:<chat>` conversation stays history,
  never current.
- *A live turn always absorbs input* (it steers), whatever the gap.
- *The check has a 3 s interactive deadline* (shared client's usual 30 s,
  raced externally; losing is a fallback); a roll during the check (a fire)
  joins the burst to the new current — never two rolls.
- *Delegation notices join, never roll* (they continue operator-started
  work); program fires roll past the gap.
- *Topic-root replies are not replies:* Telegram marks topic messages as
  replies to the root, so `reply_to_message` is ignored — else every burst
  skips the check.

## Roles and permissions (ruling 2026-10-11)

The unit of trust is the person, not the chat. Two config lists:
`operators` (min 1 — the operator's own accounts) and `allowedUsers` (may
be empty — people the operator names). Everyone else is a stranger, never
served: **every summons gets one short refusal line and nothing else** — no
turn, no conversation, no state, no meter. The fixed line ("🚫 I only talk
to my operator and approved users.") fires on every summons surface: bot
DM, a member-chat @mention or reply-to-goblin, and the guest surface
(settled into the placeholder). Ambient non-operator group chatter is not a
summons — dropped with `group message dropped — not operator`, no reply.

| who | bot DM | member group | guest surface | app doors |
|---|---|---|---|---|
| `operators` | personal, rolling | any message → the room's standing personal lane | personal guest turn | yes |
| `allowedUsers` | standing sandbox: rolling, `persona: guest`, memory-excluded, `search` only | @mention/reply → sandbox guest turn in their own `guest:` conversation; plain message dropped | sandbox guest turn | no |
| stranger | refusal line | @mention/reply → refusal line; plain message dropped | refusal line | no |

**Only operators reach normal intake.** Non-operators reach the bot through
guest summons or not at all — an allowed user's plain group message must
never fall into the room's standing conversation, the operator's personal
lane. This ruling deletes the 2026-10-06 chat-trust machinery: `/open`,
`/off`, the `guest_open_chats` row, epoch fencing, and the per-user daily
budget (`perUserDailyTurns`) — strangers are never served, so room trust
has nothing to admit and the meter nothing to count. Two lists plus a
refusal line is the whole model. The `guest` block stays the sandbox class
switch (absent → operator-only; non-operator summons get the refusal
wherever intake still runs). Settings and privileged commands (`/voice`,
`/memory`, `/forget`, `/compact`) are operator-only by sender, checked
before routing or conversation creation; approval grants sandbox chat, not
command authority.

**Sandbox class invariants.** Persona follows class at conversation
creation; the tool filter is **persona-driven** — any conversation pinned
`persona: guest` gets `SANDBOX_TOOLS` (`search` only) whatever channel it
lives on: the guard is the persona column, not the address shape (a channel
check would hand a persona-pinned DM the full toolset). Sandbox
conversations are memory-excluded by construction, capped per reply by
`guest.outputChars` on the guest surface, **uncapped in turn count** (ruling
2026-10-11 — the named list is small and vouched for), and reactive only:
no bell, pings, program hooks, or mail authority. The PWA door is
tailnet/token; the mini app door validates initData against `operators`;
config saves carry the self-lockout guard on `operators` (design/app.md →
Operator console).

**Config.** `operators: number[]` (min 1) + `allowedUsers: number[]`
(default `[]`), editable in the app's config editor. The legacy single
`allowedUsers` key meant operator class; migration is a hand-edit at deploy
(`allowedUsers: [x]` → `operators: [x]`, `allowedUsers: []`) — no code
migrates it, and an unmigrated file fails boot loud naming the key.

**The mid-flight recheck is DM-scoped.** The gate's verdict is intake-time
truth; a save during coalescing is re-adjudicated at flush, but only where
the lane names the person — a private chat's lane key IS the sender's id,
so a demotion drops the batch (refusal line, tombstoned rows) before
routing. Topic/group batches carry no sender identity (the journaled
payload records the room's chat id, not `from.id`), so a demoted operator's
coalesced group input still runs. Accepted residual: the window is the
coalescing delay; closing it means journaling `from.id` per inbox row.

## Guest mode (ruling 2026-10-06)

Goblin answers in third-party chats, summoned by mention:

- **Guest summons** — `@goblin …` where the bot is *not* a member arrives
  as `guest_message`: the summoning message plus the one it replied to,
  nothing else (no history, no participant list). One reply per summons:
  `answerGuestQuery` fires a placeholder article immediately; the returned
  `inline_message_id` is the delivery surface (streamed `editMessageText`,
  standard ~1/s throttle). One message only — no multi-bubble chunking,
  files, or voice; capped `guest.outputChars` (default 3500), with an
  explicit truncation notice pointing at the bot DM.
- **Member mentions** — mentions and replies-to-goblin from third parties
  in chats the bot *is* a member of route to a guest turn with the
  **normal delivery sink** (multi-bubble streaming, reactions); the bot may
  speak like any member. The operator's own messages there are allowed-user
  traffic: ordinary intake, a standing conversation in that chat, full
  agent, no guest machinery.

**The unit of trust is the person** (Roles and permissions, 2026-10-11 —
the earlier chat-trust machinery is deleted there). Summonses classify by
the two lists alone; a stranger's summons gets the refusal line, settled
into the placeholder where there is one. Group privacy mode stays ON
deliberately: the bot receives only mentions/replies in member chats,
mirroring guest mode's no-history property.

**Three classes, decided per summons, enforced by hard exclusion** (Roles
and permissions, above). `from.id ∈ operators` (read live; the BotFather
platform restriction is OFF, so goblin owns every gate) → a *personal*
guest turn: the normal persona (SOUL et al.), told **other people can read
the chat** — guest replies are public to the room; be deliberate before
surfacing private material — with the personal toolset minus everything
that pins, reaches beyond the chat, or changes medium: `program`, `mail`,
`delegate`, `memory_search`, `history_search`, `speak`, `send_file` never
register (one ruling everywhere, even where the member surface's sink could
deliver them). `from.id ∈ allowedUsers` → a *sandbox* turn: a **guest
persona** prompt (no SOUL.md, no USER.md, no skills — nothing private in,
nothing about the operator out) and a toolset of `search` only —
constructed, never a prompt-level promise. **No sandbox `fetch` (ruling
2026-10-09, rollout-hold review).** Personal `fetch` carries no SSRF policy
(design/web.md) — its premise (the caller has `bash`, so `fetch` adds no
reach) is what the sandbox removes; a complete guest check would deny
loopback/private/link-local and DNS-resolved addresses across every
redirect hop and pin the verified connection (verify a public address,
connect to `127.0.0.1`), but Bun's `fetch` has no custom resolver and
resolve-then-check without pinning is DNS-rebindable. Incomplete is worse
than none — the tool is out entirely, returning only as a designed feature,
never by re-extending the personal one. A busy guest conversation gets one
refusal line, never a steer — a steered reply would land in another
summoner's message.

**Identity and record.** Guest conversations are keyed
`guest:<chatId>:<Id>` — per chat per summoner, so reply chains and budgets
scope to a person and the operator's summons never share a thread with a
friend's. Summonses are discrete: no coalescing, no rolling — each is one
turn; reply context arrives as a quoted part (the swipe-reply shape,
head-cut). All guest conversations are `memory_excluded` by construction: no
recall, no distillation, no skill review (the reviewer kill-switch coupling
is deliberate), and out of FTS — off the record entirely. A `persona`
column (`personal` | `guest`) freezes the prompt class at creation — guest
conversations and allowed users' standing DMs alike — and drives the
sandbox tool filter; a later class flip (an `operators`/`allowedUsers`
edit) busts the frozen prompt snapshot with the persona, both directions —
a demoted caller must never keep the personal persona's bytes.

**Intake plumbing.** Guest handlers register **before** the access gate,
and summons traffic never hits it. The gate is the Roles router's
member-surface edge: operators pass to normal intake, allowed users pass in
the bot DM to their sandbox lane, a stranger DM gets the refusal line,
non-operator group chatter drops with one log line. The refusal send is
detached — the update is denied synchronously while the send rides a
bounded pool (8 pending, deduped per sender, 30s abort); overload drops the
send with a log line, never queues a backlog and never stalls polling.
`guest_message` updates bypass `tg_inbox` entirely (guest message ids share
no namespace with the bot's chats — a `UNIQUE(chat_id, message_id)` hit
would exit the process); at-most-once rides a `guest_dedup(update_id)`
insert-or-ignore instead. Member-surface third-party mentions run the same
dedup then the lightweight guest path (never the coalescing buffer — burst
semantics belong to conversations, not summonses). BotFather toggles are
the operator's: Guest Mode on, Restrict bot usage **off** (zero platform
restrictions; goblin's gates decide everything — stray summonses arrive,
classify deny, and cost one log line and nothing else).

**Audience awareness rides the burst, not the snapshot.** The system prompt
is frozen per conversation (cache stability), so the audience note is a
text part injected at the head of every burst in a group-addressed
conversation (`[note: this is a shared chat — everyone in it can read your
replies…]`, the swipe-reply quoted-part precedent): always current,
append-only, prefix-stable. With the chat-trust machinery gone this covers
every member group — the operator's standing conversation and topics
included; guest conversations need no note (their persona already knows);
private chats never get one: a chat where the bot is a member and the id is
positive *is* the bot DM.

**Logging.** `guest summons` (chat, from, update id, verdict
`personal|sandbox|refused|busy`), `guest answered` (inline message id, edit
count, chars), stranger refusals, non-operator group drops, and every drop
with its reason.

**Probes (unverified, resolve at enablement).** Whether `guest_message`
arrives in Telegram's default update set (else pass explicit
`allowed_updates`); whether member-chat mentions double-fire as both
`message` and `guest_message` (if so, dedupe by chat+message id, preferring
the normal path); the `answerGuestQuery` deadline (placeholder-first makes
it moot); the edit window on guest messages. Media in third-party
summonses is caption text only in v1 — photo intake for the member surface
is a follow-up, not a ruling.

## Formatted replies & draft streaming (ruling 2026-10-12)

Bot API 10.3 adds two primitives: **rich messages** (`sendRichMessage`;
markdown/html/blocks; 32 768-char cap; no edit after send) and **drafts**
(`sendMessageDraft`/`sendRichMessageDraft`; 30-second ephemeral previews
that must be followed by a real send to persist). Probed live 2026-10-12 in
the operator DM: markdown renders, 6 KB passes, `expandable_blockquote`
works on plain sends, both draft variants stream and refresh at ≤15 s.
Rich messages can never be edited.

**Streaming = rich drafts, finalizing = one rich send.** The turn streams
accumulated markdown into `sendRichMessageDraft` (same `draft_id` per turn;
the existing ~1 s throttle is well inside the TTL) and on completion sends
it once via `sendRichMessage`. The preview is the message, formatting
included; the hand-off (draft vanishes, real message lands) is accepted
behavior.

**Typing stays live alongside drafts (ruling 2026-10-14, operator):** the 4 s tick
pings `sendChatAction("typing")` in every mode while the turn runs — drafts
carry content, the chat action carries liveness. Consequences: a landing
real message clears the action, so every mid-turn send (voice note, file,
chunk boundary) re-pings immediately, gated to skip while `record_voice`
owns the status bar and after `onDone`; and the draft TTL keep-alive moves
onto whatever tick is live, so long voice synthesis doesn't let the draft
evaporate mid-turn. The finalizing send carries everything in one call —
`reply_markup` included (ruling 2026-10-13): the completed-turn rating row
goes out on the `sendRichMessage`, not a follow-up `editMessageReplyMarkup`
racing "bubble up" against "buttons on". The premium-gate retry that drops
`message_effect_id` keeps the markup.

**DMs only in v1.** Group and topic conversations keep the current
edit-streaming sink untouched; group rich rendering and reply-threading are
unprobed.

**Guest answers edit into rich (ruling 2026-10-13).** `editMessageText`'s
`text_or_rich_message` accepts an `InputRichMessage` (`{markdown}`) with
`inline_message_id` — the ⏳ is updated in place, never replaced by a second
message. The boundary is the send side: a *sent* rich message can't be
edited, but editing a plain inline message *to* rich is the documented
shape. Live behavior is **unprobed** (types pinned, API not exercised): the
first rejected rich edit flips that sink to plain edits for the rest of the
turn — warn-logged `guest rich edit rejected`, the reply still lands. The
placeholder stays plain text in `answerGuestQuery` — a platform that can't
answer rich would drop the summons at placement, not just the formatting.

**Kill switch, not feature flag.** `telegram.richReplies` (bool, default
true): false restores the plain-text sink verbatim — a phone-only operator
needs a config off-switch if streaming misbehaves, not a code deploy. Any
rich-path failure (draft or send) degrades that turn to the plain path,
logs `reply fallback`, and never loses the reply. Length drain: the
32 768-char cap replaces the 3 800-char chunking for rich sends; the drain
remains as fallback only.

**Reasoning (`telegram.showReasoning`, bool, default false, DMs only).**
When on, reasoning streams into its own draft bubble ahead of the answer
and lands in the final message as a collapsed block above the reply text.
The draft rides the native `InputRichBlockThinking` block (Bot API 10.2);
the final message keeps the probed `<details>` markdown — probe 2026-10-12
pinned the exact collapsible syntax (`<details>/<summary>` renders
collapsed; `<tg-details>` does not parse), and the thinking block itself
cannot be received in messages. Reasoning never renders for guests.

**Buttons and small parts.** Rating 👍/👎 keyboards strip themselves after
a tap (`editMessageReplyMarkup` to empty, `DisabledButton` where layout
should persist); mail approval already does this. `force_reply` is declined
— no in-scope consumer. The drafts never set `can_stop`/`keep_on_stop`
(Bot API 10.3): the client-side stop button is declined (operator ruling,
2026-10-12) — stopping stays the typed `/stop`, and the
`stopped_message_generation` handler remains a tripwire, not a stop path.
Porting the app channel's `ui` tool to Telegram would reverse the
chat-native ruling in design/app.md and needs its own conversation;
explicitly out of scope here.

**Completed-turn salute effect.** A completed DM turn's rich send carries
`message_effect_id` for the 🫡 salute (matching the reaction, which stays
the real marker). The id is pinned against the live API (`EFFECT_ID_INVALID`
on garbage); effects are premium-gated at the receiving chat — the first
`PREMIUM_ACCOUNT_REQUIRED` retries the send once without the param (a 400
is definite, nothing landed) and drops effects for the process lifetime; a
restart re-probes. Multi-image `send_file` bursts share one `sendMediaGroup`
album via a short batch window; documents never wait, and a group timeout
means the album may be live (uncertain, never resent).

**Prompt.** `prompt.ts` already tells the model Telegram messages are
Markdown; implementation updates that line to say markdown *renders*, and
that collapsible blocks are available for long asides.

**Logging.** Per-chunk draft sends stay silent (throttle territory). Per
turn: chosen mode (`rich|plain`), fallback events with the API error, the
final send, and whether a reasoning block was attached. Test seams at the
grammy boundary as everywhere else; pin mode selection, DM gating, the
fallback path, and the config schema.
