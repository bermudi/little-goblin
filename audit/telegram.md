# Audit — Area 1: Telegram boundary

Read-only. No code touched outside this file. Spec: `design/telegram.md`, `AGENTS.md` guardrails.
Colocated `*.test.ts` used as intended-behavior reference. Deep reads were fanned out to five
parallel audit workers (delivery, approvals, guest+intake, rolling+conversation, media+misc);
headline findings below were re-verified by direct reads before filing.

## Baseline

- `bun test src/tg/`: **392 pass, 0 fail** (22 files, 6.7s).
- Full `bun test`: **2626 pass, 36 skip, 0 fail** (`2662` tests across 151 files, 142.59s). tg subset
  covering this area is green; no pre-existing failures anywhere.
- `bun run typecheck` (both tsc programs): **exit 0**.
- `rg "from 'grammy'" src --glob '!src/tg/**'`: zero hits. `rg "grammy" src --glob '!src/tg/**'`:
  exactly one hit, `src/rolling.ts:5`, comment-only (verified by read).

---

## 1. grammy isolation — none found (verified)

- No `from "grammy"` / `from 'grammy'` imports outside `src/tg/` (zero hits, both quote styles).
- Sole `grammy` mention outside `src/tg/` is `src/rolling.ts:5`, a comment stating the invariant.
- `src/index.ts` holds the `Bot` opaquely (`tg.bot.api` passed into wake/mail deps) without importing
  grammy types — structural typing only. `tg/` functions exposing grammy types
  (`startBot → RunningBot{bot: Bot}`, `WakeBase.api: Api`, `TitleDeps.api: Pick<Api,…>`) are only
  constructed/consumed at the composition root or inside `tg/`. No transitive type leak found.

## 2. Delivery

- **D1 — Honored flood wait converts to false uncertainty + ghost send. P2, verified.**
  `src/tg/flood-wait.ts:17,38-49` + `src/tg/deadline.ts:12,24` + `src/tg/delivery.ts:788-814`.
  If a chunk send draws 429 `retry_after=45`, the transformer honors it (45s < 60s cap) and sleeps —
  but the outer `withTimeout` fires at 30s (`API_CALL_TIMEOUT_MS`, `deadline.ts:12`). Delivery takes
  the `TelegramTimeoutError` branch (marks uncertain, stops the drain, sends the uncertainty notice)
  while the abandoned transformer wakes at 45s and fires the original send anyway: a ghost bubble the
  sink no longer tracks plus a dropped tail. Any `retry_after` in (30,60]s, or cumulative honored
  waits >30s, breaks the header promise ("costs the drain nothing"). Same shape at every `withTimeout`
  call site (voice/photo/document/rich/bell/notify one-shots — e.g. a 45s flood wait on a bell ping
  mislogs as "delivery uncertain — timed out").
- **D2 — Non-timeout transport error retried as "definite" → duplicate bubble. P2, verified (path) / suspected (trigger).**
  `src/tg/delivery.ts:806-814`. If `sendMessage`'s fetch throws *after* Telegram committed the message
  (response lost — ECONNRESET, proxy drop), the catch takes the else-branch (`c.id = -1`, reply link
  cleared) and the drain resends the same window. Only `TelegramTimeoutError` is treated as ambiguous;
  all other throws are assumed "provably never landed". True for API-level 400s, false for post-commit
  transport failure. Path traced exactly; post-commit transport failure unobserved here.
- **D3 — Drain give-up drops the tail with log-only signal, no in-chat truncation mark. P3, verified.**
  `src/tg/delivery.ts:1264-1297,1319-1351`. Backlog outrunning `maxDrainIterations` (steady progress,
  stagnant guard never trips) or 3× stagnation abandons the tail with one `warn`; landed bubbles carry
  no truncation mark and 🫡/keyboard are silently skipped — a clean-looking partial reply.
  Enshrined by `delivery.test.ts:440-474`, so spec-vs-code tension, not a regression.
