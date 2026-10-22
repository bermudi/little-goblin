# Telegram — goblin design

Part of the goblin design spec; the core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md), read first.

## Channel availability (ruling 2026-10-22)

`telegram.enabled` is an explicit boot-pinned channel switch; absent stays
`true` for legacy configs. When `false`, startup resolves no bot token,
constructs no bot, starts no polling or Mini-App authentication, and mounts
no Telegram delivery/private-DM seam. `/app` and `/api/app/*` remain live;
Telegram-targeted wakes, notices, approvals, mail presentation, and resume
requests return an explicit channel-disabled result rather than submitting a
turn without an output door. `operators: []` is legal only in this mode.

## Shared model/thinking selection (ruling 2026-10-06)

All Telegram conversations (rolling DMs, group topics) share one
`telegram.model`/`telegram.thinking` selection, edited in the Settings mini
app, separate from root `model`/`thinking` (defaults for future **app**
conversations). Telegram never reads retired conversation overrides. Changes
apply next turn without interrupting the current answer.

## Telegram intake & delivery

- **Coalescing buffer**: rapid-fire messages merge into one turn; quiet
  window **500ms** (ruling 2026-09-25; measured on a live 7-chunk paste:
  worst inter-chunk gap 167ms ≈ one public-API long-poll RTT ~185ms — 3×
  the observed worst); 200–300ms is safe only LAN-side (self-hosted
  bot-api). The half-run rule holds: a committed turn doesn't rerun after a
  model crash — protecting future updates, not input lost before the
  journal existed. A duplicate never makes a second turn; an
  `edited_message` is not a second message (ruling 2026-10-13): while the
  original coalesces the edit amends buffered text in place, after commit
  it's ack-and-log. A `file_unique_id` swap is a different message.
- **Delivery**: a sendMessage timeout is ambiguous — the request may still
  land — **never resend**: stop the turn and best-effort send a "delivery
  uncertain" notice (fencing suppresses retries); a sendVoice timeout
  likewise stops voice, no text fallback. Flood control: a 429's
  `retry_after` is waited out once (bounded), then the 429 propagates.
- **Reply ratings**: 👍/👎 and the 🔊 ride a clean-completed reply's last
  bubble; errors, fenced, voice-mode, and guest replies get none. The
  callback is only the Telegram adapter over the shared record-only
  `reply_ratings` store (design/app.md → Reply ratings). **Record-only by
  ruling**: nothing consumes the rows — model view, history, FTS, memory,
  reviewer; a consumer needs a ruling first.
- **TTS**: default-on; `tts: ""` is explicit off. `edge` is unofficial
  read-aloud (can break); `logfare`/`mimo` doc-pinned, unverified live.
  Failures warn + a short chat message, never a turn failure; the tap
  answers immediately (callbacks expire in seconds). The boot ffmpeg/libopus
  probe failing takes TTS down for the run (boot warning; install ffmpeg,
  restart). No button in voice mode.
- **Files**: `send_file` names, it does not send — "Telegram send is
  delivery, not a tool": sends ride the same chain and fencing, so a
  `/stop`'d turn can't emit one. Magic bytes decide, never the extension;
  `as_file` forces documents (sendPhoto re-encodes; documents byte-exact;
  GIFs documented — sendPhoto strips animation). Capped at the local
  bot-api's 2GB upload ceiling.
- **Voice mode**: `/voice` toggles per conversation — a settings command, so
  a turn never switches medium mid-flight. The record keeps the text, so
  toggling off loses nothing and "what did you say verbatim" stays
  answerable; with transcription, a voice-mode topic is ears-in-ears-out.
