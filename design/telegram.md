# Telegram — goblin design

Part of the goblin design spec. The core — domain model, authority rule,
cache stability, non-goals — is [`DESIGN.md`](../DESIGN.md); read it first.

## Telegram intake & delivery

- grammy long polling; the `allowedUsers` config key gates access first thing.
- **Coalescing buffer**: rapid-fire messages in one conversation merge into
  one turn. Real product value in v1 — but its 1.5s quiet window was
  inherited, never measured, and it is a flat latency tax on every
  single-message turn. Ruled 2026-09-25 from a live 7-chunk paste: worst
  inter-chunk gap 167ms ≈ one long-poll RTT to the public Telegram API
  (~185ms from this box) — poll-boundary straddles, not client pacing — so
  the window is **500ms** (3× observed worst) while polling the public API.
  RTT-sized gaps are structural there; 200–300ms becomes safe only when
  polling goes LAN-side (self-hosted bot-api). The 10s dribble ceiling
  stands. An allowed, non-command Telegram message is recorded in a
  SQLite inbox by update id before asynchronous media work or polling
  acknowledgement. A duplicate update never makes a second turn. At
  boot pending rows are queued for replay before polling starts; media
  resolution does not block polling, but new messages in the same
  conversation wait behind recovered ones. Once the batch resolves,
  the combined user event enters history and the inbox rows become
  compact tombstones in one transaction. A failed history write leaves
  rows replayable after a crash. A history-committed turn does not rerun
  after a model crash (the normal half-run rule). A journal failure
  stops polling rather than acknowledging input held only in RAM. This
  store connection uses WAL/FULL so an acknowledged journal commit also
  survives a host power loss. This protects future updates, not input
  lost before the inbox was deployed.
- **Delivery**: `streamText` deltas → throttled message edits (~1/s), final
  flush on completion. Typing indicator while a turn runs. Errors post a short
  message and log structured detail. A definite Telegram send failure may
  retry/fall back; a sendMessage timeout is ambiguous (the abandoned request
  may still land), so never resend that content. Stop the remaining text
  chunks/drain and completion reaction, log the address and uncertainty, and
  best-effort send a distinct "delivery uncertain—check Telegram before
  retrying" notice only while the turn still holds authority. Never retry
  the notice itself. In voice mode a sendVoice timeout likewise stops voice
  output without falling back to duplicate text; use the same notice.
  Fencing suppresses any new output, including the notice.