- **D4 — Roll-marker timeout returns success; late marker can land after the answer. P3, verified (path).**
  `src/tg/notify.ts:42-56`. A timed-out `— new conversation —` send is abandoned-not-cancelled but the
  function warn-logs and returns normally, so admission proceeds and the marker may land after the
  answer's first chunk (answer-before-boundary). Intake path order (marker awaited before admit,
  `src/tg/mod.ts:843,868`) confirmed; marker failure never blocks admission (non-blocking verified).
- **D5 — Skill-proposal loop throws mid-batch; retry duplicates earlier skills. P3, suspected.**
  `src/tg/notify.ts:170-198`. `skills=[a,b,c]`, send of `a` lands, `b` throws → `c` never attempted,
  throw propagates. A caller-level retry resends `a` → duplicate proposal with a second live ✅/🚫 row.
  Loop path traced; reviewer retry behavior not read.
- **D6 — Bell marks ping delivered before journaling; store throw strands state. P3, suspected.**
  `src/tg/bell.ts:132-151,177-188`. `delivered = true` is set right after `sendMessage`; `pings.record` /
  `store.append` run after inside the same try. If either throws (disk failure), the catch logs
  "spin-off ping failed" but `delivered` stays true and the dedup key stays consumed → DM history
  permanently lacks the ping. Requires a store throw — rare.
- **D7 — Concurrent 429s sleep independently, exact-second waits, no jitter/gate. P3, suspected.**
  `src/tg/flood-wait.ts:27-71` (per-call state only) + `src/tg/delivery.ts:302-321,344-358`
  (typing/record pings bypass the serialized chain). A chunk send and a typing ping concurrently 429ed
  with `retry_after=10` both sleep the full 10s and retry at the same instant; `demanded = retryAfterS
  * 1000` exactly risks landing inside the server window and burning one of 2 retries. Concurrency ≤2
  typical; timing-dependent, low impact.
- Deadline/buffer/fencing: **none found.** `deadline.ts` (39 lines) — abandon-not-cancel documented,
  every caller traces an ambiguity decision. `buffer.ts` — ordering front-first, failed flushes retained
  with backoff, `fire`/`fireMax` double-fire harmless. `notifyUncertain` (`delivery.ts:241-248`)
  re-checks `cancelled`/`authoritative()` at send time on every uncertain path; `stampSuperseded` is the
  sole sanctioned post-fence edit. Bell timeout double-send is an explicit documented trade-off
  (re-ping noise over silence), test-pinned — not filed.
- Guardrails in this area: **none found.** No `console.log` (grep clean); chain swallows are `log.warn`
  with conversation id; delivery-boundary logging present on all paths checked.

## 3. Approval flows

- **A1 — Skill tap answers the callback query twice. P2, verified.**
  `src/tg/skill-approval.ts:180` + `:188`. `decide()` does `await answer(answerText)` then falls
  through to an unconditional `await answer()`. Every successful tap issues two `answerCallbackQuery`
  calls (proven against the real module: install tap → `[undefined, undefined]`). Compounding it:
  `skill-approval.test.ts:248` expects a single-element `answers` array and still passes — `toEqual`
  ignores trailing `undefined` elements, so the exactly-once test is blind to this.
- **A2 — Mail crash window: sent-but-undecided row can duplicate or be stamped "never sent". P3, verified (accepted in code).**
  `src/tg/mail-approval.ts:453-458`. Send-then-decide: a crash between the Gmail send and
  `outbox.decide(row.id, "sent", …)` leaves a pending row; the operator's re-tap re-sends (duplicate),
  or the sweep stamps "expired — never sent" over mail that went out. Comments at `:90-96`, `:108-109`
  explicitly accept this (duplicate preferred over silent loss); `stop()` (`:265-277`) closes it on the
  graceful path, so residual risk is crash-only.
- **A3 — Skill buttons never expire; an old card can install a newer same-name proposal. P3, suspected.**
  `src/tg/skill-approval.ts:22,37-47`. Payload `skill:<op>:<conv>:<name>` carries no epoch/nonce and
  `installProposal` (`:81-128`) acts on whatever is on disk. Proposal v1's card stays buttoned, reviewer
  stages v2 under the same name, operator taps v1's Install expecting v1 → v2 installs. Reviewer
  re-proposal flow not traced — suspected.
