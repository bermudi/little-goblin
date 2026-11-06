> Audited 2026-10-23 17:32 local, at repo commit `9d4f861e` (tracked tree clean; only untracked audit/ notes).

# Hunt 01 — src/tg/ (Telegram adapter)

Read-and-report hunt against goblin v2 at `/home/daniel/build/little-goblin`.
Governing spec: `design/telegram.md` (all rulings), `DESIGN.md` (Domain model,
The authority rule, Non-goals), `AGENTS.md` → Guardrails. Scope: every module
and colocated test under `src/tg/` (static reading; the orchestrator's
verification pass — typecheck clean, 4686 pass / 0 fail / 86 skip — is taken as
given and was not re-run). One scratch probe was written and run under /tmp
(`/tmp/goblin-hunt-probe.ts`, Bun fetch error shapes); no suite file, no live
service, no secret was touched.

Severity counts: **P0: 0 · P1: 1 · P2: 0 · P3: 2**.

---

## 1. Findings (most severe first)

### P1-1 — Rich drafts and the salute effect fire in topic-less groups; the test that pins "non-DM keeps the plain sink" uses an id that cannot occur in production

- **Where:** `src/tg/delivery.ts:230`
  ```ts
  let richMode = richOpts?.enabled === true && conv.id.startsWith("dm:") && !voice?.voiceMode;
  ```
  and the same prefix test for the completed-turn effect at `src/tg/delivery.ts:1003`
  (`done.kind === "completed" && conv.id.startsWith("dm:") && messageEffectsUsable`).
- **Violated rule:** design/telegram.md → *Formatted replies & draft streaming*:
  "**DMs only in v1.** Group and topic conversations keep the current
  edit-streaming sink untouched; group rich rendering and reply-threading are
  unprobed." (Also, by extension of the same line, *Reasoning* — "DMs only" —
  would render in a group once `showReasoning` is on, and the 🫡
  `message_effect_id` rides group sends.)
- **Why the prefix test is wrong:** a topic-less group's standing conversation
  is addressed `{kind: "dm", chatId: <negative>}` — `src/tg/mod.ts:93-106`
  (`conversationAddress`) → `src/conversation.ts:50` (`formatAddress` →
  `"dm:-404"`); positive private chats roll (`rolling.ts:19-21`), forum topics
  are `"topic:…"`, guests `"guest:…"`. So in production the **only** non-DM
  lane matching `startsWith("dm:")` is exactly the group standing conversation.
  `telegram.richReplies` defaults **true** (`src/config.ts:948,954`), and
  `makeConversationDeliverySink` (`src/tg/turn-input.ts:61-64`) passes it for
  every ordinary intake turn, group lanes included (`src/tg/mod.ts:885`), and
  for wake/program fires (`src/tg/wake.ts:90-93`).
- **Triggering path:** bot is a member of a plain (non-forum) group — a
  designed surface ("a chat without topics is one standing conversation",
  DESIGN.md → Domain model). Operator sends a message; the reply streams via
  `sendRichMessageDraft` and finalizes via `sendRichMessage` into the group —
  the unprobed group rendering the ruling fences out — and the completed send
  carries `message_effect_id`.