- **TTS**: default-on — absent config means
  `tts: {kind: "edge", voice: "en-US-AriaNeural"}`; `tts: ""` is the
  explicit off (it parses to `false` so the mini app's whole-file
  rewrite can't silently lose it and reload as on). The service is the
  Edge read-aloud websocket (no auth, unofficial, it can break; failures
  surface as a warn + a short chat message, never a turn failure — the 🔊 tap is
  answered immediately because Telegram expires callback queries in
  seconds and synthesis outruns them, so an outcome can't ride the
  toast). Three doors into
  the same `synthesizeSpeech`: the `speak` tool (text or file path, sent
  in-stream via the sink — and, when `tts.voices` configures alternates, a
  per-call `voice` zod-validated against that allowlist; Edge derives the
  language from the voice name, so alternate voices are alternate
  languages), a 🔊 button stamped on a completed reply's
  last bubble, and `/voice` mode (below). Input over ~10k chars is
  chunked at sentence boundaries inside the module — the cap is a sanity
  guard, never a control-flow path the model must recover from. Button
  text is stripped of the tool-status tail, code blocks, long URLs, and
  markdown before synthesis (`speakable`); tool input is already authored
  for speech. Edge's supported
  WebM/Opus stream is remuxed losslessly through ffmpeg to ogg/opus — a real
  voice-note bubble, not an audio-file card. ffmpeg is probed at boot —
TTS is default-on, so always; a failed probe takes TTS down for the run
with a boot warning (install ffmpeg and restart to re-enable) instead of
failing message by message.
  `record_voice` chat action runs while synthesis is in flight. The
  button voices the *whole* reply, not the tapped bubble: delivery keeps
  a bounded in-memory map of its own recent sends (chat, message id →
  full reply text — one process, one operator, no schema change), and a
  miss (restart, old message) degrades to the tapped bubble's text,
  warn-logged. No button in voice mode — the reply is already audio.
  Every door speaks the reply's language: the `speak` tool picks its
  voice per call, and `/voice` mode and the 🔊 button sniff the
  speakable text and cast the matching voice from `voice` + `voices` —
  one cast list, three consumers; `voice` speaks when the language is
  unclear or no cast member matches.
- **Files**: `send_file` is the file-out twin of intake media: it
  *names*, it does not send. The tool hands a workspace path (+ optional
  caption) to the turn's delivery sink (`sink.onFile`), which owns the
  Telegram call — so "Telegram send is delivery, not a tool" stays true
  and file sends ride the same serialized chain and authority fencing
  as text: a `/stop`'d turn can't emit one. Delivery sniffs magic bytes
  (never the extension): images go as photo previews, everything else
  as documents — except that `as_file` forces the document path
  (sendPhoto re-encodes; a document is byte-exact) and GIFs always
  ride it (sendPhoto strips animation). The file travels from disk
  (no whole-file buffering), capped at the local bot-api's 2GB upload
  ceiling.
- **Voice mode**: `/voice` toggles voice-note replies per conversation —
  a settings command like `/memory on|off`, epoch bump and all, so a
  turn never switches medium mid-flight. When on, delivery skips
  streamed text entirely: typing indicator while the turn runs,
  `record_voice` while it synthesizes, then the final reply as voice
  notes. The mode changes delivery, not the record — history still
  stores the reply text, so toggling off loses nothing and "what did you
  say verbatim" stays answerable. Code blocks and long URLs aren't
  spoken; a reply carrying them sends them as a plain text message
  alongside the audio. Composes with topics: a voice-mode topic plus
  voice-note intake transcription is a fully ears-in-ears-out
  conversation.
- **Mini Apps**: the process serves an HTTP endpoint on localhost; the bot
  links pages via `web_app` buttons. Telegram requires HTTPS, and the page is
  fetched by the *client device* — so the door is a config knob (`publicUrl`)
  and nothing in the process assumes a public IP. Reference doors, all
  zero-open-port: `tailscale serve` (tailnet HTTPS, auto cert — works when
  operator devices are on the tailnet, the v1-on-lithium pattern), `tailscale
  funnel` (public HTTPS relayed through Tailscale's edge, for off-tailnet
  clients), or any reverse proxy with a cert. NAT-first by construction.
  The settings page ships as two static files the process serves verbatim —
  markup+css in `http/app.ts`, client script in `http/app.js`, no build step.
  tsc checks the client (`tsconfig.client.json`: checkJs, DOM lib scoped to
  that program only) against the server's own wire types, so schema drift is
  a typecheck failure, not a phone-only bug. A settings GET returns an
  ETag for the current on-disk config; POST requires that version via
  If-Match and refuses a stale full-form save (409) rather than overwriting
  another tab's save or an operator hand edit. Reopen the page to resolve
  the conflict.
- **Commands** are few on purpose: `/voice` `/memory` `/forget` `/stop`
  `/compact`. `/model` and `/think` are retired — the mini app owns
  model and thinking settings (config lives where config lives), which
  keeps the chat surface small. No conversation-lifecycle commands —
  group topics and the DM's gap rule (Rolling DM) own that. The one exception is
  `/start`: clients fire it automatically on first open, so it gets a canned
  greeting (consumed before intake, never a model turn) and stays hidden
  from the advertised command menu.
- **Large files**: self-hosted `telegram-bot-api` on lithium, `--local` mode,
  grammy `apiRoot` → `http://127.0.0.1:8081`. Needs `api_id`/`api_hash` from a
  my.telegram.org app registration (operator's account, stored as secrets —
  "Little Goblin" app, api_id 955258, already minted for the v1 e2e harness,
  lives in `little-goblin/e2e/.env`). App-platform cred, not per-environment:
  all instances share it; dev/prod splits on bot token + server instance.
  No inbound ports — long-poll only, the server dials out to Telegram; its
  only client is goblin on the same box. `getFile` returns an absolute local
  path — intake reads the file off disk, no HTTP fetch. Uploads ≤2GB,
  `file://` URIs for sends. The server's working dir is a staging cache, not
  storage — Telegram still owns the files; periodic clean is safe (worst
  case = re-fetch via `file_id`). Deploy: static binary + systemd unit (no
  docker); build off-box, TDLib compile would crush lithium.


## Rolling DM (ruling 2026-10-03)

Operator ask: the app is where deliberate, named conversations live
(the chatgpt.com shape); the bot DM becomes the quick lane — one-off
questions, web lookups, small chats — and reads like messaging a
person: one long chat, no topics. But one forever-conversation drags
a stale, expensive context into every unrelated question, so the DM is
a **rolling address**: a sequence of conversations, one current, with
boundaries drawn by quiet gaps.

**Why gaps, and why not just a timer.** The cache argument is moot:
measured from goblin.log on 2026-10-03, z.ai's prefix cache holds for
messages a few minutes apart, is mostly gone by ~8 minutes, and every
gap past 13 minutes was fully cold (small sample, consistent). A long
gap therefore means the next message re-reads the whole conversation
at full price — 30–40k tokens in the logs — and a new subject drags
the old one along. Hermes is the warning on the other side: it shipped
idle (24h) + daily (4am) resets, defaulted them off because "surprise
context loss hurts more than it helps," then removed them, after a
run of bugs where reset sessions were resurrected. The failure was
surprise, not the idea. Goblin's position is better — recall runs on
every message and `history_search` reaches old conversations, so a
wrong fresh start is a "no, the earlier thing" away, not amnesia —
and the rules below exist to keep it unsurprising.

**The rule.** For each DM burst (post-coalescing, before admission):

1. **Within the gap** — the current conversation's last event (either
   side: a message, a reply, a program fire, a spin-off ping) is less
   than `telegram.dmGapMinutes` old (config, default 45, on the
   settings page) — the burst joins the current conversation. No
   check. A burst landing while a turn runs steers as always.