- **Mini Apps**: Telegram requires HTTPS and the *client device* fetches the
  page, so the door is config (`publicUrl`) — NAT-first by construction
  (`tailscale serve`/`funnel`, or any cert'd reverse proxy). **One client,
  two doors (ruling 2026-10-10):** the Telegram door serves the same
  `app/dist` bundle the PWA runs, in **telegram mode** — operator surface
  only (no rail, chat, or composer) — auth unchanged (initData per
  request), and the self-lockout guard works here too (it refuses to drop
  the *requesting* Telegram id from `operators`). **Prohibition (ruling
  2026-10-13):** `telegram-web-app.js` is never fetched — no third-party
  script, live or a pinned copy, executes there; both doors are one origin,
  the app token in its sessionStorage. Telegram Desktop does not inject
  `window.Telegram`; a local shim stands in (ruling 2026-10-13), reading
  `tgWebAppData` from the URL hash and posting `web_app_ready`/`expand`
  via the official bridges. Settings-from-Telegram depends on the app build
  (deploy.sh gates it, rollback rebuilds it; accepted by ruling). `/`
  redirects to `/app/` with a *relative* Location — the #105 rule: never
  bounce off a Host the backend guessed.
- **Commands** are few on purpose; `/model` and `/think` are retired — the
  mini app owns model/thinking. No conversation-lifecycle commands — group
  topics and the DM's gap rule own that. `/start` gets a canned greeting,
  consumed before intake, never a model turn, hidden from the menu.
- **Large files**: self-hosted `telegram-bot-api` on the prod box —
  designed, **not deployed**; nothing runs it and goblin polls the cloud Bot
  API (20 MB cap in effect). Needs `api_id`/`api_hash` from a my.telegram.org
  app registration (operator account, secrets; mint fresh — the v1 copy
  died with v1's tree); one app cred for all instances, dev/prod split on
  bot token + server instance. No inbound ports — long-poll only; `getFile`
  returns an absolute local path; uploads ≤2GB; `file://` sends. The working
  dir is a staging cache, not storage — periodic clean is safe (worst case =
  re-fetch via `file_id`). Deploy: static binary + systemd unit, built
  off-box — the TDLib compile is heavy.

## Rolling DM (ruling 2026-10-03)

The DM is the quick lane — one long chat, no topics. A
forever-conversation drags stale, expensive context into unrelated questions,
so the DM is a **rolling address**: one current conversation, split by quiet
gaps. Every admitted class rolls (operators personal, `allowedUsers`
standing sandbox); the gap check is routing machinery, the same for both.

**Why gaps, and why not just a timer.** Caching moots it — z.ai's prefix
cache is mostly gone by ~8 minutes, fully cold past ~13 (measured
2026-10-03, small sample) — so a long gap re-reads 30–40k tokens at full
price. Hermes's idle+daily resets were removed after resurrected sessions:
surprise was the failure; goblin's recall + `history_search` make a wrong
fresh start a "no, the earlier thing" away.

**The rule.** Per DM burst (post-coalescing, pre-admission): (1) last event
(either side) younger than `telegram.dmGapMinutes` → join, no check;
mid-turn bursts steer. (2) swipe-reply (`reply_to_message`) joins the
current conversation, no check, carrying the replied-to text as a quoted
part — a reply from an older conversation must still say what "this" is.
(3) past the gap: with an assistant reply on record, the follow-up check decides (follow-up →
current, new subject → fresh); with none, join. (4) no current conversation
→ fresh, no check. A fresh conversation starts empty; memory and
`history_search` are the bridge, by design.

**The follow-up check.** One System One `noul` call on the shared client.
Fresh only when `p(follow_up) < 0.3` — a wrong continuation costs one cold
read, a wrong fresh start is the surprise above; every check logs its
probability. **Failure** (no client, `System1Error`, timeout) → follow-up,
warn-logged.

**The marker.** Fresh-conversation delivery sends the boundary marker before
admission work — first, so the boundary shows before the answer; delivery,
not history (in neither conversation's events).

**Settings stay per conversation** (operator ruling): `/voice` and `/memory`
belong to the conversation they were set in; a fresh one starts at the
defaults. A settings command arriving past the gap rolls first (no check — a
command is not a follow-up); `/stop` and `/compact` act on the current
conversation and never roll.

**Manual DM navigation (operator ruling, 2026-10-05).** `/new` stops the
current turn and queued reviews, then creates a fresh current conversation
immediately — no check, even while busy. `/back` stops the turn and returns
to the conversation it was started from; repeated `/back` walks further
back; at the first conversation or with none current it reports none and
changes nothing. DM-only; group topics get an explanatory reply. Nothing
replays or copies — the operator resends after navigating. A new
conversation records its predecessor, and `/back` follows that link, not
the id counter — `/back` → `/new` → `/back` returns
to the source; ids never reuse an abandoned conversation, deleted ordinals
aren't re-minted, and selection resets the quiet-gap clock without rewriting
historical timestamps.

Commands bypass slow media intake; pending input is durably assigned to the
outgoing conversation as history-only — it never starts a turn — and
archived input can't roll the pin. A persistence failure stops
acknowledgement, not silent loss; a command addressed to another bot routes
nothing.

**DM topics are retired.** Old DM-topic conversations stay in the store —
readable, searchable — never routed to again; any DM message resolves to the
rolling address. Programs pinned to DM topics were re-pinned at cutover
(one-off). **Unverified:** whether BotFather's threaded mode must be off for
the DM to render as a plain chat, and whether a threadless send behaves while
it's on.

**Landing rulings (stage 1, 2026-10-03).**
- *Which chats roll:* private chats only, `chatId > 0` (users positive,
  groups negative).
- *Lanes:* the pre-ruling `dm:<chat>` conversation stays history, never
  current.
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

The unit of trust is the person, not the chat. Two config lists: `operators`
(min 1 while `telegram.enabled`; may be empty when the channel is off) and
`allowedUsers` (may be empty). Everyone else is a stranger,
never served: **every summons gets one short refusal line and nothing else**
— no turn, no conversation, no state, no meter — on every summons surface
(bot DM, member-chat @mention or reply-to-goblin, guest surface — settled
into the placeholder). Ambient non-operator group chatter is not a summons —
dropped, no reply.

**Only operators reach normal intake.** Non-operators reach the bot through
guest summons or not at all — an allowed user's plain group message must
never fall into the room's standing conversation, the operator's personal
lane. This ruling deletes the 2026-10-06 chat-trust machinery (`/open`,
`/off`, the `guest_open_chats` row, epoch fencing, the per-user daily
budget): strangers are never served, so room trust has nothing to admit.
Settings and privileged commands (`/voice`, `/memory`, `/forget`,
`/compact`) are operator-only by sender, checked before routing or
conversation creation; approval grants sandbox chat, not command authority.

**Sandbox class invariants.** Persona follows class at conversation
creation; the tool filter is **persona-driven** — any conversation pinned
`persona: guest` gets the sandbox toolset (`search` only) whatever channel it
lives on: the guard is the persona column, not the address shape (a channel
check would hand a persona-pinned DM the full toolset). Sandbox conversations
are memory-excluded by construction, capped per reply by `guest.outputChars`,
**uncapped in turn count** (ruling 2026-10-11 — the named list is small and
vouched for), and reactive only: no bell, pings, program hooks, or mail
authority.

**Config.** Migration from the legacy single `allowedUsers` key (which meant
operator class) is a hand-edit at deploy (`allowedUsers: [x]` →
`operators: [x]`, `allowedUsers: []`) — no code migrates it, and an
unmigrated file fails boot loud naming the key.

**The mid-flight recheck is DM-scoped.** The gate's verdict is intake-time
truth; a save during coalescing is re-adjudicated at flush only where the
lane names the person (a private chat's lane key IS the sender's id, so a
demotion drops the batch before routing). Topic/group batches carry no
sender identity, so a demoted operator's coalesced group input still runs.
Accepted residual: the window is the coalescing delay.

## Guest mode (ruling 2026-10-06)

- **Guest summons** — `@goblin …` where the bot is *not* a member arrives as
  `guest_message`: the summoning message plus the one it replied to, nothing
  else (no history, no participant list). One reply per summons —
  placeholder-first, then streamed into — one message only: no multi-bubble
  chunking, files, or voice; capped at `guest.outputChars`, with an explicit
  truncation notice pointing at the bot DM.
- **Member mentions** — mentions and replies-to-goblin from third parties in
  chats the bot *is* a member of route to a guest turn with the **normal
  delivery sink**; the bot may speak like any member. The operator's own
  messages there are ordinary intake: a standing conversation in that chat,
  full agent, no guest machinery.

Summonses classify by the two lists alone; a stranger's summons gets the
refusal line, settled into the placeholder where there is one. Group privacy
mode stays ON deliberately: the bot receives only mentions/replies in member
chats, mirroring guest mode's no-history property.

**Three classes, decided per summons, enforced by hard exclusion.**
`from.id ∈ operators` (read live; the BotFather platform restriction is OFF,
so goblin owns every gate) → a *personal* guest turn: the normal persona,
told **other people can read the chat** — be deliberate before surfacing
private material — with the personal toolset minus everything that pins,
reaches beyond the chat, or changes medium (one ruling everywhere, even
where the member surface's sink could deliver them).
`from.id ∈ allowedUsers` → a *sandbox* turn: a **guest persona** prompt (no
SOUL.md, no USER.md, no skills — nothing private in, nothing about the
operator out) and a toolset of `search` only — constructed, never a
prompt-level promise. **No sandbox `fetch` (ruling 2026-10-09).** Personal
`fetch`'s premise (the caller has `bash`) is what the sandbox removes, and
Bun's `fetch` can't do the pinned verification a complete guest check needs
(no custom resolver; resolve-then-check is DNS-rebindable). Incomplete is
worse than none — the tool is out entirely, returning only as a designed
feature, never by re-extending the personal one. A busy guest conversation
gets one refusal line, never a steer — a steered reply would land in another
summoner's message.

**Identity and record.** Guest conversations are keyed per chat per
summoner — reply chains and budgets scope to a person, not the room.
Summonses are discrete: no coalescing, no rolling — each is one turn. All
guest conversations are `memory_excluded` by construction: no recall, no
distillation, no skill review (the reviewer kill-switch coupling is
deliberate), out of FTS — off the record entirely. A `persona` column
freezes the prompt class at creation — guest conversations and allowed
users' standing DMs alike — and drives the sandbox tool filter; a later
class flip busts the frozen prompt snapshot with the persona, both
directions — a demoted caller must never keep the personal persona's bytes.

**Intake plumbing.** Guest handlers register **before** the access gate, and
summons traffic never hits it. The refusal send is detached — overload drops
it with a log line, never a backlog, never stalling polling. BotFather
toggles are the operator's: Guest Mode on, Restrict bot usage **off**;
goblin's gates decide everything.

**Audience awareness rides the burst, not the snapshot.** The system prompt
is frozen per conversation (cache stability), so the audience note is a text
part injected at the head of every burst in a group-addressed conversation —
always current, append-only, prefix-stable — covering every member group,
the operator's standing conversation and topics included; private chats
never get one: a chat where the bot is a member and the id is positive *is*
the bot DM.

**Probes (unverified, resolve at enablement).** Whether `guest_message`
arrives in Telegram's default update set (else pass explicit
`allowed_updates`); whether member-chat mentions double-fire as both
`message` and `guest_message` (dedupe by chat+message id if so); the
`answerGuestQuery` deadline (placeholder-first makes it moot); the edit
window on guest messages. Media in third-party summonses is caption text
only in v1 — photo intake for the member surface is a follow-up, not a
ruling.

## Formatted replies & draft streaming (ruling 2026-10-12)

Bot API 10.3 adds two primitives: **rich messages** (`sendRichMessage`;
markdown/html/blocks; 32 768-char cap; no edit after send) and **drafts**
(30-second ephemeral previews that must be followed by a real send to
persist). Probed live 2026-10-12 in the operator DM: markdown renders, 6 KB
passes, `expandable_blockquote` works on plain sends, both draft variants
stream and refresh at ≤15 s. Rich messages can never be edited.

**Streaming = rich drafts, finalizing = one rich send.** Markdown streams
into a draft and completion sends it once via `sendRichMessage`; the preview
is the message, formatting included; the hand-off (draft vanishes, real
message lands) is accepted behavior.

**Typing stays live alongside drafts (ruling 2026-10-14, operator):** the
tick pings typing while the turn runs — drafts carry content, the chat
action carries liveness; the draft's TTL keep-alive rides whatever tick is
live, so long voice synthesis doesn't let the draft evaporate mid-turn. The
finalizing send carries `reply_markup` (ruling 2026-10-13): the rating row
goes out on the `sendRichMessage`, not a follow-up `editMessageReplyMarkup`
racing "bubble up" against "buttons on".

**DMs only in v1.** Group and topic conversations keep the current
edit-streaming sink untouched; group rich rendering and reply-threading are
unprobed.

**Guest answers edit into rich (ruling 2026-10-13).** `editMessageText`'s
`text_or_rich_message` accepts an `InputRichMessage` (`{markdown}`) with
`inline_message_id` — the placeholder is updated in place, never replaced by
a second message; the boundary is the send side (a *sent* rich message can't
be edited). Live behavior is **unprobed**, types pinned: the first rejected
rich edit flips that sink to plain edits for the rest of the turn —
warn-logged, the reply still lands. The placeholder stays plain text — a
platform that can't answer rich would drop the summons at placement.

**Kill switch, not feature flag.** `telegram.richReplies` false restores
the plain-text sink verbatim — a phone-only operator needs a config
off-switch if streaming misbehaves, not a code deploy. Any rich-path failure
(draft or send) degrades that turn to the plain path and never loses the
reply.

**Reasoning (`telegram.showReasoning`, default false, DMs only).** When on,
reasoning streams into its own draft bubble ahead of the answer and lands in
the final message as a collapsed block above the reply text. Probe
2026-10-12 pinned the exact collapsible syntax: `<details>/<summary>`
renders collapsed, `<tg-details>` does not parse; the native thinking block
cannot be received in messages. Reasoning never renders for guests.

**Buttons and small parts.** `force_reply` is declined — no in-scope
consumer. The drafts never set
`can_stop`/`keep_on_stop` (Bot API 10.3): the client-side stop button is
declined (operator ruling, 2026-10-12) — stopping stays the typed `/stop`,
and the `stopped_message_generation` handler remains a tripwire, not a stop
path. Porting the app channel's `ui` tool would reverse the chat-native
ruling in design/app.md — its own conversation; out of scope here.

**Completed-turn salute effect.** A completed DM turn's rich send carries
`message_effect_id` for the 🫡 salute (the reaction stays the real marker);
the id is pinned against the live API (`EFFECT_ID_INVALID` on garbage).
Effects are premium-gated at the receiving chat — the first
`PREMIUM_ACCOUNT_REQUIRED` retries the send once without the param (a 400 is
definite, nothing landed) and drops effects for the process lifetime;
restart re-probes. Multi-image sends share one album; documents never wait;
a group timeout means the album may be live (uncertain, never resent).