- **A4 — Opposite-vote double-tap can leave the wrong vote displayed. P3, suspected.**
  `src/tg/rate-button.ts:86-110`. Each tap computes its strip from its own `query.message.reply_markup`
  snapshot. Two near-simultaneous opposite taps (two devices): both record (latest-wins read stays
  correct), both strip from pre-collapse snapshots, loser's `editMessageReplyMarkup` can land last,
  showing disabled 👍 while `latest()` reads 👎. Cosmetic; store never diverges.
- **A5 — Outer-catch handler failures never answer the tap (spinner spins). P3, suspected.**
  `src/tg/mail-approval.ts:169-174`, `src/tg/rate-button.ts:74-78`, `src/tg/speak-button.ts:41-46`:
  the catch-all logs but issues no `answerCallbackQuery`. Reachable only on programming errors (all edge
  paths answer) — P3. Skill's catch is fine (answers "internal error" before rethrowing, `:185`).
- Stale-callback TOCTOU on changed outbox state: **none found.** `decide()` reaches its commit point
  (`decide()` CAS for cancel/expiry `:223,:230`, `inFlight.set` for send `:250`) synchronously with no
  intervening await; `mail-outbox.ts:141-143` CAS (`WHERE status='pending'`) makes double-tap/sweep races
  single-winner; `sweepExpired` excludes in-flight sends (`mail-approval.ts:565`).
  Settled rows get strip + "already \<status\>" (`:209-213`); second tap inside a send gets
  "sending — wait for the verdict" (`:218-221`), test-pinned.
- Approval state diverging from underlying resource: **none found** beyond A2/A3. Vanished reply target,
  threading-lookup failure, Gmail failure all keep the row pending with a chat notice (`:391-452`).
  Skill gone-proposal → "already handled" + card stamp, no history append (intended, test-pinned).
- Rating vote on wrong anchor: **none found.** `RATE_DATA_RE` (`rate-button.ts:19`) parses soundly;
  pre-restart taps recording under the payload's own conv/anchor is the design ("Reply ratings").
- Speak button on stale/restart-missed text map: **none found.** Miss degrades to the tapped bubble's
  text with a warn log (`speak-button.ts:82-90`) — exactly the spec-sanctioned behavior.
- Rating-row/markup single-call requirement: **none found.** One keyboard built once
  (`delivery.ts:894-907`), riding the rich `sendRichMessage` itself (`:1161-1166`, premium-gate retry
  keeps markup `:1182-1192`) or a single `editMessageReplyMarkup` enqueue on the plain path.
- Cross-refs: `mail-outbox.ts` CAS + `expireDue` support the above; `agent/skills.ts` contains no
  approve/deny path (catalog scan) — no second writer can diverge from the tap's disk state. Stop here
  per area contract.

## 4. Guest isolation — no P1 path constructible (verified)

- **G1 — Running-turn tail survives demotion (no epoch fence on class flip). P3, suspected.**
  `src/tg/guest.ts:419-464` (`ensurePersonaClass` uses `store.setMeta`, never bumps epoch) + zero
  fencing in `onConfigWritten` (`src/index.ts:748-789`). An operator's personal turn running when a
  config save removes them from `operators` was authorized at admission; every `checkAuthority`
  (epoch equality, `runtime.ts:445-448`) in the tail still passes, so remaining tool calls execute
  post-demotion and output delivers to the turn's original sink. Stopped only by a later summons touching
  the lane or the turn ending. Window is the turn tail; work was authorized at start; output goes to the
  original sink, not a new party — close kin to the spec's accepted coalescing residual, but the spec
  blesses only the flush residual. Mechanism verified, exploitability suspected.
- **G2 — `guest` feature switch does not cover the DM sandbox lane. P3, suspected (spec-conformance).**
  `src/tg/mod.ts:182-193,762-768,865-867` vs `src/tg/guest.ts:528,646`. Removing the `guest` block
  ("absent → operator-only", `design/telegram.md:461-463`) silences third-party surfaces, but an
  `allowedUsers` DM is still served the standing sandbox lane. Not a guest→operator leak (sandbox stays
  confined); the spec sentence is arguably surface-scoped. Code verified, spec ambiguous.