2. **Swipe-reply** — the burst replies to a message in the chat
   (`reply_to_message`): it joins the current conversation, no check,
   and intake carries the replied-to message's text into the burst as
   a quoted part (head-cut, like the check's state) — a reply to a
   message from an older conversation must still say what "this" is.
   Intake drops that text today; this ruling adds it.
   (A reply to a spin-off ping is routed to the app conversation
   instead — see App channel → Spin-off.)
3. **Past the gap** — the follow-up check below decides. Follow-up →
   current conversation. New subject → a fresh conversation becomes
   current.
4. **No current conversation** (first message ever, or after cutover)
   → a fresh one, no check.

A fresh conversation starts with an empty window: system prompt,
admission-time recall, the burst. Nothing is carried over by Goblin —
memory and `history_search` are the bridge, by design.

**The follow-up check.** One System One (Jev) noul call through the
shared `JevClient` — the reviewer's gate client, so the `reviewer`
block is its on/off switch like every other Jev consumer. State:
`{gapMinutes, previous: {user, assistant}, next}` — the last user
message and last assistant reply of the current conversation and the
incoming burst, text only (attachments render as `[photo]`,
`[voice: <transcript>]`, `[file: <name>]`), each head-cut at 2000
chars. The question (id `follow_up`):

- instructions: "The operator messaged their personal assistant after
  a quiet gap. Decide whether the new message continues the previous
  exchange or starts a new subject."
- true: "The new message continues the previous exchange: it refers
  back to it (a pronoun, ellipsis, or 'and also' that only makes sense
  with it), answers a question the assistant asked, or asks more about
  the same subject."
- false: "The new message starts a new subject: it is understandable
  on its own and is not about the previous exchange."

Fresh only when `p(follow_up) < 0.3` — the threshold leans toward
continuing because a wrong continuation costs one cold read, while a
wrong fresh start is the surprise above. The constant lives in code
and every check logs its probability, so a retune is an evidence-based
edit, not a guess. **Failure** (no reviewer block, `JevError`,
timeout) → follow-up, warn-logged. A backup model before that fallback
is parked in #53 — the operator picks its model if it ever lands.

**The marker.** When a fresh conversation starts, delivery sends a
separate `— new conversation —` message before admission work begins
(recall, thinking), so it always lands first and the operator sees the
boundary before the answer. The marker is delivery, not history — it
is in neither conversation's events; the `dm rolled` log line is its
record.

**Settings stay per conversation** (operator ruling): `/voice` and
`/memory` belong to the conversation they were set in, so a fresh
conversation starts at the defaults. A settings command arriving past
the gap rolls first (no check — a command is not a follow-up), so the
setting lands on the conversation about to happen rather than the one
that just ended. `/stop` and `/compact` act on the current
conversation and never roll.

**DM topics are retired.** Old DM-topic conversations stay in the
store — readable, searchable by `history_search` — and are never
routed to again. Any DM message, thread id or not, resolves to the
rolling address and replies go to the main chat. Programs pinned to a
DM topic are re-pinned to the DM at cutover (one-off, logged per
program). Unverified: whether the bot's threaded mode must be switched
off in BotFather for the DM to render as a plain chat, and whether a
send without a thread id behaves while it is on — probe at
implementation; cutover also waits for no delegation in flight from a
DM topic. Group topics are untouched.

**Logging.** `dm rolled` (address, from → to conversation, gap,
decided by `gap|reply|check|fallback|command|first`, probability when
checked); `follow-up check` (probability, ms, cost, outcome — never
message text); `dm cutover re-pin` per program.

**Landing rulings (stage 1, 2026-10-03).** Settled while building:
- *Which chats roll:* private chats only, detected as `chatId > 0`
  (Telegram: user ids positive, group ids negative). That's the one
  test call sites holding a bare id (program pins, lane keys) can use.
- *Lanes:* a private chat's intake lane (inbox row, coalescing
  buffer, intake chain) is keyed by the rolling address `dm:<chat>`.
  Routing happens at flush, after coalescing. Rolling conversations
  are `dm:<chat>:<n>`; the pre-ruling `dm:<chat>` conversation stays
  as history and is never current.
- *A live turn always absorbs input* (it steers), whatever the gap.
- *The check has a 3 s interactive deadline*, separate from the shared
  Jev client's 30 s timeout; losing the race is a fallback. If the
  address rolled while the check ran (a fire), the burst joins the new
  current conversation — never two rolls.
- *Delegation notices join, never roll:* they continue work the
  operator started. Program fires roll past the gap.
- *Topic-root replies are not replies:* Telegram marks ordinary
  messages in a topic as replies to the topic's root message, so that
  `reply_to_message` is ignored, or every burst would skip the check.