- **Why the suite is green anyway:** `src/tg/delivery-rich.test.ts:32`
  constructs the "group" as `{ id: "tg:-100", chatId: -100 }`. `"tg:-100"` is
  not a producible id (`parseAddress` returns null for it;
  `src/conversation.ts:57-86`), and the test at
  `src/tg/delivery-rich.test.ts:373` ("the kill switch and non-DM conversations
  keep the plain sink") passes against it — while the real group lane
  `"dm:-404"` (used as such elsewhere, e.g. `src/tg/mod.test.ts:1500`) would
  take the rich branch.
- **Test sketch that catches it:** build the sink with a conversation
  `{ id: "dm:-404", chatId: -404, threadId: null }`, `rich: { enabled: true }`;
  `sink.onTextDelta("hi"); await sink.onDone({ kind: "completed" });` —
  assert no `sendRichMessageDraft`/`sendRichMessage` call and a plain
  `sendMessage` happened. Fix sketch: gate on the parsed address (kind `dm`/
  `rolling` with `chatId > 0`) instead of the string prefix, at both 230 and
  1003.

### P3-1 — flood-wait waits out a 429 up to twice by default; the ruling says "once"

- **Where:** `src/tg/flood-wait.ts:9` (`DEFAULT_MAX_RETRIES = 2`) consumed at
  `src/tg/flood-wait.ts:35` (`attempt >= maxRetries` → give up).
- **Violated rule:** design/telegram.md → *Telegram intake & delivery →
  Delivery*: "Flood control: a 429's `retry_after` is waited out **once**
  (bounded), then the 429 propagates."
- **Behavior:** with the default, a first 429 is waited (attempt 0), and a
  second 429 on the retry is waited again (attempt 1); only the third
  propagates. The wait stays bounded (`maxWaitMs = 20s` aggregate,
  `ANSWER_MAX_WAIT_MS = 5s` for `answer*`), so this is hygiene, not a hang.
  `src/tg/flood-wait.test.ts:145` ("more 429s than maxRetries returns the last
  body after the capped waits") deliberately pins multi-wait semantics — code
  and tests agree with each other and disagree with the doc's "once". One of
  the two is stale; the doc should be re-ruled or the default should be 1.

### P3-2 — The refusal latch contradicts "every summons gets one short refusal line"

- **Where:** `src/tg/guest.ts:52-58` (`refusalDue`, 10-minute latch) applied on
  the member surface at `src/tg/guest.ts:550-551` and in the bot-DM gate at
  `src/tg/mod.ts:191`; keying differs by surface (chat id in groups, user id in
  the DM).
- **Tension:** design/telegram.md → *Roles and permissions* says strangers get
  "**every summons gets one short refusal line and nothing else** — … on every
  summons surface (bot DM, member-chat @mention or reply-to-goblin, guest
  surface)". With the latch, a second stranger summons in the same chat within
  10 minutes gets **no line at all**. The guest_message surface is unlatched
  (every summons is answered into its placeholder,
  `src/tg/guest.ts:437-440`), so the three surfaces behave differently.
  Tests pin the latch (`src/tg/guest.test.ts:936` — "repeat stranger mentions
  in one window send one refusal"), so this looks like deliberate anti-spam
  that the doc's "every" no longer describes. Needs a doc touch or a ruling;
  reported as hygiene, not as a code bug.

---

## 2. Checked and found clean (later passes can skip)

All of the below were read against the cited ruling and found consistent;
page/line references are to the implementation evidence.

- **Coalescing buffer** — quiet window exactly 500 ms (`mod.ts:77`,
  design → *Coalescing buffer*), 10 s max-wait, retain-with-backoff on flush
  failure, deferred re-fire while inflight, drain that reports retained
  batches (`buffer.ts`).
- **Inbox durability & idempotency** — `record` zod-validates ids/payload,
  detects conflicting identities, fails loud (`inbox.ts:218-260`);
  `commitBatch` runs the store append inside the transaction and refuses
  no-append commits (`mod.ts:878-901`, test at `mod.test.ts:536`); crash
  redelivery consumes the original admission (`admittedDestination`,
  `mod.ts:270-281`); replay re-fetches media then commits once
  (`mod.test.ts:1538`). `InboxRecordError` → `process.exit(1)` via `bot.catch`
  (`mod.ts:1237-1240`) — acknowledgement stops on persistence failure, as
  ruled.
- **Edit handling** — in-window edit amends the buffered text part in place
  and the durable row (`mod.ts:594-663`); post-commit is ack-and-log;
  `file_unique_id` swap leaves the original standing; topic-root and
  forum-created "replies" are thread plumbing, not quotes (`mod.ts:486-491`,
  test 1965). The intake-lane serialization makes mid-media edits find their
  item (test 1801).
- **Rolling DM routing** — boundary marker awaited before admission work
  (`mod.ts:774` before `admitBatch`; test 1924); settings commands (`/voice`,
  `/memory`) roll first past the gap, `/stop` `/compact` `/resume` `/decide`
  `/abandon` `/forget` route "current" and never roll (`mod.ts:390-394`);
  swipe replies join without a check; no-current → fresh; busy absorbs
  (rolling.ts read for semantics only — it is hunt 2's file).
- **Mid-flight re-adjudication (DM-scoped)** — class re-checked before routing
  and again before admission; demotion drops the batch before routing with the
  refusal line (`mod.ts:754-790`, `refuseDroppedBatch`; tests 516, 575),
  matching design → *Roles and permissions → The mid-flight recheck*.
- **Manual navigation** — `/new`/`/back` DM-only with an explanatory group
  reply (`mod.ts:316-323`); `/new` fences the outgoing conversation durably
  (bumpEpoch inside the transaction, `cancelFenced` after commit,
  `navigation.ts:200-205`); `/back` walks the predecessor link; `no_previous`
  changes nothing; idempotent receipts with an update-alias table; pending
  input archived to the outgoing conversation as history-only and can neither
  start a turn nor roll the pin (`archivePendingBefore` +
  `archiveNavigatedInput`); persistence failure → `InboxRecordError` (test
  2333). Matches design → *Manual DM navigation* point by point.
- **Delivery authority (the authority rule)** — every queued Telegram action
  re-checks `mayDeliver()`/`authoritative()` **at execute time**, not just at
  enqueue: text sends/edits (`delivery.ts:669,715`), voice (`:296`),
  documents (`:528`), photo batches (`:429,484`), reactions/keyboards
  (`:1145,1155`), drafts (`:586,605`); `setAuthorityCheck` supplies the epoch
  probe. Fenced turns stamp `⏹ superseded` on the already-visible bubble only,
  using displayed text (`stampSuperseded`, `:737-753`); unsent chunks never
  become bubbles; fenced chunks are not wire-retried (tests 903-958).
- **Timeout/never-resend** — `sendMessage`/`sendRichMessage`/`sendVoice`/
  `sendPhoto`/`sendMediaGroup`/`sendDocument` timeouts all `markUncertain` and
  never resend; one best-effort "delivery uncertain" notice, suppressed when
  fenced; `sendVoice` timeout stops voice with **no text fallback** (tests
  244-321); definite (GrammyError) failures retry a chunk with the reply
  anchor cleared, which is safe (nothing landed).
- **Transport-ambiguity classification** (`delivery.ts:691-706`) — verified
  with the one allowed scratch probe (`/tmp/goblin-hunt-probe.ts`): real Bun
  fetch transport failures carry string `.code` (`ECONNREFUSED`,
  `ENOTFOUND`), so `HttpError`-with-coded-cause classifies as ambiguous
  (uncertain, no resend) on the realistic shapes. Not a bug.
- **Salute effect / premium gate** — first `PREMIUM_ACCOUNT_REQUIRED` retries
  the send once without the param and memoizes for the process lifetime
  (`delivery.ts:1002-1035`, tests 453-518); errors turn no effect.
  (The DM-ness gate itself is the P1 above.)
- **Reasoning surface** — reasoning drafts and the collapsed `<details>` block
  exist only inside rich mode, never for `persona: guest` (`:231`,
  `reasoningBlock`, test 558) — modulo the P1 group leak.
- **Photo/document delivery** — 400 ms media-group window, ≤10 per album,
  solo-send fallback after album failure, uncertain propagation marks every
  unsent file once, delivered groups never resend, documents never batch and
  never wait for the album window, 2 GB cap matches design → *Files* (the
  local-bot-api ceiling as written).
- **Guest mode** — three classes decided per summons by the two lists alone
  (`classifySummon`); member-chat handlers registered **before** the access
  gate and summons traffic never hits it (`mod.ts:1074-1093`); the operator's
  own member messages fall through to ordinary intake (`guest.ts:534`);
  strangers refused; sandbox = guest persona + `search`-only toolset
  (`SANDBOX_TOOLS`), constructed not promised; no sandbox `fetch`;
  memory-excluded by construction; persona frozen at creation and a demotion
  resets the lane (history cleared, epoch fenced, `ensurePersonaClass`,
  `guest.ts:337-378`); busy guest conversation gets one refusal line, never a
  steer; guest_message answers placeholder-first, one message, no
  chunking/files/voice, capped with the truncation notice; member mentions use
  the normal delivery sink with **no rating/voice buttons**; foreign quoted
  text framed as untrusted data; update-id dedupe for the double-fire probe.
- **Roles/permissions** — operators everywhere; `allowedUsers` only in their
  own DM and only while the `guest` block exists; strangers: no turn, no
  conversation, no state; ambient non-operator group chatter dropped with no
  reply (`accessGate`, `mod.ts:148-199`); privileged commands
  (`/voice /memory /forget /compact /resume /decide /abandon /skill`)
  sender-gated **before routing or conversation creation** (`mod.ts:303-315`,
  tests 937-1032); other-bot commands route nothing (`mod.ts:302`, test
  2131); an allowed user's plain group message never falls into the standing
  conversation (gate drops it).
- **Audience awareness** — the shared-chat note rides every burst in
  group-addressed lanes only (negative chat id, guest lanes excluded)
  (`turn-input.ts:22-29`), covering ordinary intake and the `/skill` door
  alike.
- **/skill** — operator-only command and callback; epoch captured before the
  fetch and re-probed synchronously after fetch and after scoring with no
  await between probe and pending+preview publish (`skill-command.ts:260-315`);
  pending confirms single-use, 15-min TTL checked at tap, existence+epoch
  re-probed, stale/gone stamped never submitted (`:359-425`); replies chunked
  under the cap at newline boundaries, pathological lines split, echoed name
  bounded, sends awaited so a failed send fails the command; shared audience
  note and one sink helper for both doors (`skillCommandDeps` →
  `makeConversationDeliverySink`, `mod.ts:854-863`). Matches design → */skill*
  invariants item by item.
- **Approval gates & channel neutrality** — `src/channel-boundary.test.ts`'s
  owner list (mail-approval, program-approval, program-ops, app-push,
  turn-tools, http/app-*) has **no** grammy or `tg/` import (grep-verified);
  the Telegram adapters are pure presentation (callback parse → shared owner →
  answer/stamp); operator authority is checked on the live operators list,
  including the demoted-operator case (approval-gate.test.ts drives the real
  bot through a fake Telegram server); program `stop()` joins in-flight taps
  so an approved hook's credential delivery is not cut off mid-await; mail
  posting classifies timeout-uncertainty by whether the buttons chunk began.
- **Topic titling** — one shot per process (`titleAttempts`), gated on
  `titleModel`, `titleImplicit` re-checked after the model call, and an
  operator rename that lands mid-edit wins and is re-applied (`titles.ts`,
  tests 1391-1407) — "an explicit operator rename always wins".
- **TTS wiring** — absent tts block parses to the default (edge), `""`/`false`
  is explicit off, and every consumer treats it identically (`mod.ts:1102`,
  `turn-input.ts:52`, `wake.ts:79`, `commands.ts:281`); the 🔊 tap answers
  immediately, failures warn + one short chat message, `ttsDown` (boot ffmpeg
  probe) takes TTS down for the run; no button in voice mode.
- **Reply ratings** — record-only adapter over the shared store; rows ride
  only a clean-completed reply's last bubble; error, fenced, voice-mode and
  guest replies get none (sink construction + `onDone` gating, tests 587-669).
  Nothing in `src/tg/` consumes the rows.
- **Media intake** — zod on photo metadata; malformed metadata becomes a
  failed-attachment text part, never a dropped update or a boot loop (tests
  689-756); download errors are token-scrubbed (`media.ts:192-197`); local
  bot-api paths copy with `COPYFILE_EXCL`; transcribable flag drives
  transcription with failure-kept attachments; a caption that looks like a
  command does not eat its media (test 670); unhandled kinds get a visible
  note. Attachment persistence is durable (tmp + fsync + rename + dir sync,
  `agent/attachments.ts` — read-only cross-check).
- **Bell / wake seams** — no duplicate ping for one response
  (`pingedResponses` with rollback when nothing landed); delegation notices
  journal into the operator's current DM without rolling; telegram-disabled
  mode keeps app bells alive and skips Telegram notices with a log line
  (`bell.ts`, `wake.ts`, `notify.ts`), matching design → *Channel
  availability*.
- **Guardrails in scope** — no `console.*`, no `any` in `src/tg/` production
  files; `log` used throughout with structured fields; grammy imports confined
  to `src/tg/` plus the sanctioned testkit exemption
  (`module-boundaries.test.ts:22`); zod at the durable boundaries (inbox
  ids/payloads, navigation inputs, media metadata); SQLite seams use
  transactions for multi-statement invariants (inbox commit, navigation,
  archive).

---

## 3. Could not verify (and suspected-but-untraceable rules)

- **Bot API 10.3 live shapes** — `editMessageTextInline` accepting the rich
  `text_or_rich_message` variant, the `disabled: {}` inline-keyboard button
  (`rate-button.ts:77`), `message_thread_id` as an `editMessageText` extra
  (`mail-approval.ts:295-299`, `program-approval.ts:284-287`), and
  `sendRichMessage`/draft behavior outside the operator DM. No live API access
  is permitted in this hunt; the design itself marks group rich rendering
  "unprobed" and the rich-edit fallback ("the first rejected rich edit flips
  that sink to plain") is implemented (`guest.ts:218-224`) but its live
  trigger is unprobed. Failures of the cosmetic ones are caught and logged,
  so none of these is more than a lead.
- **`guest_message` double-fire dedupe** — the design's probe list
  (*Guest mode → Probes*) prescribes "dedupe by chat+message id if so";
  the code dedupes by `update_id` only (`guest.ts:430,536`). If Telegram
  double-fires one logical message as both a `message` and a `guest_message`
  update, both would be processed (different update ids). This is exactly the
  design's own open probe — flagged, not chased.
- **The refusal latch's intent** (P3-2 above) — tests pin the latch, the doc
  says "every summons"; which side is stale needs a ruling, not a hunt.
- **flood-wait "once"** (P3-1 above) — same class: code+tests vs doc.
- **Out-of-scope seams read but not audited** — `rolling.ts` (follow-up check,
  gap routing), `runtime.ts`/`turn-resume.ts` (epoch capture, steering,
  fencing), `agent/attachments.ts`, `agent/tools/send.ts` (MAX_SEND_BYTES),
  `app-link.ts`. Only their contracts with `src/tg/` were checked.
- **Inbound download size** — no code path checks file size before download
  (`media.ts`); the 20 MB cloud-Bot-API cap ("in effect" per design → *Large
  files*) is enforced server-side by Telegram and unverifiable offline. Not
  counted as a finding because the doc pins the cap at the API, not the code.
- No rule was suspected without a written source; every finding above cites
  its doc section.

---

## 4. Simplifications & code smells (P3-level, evidence-backed)

1. **Four duplicated operator re-checks in callback handlers** —
   `mod.ts:1118` (skill), `:1144` (temp skill), `:1173` (mail), `:1202`
   (program) each re-implement the same live-operators guard with its own
   logging and "operator only" answer. `accessGate` (`mod.ts:148-199`),
   registered at `mod.ts:1093` **before** every `bot.callbackQuery`
   registration, already refuses non-operator taps with the identical answer
   — `approval-gate.test.ts` drives the real bot and shows the gate alone
   produces the refusal (exactly one wire answer per tap). Meanwhile the
   speak button (`mod.ts:1099`) and rate button (`mod.ts:1107`) rely solely on
   the gate, so the self-checks are accretion, not a systematic invariant:
   ~40 lines removable, or keep one and cite it once.
2. **Per-boot destructive DDL as a permanent "migration"** —
   `guest.ts:25-26` runs `DROP TABLE IF EXISTS guest_open_chats` /
   `guest_turns` on every `openGuestStore` (every boot). The machinery was
   deleted by the 2026-10-11 ruling; the cleanup is a one-time migration
   running forever in the bot-construction path.
3. **Dead `?? false` on a non-optional field** — `guest.ts:500`:
   `env.configRef.current.telegram.richReplies ?? false`.
   `telegram.richReplies` is a non-optional boolean (default `true`,
   `config.ts:948,954`), so the fallback is unreachable; it misleadingly
   suggests the field can be undefined and would silently disable rich guest
   edits if the type ever widened.
4. **Per-invocation DDL inside a transaction** — `navigation.ts:75-88` runs
   `CREATE TABLE IF NOT EXISTS` for both `tg_dm_navigation` tables inside the
   navigation transaction on every `/new`//`/back` command. Every other store
   creates its tables once at open (`inbox.ts:125-139`, `pings.ts:13-19`,
   `forget-listings.ts:18-22`).
5. **The command surface is split across two modules** — `commands.ts` lists
   `skill` in `COMMANDS` (`commands.ts:537`) but `handleCommand` has no
   `/skill` case; the dispatch is intercepted in `mod.ts:404-423` before
   `handleCommand` is called. A reader of either file alone gets an
   incomplete picture of the command set (the set is pinned only by
   `mod.test.ts:240`).
6. **Repeated string literals on the uncertain path** —
   `"not sent — delivery stopped after an uncertain timeout"` appears three
   times (`delivery.ts:403,423,524`) and the voice-uncertain message twice
   (`delivery.ts:291,321`); one constant each would keep the operator-facing
   wording from drifting between the photo, document and voice paths.