- **G3 — `guest_dedup` is update-id-keyed with a ~1000-update purge window; double-fire probe unresolved. P3, suspected.**
  `src/tg/guest.ts:54-73,529,654`. A redelivery arriving after its row was purged is treated as a new
  summons → duplicate turn (cost/double-reply, not a leak). If a member-chat mention ever double-fires
  as both `message` and `guest_message` (spec's self-flagged unverified probe, `design/telegram.md:611-616`),
  the two updates carry different `update_id`s so neither dedup collapses them — net effect is one turn
  + one busy line (busy checks at `:550,673` hold), no steering.
- **G4 — Callback-tap authorization rests solely on middleware order. P3, verified (structure) / not exploitable as read.**
  `src/tg/mod.ts:1221` (gate) before `:1230-1277` (taps); `skill-approval.ts` `handleTap` takes no sender;
  `mail-approval.ts` tap path contains no `from`/`operators` comparison (grep-verified). Holds today
  (ordering verified; dangerous buttons only render in operator-visible chats). Any future reordering or
  a button rendered into a shared chat turns this into guest→operator action (mail send, skill install).
  Defense-in-depth gap.
- Persona freeze vs snapshot bust on flip: **none found.** Demotion deletes the row (history + compactions
  + contexts swept, `conversation.ts:1472-1475`; snapshot dies via `ON DELETE CASCADE`) then busts
  (`guest.ts:437-462`); promotion busts too. Test-pinned (`guest.test.ts:693-774`). Residual is G1.
- Sandbox really search-only: **none found.** `SANDBOX_TOOLS={search}` (`guest.ts:740`), persona-driven
  filter applied post-assembly *and* post-`withScript` (`index.ts:517-528`); `fetch`/bash/file tools mount
  but are stripped for guests. Test-pinned (`guest.test.ts:205-243`).
- Memory exclusion: **none found.** Guest lanes force `memoryExcluded: true` (`guest.ts:472-483`,
  `mod.ts:865-867`); recall, retention, FTS filter, and `/memory`/`/forget` refusal all gate on it.
- `guest_dedup` vs `tg_inbox` collisions: **none found** on the `UNIQUE(chat_id,message_id)` exit —
  guest paths never touch `tg_inbox`. Residuals in G3.
- Member-surface fall-through to operator lane: **none found.** Operators fall through by design;
  non-mention traffic falls to the gate which drops non-operators (`mod.ts:182-197`).
- Guest output cap bypass: **none found** (by design). `GuestSink.render` caps at
  `min(outputChars, 4096)` with truncation notice (`guest.ts:224-234`); member surface uncapped per spec.
- Conversation key collisions / id spoofing: **none found.** `guest:<chat>:<user>` uses server-issued
  ids; prefixes disjoint; `from.id` platform-attested.
- Stranger refusal completeness: **none found.** DM gate, member mention, guest-surface placeholder, and
  ambient-group drop all match spec.
- BotFather-OFF stray updates: **none found.** Deny-by-absence is complete (registered updates exactly:
  `guest_message`, `message`, `edited_message`, `stopped_message_generation`, four callback types).

## 5. Rolling DM

- **R1 — `dm_rolls` high-water destroyed when demotion deletes the lane-current conversation → ordinal reuse / lane wedge. P1, verified.**
  `src/conversation.ts:1471` (`DELETE FROM dm_rolls WHERE current_id = ?`) × `:1156`
  (`n = (roll?.n ?? 0) + 1`) × `src/tg/guest.ts:437-451` (demotion deletes current, then `resetLane()` →
  `rollDm`). The delete path's own comment (`:1468-1470`) says "the next rollDm re-mints the lane" —
  restarting `n` at 1. Scenario A (current `dm:<chat>:<k>`, k>1): `rollDm` tries `dm:<chat>:1` while
  `:1..:k-1` still exist → PRIMARY KEY conflict → throw inside `flushRolling` → lane never admits again
  (inbox rows stay pending across reboots; `buffer.ts:149-151,172-192` retain-and-retry). The same
  collision inside `/new`'s transaction surfaces as `InboxRecordError` (`mod.ts:363-370`) → poller exit
  (`mod.ts:1279-1282`): crash loop on every `/new` attempt. Scenario B (k==1): no collision, but the
  fresh `dm:<chat>:1` silently reuses the deleted conversation's id — stale `tg_dm_navigation` receipts,
  `tg_inbox_archives` targets, `reply_ratings`, ping rows now resolve to a different conversation,
  contradicting "future ids never reuse an abandoned conversation" (`design/telegram.md:362-364`).
  Reachability is config-edge (class demotion with personal history on current — a case the design
  explicitly contemplates, `mod.ts:815-827`); this path is the sole rolling-current deleter (other
  `deleteConversation` callers touch app ids only). Core collision verified by direct read; poller-exit
  tail traced through `mod.ts`.
- **R2 — `routeDmMessage` superseded paths return the stale pre-check conversation. P3, verified (log-only).**
  `src/rolling.ts:292,303-312`. When `!stillRouteable()` (navigation archived the batch mid-check) the
  return is `{ conv: current }` — the outgoing conversation, skipping the pin re-read on the adjacent
  lines. Harmless in the only call graph (`flushRolling`, `mod.ts:841-845`, re-reads and drops the batch
  instead of admitting into the stale conv) — the `follow-up check superseded by navigation` log records
  a stale id. Log-fidelity only.
- **R3 — Roll-marker ordering not enforced on wake/command paths. P3, suspected.**
  Intake path correct (marker awaited before admit, `mod.ts:843,868`). But `src/wake.ts:39`
  (`void deps.markRoll(...)` before `submit`) and `mod.ts:415` (`void sendRollMarker(...)` before
  `handleCommand`) are fire-and-forget against the design's "always lands first" (`telegram.md:332-337`).
  Practically holds for program fires (reply arrives seconds later); command replies (`/voice → on`) are
  immediate concurrent `sendMessage` calls with no ordering guarantee. Cosmetic.
- **R4 — Batch-level swipe-reply bypass. P3, suspected.**
  `src/tg/mod.ts:833`: `batch.some((i) => i.quoted !== undefined)` routes the *entire* coalesced batch
  via `"reply"` (join current, no check) even if only one message in the 500ms window quoted another.
  Design rule 2 is stated per-burst; a mixed batch lets non-reply text skip the follow-up check. Narrow window.
- **R5 — `memoryExcluded` stickiness across class promotion. P3, suspected (design question).**
  `src/tg/guest.ts:453-456` + `mod.ts:865`: for the personal class `memoryExcluded` passes as `undefined`,
  leaving the flag untouched. A lane demoted (excluded forced `true`) then re-promoted keeps
  `memoryExcluded=true` silently — the operator's DM stays memory-excluded with no notice. Fail-closed;
  possibly intended.
- **R6 — Duplicate `/back` redelivery after selected-conversation deletion throws. P3, suspected.**
  `src/tg/navigation.ts:121-123` throws `"DM navigation selected history is missing"` when `receipt.toId`'s
  conversation is gone (e.g. R1's demotion-delete); via `mod.ts:363-370` this becomes `InboxRecordError` →
  poller exit. Requires a redelivered update id landing after an intervening delete — narrow.
- **R7 — `wake()` performs no `dmClass`/`ensurePersonaClass` check unlike the intake flush. P3, suspected.**
  `src/wake.ts:27-64` vs intake flush. A program pinned to a non-operator chat would fire personal-persona
  (full-toolset) turns into a sandbox lane. Reachability requires operator misconfiguration of a program pin.
- Gap arbitration: **none found.** Threshold `<` matches "less than … old" (`rolling.ts:223,253`; `==`
  going to check/roll is design-conformant). Clock skew joins (safe direction). Last-event either side
  verified (`qLastActivity` has no role filter, `conversation.ts:851-853`; `selected_at` in
  `lastActivityAt`, `:1186-1193`; spin-off pings journaled as assistant events). Busy-before-gap in both
  routers (`rolling.ts:220,250`); post-check pin/busy/fresh-activity re-reads (`:326-343`), test-pinned.
  Fire-during-check joins pinned conv per design (`:328`). Delegation notices use `"current"` (join, never
  roll) — pinned.
- Address math: **none found** beyond R1. `rolling` matched before `dm` (`conversation.ts:81-84`);
  `rollingChatId` rejects concrete ids (`rolling.ts:44`, test-pinned); negative chat ids guarded
  (`privateChatIdSchema`, `conversation.ts:1153`); `/back` only moves the pin, never rewinds the counter.
  Predecessor links: source linked only if canonical (`:1162`); back-step requires ordinal decrease.
- `/new`/`/back` atomicity: **none found.** Selection, archive assignment, epoch fence, and receipt commit
  in one transaction (`navigation.ts:73-195`); `cancelFenced` strictly after commit (`:200-205`); dedup by
  update id + (chat,message) + alias table; multi-destination archive partial failure handled by
  committed-row filtering on retry (`mod.ts:879-923`, `inbox.ts:306-319`).
- Settings-per-conversation leakage across roll: **none found** (fresh rows default voice=0/excluded=0;
  `/voice`+`/memory` roll first past gap, all others pin to current, `mod.ts:410-414`). R5 promotion case noted.
- Topic-root reply exclusion: verified per design (`mod.ts:495-500`). Threaded-DM residual explicitly
  Unverified in the design — no new finding.

## 6. Intake

- **I1 — Deleted messages: no handler at all. P3, suspected (low).**
  Registered updates are exactly `guest_message`, `message`, `edited_message`,
  `stopped_message_generation`, and four callback types (full `mod.ts` read). A deleted-but-buffered
  message still turns and replies. Privacy nit, not a guest leak.
- Update-type coverage: **none found.** `channel_post`, `edited_channel_post`, `inline_query`,
  `chat_member`/`my_chat_member`, `poll`/`poll_answer`, reactions, business messages — all unregistered
  → grammy acks silently. `edited_message` requires a pending `tg_inbox` row (`inbox.ts:220-233`,
  `mod.ts:637-644`); sender unchecked but only the author can edit per platform.
- Swipe-reply routing: **none found.** Guest replies-to-bot consumed by `routeMemberGuestMessage`
  (`guest.ts:625-709`) *before* the ping lookup (`mod.ts:504-510`) — a guest cannot steer an app
  conversation via a delegation-ping reply. Operator ping replies route to the app lane with no quoted
  part; deleted targets degrade to ordinary reply; topic-root pseudo-replies excluded.
- Addressing: **none found.** `conversationAddress` (`mod.ts:85-98`) matches tested behavior
  (`mod.test.ts:94-119`); comment-thread `message_thread_id` without the topic flag stays bare-chat by
  design. Redelivery keeps original admission (`mod.ts:284-298`, `inbox.ts:203-219`).
- Verdict: no wrong-chat/thread routing found; no non-update-payload crash path found.

## 7. Media

- **M1 — No 20 MB cloud cap anywhere in code; enforced only by Telegram's server. P3, verified.**
  `rg "file_size" src design` returns zero hits. `saveAttachment` (`src/tg/media.ts:198-237`) streams the
  download unbounded via `Bun.write(temp, res)` with only a 60 s timeout (`:224`); no content-length
  pre-check, no size guard before `getFile` (`mod.ts:569`); nothing reads `apiRoot` to adjust a limit, so
  local mode inherits whatever the server allows. A 100 MB video on the cloud API burns a full
  `getFile` + failed-download cycle, then an error-text part enters history (`mod.ts:592-598`).
  Absence verified by exhaustive grep; failure path verified in code.
- **M2 — 2 GB upload ceiling checked at tool input only, never re-checked at delivery (TOCTOU). P3, verified.**
  `MAX_SEND_BYTES` gate lives in `src/agent/tools/send.ts:77`; `sendDocumentSolo`
  (`delivery.ts:581-625`) only `stat`s for readability/byte logging, and `sendPhotoSolo` (`:453`) never
  stats at all. A file growing past 2 GB between the tool's `statSync` and the sink's send (or arriving
  via the photo batch) → Telegram API rejects → surfaces as send failure, fail-loud. Low impact.
- **M3 — Intake trusts Telegram-supplied mime/filename, no magic-byte sniffing. P3, suspected.**
  `mediaFromMessage` (`media.ts:96-104`) passes `mime_type`/`file_name` straight through; photo path
  hardcodes `image/jpeg` (`:93`); sticker static/video decided by flags (`:155-161`). Sniffing
  (`src/agent/sniff.ts`) exists only on the delivery path (`delivery.ts:561-562`). A lying `mime_type`
  (exe labeled `application/pdf`) materializes under the wrong modality gate at turn time. Mitigating:
  Telegram's server sets these, not the sender — mislabel requires a compromised server response.
  Downstream mislabeled-input handling not traced.
- Transcribe/TTS handoff of weird input: **none found** (all degrade gracefully, verified).
  `enqueuePersisted` (`mod.ts:567-599`): transcribe fires only when `media.transcribable` (voice/video-note
  only); any throw (missing ffmpeg, corrupt media, empty file, `MAX_SEGMENTS` overflow) is caught →
  warn-log + path-referenced attachment. Empty file: 0-byte attachment, never crashes intake. `getFile`
  local-path vs URL both handled (`media.ts:216-233`), token redacted in errors (`:228-231`).
- Document vs photo path, GIF animation strip: **none found.** Uncompressed PNG-as-document keeps
  `image/png`; `animation` arrives as Telegram-transcoded mp4; delivery forces GIFs to the document path.
- Member-surface photo intake missing: deferred by design (`design/telegram.md:617-618`), not a bug.
- Titles: **none found.** `maybeRenameTopic` (`titles.ts:56-81`) re-reads the store post-model-call, uses
  fresh ids for edit + `setMeta`; operator-rename race restores their title. Truncation enforced both ends;
  attachment-failure sentinels excluded from title input (`mod.ts:741-744`).
- Forget-listings: one finding; otherwise clean —
  **M4 — `/forget` posts memory previews into shared group chats. P2, suspected (design question).**
  `src/tg/commands.ts:441-445` (listing, 120-char snippets) + `:396-402` (delete confirmation echoes id +
  preview) render via `reply()` → `conv.chatId` + thread (`:87-96`), and `/forget` is in the
  group-advertised `COMMANDS` (`:466-472`, "Groups receive only COMMANDS", `:462-465`) with no DM-only
  guard. The audience-note ruling covers model replies, not command output. Scenario: operator runs
  `/forget <query>` in a member group topic → matching memory snippets posted to the room. Code path
  verified; whether "you typed it there" is accepted operator behavior is a design question, hence
  suspected rather than verified-wrong.
- Wake retired-DM-topic routing: **none found.** Bare-chat DM addresses roll via `routeDm` (replies land
  in main chat); threaded addresses resolve directly (correct for group topics). Cutover re-pin runs at
  boot after legacy-job migration; delegation notices `"current"`, scheduler fires `"fire"` — matches spec.

---

## Triage — fix first

**R1 — `dm_rolls` high-water destroyed on demotion-delete (`src/conversation.ts:1471`).**

Why: it is the audit's only P1 and the only finding that converts an ordinary operator action (editing
the `operators`/`allowedUsers` lists — a settings-mini-app flow) into a permanently wedged lane plus a
potential crash loop on every subsequent `/new`. Every other finding is P2 degraded output (D2 duplicate
bubble, A1 double-answer, M4 group-exposure) or P3 hygiene with bounded blast radius. The fix is small
and local (preserve the lane's `n` high-water across the demotion delete — e.g. keep the `dm_rolls` row
or re-mint at max-existing-ordinal + 1 — in the same transaction that already severs the chain), it is
covered by the existing rolling/navigation test seams, and it removes the premise of R6 as well. Second
in line: D1 (flood-wait 60s cap vs 30s `withTimeout` — a one-constant or scope interaction fix that kills
the whole ghost-send class), then A1 (delete the dead `await answer()` — one line, test-harness fix to
`toEqual` alongside).
