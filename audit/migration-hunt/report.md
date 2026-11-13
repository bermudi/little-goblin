# Migration hunt report

What a long-time **openclaw** (`~/build/testing/openclaw/`) or **hermes-agent**
(`~/build/testing/hermes-agent/`) user would find odd, confusing, or broken in
their first weeks of daily goblin use. **Odd** = differs from what they're used
to with no visible reason. **Broken** = something goblin claims to do but does
partly, silently, or only once.

- Method and journey list: [journeys.md](journeys.md). One investigator per
  journey; each cited how the references do it (`file:line`), how goblin does
  it (`file:line`), and tried to prove every finding on a throwaway
  verify-goblin instance (fake model, no keys, no Telegram, no browsers).
- 15/15 journeys investigated. **54 findings reported; 51 unique after merging
  3 findings that two journeys hit independently.** 48 seen, 3 unverified.
- Scope filter held: out-of-scope gaps are questions for the operator, not
  findings — see [Scope questions](#scope-questions).
- Full per-journey evidence trails (every command and probe, with results)
  are condensed in the [appendix](#appendix-verification-per-journey).

Evidence labels: **seen** = observed live on a throwaway instance (HTTP,
SQLite, logs) or by a module-level probe against the real code; **unverified**
= established by code-reading only, with the step that would prove it.

---

## Findings

Ranked by how much they'd hurt daily use. Citations: goblin paths are
repo-relative; reference paths name the repo (openclaw / hermes).

### High — would hurt every day or every fresh install

**H1. Fresh installs cannot transcribe voice notes** — media and voice · broken · seen
- Expected: the default local engine "downloads automatically the first time a
  voice note arrives" (goblin `docs/voice.md:24-26`); hermes local STT is
  "zero config … works out of the box" with auto-download
  (hermes `website/docs/user-guide/features/voice-mode.md:107-117`).
- Goblin: the pinned whistle engine URL
  `https://huggingface.co/Cactus-Compute/needle3/resolve/main/linux-x86_64/needle`
  returns HTTP 404 (verified from this box; the HF repo now ships only
  `needle3.cact`, no engine binary) — `src/agent/transcribe-whistle.ts:64`.
  Seen live: a voice note on a fresh install gets
  `whistle: artifact download HTTP 404` stored as `transcriptionError`; the
  message still turns, but "ears" are down. Existing installs with a cached
  artifact keep working; fresh ones don't. The failure is loud to the model
  and the log, never silent — but the default config is broken until the
  operator hand-sets engine/weights paths (`src/agent/transcribe-whistle.ts:57-67`).
- Fix direction: locate the new upstream artifact and re-pin URL + digest (or
  point docs at managed `engine:`/`weights:` paths).

**H2. A graceful restart mid-turn strands the turn forever** — restart-resume · odd · seen
- Expected: a graceful restart interrupts nothing (up to a drain) or
  auto-resumes and tells the channel — openclaw drains active turns up to
  5 minutes ("Most restarts therefore interrupt nothing at all",
  openclaw `docs/gateway/restart-recovery.md:120-124`) and re-dispatches with
  a resumption notice (`restart-recovery.md:420-442`); hermes marks active
  sessions `resume_pending` and auto-continues them
  (hermes `website/docs/developer-guide/gateway-session-lifecycle.md:309-392`).
- Goblin: SIGTERM fences every live lane under a **10-second** drain
  (`src/index.ts:94`), so any real-model turn takes the fenced rail — and
  fenced rows fall outside the entire recovery machinery: `/interrupted`
  lists only interrupted runs (`src/turn-resume.ts:481-484`), the journal
  refuses non-interrupted resume (`src/turn-journal.ts:844-847`), and boot
  notices cover only interrupted rows (`src/boot/telegram-attach.ts:276-284`).
  Seen live: resume on the fenced run → `no interrupted run matching`; the
  request stays unanswered until the operator happens to message again.
- Fix direction: make a shutdown-fenced row with an unanswered request
  boot-noticeable (and optionally resumable), or hold graceful restarts to a
  longer drain before fencing.

### Medium — would confuse or bite in normal weekly use

**M1. The shipped example makes the bot refuse its own owner** — first-setup · broken · seen
- Expected: setup collects the operator's channel identity so a wrong one is
  caught at setup (openclaw `docs/start/wizard.md:225`; hermes
  `website/docs/getting-started/quickstart.md:262`).
- Goblin: the example ships `operators: [123456789]`
  (`goblin.json5.example:313`) and nothing flags the placeholder — no doctor
  or installer check. A fresh operator whose real id differs gets the guest
  refusal "🚫 I only talk to my operator and approved users."
  (`src/tg/mod.ts:168-195`, `src/tg/guest.ts:45`) with a log line carrying no
  explanation. The self-fix (Settings → operators, applies live) is reachable
  only after diagnosing from docs.
- Fix direction: warn at boot when `operators` still holds the example id,
  and tell refused senders their own numeric id so the mistake is
  self-diagnosing.

**M2. No feedback between "sent" and "admitted" — up to 10 seconds of silence** — everyday chat · odd · seen
- Expected: intake acks immediately — openclaw types "immediately once the
  model loop begins" and can 👀-ack intake
  (`docs/concepts/typing-indicators.md`; `docs/channels/telegram/messaging.md`);
  hermes 👀-reacts at processing start and caps inbound batches at ~2s
  (`plugins/platforms/telegram/adapter.py:7008-7014`;
  `gateway/platforms/base.py:2394-2395`).
- Goblin: the typing indicator is created only when the coalescing buffer
  flushes (`src/tg/mod.ts:889`, `src/tg/delivery.ts:275,303`); there is no
  intake ack reaction. A continuous burst never quiets the 500ms window, so
  it is held until the 10s cap (`src/tg/mod.ts:77-78`) — ten seconds where
  Telegram shows nothing.
- Fix direction: ping typing (or ack-react) from intake on the first buffered
  update, and/or bound the trickle hold well below 10s.

**M3. Group topics and groups show literal markdown** — everyday chat · odd · seen
- Expected: markdown renders everywhere on Telegram — openclaw renders a
  channel IR to Telegram HTML for every reply
  (`docs/concepts/markdown-formatting.md`); hermes sends MarkdownV2 in groups
  too, falling back to stripped plain text
  (`plugins/platforms/telegram/adapter.py:3427-3440`).
- Goblin: rich rendering is gated to private DMs ("DMs only in v1",
  `design/telegram.md`); the plain sink sends text with no parse_mode, so a
  topic reply shows literal `**bold**`, `[link](url)` and raw fences
  (`src/tg/delivery.ts:154-164,282,707-785`). Probed: verbatim markers
  delivered.
- Fix direction: render for topic/group lanes too (shared IR → HTML), or
  strip-to-plain so markers at least disappear.

**M4. Telegram's native quote-select is ignored — the whole parent is injected** — message actions · odd · seen
- Expected: replying with a selected substring shows the agent the QUOTED
  part: openclaw prefers `msg.quote` (`extensions/telegram/src/bot/helpers.ts:656-667`);
  hermes prefers `message.quote` "so a user replying to a single selected
  substring … doesn't get the whole replied-to message injected"
  (`plugins/platforms/telegram/adapter.py:6929-6932`).
- Goblin: only `msg.reply_to_message` is read; its FULL text is injected
  (`src/tg/mod.ts:513,539`). `msg.quote` exists in goblin's own grammy types
  and is never read. Probed: a 3-paragraph parent, one paragraph
  quote-selected — all 3 reached the model.
- Fix direction: prefer `msg.quote.text` (and position) when building the
  quoted payload.

**M5. Replies to messages in other chats carry zero context** — message actions · broken · seen
- Expected: `external_reply` (Bot API) is a first-class reply target — openclaw
  resolves it (`extensions/telegram/src/bot/helpers.ts:655,669,699`).
- Goblin: `external_reply` is ignored (`src/tg/mod.ts:487-493`); with no
  `reply_to_message` no context part is built. Probed: "thoughts on this?" in
  — the model has no idea what "this" is, silently.
- Fix direction: fall back to `external_reply` (text + its quote) as the
  quoted context source.

**M6. New input waits out the entire current tool batch** — interrupt and steer · odd · seen
- Expected: steering is drained at tool-launch boundaries too, skipping
  unstarted calls with synthetic results (openclaw
  `docs/concepts/queue-steering.md:17-26`); hermes asks long tools to YIELD
  (`agent/interrupt_control.py:277-289`).
- Goblin: a steer is claimed at exactly one site — before each model call
  (`src/turn/stream.ts:447`); tool execution never checks for waiting input.
  Seen live: a message sent 3s into a 16s turn waited ~13s. With goblin's
  no-step-budget tool loop, one long bash call delays steering indefinitely.
- Fix direction: claim waiting steers at tool-launch boundaries (or document
  the model-boundary-only timing).

**M7. `/stop` drops queued messages with no per-message acknowledgment** — interrupt and steer · broken · seen
- Expected: queued input is either cancelled explicitly or surfaced — openclaw
  keeps a cancel identity per queued prompt (`docs/concepts/queue.md:118-136`);
  hermes never silently drops pending input (`gateway/run_turn.py:3595-3637`).
- Goblin: `/stop` drops queued turns (`src/runtime.ts:368-374`); a Telegram
  sink with nothing streamed shows NOTHING (`stampSuperseded` early-returns,
  `src/tg/delivery.ts:789-792`; probed: zero sends/edits). The message does
  stay in history, but the sender cannot tell it survived the stop.
- Fix direction: give the fenced sink a never-streamed drop ack threaded to
  the dropped message.

**M8. "Edits are live on the next message" — except they're not** — long conversation + persona and skills · broken · seen (found by both journeys)
- Expected: goblin's own docs promise SOUL.md/AGENTS.md/USER.md edits are
  "live on the next message" and skill changes are "live next turn"
  (`docs/usage.md:170-184`, `docs/skills.md:14-19`); openclaw rebuilds its
  system prompt each run (`docs/concepts/context.md:111,124-132`).
- Goblin: the system prompt is frozen per conversation and only rebuilds at a
  boundary (DM roll, compaction, spin-off; `src/agent/prompt.ts:1-6,452-470`).
  Seen live: a marker appended to SOUL.md was absent from the same
  conversation's next two model calls and a freshly installed skill's catalog
  line was absent too; a new conversation carried both. App conversations —
  which never roll — see the edit only at the next compaction.
  `docs/setup.md:251-253` states the real rule; usage.md and skills.md set a
  false expectation.
- Fix direction: correct the two docs to the boundary rule (and/or surface
  "prompt snapshot predates your edit" in the app).

**M9. The 🔊 button forgets the whole reply across restarts — and says so to no one** — everyday chat + media and voice · odd · seen (found by both journeys)
- Expected: a read-aloud of a reply reads the reply; openclaw persists TTS
  output in a media store and speaks from the stable path
  (`docs/tools/tts/output.md:28-30`).
- Goblin: the whole-reply text lives in a per-process Map capped at 256
  entries (`src/tg/delivery.ts:49,118-125`); after a restart or eviction the
  button speaks only the tapped bubble — for a multi-chunk reply, just the
  last chunk — with no notice it is partial
  (`src/tg/speak-button.ts:65-77`). Probed both paths.
- Fix direction: resolve reply text durably from the conversation store, or
  answer the miss with an explicit partial notice.

**M10. Input accepted before shutdown is swallowed without a trace** — restart-resume · broken · seen
- Expected: input in flight at a restart is rejected loudly or recovered —
  openclaw rejects drain-window messages "with an explicit restart error"
  (`docs/gateway/restart-recovery.md:692-695`).
- Goblin: a submit made mid-turn persists as a durable user event, then the
  shutdown fences its would-be turn; after restart nothing submits it and no
  notice names it. Seen live: the message sat unanswered until the operator
  happened to send something else.
- Fix direction: surface accepted-but-never-run inputs at boot (count them in
  the interrupted notice, or re-admit them).

**M11. A reply produced but not delivered before a crash is never delivered** — restart-resume · broken · unverified
- Expected: undelivered replies are retried after restart (openclaw
  `docs/gateway/restart-recovery.md:29,95-103,424-427`); hermes claims
  `delivery_obligations` at startup and delivers the owed answer
  (`gateway/run_startup.py:303-342`).
- Goblin: reply + `reply_landed` commit before terminal delivery
  (`src/runtime.ts:1055-1061`); a crash in the delivery window leaves the row
  `running`/`pending`, reclassified interrupted with the reply already in
  history — and nothing scans pending-delivery rows at boot
  (`src/wake-dispatcher.ts:101` reads the stamp only for wakes); Telegram
  sends are never retried (`src/tg/delivery.ts:209`). `/resume` offers a
  re-run, not delivery of the text already written.
- Proves it: hand-craft the crash-mid-delivery row on a throwaway (status
  `running`, `reply_landed=1`, delivery `pending`), restart with Telegram
  mocked at the grammy edge, observe the boot notice fire while no channel
  send happens.
- Fix direction: give `reply_landed=1` + delivery `pending` rows a boot owner
  that re-delivers (or names) the landed reply.

**M12. Memory failures are invisible on the app channel** — memory · odd · seen
- Expected: memory use and failures show in the conversation — hermes renders
  a per-turn recall indicator (`agent/memory_manager.py:450-462`) and visible
  save announcements (`website/docs/user-guide/features/memory.md:295-323`);
  openclaw surfaces flush failures as visible ⚠️ payloads
  (`src/auto-reply/reply/agent-runner-memory.ts:1866-1872`).
- Goblin: Telegram gets the designed notices (`src/tg/notify.ts:85-98,123-134`);
  app conversations get neither — both paths log "skipped — app conversation
  rings nothing" (observed live). Blocked saves reach the attention feed, but
  recall outages and undrained queues have no attention item at all
  (`src/http/app-attention.ts` builds only memory-blocked) — the turn
  completes looking normal.
- Fix direction: mirror the memory-blocked attention item for recall outages
  and undrained queues (or deliver the episode notice into the app thread).

**M13. Ecosystem skills with spec-legal metadata are silently skipped** — persona and skills · broken · seen
- Expected: "skills from the wider ecosystem usually just work"
  (`docs/skills.md:4-6`); openclaw skills carry nested metadata objects,
  hermes skills carry list-valued metadata — both spec-legal.
- Goblin: the frontmatter schema accepts only string-valued metadata
  (`src/agent/skills.ts:27`). A nested object or list fails `parseSkill`; the
  skill is skipped with a warn to goblin.log only, and the prompt section
  shows just "(N entries skipped as malformed)" — never the reason. Seen
  live: an openclaw-shaped skill skipped (`expected string, received object →
  at metadata.openclaw`); a hermes-shaped one rejected the same way at module
  level. Install-by-chat has no validation surface at all.
- Fix direction: widen the metadata schema (`z.record(z.string(), unknown())`
  or openclaw-style flattening).

**M14. "Drafts never install themselves" — unless the reviewer is configured; meanwhile the prompt invites direct writes** — persona and skills · odd · seen
- Expected: docs read as default behavior: "the bot may draft what it learned
  … Drafts never install themselves" (`docs/skills.md:67-75`); openclaw's
  Skill Workshop queues agent drafts (`docs/tools/skills.md:292-298`).
- Goblin: the proposal pipeline is the optional skill reviewer — off unless
  configured (`goblin.json5.example:199`, `design/skills.md:292-296`; boot log
  had zero reviewer lines). The always-on prompt instead invites the model to
  write the live catalog directly ("This catalog is yours: write
  skills/<name>/SKILL.md…", `src/agent/skills.ts:209-210`), and nothing
  distinguishes an operator-requested write from a self-initiated one.
- Fix direction: document that auto-proposals need the reviewer block, and
  reconcile the prompt's direct-write invitation with the parking promise.

**M15. "I prefer X" is captured nowhere by default** — persona and skills · odd · seen
- Expected: stating a preference sticks — openclaw feeds USER.md as protected
  directives (`docs/concepts/user-model.md:12,98-116`); hermes captures
  memory from conversations automatically (`guides/work-with-skills.md:263-274`).
- Goblin: memory retention is opt-in/off; when on, preferences land in
  Hindsight, never promoted to USER.md (`design/skills.md:188-191`). USER.md
  has exactly one writer: the boot seed (`src/home-layout.ts:168-185`); the
  prompt carries no standing instruction to record stated preferences there —
  the only capture trigger is the literal "remember this"
  (`src/home-layout.ts:126`). The mechanism absence is verified; whether real
  models write USER.md unaided is not (the fake model makes no tool calls).
- Fix direction: add a standing prompt instruction to write stated
  preferences into USER.md in the seeded directive format.

**M16. `/model` on Telegram becomes chat text** — model switching · odd · seen
- Expected: model switching is a chat command (openclaw `docs/concepts/models.md:350-353`;
  hermes `website/docs/user-guide/configuring-models.md:52,308-315`).
- Goblin: Telegram has no model command (`src/tg/commands.ts:536-552`);
  `/model <ref>` fails `COMMAND_RE` and falls through to the inbox as
  ordinary user text — no error, no hint; the model may casually answer it.
- Fix direction: refuse slash-shaped text matching no known command (or add a
  /model stub pointing at Settings).

**M17. A mid-stream connection drop kills the turn with zero retries** — errors and limits · broken · seen
- Expected: goblin's own ruling grants one stream-surface step retry because
  "a dropped connection must not kill a turn that already executed tools"
  (`design/model.md:377-414`, issue #191); openclaw recovers transient
  failures preserving partial output (`docs/concepts/model-failover.md:16-21`);
  hermes retries each call 3× and can switch provider mid-turn.
- Goblin: on the openai-compatible lane a mid-stream socket reset arrives as
  a reader throw, not an error part — `filterErrorStream` tags only error
  PARTS as stream-surface (`src/agent/filter-stream.ts:85-94,103-107`), the
  transport middleware retries only doStream dispatch throws
  (`src/agent/providers.ts:57-97`), and `streamText` never invokes the onError
  grantor. Seen live: a scripted mid-stream break made exactly ONE provider
  POST and the turn failed; the fallback walk can't help (failure after spend
  never advances, `src/runtime.ts:1287-1306`).
- Fix direction: treat a reader-throw of a transient-classified error as an
  error part so the designed one-step retry can fire.

**M18. A delegations worker that freezes mid-work runs forever, unnoticed** — delegate coding · broken · seen
- Expected: a stalled child eventually surfaces — hermes' stall monitor
  interrupts at 450s idle / 1200s in-tool and finalizes `stalled`
  (`website/docs/user-guide/features/delegation.md:395-426`); openclaw
  finalizes stale runs after a 2h window (`docs/tools/subagents/operations.md:29-35`).
- Goblin: the watcher transitions only on blocked/idle/done/seq-advance
  (`src/delegation-lifecycle.ts:1385-1428`); the only stall rule is 90s for
  never-started (`:156-158`), and no run timeout exists. Probed: a scripted
  herdr reporting `working`/frozen kept its row `running` forever with zero
  notices. Goblin's own ROADMAP names the missing backstop
  (`ROADMAP.md:95`).
- Fix direction: a progress-stall rule symmetric to never-started — no
  `state_change_seq` advance in a configurable window flips to `needs_input`
  with a notice.

**M19. `resumeWhen` is stored, displayed — and never consulted** — ongoing concerns · odd · seen
- Expected: work waiting on an external condition holds model spend until it
  — hermes parks on a judged `wait` with no turn consumed
  (`website/docs/user-guide/features/goals.md:159`); openclaw parks flows on
  wait metadata (`docs/automation/taskflow.md:60,76`).
- Goblin: `waiting` requires and stores `resumeWhen`
  (`src/responsibility-reports.ts:70-71`, `src/responsibilities.ts:914`) and
  the feed shows it — but no scheduler reads it. `waiting` derives waitsFor
  `nobody` (`src/responsibility-stage.ts:90-95`), so the follow-up Program
  fires a full charter model turn at each hourly bound until the model
  happens to file a report. Seen live end to end: a responsibility waiting on
  an external event burned a scheduled check-in at :27 and re-armed for the
  next hour, indefinitely.
- Fix direction: schedule the next review from `resumeWhen` (or require a
  planned commitment whenever a report states `waiting`).

**M20. A dead observation target still shows "attached"** — ongoing concerns · broken · seen (module level)
- Expected: a stopped target is surfaced — openclaw's `tasks audit` reports
  stale/lost work (`docs/automation/tasks.md:280-302`); hermes records spawn
  failures on the card (`website/docs/user-guide/features/kanban.md:340-347`).
- Goblin: the observer treats a failing target as a skipped group with only a
  warn log ("responsibility observation unreachable",
  `src/responsibility-observer.ts:401-410`); health stays `attached`, the
  feed pill keeps `worker-a (attached)`, no work event, nothing in Attention,
  and doctor has no observer check. Probed at module level: three failing
  passes, zero user-visible change.
- Fix direction: track consecutive unreachable polls and surface an
  "observation unreachable since" state on the pill (plus a doctor check).

**M21. The transcript grows without bound — payload, JSON, and DOM** — two doors · odd · unverified
- Expected: history stays stable however big — openclaw truncates and offers
  per-message recovery (`docs/web/webchat.md:28-30`); hermes pages at 500
  per request (`website/docs/user-guide/features/web-dashboard.md:506`).
- Goblin: `GET /api/app/conversations/<id>/messages` maps the ENTIRE durable
  history with no LIMIT (`src/http/app-conversations.ts:723,757-762`; causal
  SQL unbounded, `src/conversation-queries.ts:39-41,132-141`), the client
  renders every message with no virtualization, and compaction rewrites only
  the model view — the transcript, its payload and the DOM grow forever.
  Shape read, not measured.
- Proves it: seed ~5k events through the store API on a throwaway and time
  `GET /messages` + render cost.
- Fix direction: serve a bounded newest window with an older-page fetch.

### Lower — friction, surprises, polish

**L1. Setup reports success before anyone knows inference works** — first-setup · odd · seen. Openclaw's onboarding is "locked until one backend has passed" a live completion (`docs/start/onboarding.md:177-179`); goblin's installer ends at "local startup accepted; message the bot" (`scripts/install.ts:432`) and diagnostics deliberately make no model test. The first proof is your own first message (which does fail loud in-channel — probed). Fix: a non-paying provider-readiness line in installed-phase doctor / `/api/app/status`.

**L2. App conversations are never titled with the shipped example** — first-setup · odd · seen. The example leaves `titleModel` unset commenting it as "Auto-titles for Telegram's placeholder topic names" (`goblin.json5.example:66-69`), but the app channel asks the same titler (`src/http/app-chat.ts:413-435`); seen live: 2 turns, title still null, 0 title calls. Fix: broaden the comment or fall back to the conversation's model with a tight cap.

**L3. A typo'd top-level config key errors with no key name** — first-setup · odd · seen. Boot fails with `invalid config — config: unrecognized_keys` and no pointer (deliberate, so pasted secrets never surface — `src/config.ts:114-123`); JSON5 syntax errors do keep line numbers. Fix: report unrecognized keys' line numbers only, mirroring the syntax-error precedent.

**L4. Message splitting can cut a code fence in half** — everyday chat · odd · seen. The plain path slices at a fixed 3800-char window (`src/tg/delivery.ts:18,140-150`); a fence straddling the boundary split open (fence markers [1,0,1]). openclaw's chunker keeps fences whole, closing and reopening them (`docs/concepts/streaming.md`). Fix: snap boundaries to paragraph/newline; close-and-reopen fences.

**L5. Forwarded messages arrive with no origin** — message actions · odd · seen. openclaw prefixes `[Forwarded from <name> at <date>]` (`extensions/telegram/src/bot/body-helpers.ts:531-536`); goblin has no `forward_origin` handling anywhere — the model can't know the text came from someone else (hermes also lacks it, so this mainly surprises openclaw migrants). Fix: prefix a forward-origin marker at intake.

**L6. Quoted text is silently hard-cut at 2000 chars — in the model's view only** — message actions · odd · seen. `quoted.text.slice(0, 2_000)` with no marker (`src/tg/mod.ts:539`); probed: a 2459-char parent's tail clause absent from the model view while the durable row keeps the full text. hermes deliberately keeps reply-to text whole (`gateway/run_inbound.py:1569-1576`). Fix: raise the bound or mark the truncation.

**L7. Editing a sent message after commit is silently ignored** — message actions · broken · seen. In-window edits amend the buffered text (probed); after commit the edit is acked with only a log line (`src/tg/mod.ts:615-619`) — the ruling settles ack-and-log (`design/telegram.md:67-69`), but goblin's own app door offers edit-in-place (`src/http/app-chat.ts:27-31`). Fix: a tiny chat notice when a committed message's edit arrives.

**L8. Replying to a media-only message gives the model no reply marker** — message actions · odd · seen. Empty quoted text produces no part at all (`src/tg/mod.ts:513,538`); probed: bare "what is this?" with no marker (openclaw renders a media placeholder; hermes behaves the same). Fix: emit a media-kind placeholder when quoted text is empty.

**L9. The claude-code engine never merges steered messages — and nothing says so** — interrupt and steer · odd · seen. `docs/usage.md:43-44` promises bursts merge; the claude-engine defers steered messages to separate turns by ruling (`src/agent/claude-code/engine.ts:8-9`, pinned in tests) on goblin's first-class subscription lane, with no per-message notice. Fix: name the exception in docs; consider a "will answer next" state.

**L10. On process death mid-stream, the words you watched vanish** — interrupt and steer + errors and limits · broken · seen (found by both journeys). Checkpoints land only at step end (`src/turn/stream.ts:612-646`); a death mid-step leaves `partial NULL`, the interrupted rail appends nothing, and the resume seed has no partial — probed live: ~9 streamed words exist nowhere. Fix: a lightweight wire-tail checkpoint so the interrupted record carries text already streamed.

**L11. A fenced Telegram reply loses its unflushed tail (~1s of text)** — interrupt and steer · odd · seen. The sink flushes at most 1×/second; the superseded stamp lands only on shown text (`src/tg/delivery.ts:15,789-792`) and no Telegram command renders history, so that text is unretrievable in-channel. Code-read note (unverified live): rich-DM drafts never get a stamp at all. Fix: flush pending deltas before stamping.

**L12. `/compact focus on X` — the focus is parsed and dropped** — long conversation · odd · seen. `handleCommand` binds the arg, then calls `compact(conv)` with none of it (`src/tg/commands.ts:117,141-160`; the app route reads no body either). openclaw passes operator focus into the summarizer (`docs/concepts/compaction.md:79-85`). Fix: thread the focus through, or reply that it's unsupported.

**L13. Transcription failures are stored and sent to the model — but never shown to the user** — media and voice · odd · unverified. The part carries `transcriptionError` end to end (`src/tg/mod.ts:566-572`); the app UI parses it (`app/src/chat/MessageParts.tsx:181-185`) but renders only transcripts — the operator sees a normal audio chip with no hint their ASR is broken. Proves it: open the probe conversation in the app and observe the chip. Fix: render the error on the chip (plus a one-line Telegram note).

**L14. Video stickers are saved as `.webp` with `application/octet-stream`** — media and voice · odd · seen. `src/tg/media.ts:132-141` ignores `is_video`; the bytes are webm, so the extension lies and tools treat it as a non-image. Fix: name by real container (sniff or `is_video`).

**L15. `/voice` speaks every reply, even to typed text** — media and voice · odd · seen. One binary per-topic flag (`src/tg/commands.ts:280-297`); hermes ships off/voice_only/all (`voice-mode.md:283-299`). Fix if wanted: a speak-only-on-voice arm.

**L16. Recovery is one operator decision per run, in the owning conversation** — restart-resume · odd · seen. Boot is strictly notice-only by settled ruling (`DESIGN.md:169-172`); both references auto-continue (openclaw `restart-recovery.md:420-433`; hermes `gateway-session-lifecycle.md:341-352`). No fix required if the ruling stands; an opt-in auto-resume for zero-ambiguity runs would match the references.

**L17. The Telegram program-approval card shows raw cron; the app card shows words** — scheduled work · odd · seen. Module probe of the Telegram card text: `triggers: cron "* * * * *"` with no words/timezone (`src/program-approval.ts:264-274`), while the app renders "Weekdays 08:30" via `cronWords` (`app/src/Approvals.tsx:318-327`). openclaw's ruling: "Confirm that sentence, not a cron expression" (`docs/automation/cron-jobs/how-it-works.md:63-66`). Fix: render through `src/cron-words.ts` + timezone on both surfaces.

**L18. A 23-hour-late catch-up fire is indistinguishable from an on-time one** — scheduled work · odd · seen. The delivered tag carries only name+trigger (`src/tags.ts:6-8`); the missed occurrences exist only in a log line (`src/scheduler.ts:498-509`). Probed: 5 missed weekdays coalesced into one fire, nothing in the conversation says so. Fix: include the occurrence (and coalesced count) in the tag.

**L19. A skipped scheduled occurrence leaves a log-only trace** — scheduled work · odd · seen. The skip warn lands in goblin.log (`src/scheduler.ts:272-285`); the Programs page's "late N min" pill clears the moment the cursor advances, and there is deliberately no run-history table (`design/programs.md:376-384`). Goblin's own roadmap targets inspectable skips without logs (`ROADMAP.md:122-123`). Fix: stamp the last skip on the program row.

**L20. Lifting a project's memory gate leaves its conversations excluded** — memory · odd · seen. The exclusion is stamped on each conversation at create (`src/http/app-conversations.ts:284-298`); after the project returns to `shared`, turns still log "memory exchange excluded at admission" until each conversation is flipped by hand (probed both directions). openclaw's rule removal re-admits via a later sweep (`docs/concepts/memory-provenance.md:147-150`). Fix: recompute the effective flag when the project setting changes.

**L21. The 128-skill cap truncates silently — even to the bot** — persona and skills · broken · seen. The catalog is sorted, sliced, and the overflow dropped with a log-only warn (`src/agent/skills.ts:16,175-183`); probed: 130 skills → 128 advertised, no capped note anywhere in the prompt section, so `docs/skills.md:80-82`'s "mention it to the bot" remedy cannot work. Fix: render a capped note like the malformed count.

**L22. A mid-flight model switch is acknowledged only in the log** — model switching · odd · seen. The running turn keeps its admitted pair by design; the PATCH response says nothing ("applies: next turn" is log-only, `src/http/app-conversations.ts:436-486`). Proven live. Fix: surface the fact in the response/composer.

**L23. `/resume` after a model switch refuses without offering the restore** — model switching · odd · seen. "model changed a → b since the interruption — not resumed" (`src/turn-resume.ts:632-645`); the recorded snapshot already carries the pair. Fix: offer the drift pair as a one-tap restore.

**L24. Switching models silently rewrites your thinking level** — model switching · odd · seen. The switch clamps thinking onto the destination ladder at-or-above (`src/http/app-conversations.ts:468-475`) — e.g. medium → high, raising per-turn spend, visible only in the knob after refetch. Fix: a one-line note in the switch UI.

**L25. A transport failure surfaces as "Failed to process successful response"** — errors and limits · odd · seen. The terminal path returns `err.message` verbatim (`src/turn/overflow.ts:169-172`, `src/turn/stream.ts:760-765`); the real cause (ECONNRESET) and retry story are log-only. openclaw composes visible failure text and keeps raw provider detail out (`docs/concepts/model-failover.md:330-332`). Fix: classify transport-shaped failures and compose a short operator line.

**L26. An orphaned foreground reply's push says "A background turn finished"** — two doors · odd · seen. The interactive chat route wires the same `notifyDone` the wake path uses when the wire died (`src/http/app-chat.ts:217-219`), with the fixed background body (`src/app-push.ts:206-212`; probe-asserted). Fix: derive the wording from the submit origin.

**L27. A delegation that ends by asking a question settles `done`** — delegate coding · odd · seen. Any idle agent with a completion settles `done` regardless of report content (`src/delegation-lifecycle.ts:1408-1421`); probed: a report that is itself a question settled `done` (the text does arrive fenced, so relaying works — the label misleads). Fix: downgrade end-of-turn questions to `needs_input`.

**L28. `delegate answer` delivers a keypress to an agent that isn't blocked** — delegate coding · odd · seen. `answer` checks only stopped/starting/never-launched (`src/delegation-lifecycle.ts:908-917`) though herdr documents sendKey as "the only input a blocked agent accepts" (`src/herdr.ts:168-172`); probed: the key reached a mid-work TUI unnoticed. Fix: preflight `agent get` and refuse unless blocked.

---

## Scope questions

For the operator. Each is a gap the investigators could not classify as a
finding because goblin's scope documents may settle it. Grouped by theme;
the journey that raised it is named.

**Setup & doors**
1. Is a first-boot guided provider setup with a live (paid) verification gate
   wanted at all, or is hand-edited bootstrap + manual handshake the settled
   shape? A wizard is a recorded non-goal (`DESIGN.md:326`); openclaw locks
   onboarding until a live completion passes. (first-setup)
2. A terminal door (hermes users live in `hermes`/`hermes --continue`) —
   confirm out of scope for CLI-first migrants? (first-setup)
3. Should anything carry an old agent's memory over (openclaw onboarding
   imports Claude Code/Codex/Hermes memory; goblin seeds empty stubs), or is
   restart-fresh by design? (first-setup)
4. `docs/setup.md`'s first-boot tree lists `goblin.json5`/`auth.jsonl` under
   "boot seeds missing files", but boot seeds neither — it exits telling you
   to copy the example (verified live). Fix the tree? (first-setup)
5. Cross-door read-only visibility (openclaw WebChat shows cross-channel
   context; hermes' dashboard resumes Telegram-sourced sessions) — still out
   of scope under the disjoint-pools ruling? (two-doors)
6. The Telegram mini app door serves settings+memory pages only, while
   openclaw's mini app opens the full Control UI — settled two-page scope? (two-doors)
7. Should channel (Telegram attach/poll) health ever surface in-app, or is
   log-page-only settled? (two-doors)
8. The context-window view and gauge are app-only by ruling — fine for a
   Telegram-only operator to have no "what hit the window" surface? (two-doors)

**Conversation mechanics**
9. Ratings are record-only by ruling, while DIRECTION.md calls up/down
   steering signals Goblin must interpret — when should a 👍/👎 start
   steering? (everyday chat)
10. Rich rendering/🫡 for group topics: planned, or should topics stay plain? (everyday chat; overlaps M3)
11. Is the 500ms/10s coalescing pairing settled, given the silent 10s hold? (everyday chat)
12. Model-directed reply threading (`[[reply_to:<id>]]` in openclaw): non-goal? (everyday chat + message actions)
13. Should the Telegram door get the app's edit-in-place affordance, or does
   the ack-and-log ruling stay final? (message actions; two doors raised the no-replay ruling too)
14. The always-on reply anchor carries no native quote excerpt (openclaw adds
   one when enabled) — intended? (message actions)
15. Deletes: the Bot API delivers none for ordinary chats — is /forget plus
   memory exclusion the accepted answer for "unsay this"? (message actions)
16. Per-conversation queue modes (openclaw `/queue steer|followup|collect|interrupt`,
    hermes `/busy`): non-goal, or wanted? (interrupt and steer)
17. A hermes-style redirect (cancel only the in-flight model request, keep
    completed work, retry with the correction) instead of wait-or-`/stop`? (interrupt and steer)
18. Per-message "withdraw queued message" in the app, vs conversation-wide
    `/stop` only? (interrupt and steer)
19. Should a fenced (`/stopped` or settings-fenced) run be resumable like an
    interrupted one? Today `/resume` lists only process-death runs. (interrupt and steer)
20. For rich-DM replies, the partial lives in editable drafts that never get
    the superseded stamp — acceptable, or should the fenced path withdraw the
    draft? (interrupt and steer)
21. Is a live multi-step steering demo required before shipping changes here?
    The fake model can't emit tool calls, so the mid-run fold is module-proven
    only. (interrupt and steer)
22. Telegram has no window-fullness visibility (gauge/context view are
    app-only; openclaw chats get `/status` with tokens + compaction count) —
    minimal `/context` reply wanted? (long conversation)
23. Undo-a-turn (hermes `/rollback` + checkpoints; goblin has edit-in-place
    and branch but no undo) — non-goal? (long conversation)
24. The pre-fold memory flush runs only when the `memory` block is ABSENT —
    with Hindsight configured it is always skipped. Settled trade? (long conversation)
25. Provider-native opaque compaction and micro-compaction remain documented
    non-goals — still settled? (long conversation)

**Media & voice**
26. Should intake transcripts be echoed into the chat (hermes echoes by
    default; goblin shows them in the app UI and to the model only)? (media and voice)
27. Is `/voice` granularity (speak only when spoken to) wanted, or is the
    binary the settled shape? (media and voice; overlaps L15)
28. Should very long replies be summarized before speech (openclaw Auto-TTS),
    or is whole-reply chunked speech intended? (media and voice)
29. Is live/streaming voice permanently out of scope
    (`design/asr.md:191-193`) as the references grow there? (media and voice)

**Memory & persona**
30. Explicit "remember this": is automatic retention plus the browser's
    "Recent saves / nothing kept" rollup the whole answer, or should the
    model get a deliberate must-keep affordance (hermes `memory(add)` acks at
    its limit; openclaw writes files you can open)? (memory)
31. `/forget <query>` resolves via recall, so a stored exchange whose facts
    don't surface semantically can't be listed on Telegram; the app browser
    filters by id substring only — content search for forgetting out of
    scope? (memory)
32. Recall score floors drop facts client-side with only a log trace —
    acceptable silence while the floors tune? (memory)
33. Guest lanes are memory-free by class with no override — confirm
    unconditional even inside memory-on projects. (memory)
34. The global Memories routes 503 when Telegram is disabled — the PWA gets
    the per-thread sheet only; intended door split? (memory)
35. The recall query is built from recent history text (≤2000 chars),
    including assistant prose that may quote recalled evidence — intended
    query policy? (memory)
36. Should unprompted model writes into the live skills catalog carry any
    approval or marking, or is "conversation = approval" settled? (persona and skills)
37. Should preference capture into USER.md exist now, independent of the
    opt-in memory block (ROADMAP §4 defers the memory loop)? (persona and skills; overlaps M15)
38. Should the app skills page surface malformed-skill reasons (currently
    log-only)? (persona and skills)
39. Temp-skill invocation (`/skill <url>`, preview card, Telegram confirm)
    wasn't exercisable here — does another journey cover it? (persona and skills)
40. Is the 128-skill cap a real limit, or should oversized catalogs warn and
    advertise a relevance-bounded subset? (persona and skills; overlaps L21)

**Models & errors**
41. Should Telegram get any in-chat model surface, even read-only
    ("what model am I on")? The one-shared-selection ruling settles scope,
    not in-chat visibility. (model switching; overlaps M16)
42. Should `modelFallbacks` ever become per-conversation (explicitly out of
    scope, `design/model.md:359-361`) as the references support? (model switching)
43. Should large-context switches get a confirmation or cost note (hermes
    confirms above 100k tokens), given each switch is a sanctioned cold-cache
    re-read? (model switching)
44. Provider Retry-After longer than 60s isn't honored (the AI SDK's 0–60s
    window); openclaw deliberately honors longer floors — worth a
    goblin-granted wait? (errors and limits)
45. One credential per provider, no cooldowns/health checks, is settled —
    should a failing provider's single key still be the only thing tried
    before the fallback walk? (errors and limits)
46. A quota wall logs the provider's `resetAt` but schedules nothing on it;
    should quota-walled scheduled work re-fire at the stated reset? (errors and limits)
47. Interactive turns get no automatic re-fire after a transient zero-effect
    failure (the 5/15/30m ladder is program-fires only) — is the manual ↻
    the intended story for chat turns? (errors and limits)

**Delegation & ongoing work**
48. Should the app Delegations page grow a live transcript/steer affordance
    (openclaw Control UI and hermes `/agents` both have one), or are
    conversation + `herdr session attach` the intended paths? (delegate coding)
49. Issue/PR readiness watching is project-only (the fields are physically
    omitted from the tool schema outside a project conversation) — by design,
    or should a non-project "fix issue N" nudge creating a responsibility? (delegate coding)
50. For machine targets, the deep screen tail is always the result and the
    remote report.md is never fetched — accepted posture? (delegate coding)
51. Work sitting in `review` has no operator-side close (app offers only
    Correct/Pause/Resume/Cancel; `done` must come from goblin's evidenced
    report) — should the operator accept-and-close directly? (ongoing concerns)
52. A chat-typed correction uses `responsibility revise`, which — unlike the
    app-route correction — neither fences other lanes nor records a durable
    operator-correction event. Intended asymmetry? (ongoing concerns)
53. Pause stops goblin's watching but deliberately leaves the Herdr agent
    running — should the pill say "agent still running"? (ongoing concerns)
54. Handover exists only in app project conversations — for a Telegram-first
    user saying "keep an eye on X", is steering them to the app the intended
    UX? (ongoing concerns)
55. There is no way to fire a program on demand (`/cron run`, test fire) —
    approving "weekdays at 8:30" activates a program whose first output may
    be five days away and untested. Run-now/test-fire wanted? (scheduled work)
56. Outbound webhook delivery of program output (openclaw `--webhook`) — out
    of scope alongside inbound hooks? (scheduled work)
57. The webhook secret URL requires HTTPS-only `publicUrl` — on a
    loopback-only box hooks cannot be granted at all. Intended minimum
    footprint, or should a tailscale-serve HTTP door qualify? (scheduled work)

---

## Questions that would have caught these

One generic question per finding, to add to the step-3 list so future hunts
ask it of every journey.

1. H1 — Does the journey's default configuration still work end to end on a
   fresh install today — do all pinned external artifacts still exist?
2. H2 — When a step is interrupted intentionally (restart, stop), is the
   unfinished work findable, explainable, and resumable afterwards?
3. M1 — If the operator follows the shipped example verbatim but their real
   identity differs, does the first real action fail with a message that
   names the cause?
4. M2 — From the moment input is sent until the first visible response, is
   there any feedback at all? What is the worst-case gap?
5. M3 — Does every surface this journey renders on apply the same formatting
   rules?
6. M4 — When the user narrows or points at something (quote, selection,
   reply target), does the model see the narrowed thing or the whole parent?
7. M5 — Does every kind of reply target, including cross-chat/external ones,
   carry its context into the model's view?
8. M6 — How long can new input wait before the model sees it, worst case in
   this journey?
9. M7 — When the product discards user input or work, does the user get a
   per-item acknowledgment?
10. M8 — When the operator edits a file the docs promise is live, does the
    next turn actually reflect the edit — and do the docs match the real
    boundary?
11. M9 — Which parts of this journey live only in process memory, and what
    does the user experience after a restart?
12. M10 — Is any accepted input ever left with no owner (no turn, no notice)?
13. M11 — If a produced result is committed but its delivery is interrupted,
    who delivers it later?
14. M12 — When a background subsystem fails during this journey, is the
    failure visible on every channel it affects?
15. M13 — Does the product accept the formats its own docs claim are
    compatible — tested with real samples from the ecosystem?
16. M14 — Do the docs' safety promises hold under the default configuration,
    or only when an optional feature is enabled?
17. M15 — When the user states a durable preference, what mechanism records
    it — and is that mechanism present by default?
18. M16 — Do commands the reference agents train users to type fail loudly
    when this product doesn't support them?
19. M17 — Which failure shapes reach the designed retry/backup paths, and
    which bypass them?
20. M18 — If a worker or turn never advances, what eventually notices, and
    when?
21. M19 — Does every stored field that promises future behavior actually get
    read by a scheduler?
22. M20 — When a dependency becomes unreachable, does the UI keep claiming
    health?
23. M21 — What in this journey grows without bound, and what is the
    experience at 100× today's size?
24. L1 — Does "installed/healthy" mean the same thing to the product as it
    does to the migrating user?
25. L2 — Which features does the shipped example config accidentally disable?
26. L3 — When validation fails, does the error name the location without
    leaking content?
27. L4 — Does output splitting respect content boundaries the references
    respect?
28. L5 — When a message's origin matters (forwarded, cross-chat), does the
    model learn the origin?
29. L6 — Are any silent truncations applied between what the user sent and
    what the model sees?
30. L7 — Does an ignored user action get any visible acknowledgment?
31. L8 — When context exists but is empty-shaped (media-only parent), does
    the model still learn the fact of the reference?
32. L9 — Are engine-specific exceptions to documented behavior named where
    the behavior is documented?
33. L10 — What does the user watch disappear when the process dies mid-step?
34. L11 — Is already-produced output retrievable in-channel after an
    interruption?
35. L12 — Are command arguments parsed but unused anywhere in the product?
36. L13 — Is error detail that reaches the model also reachable by the user?
37. L14 — Do saved artifacts keep truthful names and types?
38. L15 — Do mode flags match the granularity the references offer?
39. L16 — Is notice-only recovery a ruling or an accident, and does the
    operator know which?
40. L17 — Do all surfaces of one confirmation show the same human-readable
    form?
41. L18 — Can the user tell delayed/coalesced work from on-time work?
42. L19 — Do skipped actions leave a trace on an inspectable surface?
43. L20 — When a parent scope's setting changes, are children's stamped
    copies recomputed?
44. L21 — Are enforced limits visible to the party the docs tell to react to
    them?
45. L22 — Is a deferred effect ("applies next turn") visible at switch time?
46. L23 — When an action is refused because state drifted, does the refusal
    offer the restore?
47. L24 — Do automatic adjustments to user-chosen settings explain
    themselves?
48. L25 — Does user-facing failure copy diagnose, or does it relay SDK
    internals?
49. L26 — Do notifications name their actual origin?
50. L27 — Is completion distinguished from an ended turn that asks a
    question?
51. L28 — Are steering/refusal preflight checks symmetric across all input
    verbs?

---

## Appendix: verification per journey

Condensed from the investigators' evidence trails. Every "seen" label above
rests on these; every instance was `bun run try down` afterwards and the
checkout left pristine.

- **first-setup** — throwaway instance; full first-conversation flow over the
  app HTTP API; restart-survival probe; dead-provider and missing-key probes
  (both fail loud in-stream, then self-fixed via the app's settings/secrets
  routes); no-config and typo-config boot probes; `bun test src/tg/mod.test.ts`
  operator-refusal probe. Not run: real Telegram legs, real model.
- **everyday chat** — in-process end-to-end probe (real bot + grammy polling
  against a fake Bot API server, real buffer/inbox/runtime with scripted
  fake model): 32 checks — burst merging, rich drafts, threading, 🫡 +
  ratings row, swipe-reply quote, ⚠ on tool throw, chunking, typing cadence,
  roll marker; two-process restart replay probe; module probes for the
  trickle cap, speak button, and literal-markdown delivery; repo tests green.
- **message actions** — 14 module probes against real `src/tg` modules
  (quote-select, external_reply, forward origin, 2000-char cut, edit
  windows, media parents, restart replay, first-chunk anchoring) + live
  end-to-end app turn. Not run: real Telegram wire.
- **interrupt and steer** — live queued-message, `/stop`, and SIGKILL-resume
  scenarios on the instance (unlanded records, `/interrupted`, resume
  refusal for fenced runs); `src/turn/stream.test.ts` (44), `src/runtime.test.ts`
  (130), claude-engine steer pin (16), app ChatView (125), Telegram fence
  probes (4).
- **long conversation** — 6-turn growing history, `/window` captures, SOUL
  freeze probe (marker absent until a fold), `/compact` noop + audit-failure
  500 + successful fold via goblin's own store API, trigger/boundary/
  budget/pre-empt module probes, `/compact <focus>` parse probe.
- **media and voice** — attachment + speech turn with transcription failure
  (named error stored, message kept); live whistle 404 (URL checked from
  this box); TTS route 503→200 lifecycle incl. restart persistence; module
  probes for speakable-content rules, voice-mode sink, speak-button cache
  hit/miss, media typing, transcription chain fallbacks, materialization,
  and the `speak` tool. One stray file written to the real home during a
  probe was trashed immediately; nothing else touched it.
- **restart-resume** — SIGTERM-fence and SIGKILL-interrupt scenarios on the
  instance; fenced-run non-resumability proven; wake reconcile, inbox replay,
  journal crash tests, memory/program restart tests green; one probe
  artifact (two processes on one home, against goblin's single-process
  design) was identified as such and all cited scenarios redone with one
  process.
- **scheduled work** — full program lifecycle live: proposal → approve →
  fire → reschedule (no approval) → 5-missed-occurrence coalesce →
  maxLateness skip → toggle re-baseline → hook route (mint refused
  https-only live; token→hash lookup, throttle, 429, redaction proven) →
  superseded/orphaned proposal refusals → provider-failure visibility and
  bounded retry ladder → delete with retry-drop. Not run: Telegram card
  tap flow, grant-time hook DM, actual process restart (equivalent stale-due
  shape proven).
- **memory** — fake Hindsight implementing the real wire contract; recall
  persistence across restart, retention queue (blocked → retry → dismiss),
  `/forget` protocol (cancel + redact + suppress verified), per-conversation
  exclusion, project boundary staleness, recall timeout marker, floor
  filtering, credential screening (`[REDACTED:credential]`), tools probes
  (`memory_search`/`memory_reflect` budgets, fail-closed listings). Telegram
  rendering surfaces code-read only.
- **persona and skills** — prompt snapshots read from SQLite; nested-metadata
  skill skipped live (log reason captured); SOUL-edit freeze re-proven;
  proposal install/discard module probes; 130-skill cap probe; reviewer-off
  verified from boot log. Temp-skill invocation not exercisable (Telegram
  off, no browser).
- **model switching** — mid-flight switch freeze proven live (running turn
  keeps admitted pair; queued turn captures latest); favorites/settings
  round-trips incl. If-Match 428/409; fallback walk live with
  `fallback.from` metadata; restart persistence; repo test suites
  (`turn-resume` 86, `thinking` 57, operator routes 57, `turn/view` 25,
  ModelPicker 13, `runtime-fallback` 11).
- **errors and limits** — scripted `[fail]`/`[slow]` turns: single-POST
  mid-stream death with unlanded record; every-model-failed combined error;
  fallback-served run metadata; SIGKILL mid-stream with NULL partial;
  429 ladder module probes (2×429→recover; always-429→wire error text); repo
  suites green (provider errors 89, fallback 11, scheduler 58, delivery 67).
- **two doors** — both doors' route matrix live (mini app fails closed 503;
  app-only ids refused on the app wire with 422; relative `/` redirect);
  offline-shell precache manifest stamped; settings If-Match semantics;
  initData auth probes (signed/stale/forged); pool disjointness,
  cross-DM ring journaling, push payload and retry probes; crash-test suite.
- **delegate coding** — 7 module probes against the real lifecycle with a
  scripted herdr CLI (frozen worker, question-settles-done, send/answer
  preflight, restart of `starting`/`running` rows, tool-mount gating);
  instance route checks (delegation unconfigured → 503 fail-loud).
  Not run: real GitHub readiness, real harness TUI, machine targets.
- **ongoing concerns** — real responsibility service against the instance
  SQLite: accept → follow-up plan → `waiting` report; a real 65-minute
  wait on the live instance proved the hourly check-in cycle fires despite
  `resumeWhen`; worker report review flow; correction/pause/resume;
  evidence-gated close (wrong evidence refused naming the entry); delivery
  uncertain/reconcile; observer-failure invisibility probe; restart
  persistence at module level.
